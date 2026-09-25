/**
 * agent/index.ts — the universal REPL/GUI agent loop barrel (file 11 §3.2).
 *
 * The tunable agent both `prometheus chat` and the GUI agent pane drive — model + tool
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
  progressDigest,
} from "./auto-continue.js";
// WRAPPER Subsystem 3: remembered "don't ask again" grants (deny-priority) over the pure engine.
export type { GrantScope, Grant, AddResult } from "./scoped-permission.js";
export { ScopedPermissionStore, deriveSubject, isTooBroad } from "./scoped-permission.js";
// The seam that makes those grants LIVE — without it the store had no production caller.
export type {
  RememberedConfirmOptions,
  RefOf,
  PathsOf,
  ArgvOf,
} from "./remembered-confirm.js";
export { withRememberedGrants } from "./remembered-confirm.js";
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

// --- user-authored lifecycle hooks (PreToolUse / PostToolUse / SessionStart) -------- //
// PURE: the runner is injected (`agent/system/host/hook-runner.ts` is the node-backed one).
export type {
  HookDenial,
  HookEvent,
  HookInvocation,
  HookOutcome,
  HookRefusal,
  HookRunner,
  HookSpec,
} from "./hooks.js";
export {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  HOOK_OUTPUT_CAP_CHARS,
  HOOK_REFUSAL_HINT,
  SESSION_START_BLOCK_HEADER,
  firePostToolUseHooks,
  hookMatchesTool,
  hookRefusal,
  isHookSpec,
  matchingHooks,
  runPreToolUseHooks,
  runSessionStartHooks,
  sessionStartHookBlock,
  validateHooks,
} from "./hooks.js";

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

// --- the PRODUCER for those rules: a user `[permissions]` table (allow/ask/deny) --- //
export type { CompiledPermissionRules, PermissionRulesConfig } from "./permission-config.js";
export { compilePermissionRules } from "./permission-config.js";

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
  MAX_AUTH_LEVEL,
  UNSCOPED_AUTO_LEVEL,
  authDecision,
  authLevelLegend,
  authLevelMeta,
  authLevelName,
  authLevelToMode,
  authRunToDone,
  classifyAuth,
  modeToAuthLevel,
  parseAuthLevel,
  scopedWriteDecision,
} from "./authorization.js";
// --- human-readable elapsed-duration formatter (turn/subtask timing) ---------------- //
export { formatDuration } from "./duration.js";
// --- structured, line-numbered, word-level diff for the surgical edit card ----------- //
export type { WordSpan, DiffRow, DiffHunkView, EditView } from "./diff-view.js";
export { buildEditView } from "./diff-view.js";

// The "what will this actually change?" preview for the three mutators that had a DESCRIPTION
// and no preview: apply_patch, delete_file, move_file. A delete is modelled as a diff to the
// empty string so the host's existing edit card paints all three.
export type {
  MutationChange,
  MutationPreview,
  PendingCall,
  PreviewIo,
} from "./mutation-preview.js";
export {
  DELETE_DIR_SAMPLE,
  previewMutation,
  previewPaths,
  renderMutationPreview,
} from "./mutation-preview.js";

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
  estimateTextTokens,
  estimateTurnTokens,
  shouldCompact,
  shouldCompactTexts,
  sliceForCompaction,
} from "./compact.js";

// --- the doom-loop guard: same tool, same ARGS, above the broker -------------------- //
export type { RepeatVerdict } from "./repeat-guard.js";
export {
  DEFAULT_REPEAT_LIMIT,
  RepeatGuard,
  callFingerprint,
  repeatRefusal,
  stableStringify,
} from "./repeat-guard.js";

// --- what the agent REMEMBERS between turns (tool results, budgeted) ---------------- //
export type { CarryForwardOptions } from "./carry-forward.js";
export { ELISION, carryBudgetFor, carryForward } from "./carry-forward.js";

// --- file 14 E2: per-turn workspace checkpoint (exact revert incl. bash writes) ----- //
export type { Checkpoint, RestorePlan, SnapshotPolicy } from "./checkpoint.js";
export {
  CheckpointStore,
  changedPaths,
  checkpointSize,
  makeCheckpoint,
  restorePlan,
  shouldSnapshot,
} from "./checkpoint.js";

/**
 * file 14 §3.1 "modes-as-agents" — RETIRED.
 *
 * `modes.ts` held a second, parallel agent system (`AGENT_BUILD`/`AGENT_PLAN`/`SEED_AGENTS`
 * AgentDefs, a fail-open `agentFileToDef`, an `@mention` parser and duplicate tool
 * descriptors) that nothing outside this barrel and its own test ever imported, while the
 * plan-mode posture that IS wired lives in `permission-modes.ts`. Keeping both meant two
 * answers to "what does plan mode do". The unused half is deleted; the one live export
 * (`parseAgentFile`) moved next to its only consumer in `agent-files.ts`.
 */
export type { ParsedAgentFile } from "./agent-files.js";
export { parseAgentFile } from "./agent-files.js";

// full_wrapper_compose Phase 2: the exec core (parse → classify). Re-exported here so hosts
// reach it through the same `agent.*` namespace they already use for the ladder and the
// broker — a command's tier is an authorization concern, not a separate subsystem.
export {
  parseCommand,
  formatCommand,
  allStages,
  classifyCommand,
  describeCommand,
  execAuthDecision,
  PROGRAMS,
  FORBIDDEN,
  forbiddenReason,
  programSpec,
} from "./exec/index.js";
export type {
  ClassifyResult,
  ExecTier,
  ParsedCommand,
  ParseResult,
  Stage,
  StageClass,
} from "./exec/index.js";

// The host-dispatched system tools (Tier R + run_command) and the secret scrubber.
export {
  SYSTEM_FS_WRITE_TOOLS,
  SYSTEM_FS_WRITE_TOOL_NAMES,
  DELETE_FILE_TOOL,
  MOVE_FILE_TOOL,
  MKDIR_TOOL,
  isFsWriteTool,
  SYSTEM_TOOLS,
  PROPOSE_ELEVATED_TOOL,
  checkElevated,
  elevatedCommandLine,
  renderElevated,
  SYSTEM_READ_TOOLS,
  RUN_COMMAND_TOOL,
  ENV_ALLOWLIST,
  isEnvReadable,
  redactSecrets,
  isSecretPath,
} from "./system/index.js";

/**
 * How a model is TOLD about tools and how its calls are read back — schema rendering, the
 * budgeted prompt preamble, the text call protocol, and transport negotiation.
 *
 * Namespaced rather than flattened: `parseToolCalls` beside this file's existing `parseHunks`
 * reads as two halves of one thing when they are unrelated, and the surfaces that consume
 * this reach for the whole group at once (`agent.protocol.renderToolPreamble`).
 */
export * as protocol from "./protocol/index.js";
// The inactivity-pause primitive shared by CLI + Desktop — see idle-watchdog.ts's header.
export * as idleWatchdog from "./idle-watchdog.js";

// The structured task list the agent works to. `modes.ts` declared `todowrite`/`todoread`
// descriptors with no schema, no state and no dispatch; these are the real thing.
// Delegate a subtask to a scoped worker. The guards ARE the design — see the module header.
export type {
  SpawnDecision,
  SubagentBudget,
  SubagentOutcome,
  SubagentRole,
  RunTurn,
} from "./subagent.js";
export {
  DEFAULT_CHILD_ROUNDS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_SPAWNS,
  SPAWN_AGENT_TOOL,
  SUBAGENT_ROLES,
  canSpawn,
  childTuning,
  initialBudget,
  isSubagentRole,
  runSubagent,
} from "./subagent.js";

// Scheduled/autonomous runs: "run this task on this cron schedule, unattended, at a bounded
// autonomy level" — see that module's own header for why the ladder is part of the type.
export type {
  NextRunResult,
  ParsedCron,
  ScheduleAutonomy,
  ScheduledTask,
  ScheduleRunResult,
  ScheduleStore,
} from "./schedule.js";
export {
  cronMatches,
  isDue,
  mergeTask,
  nextRunAfter,
  nextRunAfterResult,
  parseCronExpr,
  removeTask,
  validateCronExpr,
} from "./schedule.js";

// web_search behind a provider seam — no provider means an honest failure, never a fake list.
export type {
  ProviderChoice,
  SearchProvider,
  SearchRequest,
  SearchResult,
} from "./search.js";
export {
  BRAVE,
  DDG_INSTANT,
  MAX_RESULTS,
  NO_PROVIDER_MESSAGE,
  SEARCH_KEY_ENV,
  SEARCH_PROVIDERS,
  TAVILY,
  WEB_SEARCH_TOOL,
  clampLimit,
  defaultProvider,
  findProvider,
  needsKey,
  renderResults,
  selectProvider,
} from "./search.js";

// User-defined sub-agent personas from markdown — clamped by SCOPE, not by trust.
export type { AgentFileScope, AgentFileRejection, LoadedAgent } from "./agent-files.js";
export {
  MAX_PERSONA_CHARS,
  agentNameFromFile,
  loadAgentFile,
  personaDeny,
  personaSystemPrompt,
} from "./agent-files.js";

// The agent asks the user instead of guessing — budgeted, and honest when nobody can answer.
export type { QuestionBudget } from "./question.js";
export {
  DEFAULT_MAX_QUESTIONS,
  NO_ASKER_MESSAGE,
  QUESTION_TOOL,
  canAsk,
  initialQuestionBudget,
  renderAnswer,
  renderQuestion,
} from "./question.js";

// One edit across N files, all of it or none of it.
export type { PatchFile, PatchResult, ResolvedFile, ReadFile } from "./patch.js";
export {
  APPLY_PATCH_TOOL,
  describePatch,
  parsePatchFiles,
  resolvePatch,
} from "./patch.js";

export type { TodoItem, TodoStatus } from "./todo.js";
export {
  MAX_TODOS,
  TODO_GLYPH,
  TODO_READ_TOOL,
  TODO_TOOLS,
  TODO_WRITE_TOOL,
  TodoStore,
  parseTodos,
  renderTodos,
  runTodoTool,
  todoSummary,
} from "./todo.js";

// The external-tool catalog + the ~100-token manifest the model is told about it. PURE (the
// probe that fills it in is in agent/system/host/host-tool-probe.ts) — see host-tools.ts for
// why this is a list of NAMES and not a set of tool schemas.
export {
  DEFAULT_EXTERNAL_TOOLS,
  EXTERNAL_TOOL_CHOICES,
  HOST_TOOLS,
  type ExternalToolDefaults,
  type HostTool,
  type HostToolStatus,
  installPackage,
  renderHostToolManifest,
  renderToolDefaults,
} from "./host-tools.js";
