/**
 * agent/system/host/index.ts — the SHARED host implementation of the system tools (Phase 6).
 *
 * Moved here from `apps/cli/src/session/` so the CLI and Studio run ONE implementation
 * instead of two. Before this, Studio had its own four tool definitions and its own
 * executor: `spawn(shell, ["-c", command])` guarded by an 11-pattern regex denylist. The
 * CLI had the six-layer stack. Same product, same model, two very different answers to
 * "what happens when the agent wants to run something" — and the weaker one was the GUI,
 * which is the surface most people use.
 *
 * NODE-DEPENDENT, unlike the rest of `agent/system`. The tool DEFINITIONS stay node-free in
 * `../tools.js` so the C5-sandboxed renderer can import the list; this half runs in a main
 * process (Electron) or the CLI process, and the renderer reaches it over IPC.
 */

export {
  runSystemTool,
  isSecretPath,
  execVarsFromEnv,
  // Shared with the other agent hosts so the untrusted-file-data frame is ONE implementation:
  // the VS Code extension had none at all, which is exactly how a protection drifts.
  frameFileContent,
  FILE_CONTENT_TOOLS,
  type SystemToolDeps,
} from "./system-tools.js";
export {
  runParsedCommand,
  type ExecPipelineResult,
  type RunPipelineOptions,
} from "./exec-runner.js";
export {
  describeJob,
  getJob,
  killAllJobs,
  killJob,
  listJobs,
  resetJobs,
  runningJobCount,
  startJob,
  type JobRecord,
  type JobState,
} from "./exec-jobs.js";
export {
  appendExecAudit,
  execAuditEntry,
  execAuditPath,
  resetScanCache,
  scanCommand,
  verdictBlocks,
  type ExecAuditEntry,
  type ExecDecision,
} from "./exec-gate.js";
// The canary tripwire's audit trail (point 6b) — see `agent/canary.ts` for the mechanism itself.
export { appendCanaryAudit, canaryAuditPath } from "./canary-audit.js";
export { makeStreamSink, type StreamSink } from "./exec-stream.js";
// The OS-level confinement applied to an already-approved `run_command` — macOS Seatbelt and
// Linux bubblewrap. Read exec-sandbox.ts's header for the precise list of what each does and
// does not restrict, and for the fail-closed vs honest-absence rule.
export {
  BWRAP_CANDIDATES,
  SEATBELT_BIN,
  authAllowsNetwork,
  buildBwrapArgs,
  buildSeatbeltProfile,
  describeSandbox,
  planExecSandbox,
  sandboxArgv,
  sandboxHint,
  type BwrapPlan,
  type SandboxMode,
  type SandboxPlan,
  type SandboxRequest,
  type SeatbeltPlan,
} from "./exec-sandbox.js";
export {
  createHookRunner,
  hookShell,
  type HookChildLike,
  type HookRunnerOptions,
  type HookSpawnLike,
} from "./hook-runner.js";
export {
  resolveEffectiveHooks,
  type HookRefusal,
  type ResolvedHooks,
} from "./hooks-trust.js";
export {
  createWorkingSet,
  expandHome,
  scopedAbsolute,
  isPathAllowed,
  pathArgsOf,
  resolveDir,
  type ResolveResult,
  type WorkingSet,
} from "./working-set.js";
export {
  OWN_WORKSPACE_NAME,
  findOwnWorkspaceRoot,
  guardCwd,
  isInsideRepo,
  type CwdGuardResult,
  type PackageJsonFs,
} from "./own-repo-guard.js";

/* ── the reaper: nothing this process started outlives it ────────────────────*/
export {
  installChildReaper,
  trackChild,
  trackedChildren,
  signalTracked,
  setRegistryDelegate,
  OWNER_PID_ENV,
} from "./reaper/child-reaper.js";
export type { RegistryDelegate } from "./reaper/child-reaper.js";
export { bootOrphanGuard, stopSentinel } from "./reaper/orphan-guard-boot.js";

/** The home root both hosts write the exec audit under. */
export { prometheusHome } from "./home.js";

// `semantic_search` — real local-embedding search with an explicitly-labeled lexical fallback
// (see the file header for exactly what "real" and "fallback" mean here). Exported so a host
// (or a test) can call the pieces directly rather than only through `runSystemTool`.
export {
  DEFAULT_EMBED_MODEL,
  OLLAMA_BASE_URL,
  bm25Search,
  cosineSimilarity,
  defaultOllamaEmbedder,
  semanticSearchTool,
} from "./semantic-index.js";
export type { Chunk, EmbedFn, ScoredChunk, SemanticSearchDeps } from "./semantic-index.js";

// Tier W: the file mutators, shared by both hosts (they were CLI-local, so the desktop had none).
export type { FsMutateDeps, FsPreImage } from "./fs-mutate-host.js";
export {
  deleteFileTool,
  mkdirTool,
  moveFileTool,
  readTextExact,
  runFsMutateTool,
} from "./fs-mutate-host.js";

// web_fetch / web_search through the L6 proxy — were CLI-local, so the GUI had no network.
export type { SafeFetchLike, WebToolOptions } from "./web-tools.js";
export {
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_TIMEOUT_SEC,
  capUtf8,
  runWebTool,
  webFetchTool,
  webSearchTool,
} from "./web-tools.js";

// browser_navigate / browser_screenshot / browser_extract_text — desktop-only (no CLI browser),
// scoped MVP (navigate + look + read; no click/type — see browser-tools.ts's header).
export type {
  BrowserExtractResult,
  BrowserHostDeps,
  BrowserNavigateResult,
  BrowserScreenshotResult,
} from "./browser-tools.js";
export {
  BROWSER_PREFLIGHT_MAX_BYTES,
  BROWSER_PREFLIGHT_TIMEOUT_SEC,
  runBrowserTool,
} from "./browser-tools.js";

// The `prometheus_*` verbs — the product's own surface, which the desktop pane could not
// reach at all. Shared so the nemesis verdict is lifted off the envelope in exactly one place.
export type { RunPrometheus } from "./engine-verb.js";
export { runEngineVerb, summarizeEnvelope, verdictFromEnvelope } from "./engine-verb.js";

// Remembered grants, on disk, shared by BOTH surfaces (it was CLI-only).
export { grantsPath, loadGrantsInto, readGrants, saveGrants } from "./grants-store.js";

// The OS keychain, shared by both surfaces (it was CLI-only, so the GUI could not
// authenticate to any cloud provider).
export type { CliSecretsDeps, SecretSpawn, SpawnResult } from "./os-keychain.js";
export { createCliSecretsStore } from "./os-keychain.js";

// The user's `[permissions]` table — the producer the §3.4 rule engine never had.
export { loadPermissionRules, readPermissionsTable } from "./permission-rules.js";

// Durable cross-session memory (`memory_write`/`memory_read`), shared by BOTH surfaces —
// see the file header for the on-disk layout and the project-key derivation.
export {
  loadMemoryIndexBlock,
  memoryDir,
  memoryProjectRoot,
  projectKey,
  readMemoryEntry,
  runMemoryTool,
  writeMemoryEntry,
} from "./memory-store.js";

// The node-backed filesystem seam behind `previewMutation` — the "what will this delete /
// overwrite / patch?" card the three destructive mutators had no way to draw. Binary-safe,
// size-capped, and it never follows a symlink out of the tree it is describing.
export { PREVIEW_MAX_BYTES, PREVIEW_MAX_ENTRIES, nodePreviewIo } from "./preview-io.js";

// The external-tool inventory: which of `HOST_TOOLS` are on PATH. Pure `access(X_OK)`, never a
// spawn, cached for the process — an inventory consulted once per turn cannot afford fourteen
// forks per turn on this machine (CLAUDE.md §2.3). It also repairs a GUI-launched PATH, which
// is why it sees the Homebrew tools that `whichTool` reports as missing.
// `lookPathAll` is the same walk without the early return: it answers "what ELSE is installed
// under this name", which is what makes a shadowed second copy visible at all.
export {
  clearHostToolCache,
  lookPath,
  lookPathAll,
  probeHostTools,
  searchPath,
} from "./host-tool-probe.js";
