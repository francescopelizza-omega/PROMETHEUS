/**
 * @prometheus/core — the shared domain layer for Prometheus Studio.
 *
 * Consumed by BOTH the desktop GUI and the prometheus CLI. It owns the domain models,
 * the C11 provider promotion policy + cost guardrails, the C8 ServerSupervisor
 * (main-process only), and the SHARED command registry that both surfaces render.
 *
 * It depends ONLY on @prometheus/engine-bridge (the single JS->engine gateway)
 * and Node built-ins. It re-exports the C3 verdict model from engine-bridge so
 * callers never reach past core. core itself NEVER spawns python3/nemesis.
 */

// --- domain models (re-exports the C3 verdict model from engine-bridge) ----- //
export type {
  // verdict model (C3), re-exported verbatim
  VerdictTier,
  Severity,
  Finding,
  SecurityVerdict,
  NemesisVerdictRef,
  GateBadge,
  ForcedDanger,
  // environments
  EnvKind,
  Env,
  Package,
  Template,
  CudaInfo,
  // models & hardware
  ModelKind,
  Quant,
  Model,
  LocalModel,
  GpuInfo,
  HardwareProfile,
  FitVerdict,
  FitScore,
  // serving
  ServeProfile,
  // catalog / repos
  Repo,
  CatalogItem,
  // providers
  IntegrationKind,
  BillingMode,
  ProviderTier,
  CostLight,
  ProviderWarn,
  Provider,
  CostGuardrail,
  ConnectorConfig,
} from "./domain/models.js";

// --- security: verdict display mapping + force/purge tokens (file 03 §3,§5) - //
// The ONLY verdict→display map (color/label/defaultAction/override) + the
// needsExplicitApproval helper (reads engine counts only — C5, no scoring), and
// the engine's exact `install-dangerous` token + the typed-name purge guard.
export type {
  ColorRole,
  DefaultAction,
  OverrideAffordance,
  VerdictDisplay,
  ApprovalCounts,
} from "./security/verdictMapping.js";
export {
  VERDICT_DISPLAY,
  verdictDisplay,
  verdictColor,
  verdictLabel,
  verdictDefaultAction,
  verdictOverride,
  isRefusedByDefault,
  needsExplicitApproval,
} from "./security/verdictMapping.js";
export {
  FORCE_TOKEN,
  matchesForceToken,
  purgeBasename,
  purgeNameMatches,
} from "./security/forceToken.js";

// --- provider promotion policy (C11) --------------------------------------- //
export type { PromotionContext, LocalaiRepointSuggestion } from "./providers/policy.js";
export {
  classifyTier,
  costLight,
  needsCostWarning,
  requiredConfirmPhrase,
  hasCoveringSubscription,
  sortByPromotion,
  localaiRepointSuggestion,
  parseProvider,
  loadProviders,
  loadProvidersSync,
  DEFAULT_PROVIDERS_CONFIG,
} from "./providers/policy.js";

// --- cost guardrails (C11) -------------------------------------------------- //
export type { GuardrailEvaluation } from "./providers/guardrails.js";
export { evaluateGuardrail, recordSpend, describeGuardrail } from "./providers/guardrails.js";

// --- model-aware pricing (CLI-058) ----------------------------------------- //
export type { ModelPrice, Pricing } from "./ai/providers/registry.js";
export { loadPricing, priceForModel, costOf } from "./ai/providers/registry.js";

// --- server supervisor (C8, main-process only) ----------------------------- //
export type {
  ServerState,
  SupervisedServer,
  ServerStatus,
  SupervisorEvents,
} from "./supervisor/registry.js";
export { ServerSupervisor, loadServeProfiles } from "./supervisor/registry.js";

// --- shared command registry ----------------------------------------------- //
export type {
  CommandGroup,
  CommandContext,
  CommandResult,
  ProviderRow,
  Command,
} from "./commands/registry.js";
export {
  COMMANDS,
  getCommand,
  listCommands,
  commandsByGroup,
  runCommandById,
} from "./commands/registry.js";

// --- env + package lifecycle (file 04 §7,§9) ------------------------------- //
// The framework-free per-row lifecycle state machine (pure reducer + selectors),
// the file-04 §2 richer Template/TemplatePkg the wizard edits, the CUDA-aware
// template→spec resolver (§7), and the batched-gate-plan shape (§6). NO react/
// zustand here — the Zustand binding lives in the desktop renderer.
export type {
  PkgState,
  PkgSource,
  TemplatePkg,
  Template as EnvTemplate,
  PkgEvent,
  PackageRow,
  EnvStoreState,
  ResolvedSpec,
  GatePlanItem,
  BatchedGatePlan,
} from "./env-store.js";
export {
  pkgTransition,
  canTransition,
  legalEvents,
  isBlockedTerminal,
  initialEnvStoreState,
  selectSelectedEnv,
  selectPackageRows,
  selectRowsByState,
  torchCudaIndex,
  templateResolve,
  batchedGatePlan,
} from "./env-store.js";

// --- shipped init-package templates (file 04 §7) --------------------------- //
export {
  BUILTIN_TEMPLATES,
  BUILTIN_TEMPLATE_IDS,
  getBuiltinTemplate,
} from "./templates/index.js";

// --- canonical command PARITY router (file 01 §11.3 / 11 §2+§5) ------------- //
// The single CommandSpec registry BOTH the GUI and `prometheus` route through, so
// parity is STRUCTURAL. Exported under `Router*` / `command*Spec` aliases so the
// new full-surface registry coexists with the M1 commands/registry.ts above
// (which keeps the hand-tuned scan/provider summaries) without name clashes.
export type {
  Surface,
  CommandGroup as RouterCommandGroup,
  EngineBinding,
  PrometheusSubcommand,
  NemesisVerb,
  ArgSpec,
  ArgsSchema,
  ParsedArgs,
  ValidationResult,
  RawArgs,
  RouterContext,
  RouterResult,
  CommandSpec,
  CommandHelp,
} from "./commands.js";
export {
  COMMAND_SPECS,
  validateArgs,
  invoke,
  rawArgs,
  engineTargets,
  coveredPrometheusSubcommands,
  getCommand as getCommandSpec,
  listCommands as listCommandSpecs,
  commandsByGroup as commandSpecsByGroup,
} from "./commands.js";

// --- model hub state (file 05 §1,§5,§7) ------------------------------------ //
// Framework-free (NO react/zustand; the renderer binds it): the §5 DOWNLOAD QUEUE
// state machine (queued→staging→scanning→admitted|blocked|quarantined, the verdict
// the REAL nemesis produced — C5), the LIBRARY CACHE indexed by id/modality, the
// SERVE-PROFILE status machine (stopped|starting|ready|error), the §6 open-weight-
// first sort-to-top, the §4.4 fit-rank ordering, and the §8 queue concurrency.
export type {
  DownloadState,
  DownloadEvent,
  DownloadItem,
  DownloadQueueState,
  LibraryCacheState,
  QuantFitRow,
  ServeStatus,
  ServeEvent,
  ServeProfileRow,
  ServeProfilesState,
} from "./modelhub/store.js";
export type {
  LocalaiAction,
  LocalaiEnvelope,
  LocalaiModelRow,
  LocalaiToolRow,
} from "./modelhub/localai.js";
export {
  LOCALAI_ENVELOPE_VERSION,
  isNewerLocalaiEnvelope,
  parseLocalaiEnvelope,
} from "./modelhub/localai.js";
export {
  // §5 download queue state machine
  downloadTransition,
  canDownloadTransition,
  legalDownloadEvents,
  isTerminalDownload,
  isBlockedDownload,
  isActiveDownload,
  scanEventForVerdict,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  initialDownloadQueueState,
  enqueueDownload,
  advance,
  removeDownload,
  selectQueue,
  selectActiveDownloads,
  selectQuarantined,
  availableSlots,
  selectStartable,
  // library cache
  initialLibraryCacheState,
  modalityBucket,
  upsertModels,
  removeFromLibrary,
  selectAllModels,
  selectInstalledModels,
  selectByModality,
  // §6 open-weight-first sort
  isFreeOpenWeight,
  sortOpenWeightFirst,
  // §4.4 fit-rank ordering
  fitRankSelector,
  // serve-profile status machine
  serveTransition,
  canServeTransition,
  legalServeEvents,
  initialServeProfilesState,
  upsertServeProfile,
  advanceServeProfile,
  removeServeProfile,
  selectServeProfiles,
  selectReadyServeProfiles,
  serveProfilesForModel,
} from "./modelhub/store.js";

// --- catalog manager (file 06 §2,§7 — repo/plugin/skill/agent/app/worldsim) - //
// The framework-free projection + reconciliation + cache layer the catalog browser
// (desktop) and `prometheus` CLI both render. PURE: engine list/info/matrix/where -> CatalogItem[]
// (OFFICIAL above EXTERNAL, ranked, ties-by-name; DOCUMENTED_ONLY -> installable:false in CORE,
// not just the UI — file 06 §0/§10), status/inventory -> InstallState (optimistic↔truth), the
// two-speed cache (registry by engine version+mtime, install-state by TTL), and the Repo-index
// projection (the `repo.py` sidecar is the on-disk index's SINGLE writer — core only shapes +
// reconciles). NOTHING decides "safe" (C5): it stores the engine's SIGNED verdict refs.
//
// `CatalogItem`/`Repo` already exist in domain/models.ts (the MINIMAL M1 scan row); the file-06
// richer shapes are surfaced under `Catalog*` aliases so both coexist without a clash.
export type {
  CatalogTier as CatalogManagerTier,
  CatalogKind,
  CatalogScope as CatalogManagerScope,
  ReachCell,
  CatalogComponent,
  CatalogItem as CatalogManagerItem,
  PerAgentState,
  InstallState,
  InstallTarget,
  RepoStatus,
  CatalogRepo,
  EngineListRow,
  EngineInfoPlugin,
  DocumentedEntry,
  MatrixReachRow,
  WhereTargetRow,
  AppTableOptions,
  StatusPluginBlock,
  StatusEnvelopeLike,
  OptimisticOp,
  EngineSignature,
  CatalogCacheOptions,
  SidecarRepoRow,
} from "./catalog/index.js";
export {
  // normalize
  listRowToItem,
  listToItems,
  infoComponents,
  infoToItem,
  mergeInfo,
  reachRowToMap,
  reachIndex,
  applyReach,
  whereTargets,
  documentedToItem,
  documentedToItems,
  appTableToItems,
  sortCatalog,
  buildPluginCatalog,
  // reconcile
  statusToInstallState,
  indexStatus,
  mergeState,
  reconcileItems,
  applyOptimistic,
  bindVerdict,
  // cache
  CatalogCache,
  createCatalogCache,
  sameSignature,
  DEFAULT_VOLATILE_TTL_MS,
  // repos
  repoVerdictRef,
  verdictCommit,
  toCatalogRepo,
  toCatalogRepos,
  isBlockedRepo,
  isCleanRepo,
  needsConfirmRepo,
  reposByCatalogItem,
  linkReposToItems,
  sortReposByFetched,
} from "./catalog/index.js";

// --- editor / IDE core (file 07 §3.1,§4,§5,§7,§8) -------------------------- //
// The PURE, framework-free editor logic (NO monaco/react/electron): the ChangeSet
// apply/reject engine (§7.4 — the riskiest core logic), the EDITOR command registry
// (§8, COMPOSES the engine router for prometheus.* ids — never duplicates it), the
// provider-agnostic AI client (§7 — thin OpenAI-compatible SSE client, cloud-policy
// guard, keychain-ref keys), and the LSP/DAP wire types + framing (§4/§5). Spawns
// nothing; decides nothing about "safe" (C5).

// ChangeSet apply/reject engine (§7.4)
export type {
  Hunk,
  FileEdit,
  ChangeSet,
  FilePlanSummary,
  ChangeSetSummary,
} from "./editor/changeset.js";
export {
  computeHunks,
  applyChangeSet,
  applyFileEditFully,
  acceptAll,
  rejectAll,
  acceptHunk,
  summarizeChangeSet,
  fileEditFromTexts,
} from "./editor/changeset.js";

// EDITOR command registry (§8)
export type {
  EditorCommandCategory,
  EditorCommandCtx,
  EditorCommandResult,
  EditorCommand,
} from "./editor/command-registry.js";
export {
  EDITOR_COMMANDS,
  EditorCommandRegistry,
  evaluateWhen,
  getEditorCommand,
  listEditorCommands,
  editorCommandsByCategory,
} from "./editor/command-registry.js";

// smart keys + the clipboard ring (APP-018 — ⇧⌘⏎ complete-statement / smart-enter
// / ⌘⇧V ring math). Also served via the pure `@prometheus/core/editor` subpath
// (the C5 renderer may import THAT, never this node-evaluating root barrel).
export type {
  SmartPosition,
  SmartEdit,
  SmartKeyResult,
  SmartEnterContext,
} from "./editor/smart-keys.js";
export {
  completeStatement,
  smartEnterEdit,
  CLIP_RING_CAP,
  clipPush,
  clipCycle,
} from "./editor/smart-keys.js";

// new-file + copyright-header templates (APP-028 — the editor Generate menu; pure,
// also served via the `@prometheus/core/editor` subpath for the C5 renderer)
export type { TemplateKind, TemplateVars } from "./editor/templates.js";
export {
  TEMPLATE_KINDS,
  copyrightHeader,
  fileTemplate,
  headerInsertLine,
  templateKindForLanguage,
} from "./editor/templates.js";

// provider-agnostic AI client (§7)
export type {
  EndpointLocality,
  AiEndpoint,
  WorkspacePolicy,
  Msg,
  ChatOpts,
  ChatChunk,
  InlineEditReq,
  EditChunk,
  FetchLike,
  KeyResolver,
  AiClientDeps,
  AiClient,
  SseTokenUsage,
} from "./ai/client.js";
export type { ContextWindowResult, ContextWindowSource } from "./ai/context-window.js";
export {
  DEFAULT_CONTEXT_WINDOW,
  CONTEXT_PROBE_AWAIT_MS,
  probeContextWindow,
  contextFromOllamaShow,
  contextFromModelsEntry,
  capabilitiesFromOllamaShow,
  revisionFromOllamaShow,
} from "./ai/context-window.js";
export type { LocalRunnerSpec } from "./ai/local-runners.js";
export {
  LOCAL_RUNNERS,
  runnerForBaseUrl,
  runnerById,
  portOf as localRunnerPortOf,
  isLocalUrl,
  localKeepAlive,
  localKeepAliveField,
} from "./ai/local-runners.js";
export type { EnsureOllamaOptions, EnsureOllamaResult } from "./ai/ollama-autostart.js";
export { ensureLmStudioRunning, ensureOllamaRunning } from "./ai/ollama-autostart.js";
export type {
  EndpointProbe,
  EndpointProbeDeps,
  EndpointProbeOutcome,
} from "./ai/endpoint-probe.js";
export { createEndpointProbe, PROBE_CACHE_TTL_MS } from "./ai/endpoint-probe.js";
export type {
  ContextWindowOrigin,
  EndpointHealthRecord,
  ModelHealthStore,
  TransportMode,
} from "./ai/model-health.js";
export {
  NO_BREAKER_SNAPSHOT,
  buildHealthRecord,
  describeBreaker,
  describeContextWindow,
  describeTransport,
  formatHealthTable,
  mergeHealthRecord,
  parseEndpointHealthRecord,
} from "./ai/model-health.js";
export {
  createAiClient,
  CloudPolicyError,
  ModelIdlePausedError,
  parseSseChunk,
  deltaFromPayload,
  // Exported so a host driving its OWN SSE loop (the CLI's native tool transport does, to
  // reassemble `delta.tool_calls`) accounts tokens with the SAME parser as `createAiClient`
  // instead of a second copy that drifts. Its absence here is why agentic turns were the only
  // turns with no cost accounting at all.
  usageFromPayload,
  joinUrl,
  endpointAllowed,
} from "./ai/client.js";

// LSP wire types + JSON-RPC framing (§4)
export type {
  RpcId,
  RpcRequest,
  RpcNotification,
  RpcError,
  RpcResponse,
  RpcMessage,
  LspPosition,
  LspRange,
  TextDocumentIdentifier,
  DiagnosticSeverity,
  LspDiagnostic,
  PublishDiagnosticsParams,
  InitializeParams,
  DecodedFrame,
} from "./lsp/protocol.js";
export {
  RPC_ERROR,
  encodeMessage,
  decodeMessage,
  MessageReader,
  makeIdGenerator,
  makeRequest,
  makeNotification,
  makeCancel,
  isResponse,
  isNotification,
  isServerRequest,
  makeResponse,
  makeErrorResponse,
} from "./lsp/protocol.js";

// LSP server registry (§4.1)
export type { LspWorkspace, ServerSourcing, LspServerSpec } from "./lsp/servers.js";
export {
  SERVERS,
  supportedLanguages,
  serverFor,
  serverIdFor,
  requiresGateBeforeDownload,
  initOptionsFor,
} from "./lsp/servers.js";

// DAP wire types + framing (§5)
export type {
  DapProtocolMessage,
  DapRequest,
  DapResponse,
  DapEvent,
  DapMessage,
  DebugConfig,
  SourceBreakpoint,
  SetBreakpointsArguments,
  ExceptionBreakpointsFilter,
  SetExceptionBreakpointsArguments,
  DapCapabilities,
  StoppedEventBody,
  OutputEventBody,
  DecodedDapFrame,
} from "./dap/protocol.js";
export {
  encodeDapMessage,
  decodeDapMessage,
  DapMessageReader,
  makeSeqGenerator,
  makeDapRequest,
  isDapEvent,
  isDapResponse,
} from "./dap/protocol.js";

// --- extensibility: MCP host/server, extensions, secrets, settings (file 09) ---
// Namespaced barrels — each cluster is large and a couple of names (e.g. ValidationResult,
// RunResult) would clash with the flat exports above, so they're surfaced under stable
// namespaces. All PURE: SDK / keytar / Electron / unzip live behind injected seams.
//   mcpServer — the embedded server's 19-tool catalog + runner + isError policy (§1/§3)
//   mcpHost   — Studio as an MCP client: manager + gate + policy + importers (§2)
//   ext       — the extension API: manifest + permissions + loader + context (§5)
//   secrets   — OS-keychain secret store + stderr redaction (§7.2)
//   settings  — config layering + the built-in profiles (§7.1)
export * as mcpServer from "./mcp/server/index.js";
export * as mcpHost from "./mcp/host/index.js";
/**
 * `agents/` is INTERNAL — no longer re-exported as a public namespace.
 *
 * It was `export * as agents`, which advertised a surface nobody could drive: the barrel's
 * headline items were a second ReAct loop (`runAgent`) and its dispatcher/supervisor, whose
 * `ToolCall` is `{ref}` where the live loop's is `{name}` — not assignable, and callable only
 * from its own tests. Those two modules are gone. What remains is genuinely load-bearing and
 * is imported directly by the modules that need it, which is the honest shape for it:
 *   - `toolBroker.brokerDecision` IS the §4.3 broker in `agent/loop.ts`;
 *   - `sandbox.isPathAllowed` / `globMatch` / `globToRegExp` back ext permissions, scopes,
 *     checkpoints, local history and hooks;
 *   - `types.ModelRef` and the `AgentDef` family are used across repl, profiles and modes.
 */
export * as ext from "./ext/index.js";
export * as secrets from "./secrets/index.js";
// top-level type re-exports so CLI/desktop can implement a SecretsStore without the namespace.
export type { SecretsStore, SafeStorageBackend } from "./secrets/keychain.js";
export * as settings from "./settings/index.js";

// --- prometheus CLI/TUI brain (file 11): the tunable agent loop, the TOML profiles, and
//     the REPL state machine. All PURE + framework-free (no ink/yargs/react) — the
//     SAME modules apps/desktop's agent pane uses; apps/cli adds only the Ink shell.
//   agent       — §3.2 runAgentTurn + AgentTuning + the 14-tool exposure (never-force)
//   cliProfiles — §6 TOML profiles (default/local-safe/ci/airgapped) + resolveTuning
//   repl        — §3.1/§7 slash registry + REPL reducer + footer + keymap + panes
export * as agent from "./agent/index.js";
export * as cliProfiles from "./cli-profiles/index.js";
export * as repl from "./repl/index.js";

// --- AI integrations + billing (file 12): the 3-tier promotion hierarchy ----- //
// A local/free (default) · B subscription-included (bounded) · C metered (warned).
// Namespaced as `ai` because its richer, billing-aware vocabulary (CostLight,
// BillingMode, ConnectorConfig, CostGuardrail) intentionally OVERLAPS the leaner C11
// domain/models.ts flat exports above; they must not collide. The thin HTTP client
// stays flat at top-level (`createAiClient`) — this layer is config + policy + wiring.
//   ai.providers   — the data-driven matrix + tier/light/warn policy + brain resolver
//   ai.connectors  — the 4 connector kinds (local-serve/oauth/cli/api-key) as builders
//   ai.guardrails  — the metered-spend control subsystem (estimate → enforce → meter)
//   ai.repoint     — the localai "run it free locally" escape hatch (§6)
export * as ai from "./ai/index.js";

// --- IDE terminal launcher UX (file 13 Area 1) ----------------------------- //
// Pure profiles + AI presets (§1.3/§1.4), venv-activated spawn-arg resolution (§1.5),
// the session-list reducer + broadcast + "session, not process" persistence (§1.7),
// and the §1.8 command catalog. Namespaced `terminal`: spawning is 07's pty-host (the
// engine room); this is the cockpit. Its `TerminalProfile`/`IdeCommand` are file-13
// vocabulary, kept off the flat surface to avoid any clash.
export * as terminal from "./terminal/index.js";

// --- Local History + Scopes (file 13 §2.6) --------------------------------- //
// Pure, git-independent file-snapshot timeline (capped ring + capture policy +
// line-delta + serialize; persistence is the caller's) and named file-glob Scopes +
// Favorites/Bookmarks (glob matching reuses 07/09's globMatch). Namespaced.
export * as localHistory from "./local-history/index.js";
export * as scopes from "./scopes/index.js";

// --- opencode/PyCharm parity gap-closure (file 14) ------------------------- //
// PURE additions: markdown command-file loader (§3.2), AGENTS.md/CLAUDE.md rules
// precedence chain + /init (§3.3), and the formatter registry + format-on-save policy
// (§3.5). Namespaced; each exec/fetch sink the caller wires still crosses the gate (C12).
export * as commandLoader from "./commands/loader.js";
// The gate that decides what a user-defined command file may READ and RUN, keyed on provenance.
export * as commandGate from "./commands/gate.js";
export * as rules from "./rules/index.js";
export * as format from "./format/index.js";

// --- Agent memory: durable cross-session facts, project-scoped -------------- //
// PURE parse/validate/assemble for `~/.prometheus/memory/<project-key>/*.md`; the host
// (agent/system/host/memory-store.ts) owns discovery + fs + the project-key derivation.
export * as memory from "./memory/index.js";

// --- /demos multi-CLI agent orchestration (the swarm) ---------------------- //
// PURE engine: topology + message bus + directive protocol + runaway guards + the
// recursive coordinator. Backends (the only IO — vendor CLI / local model) are injected
// by apps/cli. Orchestrator ↔ subagents ↔ child-subagents all communicate on the bus.
export * as orchestration from "./orchestration/index.js";

// --- Reliability & Polish pack: durability/stability/health primitives ----- //
// resilience: retry+backoff+jitter, circuit breaker, timeout (wrap flaky deps).
// health:     fold component statuses into a SystemHealth (tier + 0–100 score).
// migrations: versioned, idempotent, fail-soft state evolution across upgrades.
// All pure; clock/rng/timer injected for deterministic tests.
export * as resilience from "./resilience/index.js";
export * as health from "./health/index.js";
export * as migrations from "./migrations/index.js";
// stretch: AirLLM/offload technique registry + feasibility assessor (run a too-big model).
export * as stretch from "./stretch/index.js";
// tokenEconomy: curated token-saving toolkit (proposed by default) + Gemini-Nano feasibility.
export * as tokenEconomy from "./token-economy/index.js";

// --- updates: vendor-CLI version checks, local-model (Ollama) update detection, --- //
// and Prometheus self-update (propose a copyable command, never auto-swap). PURE —
// the IO (fetch/spawn) is injected by apps/cli. See packages/core/src/updates/.
export * as updates from "./updates/index.js";

// --- build/dist: telemetry (§8) + version reconcile (§5) (file 10) ---------- //
// Local-first, opt-in, scrubbed telemetry (off by default) + the About-panel
// version triple (Studio · Engine · Nemesis DB). Pure; sinks are injected.
export type { StudioEvent, StudioEventRecord, TelemetryDeps, Telemetry } from "./telemetry.js";
export { eventsLogPath, scrub, createTelemetry } from "./telemetry.js";
export type { EngineVersionFile, VersionInfo } from "./version.js";
export { parseEngineVersion, reconcileVersions, formatAbout } from "./version.js";
export type { UpdateChannel } from "./update-policy.js";
export {
  channelForTag,
  isPrerelease,
  stagedRolloutAllows,
  AUTO_DOWNLOAD,
  AUTO_INSTALL,
} from "./update-policy.js";
