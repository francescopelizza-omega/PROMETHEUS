// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/providers/types.ts — the billing-aware AI provider model (file 12 §2).
 *
 * The RICHER, billing-aware vocabulary file 12 specifies — distinct from (and
 * additive to) the leaner C11 `domain/models.ts` Provider, which the CLI + the
 * CostLight UI still depend on. This layer is the authoritative source for "who can
 * be a brain, how it's wired, and how it bills". Dependency-free structural types
 * (validated by a fail-soft validator in registry.ts, like theme.ts/manifest.ts).
 *
 * The spine (§0): a 3-tier promotion hierarchy — A local/free (default), B
 * subscription-included (bounded), C metered (allowed, never promoted, always warned).
 */

/** How a provider charges (§2.1). */
export type BillingMode = "free-local" | "flat-subscription" | "metered";

/** How Studio wires to the provider — the connector kind DECIDES the tier (§1.1). */
export type IntegrationKind =
  | "local-serve" // → A: base-URL at a local Model Hub ServeProfile
  | "oauth-subscription-bridge" // → B: vendor OAuth; token rides the subscription
  | "cli-passthrough" // → B: spawn the vendor CLI; it owns auth + billing
  | "api-key"; // → C: static key → a metered endpoint

export type PromotedTier = "A" | "B" | "C";
export type CostLight = "green" | "blue" | "red"; // 🟢 local · 🔵 subscription · 🔴 metered
export type WarnLevel = "none" | "gentle" | "loud"; // "loud" ⇒ blocking modal + typed-confirm

export type Modality = "text" | "vision" | "embedding" | "asr" | "code" | "reranker" | "multimodal";

/** A selectable model under a provider (§2.3). Pricing is meaningful for metered only. */
export interface ModelEntry {
  id: string;
  label: string;
  modality: Modality;
  openWeight: boolean; // true ⇒ also runnable locally (Tier-A escape-hatch eligible)
  contextLen?: number;
  pricePerMTokIn?: number | null; // USD per 1M input tokens (verifyAtSetup); null for free/sub
  pricePerMTokOut?: number | null; // USD per 1M output tokens
  servedVia?: string[]; // open-weight API hosts that serve it
  localOllamaTag?: string; // the `ollama pull` tag if it runs locally ($0)
}

/** The vendor OAuth / IDE-integration flow descriptor (§2.2, no secrets). */
export interface ProviderOauth {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  betaHeader?: string;
}

/** The catalog row — one per matrix entry (§2.2). Pure config; no secrets, no live logic. */
export interface Provider {
  id: string;
  label: string;
  kinds: IntegrationKind[]; // the connector kinds this provider supports (one provider, many tiers)
  billing: BillingMode; // the DEFAULT billing for the recommended kind
  includedInSubscription: boolean | "per-plan"; // "per-plan" ⇒ verify at setup
  tier: PromotedTier; // promotion rank for the DEFAULT/recommended kind
  costLight: CostLight;
  warnLevel: WarnLevel;
  verifyAtSetup: true; // §0.1 — every billing claim is ToS-bound, always true
  repointSuggest?: boolean; // true ⇒ offer the localai "run it free locally" escape hatch (§6)
  baseUrlEnv?: string; // e.g. "OPENAI_BASEURL" — the var Studio writes for a local repoint
  oauth?: ProviderOauth;
  cliBin?: string; // for cli-passthrough, e.g. "cursor"
  models?: ModelEntry[];
  tosUrl?: string;
}

/** Where a configured brain is allowed to be used (§2.4). */
export type EnabledSurface = "inline-edit" | "agent-pane" | "prometheus" | "embeddings";

/** A keychain reference (file 09 §7.2) — NEVER the secret itself. */
export interface KeychainRef {
  service: string;
  account: string;
}

/** The spend-control envelope — MANDATORY on any Tier-C connector (§2.5). */
export interface CostGuardrail {
  monthlyCapUsd: number; // hard ceiling per provider per calendar month
  warnAtPct: number; // e.g. 0.8 ⇒ amber banner at 80% of cap
  spentThisMonthUsd: number; // live meter (updated from per-request usage; §4.3)
  perRequestMaxUsd?: number; // refuse a single call estimated to exceed this
  onCap: "auto-disable" | "block-new" | "warn-only"; // default "auto-disable"
  resetsOn: string; // ISO date of the next monthly reset
  lastEstimateUsd?: number; // estimate shown in the meter before a call fires
}

/** The configured, ready-to-use binding for one provider (§2.4). Secrets are refs. */
export interface ConnectorConfig {
  providerId: string;
  kind: IntegrationKind; // the chosen wiring (decides the effective tier)
  modelId: string;
  baseUrl?: string;
  keyRef?: KeychainRef; // api-key — keychain ref, NEVER the secret
  oauthRef?: KeychainRef; // oauth-subscription-bridge — keychain ref to the token
  effectiveTier: PromotedTier; // derived from kind
  guardrail?: CostGuardrail; // REQUIRED & enforced when effectiveTier === "C" (§4)
  enabledFor: EnabledSurface[];
  confirmedCostWarningAt?: string; // ISO — set only after the typed-confirm modal (Tier C)
}

/** The literal phrase the user must type to enable a metered (Tier-C) connector (§4.1). */
export const ENABLE_METERED_PHRASE = "ENABLE METERED";
