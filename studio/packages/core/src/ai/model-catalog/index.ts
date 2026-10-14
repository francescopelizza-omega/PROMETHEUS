// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog — what the `/models` guided picker offers and how it prepares a pick.
 * Pure data + pure planning; the hosts (CLI, TUI, desktop) do the IO.
 */
export * from "./types.js";
export { FREE_TIERS, FREE_TIER_CHECKED_AT, freeTierFor, describeDataUse } from "./free-tier.js";
export { CLOUD_MODELS, cloudModelsFor, findCloudModel } from "./cloud.js";
export { LOCAL_MODELS, findLocalModel } from "./local.js";
export { OFFLOAD_RUNTIMES, offloadRuntime } from "./offload.js";
export {
  type LocalRunPlan,
  planLocalModel,
  planCatalog,
  diskFits,
  nativeAlternatives,
  machineFromHost,
} from "./plan.js";
export { type LiveModelMatch, matchLiveModel, modelsPathFor } from "./live-models.js";
export * from "./wizard.js";
