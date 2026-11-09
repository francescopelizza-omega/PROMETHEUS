// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog — what the `/models` guided picker offers and how it prepares a pick.
 * Pure data + pure planning; the hosts (CLI, TUI, desktop) do the IO.
 */
export * from "./types.js";
export { FREE_TIERS, FREE_TIER_CHECKED_AT, freeTierFor, describeDataUse } from "./free-tier.js";
export { CLOUD_MODELS, cloudModelsFor, findCloudModel } from "./cloud.js";
export { LOCAL_MODELS, findLocalModel, toLocalEntry } from "./local.js";
export type * from "./catalog-types.js";
export { CATALOG_MODELS } from "./catalog.generated.js";
export { OFFLOAD_RUNTIMES, offloadRuntime } from "./offload.js";
export {
  type LocalRunPlan,
  type StreamingOption,
  planLocalModel,
  planCatalog,
  diskFits,
  fitsNatively,
  hasLocalBuild,
  modelBudgetGb,
  nativeAlternatives,
  machineFromHost,
  streamingOptions,
} from "./plan.js";
export { type LiveModelMatch, matchLiveModel, modelsPathFor } from "./live-models.js";
export * from "./wizard.js";
