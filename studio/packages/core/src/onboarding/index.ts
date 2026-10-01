// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * onboarding — the first ten minutes.
 *
 * `doctor.ts` decides WHAT is missing from a snapshot of the machine; `render.ts` turns that
 * into lines, in the user's language, with the commands left untranslated. Both are pure —
 * the caller does the probing and hands the facts in, which is what lets the whole experience
 * be tested without putting a machine into a particular state.
 */
export type {
  DoctorReport,
  MachineFacts,
  PackageManager,
  Requirement,
  RequirementId,
  RequirementResult,
  RequirementState,
  RequirementTier,
} from "./doctor.js";
export {
  MIN_NODE_MAJOR,
  REQUIREMENTS,
  STARTER_HEADROOM_BYTES,
  STARTER_MODELS,
  commandFor,
  diagnose,
  stateOf,
  suggestModel,
} from "./doctor.js";
export { MARKS, renderDoctor, renderGuide, renderRequirement } from "./render.js";
