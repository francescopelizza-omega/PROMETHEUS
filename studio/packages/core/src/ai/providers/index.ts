// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/providers — the billing-aware provider matrix + the 3-tier promotion policy
 * (file 12 §1–§3). Pure, dependency-free: load/validate the catalog, derive
 * tier/light/warn from the connector kind, resolve the brain Tier-A-first, and guard
 * the api-key-shadows-subscription footgun.
 */
export * from "./types.js";
export {
  type ModelPrice,
  type Pricing,
  DEFAULT_AI_PROVIDERS_CONFIG,
  contextLenForModel,
  costLightForTier,
  costOf,
  effectiveTier,
  getProvider,
  loadPricing,
  loadProviders,
  priceForModel,
  sortByPromotion,
  validateProvider,
  warnForTier,
} from "./registry.js";
export {
  type ConnectorIssue,
  type ResolvedBrain,
  detectKeyShadowsOauth,
  newConnector,
  resolveBrain,
  validateConnector,
} from "./resolver.js";
