/**
 * ai/providers/registry.ts — load the matrix + derive tier/light/warn (file 12 §1/§2).
 *
 * `loadProviders` reads + structurally validates `providers.config.json` (fail-soft,
 * like policy.ts — a bad row is dropped, never throws). The connector KIND decides
 * the effective tier (§1.1): local-serve→A, oauth/cli→B, api-key→C; the tier decides
 * the cost light + warn level. `sortByPromotion` is the A>B>C promotion order.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BillingMode,
  CostLight,
  IntegrationKind,
  Modality,
  ModelEntry,
  PromotedTier,
  Provider,
  WarnLevel,
} from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The shipped matrix config (read from beside this module). */
export const DEFAULT_AI_PROVIDERS_CONFIG = join(here, "providers.config.json");

const KINDS = new Set<IntegrationKind>([
  "local-serve",
  "oauth-subscription-bridge",
  "cli-passthrough",
  "api-key",
]);
const BILLING = new Set<BillingMode>(["free-local", "flat-subscription", "metered"]);
const TIERS = new Set<PromotedTier>(["A", "B", "C"]);
const LIGHTS = new Set<CostLight>(["green", "blue", "red"]);
const WARNS = new Set<WarnLevel>(["none", "gentle", "loud"]);
const MODALITIES = new Set<Modality>([
  "text",
  "vision",
  "embedding",
  "asr",
  "code",
  "reranker",
  "multimodal",
]);

/** The connector KIND decides the effective tier (§1.1). */
export function effectiveTier(kind: IntegrationKind): PromotedTier {
  if (kind === "local-serve") return "A";
  if (kind === "api-key") return "C";
  return "B"; // oauth-subscription-bridge | cli-passthrough
}

/** The tier decides the cost light (§5). */
export function costLightForTier(tier: PromotedTier): CostLight {
  return tier === "A" ? "green" : tier === "B" ? "blue" : "red";
}

/** The tier decides the warn level (§0). */
export function warnForTier(tier: PromotedTier): WarnLevel {
  return tier === "A" ? "none" : tier === "B" ? "gentle" : "loud";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function numOrNull(v: unknown): number | null | undefined {
  if (v === null) return null;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function validateModel(raw: unknown): ModelEntry | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const label = str(raw.label);
  const modality = str(raw.modality);
  if (!id || !label || !modality || !MODALITIES.has(modality as Modality)) return null;
  return {
    id,
    label,
    modality: modality as Modality,
    openWeight: raw.openWeight === true,
    ...(typeof raw.contextLen === "number" ? { contextLen: raw.contextLen } : {}),
    ...(numOrNull(raw.pricePerMTokIn) !== undefined
      ? { pricePerMTokIn: numOrNull(raw.pricePerMTokIn) }
      : {}),
    ...(numOrNull(raw.pricePerMTokOut) !== undefined
      ? { pricePerMTokOut: numOrNull(raw.pricePerMTokOut) }
      : {}),
    ...(Array.isArray(raw.servedVia)
      ? { servedVia: raw.servedVia.filter((s): s is string => typeof s === "string") }
      : {}),
    ...(str(raw.localOllamaTag) ? { localOllamaTag: str(raw.localOllamaTag) } : {}),
  };
}

/** Structurally validate one row → Provider, or null (fail-soft). */
export function validateProvider(raw: unknown): Provider | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const label = str(raw.label);
  if (!id || !label) return null;
  const kinds = Array.isArray(raw.kinds)
    ? raw.kinds.filter(
        (k): k is IntegrationKind => typeof k === "string" && KINDS.has(k as IntegrationKind),
      )
    : [];
  if (kinds.length === 0) return null;
  const billing = str(raw.billing);
  if (!billing || !BILLING.has(billing as BillingMode)) return null;
  const tier = str(raw.tier);
  if (!tier || !TIERS.has(tier as PromotedTier)) return null;
  const costLight = str(raw.costLight);
  const warnLevel = str(raw.warnLevel);
  if (!costLight || !LIGHTS.has(costLight as CostLight)) return null;
  if (!warnLevel || !WARNS.has(warnLevel as WarnLevel)) return null;

  const inc = raw.includedInSubscription;
  const includedInSubscription: boolean | "per-plan" =
    inc === "per-plan" ? "per-plan" : inc === true;

  const out: Provider = {
    id,
    label,
    kinds,
    billing: billing as BillingMode,
    includedInSubscription,
    tier: tier as PromotedTier,
    costLight: costLight as CostLight,
    warnLevel: warnLevel as WarnLevel,
    verifyAtSetup: true,
  };
  if (raw.repointSuggest === true) out.repointSuggest = true;
  if (str(raw.baseUrlEnv)) out.baseUrlEnv = str(raw.baseUrlEnv);
  if (str(raw.cliBin)) out.cliBin = str(raw.cliBin);
  if (str(raw.tosUrl)) out.tosUrl = str(raw.tosUrl);
  if (isRecord(raw.oauth) && str(raw.oauth.authUrl) && str(raw.oauth.tokenUrl)) {
    out.oauth = {
      authUrl: raw.oauth.authUrl as string,
      tokenUrl: raw.oauth.tokenUrl as string,
      scopes: Array.isArray(raw.oauth.scopes)
        ? raw.oauth.scopes.filter((s): s is string => typeof s === "string")
        : [],
      ...(str(raw.oauth.betaHeader) ? { betaHeader: str(raw.oauth.betaHeader) } : {}),
    };
  }
  if (Array.isArray(raw.models)) {
    const models = raw.models.map(validateModel).filter((m): m is ModelEntry => m !== null);
    if (models.length > 0) out.models = models;
  }
  return out;
}

/** Load + validate the provider matrix (fail-soft → [] on read/parse error). */
export function loadProviders(path: string = DEFAULT_AI_PROVIDERS_CONFIG): Provider[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const rows = isRecord(parsed) && Array.isArray(parsed.providers) ? parsed.providers : [];
  return rows.map(validateProvider).filter((p): p is Provider => p !== null);
}

/** Look up a provider by id. */
export function getProvider(providers: readonly Provider[], id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}

const TIER_RANK: Record<PromotedTier, number> = { A: 0, B: 1, C: 2 };

/** Promotion order: A before B before C; within a tier, by label (stable). */
export function sortByPromotion(providers: readonly Provider[]): Provider[] {
  return [...providers].sort((a, b) => {
    const d = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    return d !== 0 ? d : a.label.localeCompare(b.label);
  });
}

/* ── model-aware pricing (CLI-058) ───────────────────────────────────────── */

/** Per-model list price (USD per 1M tokens). Optional `match` overrides the map key as the
 *  prefix to compare a model id against (else the key itself is the prefix). */
export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  match?: string;
  /** the connector's declared context window, when known (CLI-092: no cloud endpoint should
   *  hard-code 8192 when the provider's real window is public knowledge). */
  contextLen?: number;
}

/** The `pricing` map from providers.config.json, keyed by model id / prefix. */
export type Pricing = Record<string, ModelPrice>;

/** Load + validate the `pricing` map (fail-soft → {} on error). Drops entries whose rates aren't
 *  finite numbers so a note/typo can never produce a NaN cost. */
export function loadPricing(path: string = DEFAULT_AI_PROVIDERS_CONFIG): Pricing {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  const src = isRecord(raw) && isRecord(raw.pricing) ? raw.pricing : {};
  const out: Pricing = {};
  for (const [key, val] of Object.entries(src)) {
    if (!isRecord(val)) continue;
    const inRate = val.inputUsdPerMTok;
    const outRate = val.outputUsdPerMTok;
    if (typeof inRate !== "number" || !Number.isFinite(inRate)) continue;
    if (typeof outRate !== "number" || !Number.isFinite(outRate)) continue;
    const contextLen = val.contextLen;
    out[key] = {
      inputUsdPerMTok: inRate,
      outputUsdPerMTok: outRate,
      ...(typeof val.match === "string" ? { match: val.match } : {}),
      ...(typeof contextLen === "number" && Number.isFinite(contextLen) ? { contextLen } : {}),
    };
  }
  return out;
}

/**
 * Longest-prefix match (case-insensitive) of a model id against the pricing map — so
 * `claude-sonnet-4-6-20250219` resolves `claude-sonnet-4` over `claude`. Ambiguous/absent ⇒
 * null (the caller renders `n/a`, never a nearest guess).
 */
export function priceForModel(pricing: Pricing, modelId: string): ModelPrice | null {
  const id = modelId.toLowerCase();
  let best: ModelPrice | null = null;
  let bestLen = -1;
  for (const [key, price] of Object.entries(pricing)) {
    const prefix = (price.match ?? key).toLowerCase();
    if ((id === prefix || id.startsWith(prefix)) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * The connector's declared context window for a cloud model, by the same longest-prefix rule
 * as `priceForModel` (CLI-092). Absent/unknown ⇒ null so the caller falls back to the
 * documented conservative default rather than a fabricated number — never probed live: firing
 * an unrequested request at a cloud provider to satisfy curiosity is out of scope for a
 * privacy-first client (see `ai/context-window.ts`'s local-only probe).
 */
export function contextLenForModel(pricing: Pricing, modelId: string): number | null {
  const p = priceForModel(pricing, modelId);
  return p?.contextLen ?? null;
}

/**
 * Cost of a turn's token usage: local endpoint ⇒ $0 (never priced from the table); a known model
 * ⇒ `in·inRate + out·outRate` in full float (round only at display); an UNKNOWN model ⇒ null so
 * the caller prints `n/a` + the add-it hint rather than synthesizing a dollar figure.
 */
export function costOf(
  usage: { inputTokens: number; outputTokens: number },
  modelId: string,
  pricing: Pricing,
  isLocal: boolean,
): number | null {
  if (isLocal) return 0;
  const p = priceForModel(pricing, modelId);
  if (!p) return null;
  return (
    (usage.inputTokens / 1e6) * p.inputUsdPerMTok + (usage.outputTokens / 1e6) * p.outputUsdPerMTok
  );
}
