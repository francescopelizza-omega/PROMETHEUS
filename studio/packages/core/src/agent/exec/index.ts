// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/exec/index.ts — the exec core (full_wrapper_compose Phase 2).
 *
 * Parse → classify. Both PURE, so the security-critical half of "let the agent run commands"
 * is unit-testable with no spawn and shared by every host. The runner that actually spawns
 * lives in the host (the CLI's `session/exec-runner.ts`), because `child_process` belongs to
 * engine-bridge (C5).
 */
export {
  parseCommand,
  allStages,
  formatCommand,
} from "./parse.js";
export type {
  ParsedCommand,
  ParseFailure,
  ParseOptions,
  ParseResult,
  Pipeline,
  Redirect,
  SequencedPipeline,
  Sequencing,
  Stage,
} from "./parse.js";

export {
  classifyCommand,
  describeCommand,
  execAuthDecision,
} from "./classify.js";
export type { ClassifyResult, StageClass } from "./classify.js";

export { PROGRAMS, FORBIDDEN, basename, forbiddenReason, programSpec } from "./registry.js";
export { shellQuote } from "./parse.js";
export type { DeniedFlag, ExecTier, ProgramSpec } from "./registry.js";

/** Layer 6 — the catastrophic-pattern denylist, shared by both hosts (Phase 6). */
export { screenCommand, MAX_SCREENED_LENGTH } from "./screen.js";
export type { CommandScreen } from "./screen.js";
