import { readFileSync } from "node:fs";
/**
 * providers/policy.ts — the C11 provider promotion policy.
 *
 * Loads config/providers.config.json and answers the questions the GUI/CLI ask
 * before letting a user pick a provider:
 *   - classifyTier(provider, ctx)  -> A | B | C  (subscription promotes C->B)
 *   - costLight(provider, ctx)     -> green | blue | red
 *   - sortByPromotion(providers)   -> Tier-A first (default, green), C last
 *   - needsCostWarning(provider)   -> true for metered (Tier-C) providers
 *   - localaiRepointSuggestion()   -> the engine localai escape-hatch helper
 *
 * GOLDEN RULE alignment: this module NEVER auto-promotes a Tier-C provider on
 * its own. Promotion C->B happens ONLY when the caller passes a PromotionContext
 * proving a covering subscription/seat was detected (verifyAtSetup). Absent that
 * proof, a metered provider stays Tier C (red, loud warning, typed confirm).
 *
 * Node built-ins only (node:fs/promises, node:path). Zero third-party deps.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  BillingMode,
  CostLight,
  IntegrationKind,
  Provider,
  ProviderTier,
  ProviderWarn,
} from "../domain/models.js";

/**
 * Runtime proof, gathered at setup (verifyAtSetup), that a subscription/seat
 * covers a provider's IDE use. The presence of a capability id in
 * `coveredCapabilities` that matches a provider's `subscriptionCoversIf`
 * promotes that provider C -> B.
 */
export interface PromotionContext {
  /** capability ids confirmed present (e.g. "claude-code-oauth"). */
  coveredCapabilities?: string[];
}

const EMPTY_CONTEXT: PromotionContext = {};

/**
 * Does this context prove the provider's covering subscription/seat is present?
 * Requires BOTH a declared `subscriptionCoversIf` condition AND that exact
 * capability in the context. A provider already marked includedInSubscription
 * (e.g. Copilot/Cursor) is treated as covered unconditionally.
 */
export function hasCoveringSubscription(
  provider: Provider,
  ctx: PromotionContext = EMPTY_CONTEXT,
): boolean {
  if (provider.includedInSubscription) return true;
  const need = provider.subscriptionCoversIf;
  if (!need) return false;
  const have = ctx.coveredCapabilities ?? [];
  return have.includes(need);
}

/**
 * Classify the EFFECTIVE tier of a provider given runtime context (C11).
 * Promotion is strictly conservative: a provider may only move toward A
 * (C -> B when a covering subscription is proven); it is never moved toward C.
 */
export function classifyTier(
  provider: Provider,
  ctx: PromotionContext = EMPTY_CONTEXT,
): ProviderTier {
  // Tier-C providers may be promoted to B when a covering subscription exists.
  if (
    provider.promotedTier === "C" &&
    provider.promotedTierIfSubscription === "B" &&
    hasCoveringSubscription(provider, ctx)
  ) {
    return "B";
  }
  return provider.promotedTier;
}

/** The cost light for a provider's EFFECTIVE tier (green/blue/red). */
export function costLight(provider: Provider, ctx: PromotionContext = EMPTY_CONTEXT): CostLight {
  const tier = classifyTier(provider, ctx);
  // The realised tier drives the light so a promoted provider goes blue, not red.
  if (provider.costLightIfSubscription && tier === "B" && provider.promotedTier === "C") {
    return provider.costLightIfSubscription;
  }
  switch (tier) {
    case "A":
      return "green";
    case "B":
      return "blue";
    case "C":
      return "red";
  }
}

/** A metered (Tier-C) provider needs a loud cost warning + typed confirm. */
export function needsCostWarning(
  provider: Provider,
  ctx: PromotionContext = EMPTY_CONTEXT,
): boolean {
  return classifyTier(provider, ctx) === "C";
}

/** The literal string the user must type to enable a metered provider, if any. */
export function requiredConfirmPhrase(provider: Provider): string | undefined {
  return provider.requiresTypedConfirm;
}

/** Rank tiers so Tier-A sorts FIRST (default, promoted, green). */
const TIER_ORDER: Record<ProviderTier, number> = { A: 0, B: 1, C: 2 };

/**
 * Sort providers Tier-A-first (then B, then C). Within a tier, the escape-hatch
 * `local` provider floats to the very top, then alphabetical by label for a
 * stable, deterministic UI ordering. Returns a NEW array (input untouched).
 */
export function sortByPromotion(
  providers: Provider[],
  ctx: PromotionContext = EMPTY_CONTEXT,
): Provider[] {
  return [...providers].sort((a, b) => {
    const ta = TIER_ORDER[classifyTier(a, ctx)];
    const tb = TIER_ORDER[classifyTier(b, ctx)];
    if (ta !== tb) return ta - tb;
    // escape-hatch first within a tier
    const ea = a.isEscapeHatch ? 0 : 1;
    const eb = b.isEscapeHatch ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return a.label.localeCompare(b.label);
  });
}

/**
 * The localai re-point suggestion (C11 escape hatch). For any metered provider,
 * the way out is to demote to a local endpoint via the engine `localai` flow.
 * Returns a structured suggestion the GUI/CLI can render as a one-click action.
 */
export interface LocalaiRepointSuggestion {
  fromProviderId: string;
  toProviderId: "local";
  /** the engine subcommand the bridge would run to re-point inference local. */
  engineCommand: string[];
  defaultBaseUrl: string;
  rationale: string;
}

export function localaiRepointSuggestion(
  provider: Provider,
  localProvider?: Provider,
): LocalaiRepointSuggestion {
  const baseUrl = localProvider?.defaultBaseUrl || "http://localhost:11434/v1";
  return {
    fromProviderId: provider.id,
    toProviderId: "local",
    engineCommand: ["localai", "--point", baseUrl],
    defaultBaseUrl: baseUrl,
    rationale: `${provider.label} is metered (Tier C). Re-point inference at a local open-weight endpoint to drop to Tier A (green, no per-token cost).`,
  };
}

// ====================================================================== //
//  Config loading (config/providers.config.json)                          //
// ====================================================================== //

interface RawProvider {
  id: string;
  label: string;
  aliases?: string[];
  integrationKind: string;
  billingMode: string;
  includedInSubscription?: boolean;
  promotedTier: string;
  promotedTierIfSubscription?: string;
  subscriptionCoversIf?: string;
  includedInSubscriptionVia?: string;
  costLight: string;
  costLightIfSubscription?: string;
  warn?: string;
  verifyAtSetup?: boolean;
  defaultBaseUrl?: string;
  requiresTypedConfirm?: string;
  isEscapeHatch?: boolean;
  notes?: string;
}

interface RawConfig {
  version?: string;
  providers?: RawProvider[];
}

const TIERS = new Set(["A", "B", "C"]);
const LIGHTS = new Set(["green", "blue", "red"]);

function asTier(v: string | undefined, fallback: ProviderTier): ProviderTier {
  return v && TIERS.has(v) ? (v as ProviderTier) : fallback;
}
function asTierOpt(v: string | undefined): ProviderTier | undefined {
  return v && TIERS.has(v) ? (v as ProviderTier) : undefined;
}
function asLight(v: string | undefined, fallback: CostLight): CostLight {
  return v && LIGHTS.has(v) ? (v as CostLight) : fallback;
}
function asWarn(v: string | undefined): ProviderWarn {
  return v === "high" || v === "low" || v === "none" ? v : "high";
}

/** Map one raw JSON provider entry to the typed Provider domain model. */
export function parseProvider(raw: RawProvider): Provider {
  const tier = asTier(raw.promotedTier, "C");
  return {
    id: raw.id,
    label: raw.label,
    aliases: raw.aliases,
    integrationKind: raw.integrationKind as IntegrationKind,
    billingMode: raw.billingMode as BillingMode,
    includedInSubscription: raw.includedInSubscription === true,
    promotedTier: tier,
    promotedTierIfSubscription: asTierOpt(raw.promotedTierIfSubscription),
    subscriptionCoversIf: raw.subscriptionCoversIf,
    includedInSubscriptionVia: raw.includedInSubscriptionVia,
    costLight: asLight(raw.costLight, tier === "A" ? "green" : tier === "B" ? "blue" : "red"),
    costLightIfSubscription: raw.costLightIfSubscription
      ? asLight(raw.costLightIfSubscription, "blue")
      : undefined,
    warn: asWarn(raw.warn),
    verifyAtSetup: raw.verifyAtSetup !== false,
    defaultBaseUrl: raw.defaultBaseUrl,
    requiresTypedConfirm: raw.requiresTypedConfirm,
    isEscapeHatch: raw.isEscapeHatch === true,
    notes: raw.notes,
  };
}

function parseConfigText(text: string): Provider[] {
  const cfg = JSON.parse(text) as RawConfig;
  const raw = Array.isArray(cfg.providers) ? cfg.providers : [];
  return raw.map(parseProvider);
}

/**
 * Default config location, resolved RELATIVE to this module rather than hard-coded:
 * …/studio/packages/core/(src|dist)/providers → up 4 = …/studio. src and dist sit at the
 * same depth, so one count serves both the dev and the compiled tree.
 *
 * This value is inlined into the published CLI bundle and the Electron asar, so an
 * absolute developer path here ships the author's username and home layout to every user
 * — and points at a directory that exists on exactly one machine. Callers pass an explicit
 * path when they have one; this is only the fallback.
 */
export const DEFAULT_PROVIDERS_CONFIG = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "..", "..", "..", "..", "config", "providers.config.json");
  } catch {
    // no import.meta (bundled to CJS / SEA) — stay relative to the process, not to a home dir
    return resolve(process.cwd(), "studio", "config", "providers.config.json");
  }
})();

/** Async-load + parse the provider config from disk (C11). */
export async function loadProviders(path: string = DEFAULT_PROVIDERS_CONFIG): Promise<Provider[]> {
  const text = await readFile(path, "utf8");
  return parseConfigText(text);
}

/** Sync variant for non-async callers (CLI bootstrap). */
export function loadProvidersSync(path: string = DEFAULT_PROVIDERS_CONFIG): Provider[] {
  return parseConfigText(readFileSync(path, "utf8"));
}
