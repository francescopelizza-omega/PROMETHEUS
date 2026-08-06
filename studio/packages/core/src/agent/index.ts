/**
 * agent/index.ts — the universal REPL/GUI agent loop barrel (file 11 §3.2).
 *
 * The tunable agent both `prom chat` and the GUI agent pane drive — model + tool
 * runner injected, the same 14-tool catalog, the same never-force + gate-first
 * invariants. PURE (no ink/react/node-only beyond the injected bridge interface).
 */
export type { ToolName, AgentToolPolicy } from "./tools.js";
export { exposedTools, exposedToolNames, isForceArg, stripForce } from "./tools.js";
// CLI-010: the propose_edit tool + its pure exact-match applier + line-diff helper.
export type { EditHunk, ApplyEditResult, DiffLine } from "./edit.js";
export {
  PROPOSE_EDIT_TOOL,
  WRITE_FILE_TOOL,
  applyProposedEdit,
  diffHunk,
  parseHunks,
  parseHunksResult,
} from "./edit.js";
// WRAPPER Phase A: the deterministic fallback ladder + post-apply verify + retry-hint diagnoser.
export type { Rung, ResolveResult, ResolveOptions } from "./ladder.js";
export { RUNGS, resolveHunk } from "./ladder.js";
export type { Balance, VerifyResult } from "./verify.js";
export { balanceScore, changedLineRange, verifyEdit } from "./verify.js";
export type { RetryHint } from "./diagnose.js";
export { diagnoseFailedEdit } from "./diagnose.js";
export type { EditIntent } from "./extract.js";
export { extractEditIntents, pathCandidate } from "./extract.js";
// WRAPPER Subsystem 3: run-to-done (yolo) auto-continue decision core.
export type {
  AutoContinueBudget,
  AutoContinueState,
  AutoDecision,
  AutoContinueInput,
} from "./auto-continue.js";
export {
  DEFAULT_AUTO_CONTINUE_BUDGET,
  decideAutoContinue,
  initAutoContinue,
  observeEvent,
} from "./auto-continue.js";
// WRAPPER Subsystem 3: remembered "don't ask again" grants (deny-priority) over the pure engine.
export type { GrantScope, Grant, AddResult } from "./scoped-permission.js";
export { ScopedPermissionStore, deriveSubject, isTooBroad } from "./scoped-permission.js";
// CLI-011: the web_fetch tool (dispatched locally via the safeFetch L6 proxy).
export { WEB_FETCH_TOOL } from "./web.js";
export type { GateVerdictTier, AgentEvent } from "./events.js";
export type {
  AgentTuning,
  ToolCall,
  ThreadMessage,
  Thread,
  LlmTurn,
  LLMClient,
  ToolOutcome,
  ToolRunner,
  AgentTurnDeps,
  ConfirmResult,
} from "./loop.js";
export {
  runAgentTurn,
  defaultTuning,
  capBytes,
  DEFAULT_MAX_ROUNDS,
  TOOL_OUTPUT_CAP_BYTES,
} from "./loop.js";

// --- file 14 §3.4: user-editable permission/approval engine (ToolBroker pre-filter) -- //
// Autonomy policy ONLY — an `allow` here never bypasses the nemesis gate (C5).
export type {
  PermissionDecision,
  PermissionRule,
  PermissionInput,
  PermissionContext,
  PermissionResult,
} from "./permission-engine.js";
export {
  doomLoopRunLength,
  evaluatePermission,
  isExternalPath,
  isProtectedEnvFile,
  matchBashPattern,
  matchRef,
  permissionEngine,
  shellWords,
} from "./permission-engine.js";

// --- Claude-parity permission MODES (default/acceptEdits/plan/bypass) over §3.4 ----- //
export type {
  PermissionModeId,
  PermissionModeMeta,
  PlanRefusal,
  ToolClass,
  ToolEffect,
} from "./permission-modes.js";
export {
  AUDIT_LINE_MAX_BYTES,
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  PERMISSION_MODE_CYCLE,
  PLAN_REFUSAL_HINT,
  classifyTool,
  cyclePermissionMode,
  decideToolForMode,
  formatAuditLine,
  isRunToDoneMode,
  permissionModeIndicator,
  permissionModeMeta,
  permissionModePolicy,
  planModeRefusal,
} from "./permission-modes.js";
// --- the --authorisation(s) autonomy scale (0–7) ------------------------------------ //
export type { AuthCategory, AuthLevelMeta, AuthToolEffect } from "./authorization.js";
export {
  AUTH_LEVELS,
  DEFAULT_AUTH_LEVEL,
  authDecision,
  authLevelLegend,
  authLevelMeta,
  authLevelName,
  authLevelToMode,
  authRunToDone,
  classifyAuth,
  modeToAuthLevel,
  parseAuthLevel,
} from "./authorization.js";
// --- human-readable elapsed-duration formatter (turn/subtask timing) ---------------- //
export { formatDuration } from "./duration.js";
// --- structured, line-numbered, word-level diff for the surgical edit card ----------- //
export type { WordSpan, DiffRow, DiffHunkView, EditView } from "./diff-view.js";
export { buildEditView } from "./diff-view.js";

// --- file 14 §3.10: named/searchable/resumable session store (shared GUI+CLI) ------- //
export type { Session, SessionTurn, SessionQuery } from "./session-store.js";
export {
  appendTurn,
  createSession,
  deserializeSession,
  renameSession,
  revertTargetFor,
  searchSessions as searchSessionStore,
  serializeSession,
  truncateAfter,
} from "./session-store.js";

// --- file 14 §3.11: autocompact + session-event bus --------------------------------- //
export type {
  CompactPolicy,
  CompactResult,
  SessionEvent,
  SessionEventKind,
  Summarizer,
} from "./compact.js";
export {
  SessionEventBus,
  compact,
  compactionSlices,
  estimateTokens,
  estimateTurnTokens,
  shouldCompact,
} from "./compact.js";

// --- file 14 E2: per-turn workspace checkpoint (exact revert incl. bash writes) ----- //
export type { Checkpoint, RestorePlan, SnapshotPolicy } from "./checkpoint.js";
export {
  CheckpointStore,
  changedPaths,
  makeCheckpoint,
  restorePlan,
  shouldSnapshot,
} from "./checkpoint.js";

// --- file 14 §3.1: modes-as-agents (Plan/Build + roster + @-mention + extra tools) -- //
export type { AgentExtraTool, AgentModeId, ParsedAgentFile } from "./modes.js";
export {
  AGENT_BUILD,
  AGENT_EXPLORE,
  AGENT_EXTRA_TOOLS,
  AGENT_PLAN,
  AGENT_SCOUT,
  DEFAULT_AGENT_ID,
  SEED_AGENTS,
  TOOL_QUESTION,
  TOOL_TODOREAD,
  TOOL_TODOWRITE,
  agentFileToDef,
  getAgent,
  parseAgentFile,
  parseMention,
  parseModelRef,
} from "./modes.js";
