import { effectiveTier, getProvider } from "./registry.js";
/**
 * ai/providers/resolver.ts — pick the brain + guard the wiring (file 12 §3).
 *
 * `resolveBrain` is the Tier-A-first policy in code (§3): given the configured
 * connectors, prefer A (local/free) → B (subscription) → C (metered), and within a
 * tier the most-recently-confirmed wins. `detectKeyShadowsOauth` is the §3.2 footgun
 * guard: a provider that COULD ride a subscription (oauth) but was wired with a raw
 * api-key silently demotes A/B → C metered — surface it loudly. `validateConnector`
 * is the structural + policy gate every ConnectorConfig must pass before use.
 */
import type {
  ConnectorConfig,
  EnabledSurface,
  IntegrationKind,
  PromotedTier,
  Provider,
} from "./types.js";

const TIER_RANK: Record<PromotedTier, number> = { A: 0, B: 1, C: 2 };

/** A resolved brain choice + why it won (for the picker + the audit log). */
export interface ResolvedBrain {
  connector: ConnectorConfig;
  tier: PromotedTier;
  reason: string;
}

/**
 * Pick the connector to use for a surface, Tier-A-first (§3).
 * Filters to connectors enabled for `surface`, sorts A→B→C, and within a tier
 * prefers the one most-recently confirmed (Tier-C requires confirmedCostWarningAt).
 * Returns null when nothing is wired for the surface.
 */
export function resolveBrain(
  connectors: readonly ConnectorConfig[],
  surface: EnabledSurface,
): ResolvedBrain | null {
  const eligible = connectors.filter((c) => c.enabledFor.includes(surface));
  if (eligible.length === 0) return null;
  const ranked = [...eligible].sort((a, b) => {
    const d = TIER_RANK[a.effectiveTier] - TIER_RANK[b.effectiveTier];
    if (d !== 0) return d;
    // within a tier, the most-recently confirmed wins (stable otherwise)
    const at = a.confirmedCostWarningAt ?? "";
    const bt = b.confirmedCostWarningAt ?? "";
    return bt.localeCompare(at);
  });
  const chosen = ranked[0];
  if (!chosen) return null;
  const reason =
    chosen.effectiveTier === "A"
      ? "local/free — the default brain (Tier A)"
      : chosen.effectiveTier === "B"
        ? "covered by your subscription (Tier B)"
        : "metered — used because no free/subscription brain is enabled for this surface (Tier C)";
  return { connector: chosen, tier: chosen.effectiveTier, reason };
}

/**
 * §3.2 footgun guard: the chosen kind is api-key (→ Tier C metered) but the SAME
 * provider also supports oauth-subscription-bridge — so the user is paying per-token
 * for something a subscription would cover. Returns a warning, or null when fine.
 */
export function detectKeyShadowsOauth(
  connector: ConnectorConfig,
  providers: readonly Provider[],
): string | null {
  if (connector.kind !== "api-key") return null;
  const provider = getProvider(providers, connector.providerId);
  if (!provider) return null;
  if (!provider.kinds.includes("oauth-subscription-bridge")) return null;
  return `${provider.label}: wired with a raw API key (metered, Tier C) but it can ride your subscription (Tier B). Re-connect via "Sign in" to stop paying per token.`;
}

/** A validation problem on a ConnectorConfig (id = stable code for tests/UX). */
export interface ConnectorIssue {
  code:
    | "unknown-provider"
    | "kind-unsupported"
    | "tier-mismatch"
    | "missing-key"
    | "missing-oauth"
    | "missing-guardrail"
    | "unconfirmed-metered"
    | "no-surface"
    | "unknown-model";
  message: string;
}

const SURFACES = new Set<EnabledSurface>(["inline-edit", "agent-pane", "prometheus", "embeddings"]);

/**
 * Structural + policy validation for a ConnectorConfig (§2.4 / §4).
 * The load-bearing rules: kind must be supported by the provider; effectiveTier must
 * match the kind; api-key needs a keyRef; oauth needs an oauthRef; Tier-C MUST carry a
 * guardrail AND a confirmedCostWarningAt (the typed-confirm receipt). Returns [] when ok.
 */
export function validateConnector(
  connector: ConnectorConfig,
  providers: readonly Provider[],
): ConnectorIssue[] {
  const issues: ConnectorIssue[] = [];
  const provider = getProvider(providers, connector.providerId);
  if (!provider) {
    return [
      { code: "unknown-provider", message: `No provider "${connector.providerId}" in the matrix.` },
    ];
  }
  if (!provider.kinds.includes(connector.kind)) {
    issues.push({
      code: "kind-unsupported",
      message: `${provider.label} does not support the "${connector.kind}" connector.`,
    });
  }
  if (connector.effectiveTier !== effectiveTier(connector.kind)) {
    issues.push({
      code: "tier-mismatch",
      message: `effectiveTier "${connector.effectiveTier}" does not match kind "${connector.kind}" (expected "${effectiveTier(connector.kind)}").`,
    });
  }
  if (connector.kind === "api-key" && !connector.keyRef) {
    issues.push({
      code: "missing-key",
      message: `${provider.label}: api-key connector needs a keychain ref.`,
    });
  }
  if (connector.kind === "oauth-subscription-bridge" && !connector.oauthRef) {
    issues.push({
      code: "missing-oauth",
      message: `${provider.label}: oauth connector needs a token ref.`,
    });
  }
  if (connector.effectiveTier === "C") {
    if (!connector.guardrail) {
      issues.push({
        code: "missing-guardrail",
        message: `${provider.label}: a metered (Tier C) connector MUST carry a cost guardrail (§4).`,
      });
    }
    if (!connector.confirmedCostWarningAt) {
      issues.push({
        code: "unconfirmed-metered",
        message: `${provider.label}: metered use requires the typed-confirm warning (§4.1) before it can be enabled.`,
      });
    }
  }
  if (connector.enabledFor.length === 0 || !connector.enabledFor.every((s) => SURFACES.has(s))) {
    issues.push({
      code: "no-surface",
      message: `${provider.label}: connector must be enabled for at least one valid surface.`,
    });
  }
  if (
    provider.models &&
    provider.models.length > 0 &&
    !provider.models.some((m) => m.id === connector.modelId)
  ) {
    issues.push({
      code: "unknown-model",
      message: `${provider.label}: model "${connector.modelId}" is not in the provider's catalog.`,
    });
  }
  return issues;
}

/** Derive a fresh ConnectorConfig skeleton for a provider+kind (effectiveTier from kind). */
export function newConnector(
  provider: Provider,
  kind: IntegrationKind,
  modelId: string,
  enabledFor: EnabledSurface[],
): ConnectorConfig {
  return {
    providerId: provider.id,
    kind,
    modelId,
    effectiveTier: effectiveTier(kind),
    enabledFor,
  };
}
