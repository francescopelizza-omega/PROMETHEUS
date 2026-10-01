// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * rules — file 14 §3.3: AGENTS.md/CLAUDE.md precedence chain + /init scaffold. Pure;
 * the caller reads files + gates remote instruction fetches (C12).
 */
export type {
  AssembledRules,
  InitScaffoldInput,
  RuleKind,
  RuleScope,
  RuleSource,
  SteeringCandidate,
} from "./loader.js";
export {
  DEFAULT_PRECEDENCE,
  STEERING_GLOBAL_NAMES,
  STEERING_PROJECT_NAMES,
  assembleRules,
  initRulesScaffold,
  isRemoteInstruction,
  orderRuleSources,
  steeringCandidates,
  steeringKindOf,
} from "./loader.js";
