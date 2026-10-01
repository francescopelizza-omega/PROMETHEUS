// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/index.ts — Tier R barrel (full_wrapper_compose Phase 1).
 *
 * The agent's read-only view of the machine: the tool DEFINITIONS plus the secret scrubber
 * every host must run their output through. Pure — no IO, no node — so both the CLI and
 * Studio import the same definitions and cannot drift the way `run_command` did.
 */

// Tier W — the file MUTATORS, exported separately so a host opts in deliberately (adding
// them to SYSTEM_TOOLS would hand them to the desktop pane, which cannot dispatch them).
export {
  SYSTEM_FS_WRITE_TOOLS,
  SYSTEM_FS_WRITE_TOOL_NAMES,
  DELETE_FILE_TOOL,
  MOVE_FILE_TOOL,
  MKDIR_TOOL,
  isFsWriteTool,
} from "./fs-mutate.js";

export {
  SYSTEM_READ_TOOLS,
  SYSTEM_TOOLS,
  RUN_COMMAND_TOOL,
  JOB_STATUS_TOOL,
  JOB_OUTPUT_TOOL,
  JOB_KILL_TOOL,
  PROPOSE_ELEVATED_TOOL,
  SYSTEM_READ_TOOL_NAMES,
  isSystemReadTool,
  ENV_ALLOWLIST,
  isEnvReadable,
  READ_FILE_TOOL,
  LIST_DIR_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  SEMANTIC_SEARCH_TOOL,
  STAT_PATH_TOOL,
  GIT_STATUS_TOOL,
  GIT_DIFF_TOOL,
  GIT_LOG_TOOL,
  GIT_SHOW_TOOL,
  SYSTEM_INFO_TOOL,
  GPU_INFO_TOOL,
  PROCESS_LIST_TOOL,
  WHICH_TOOL,
  PACKAGE_LIST_TOOL,
  ENV_GET_TOOL,
} from "./tools.js";

// Durable cross-session memory — kept separate for the same reason Tier W is: a host opts in
// deliberately, and both the renderer-side and main-side dispatch guards must admit them.
export {
  SYSTEM_MEMORY_TOOLS,
  SYSTEM_MEMORY_TOOL_NAMES,
  MEMORY_WRITE_TOOL,
  MEMORY_READ_TOOL,
  isMemoryTool,
} from "./memory.js";

export {
  redact,
  redactSecrets,
  mask,
  isSecretPath,
  secretPathReason,
  secretRefusal,
} from "./redact.js";
export type { Redaction, RedactResult, SecretKind } from "./redact.js";

export { checkElevated, elevatedCommandLine, renderElevated } from "./elevated.js";
export type { ElevatedProposal, ElevatedCheck } from "./elevated.js";

// The ONE membership list both a renderer-side guard and a main-side guard check, so that
// adding a tool cannot leave one of them behind (it did, for the Tier-W mutators).
export {
  HOST_DISPATCH_TOOLS,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  BROWSER_TOOLS,
  BROWSER_NAVIGATE_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_EXTRACT_TEXT_TOOL,
  isHostDispatchTool,
} from "./host-dispatch.js";
