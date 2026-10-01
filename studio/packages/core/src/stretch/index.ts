// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * stretch — run-a-too-big-model toolkit: the curated AirLLM/offload technique
 * registry + a pure feasibility assessor that recommends the cheapest viable way
 * to run a model that overflows the user's RAM/VRAM (or nudges to a smaller one).
 */
export {
  STRETCH_TECHNIQUES,
  getTechnique,
  type StretchTechnique,
  type SpeedCost,
  type QualityCost,
} from "./techniques.js";
export {
  assessFeasibility,
  type DemandInput,
  type MachineInput,
  type FitTier,
  type StretchSuggestion,
  type FeasibilityVerdict,
} from "./suggest.js";
