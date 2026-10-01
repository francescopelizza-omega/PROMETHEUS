// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shared/ipc-contract.ts — the typed contextBridge IPC seam (C5).
 *
 * This is the SINGLE source of truth for every channel name + request/response
 * shape that crosses the Electron process boundary. It is imported by all three
 * processes:
 *   - main/ipc.ts   registers `ipcMain.handle(<channel>, handler)`,
 *   - preload/index.ts wires `ipcRenderer.invoke(<channel>, …)` behind the
 *     contextBridge so the sandboxed renderer never touches Node,
 *   - renderer (window.d.ts) gets the typed `window.prometheus` surface.
 *
 * It contains ZERO runtime behaviour and ZERO Node/Electron imports, so it is
 * safe to bundle into the sandboxed renderer. The renderer only ever sees the
 * PLAIN DATA shapes declared here — never a live EngineClient, never a child
 * process, never `node:*`. All privileged work happens in the MAIN process.
 *
 * GOLDEN RULE (C5): the renderer cannot decide "safe". Every security answer it
 * receives is a verdict the MAIN process obtained from engine-bridge / nemesis.
 * A failed/timed-out/unparseable scan surfaces here as `verdict: "error"` (a
 * fail-closed BLOCK), never as a silent allow.
 */

import type {
  CatalogItem,
  CatalogManagerItem,
  CostLight,
  ProviderTier,
  RepoStatus,
  ServerStatus,
  agent,
} from "@prometheus/core";
import type {
  AuditLogEntry,
  NemesisVerdict,
  NemesisVerdictRef,
  SecurityVerdict,
  Severity,
  ThreatDbStatus,
  TrustedSource,
  VerdictTier,
} from "@prometheus/engine-bridge";

/* ── channel names ─────────────────────────────────────────────────────────
 * One const per channel. Using a const object (not a bare string union) means
 * main + preload reference the exact same literal, so a rename is a compile
 * error on every side instead of a silent dead channel.
 */
export const IPC = {
  scan: "prometheus:scan",
  gate: "prometheus:gate",
  list: "prometheus:list",
  info: "prometheus:info",
  providers: "prometheus:providers",
  envList: "prometheus:env.list",
  modelHw: "prometheus:model.hw",
  servers: "prometheus:servers.list",
  serverStart: "prometheus:servers.start",
  serverStop: "prometheus:servers.stop",
  // ── added for the full preload surface (file 01 §5) ──────────────────────
  install: "prometheus:install",
  version: "prometheus:version",
  // ── added for the full PrometheusApi (file 02 §6) ────────────────────────
  health: "prometheus:health",
  audit: "prometheus:audit",
  status: "prometheus:status",
  where: "prometheus:where",
  matrix: "prometheus:matrix",
  uninstall: "prometheus:uninstall",
  enable: "prometheus:enable",
  disable: "prometheus:disable",
  // ── the file 03 §5,§7 security surface (the FULL nemesis.verdict/1 path) ──
  // These carry the RICH NemesisVerdict the security UI renders, distinct from
  // the lightweight `prometheus:gate` above (which feeds the title-bar badge).
  securityGate: "security:gate",
  securityGateFull: "security:gateFull",
  securityAudit: "security:audit",
  securityInstall: "security:install",
  /** §9c: run ONE model chat turn in MAIN (see AiStreamRequest for why not the renderer). */
  aiStream: "ai:stream",
  /** cancel an in-flight `ai:stream` by runId. */
  aiCancel: "ai:cancel",
  /** Task #18: probe a LOCAL runner's served models in MAIN (see AiProbeModelsResult). */
  aiProbeModels: "ai:probeModels",
  /** Measure ONE local model — real context window + runner capabilities (see
   *  AiProbeEndpointResult). Same MAIN detour, same CSP reason as `ai:probeModels`. */
  aiProbeEndpoint: "ai:probeEndpoint",
  /** Scan THIS machine for local model servers (see AiDiscoverRunnersResult). */
  aiDiscoverRunners: "ai:discoverRunners",
  /** The external-tool inventory — the terminal's `/deps` (see HostToolsResult). */
  hostToolsList: "hostTools:list",
  securityRemediate: "security:remediate",
  securityThreatdb: "security:threatdb",
  securityTrust: "security:trust",
  // URL-injection safeguard L5: re-scan / list-vault / restore installed sources.
  securityUrlAudit: "security:urlAudit",
  // ── the file 04 §1,§3 Package & Environment Manager surface ──────────────
  // venv/conda CRUD + the eight package lifecycle verbs + CUDA. Every FETCHING
  // verb (install/update/upgrade/import/clone/cuda.torch) routes through
  // envmgr.py's gate (stage → REAL nemesis → gated install) — JS never decides
  // safe (C5/the SPINE). Read-only verbs (list/doctor/export/cuda.info) never gate.
  envEnvList: "env:list",
  envEnvCreate: "env:create",
  envEnvClone: "env:clone",
  envEnvDelete: "env:delete",
  envEnvUse: "env:use",
  envEnvExport: "env:export",
  envEnvImport: "env:import",
  envEnvDoctor: "env:doctor",
  envPkgList: "pkg:list",
  envPkgInstall: "pkg:install",
  envPkgUpdate: "pkg:update",
  envPkgUpgrade: "pkg:upgrade",
  envPkgRemove: "pkg:remove",
  envPkgUninstall: "pkg:uninstall",
  envPkgEnable: "pkg:enable",
  envPkgDisable: "pkg:disable",
  envCudaInfo: "cuda:info",
  envCudaTorch: "cuda:torch",
  envCudaInstall: "cuda:install",
  // ── the file 05 §1,§7,§8 Model Hub surface ───────────────────────────────
  // discover / fit / download (stage → REAL nemesis → admit | quarantine) /
  // library / serve (drives the MAIN-process C8 ServerSupervisor) / repoint.
  // Every DOWNLOAD's gate decision is the engine's nemesis — JS never decides
  // "safe" (C5/the SPINE); a BLOCK rides back as ok:false+blocked, not a throw.
  // SERVE drives the supervisor to spawn + poll {base_url}/models (C8); the
  // renderer supplies only ids/options, never a spawnable command.
  modelHardware: "model:hardware",
  modelSearch: "model:search",
  modelInfo: "model:info",
  modelFit: "model:fit",
  modelDownload: "model:download",
  modelPull: "model:pull",
  // Auto-install the local runner (ollama) ON THE USER'S BEHALF, OS-aware (macOS
  // brew / Linux install.sh) — replaces the copy-paste command with a real run.
  modelInstallRunner: "model:installRunner",
  modelLibrary: "model:library",
  modelRemove: "model:remove",
  modelServe: "model:serve",
  modelUnserve: "model:unserve",
  // Start (or confirm already-running) the raw Ollama daemon specifically — distinct from
  // `model:serve`'s fit-derived HF ServeProfile lifecycle (different argv, different health
  // check, a model that's already pulled vs. one downloaded on demand). See
  // packages/core/src/ai/ollama-autostart.ts's docstring for why the two must never be
  // conflated.
  modelOllamaStart: "model:ollamaStart",
  // LM Studio's twin of modelOllamaStart, above — same reasoning, `lms server start` instead of
  // `ollama serve`.
  modelLmstudioStart: "model:lmstudioStart",
  // Distinct from unserve: skips the 5s SIGTERM grace window and SIGKILLs on the next
  // tick — "kill it with brute force if something is not responding properly."
  modelKill: "model:kill",
  modelServing: "model:serving",
  modelEndpoints: "model:endpoints",
  modelRepoint: "model:repoint",
  // /hug: bring in a model from a local folder or Hugging Face — fetch (if needed) →
  // convert (always via llama.cpp's own tools) → install into ollama/llama.cpp/vllm/
  // lmstudio, one physical copy shared across all of them (never re-downloaded).
  modelFetchHf: "model:fetchHf",
  modelInstallHfCli: "model:installHfCli",
  modelConvert: "model:convert",
  modelInstallConverter: "model:installConverter",
  modelInstallTarget: "model:installTarget",
  // ── whole-machine resource telemetry (CPU/GPU/NPU/RAM/DISK) + launch guard ──
  // Read-only native probe (node:os/statfs/nvidia-smi); the renderer polls it to
  // draw the bottom-bar strip + System panel. The `guard` field is the same verdict
  // the Model Hub launch handlers enforce server-side (don't saturate the host).
  systemTelemetry: "system:telemetry",
  // ── the file 06 §4 Catalog surface (plugins/skills/apps/worldsim/models/…) ─
  // The faithful projection of prometheus.py's six registries behind nine
  // subcommands. READ verbs (list/info/where/matrix/status/audit/superscan/
  // inventory/apps/worldsim/models/localai/skillsList) never change state; the
  // STATE-CHANGING verbs (install/uninstall/enable/disable/bundle/sync/
  // scaffoldSkill + the apps/worldsim/models lifecycle) route through the ENGINE,
  // which runs nemesis ITSELF (prepare_nemesis → enforce_gate) — JS never decides
  // "safe" (C5/the SPINE). A BLOCK rides back as ok:false + forced_danger, never a
  // throw; the MAIN process REFUSES --force without the typed-confirm flag (§8).
  catalogBrowse: "catalog:browse",
  catalogList: "catalog:list",
  catalogInfo: "catalog:info",
  catalogWhere: "catalog:where",
  catalogMatrix: "catalog:matrix",
  catalogStatus: "catalog:status",
  catalogAudit: "catalog:audit",
  catalogSuperscan: "catalog:superscan",
  catalogInventory: "catalog:inventory",
  catalogSkillsList: "catalog:skillsList",
  catalogVaultStatus: "catalog:vaultStatus",
  catalogApps: "catalog:apps",
  catalogWorldsim: "catalog:worldsim",
  catalogModels: "catalog:models",
  catalogLocalai: "catalog:localai",
  catalogInstall: "catalog:install",
  catalogUninstall: "catalog:uninstall",
  catalogEnable: "catalog:enable",
  catalogDisable: "catalog:disable",
  catalogBundle: "catalog:bundle",
  catalogSync: "catalog:sync",
  catalogScaffoldSkill: "catalog:scaffoldSkill",
  catalogAppLifecycle: "catalog:appLifecycle",
  // ── the file 06 §3 GitHub Repo Manager surface (FEATURE #5a / 00-INDEX C6) ──
  // The ONLY arbitrary-URL clone path, hard-wired through _GIT_SAFE_FLAGS + the
  // REAL nemesis gate inside the repo.py sidecar. STAGE → gate → promote |
  // quarantine: a BLOCK rides back as ok:false + blocked + quarantined, never a
  // throw, never promoted. The MAIN process REFUSES --force without the typed-
  // confirm flag (§8). JS never decides "safe" (C5).
  repoClone: "repo:clone",
  repoList: "repo:list",
  repoUpdate: "repo:update",
  repoPin: "repo:pin",
  repoBranch: "repo:branch",
  repoRescan: "repo:rescan",
  repoRemove: "repo:remove",
  // file 0C — atomic file-metadata control (privacy protection)
  metadataInspect: "metadata:inspect",
  metadataScrub: "metadata:scrub",
  metadataEdit: "metadata:edit",
  metadataTimestomp: "metadata:timestomp",
  fileOpen: "file:open",
  folderOpen: "folder:open",
  openPath: "path:open",
  revealPath: "path:reveal",
  // ── SPECTACULAR power-up: catalog cards + chat + models folder + harden ────
  // Read-only/preview engine commands over a PrometheusEngine facade in MAIN.
  // chat is PREVIEW-only here (the engine assembles an injection-safe argv); the
  // actual terminal handoff is the user's via the prometheus CLI / pty panel.
  spectacularDescribe: "spectacular:describe",
  spectacularTutorial: "spectacular:tutorial",
  spectacularMethods: "spectacular:methods",
  spectacularHarden: "spectacular:harden",
  spectacularChatLocal: "spectacular:chatLocal",
  spectacularChatPreview: "spectacular:chatPreview",
  spectacularModelsConfig: "spectacular:modelsConfig",
  spectacularModelsBrowse: "spectacular:modelsBrowse",
  // ── the file 07 §3.2/§4/§5/§6/§9 Code-Editor / IDE surface ────────────────
  // The MAIN process owns ALL child processes (LSP/DAP/PTY/git) + the fs (C5);
  // the renderer NEVER spawns a child — it drives the hosts over these typed
  // channels and receives output/diagnostics/events over the `ide:event` push.
  // The RUN-GATE (`ide:gate`, §5.2/§9) reuses the REAL engine-bridge gate; JS
  // never decides "safe" (C5). fs read/write/tree are the MAIN-owned fs path.
  ideFsRead: "ide:fs.read",
  /** the GLOBAL (`~/.prometheus`) steering tier — main owns the home path, not the renderer. */
  ideSteeringGlobal: "ide:steering.global",
  ideFsWrite: "ide:fs.write",
  /** handoff §3: declare the workspace roots MAIN gates every write against. */
  ideSetWorkingSet: "ide:workingSet.set",
  /** handoff §3: register ONE human-approved out-of-scope path (never a wildcard). */
  ideApproveOutside: "ide:workingSet.approve",
  ideFsTree: "ide:fs.tree",
  ideFsWatch: "ide:fs.watch",
  ideFsUnwatch: "ide:fs.unwatch",
  ideFsCreateFile: "ide:fs.createFile",
  ideFsMkdir: "ide:fs.mkdir",
  ideFsRename: "ide:fs.rename",
  ideFsDelete: "ide:fs.delete",
  ideLspEnsure: "ide:lsp.ensure",
  ideLspRequest: "ide:lsp.request",
  ideLspCancel: "ide:lsp.cancel",
  // APP-077: the live LSP server list (for Cmd-T workspace-symbol federation).
  ideLspList: "ide:lsp.list",
  // APP-078: the renderer's ack for a relayed server→client workspace/applyEdit.
  ideLspApplyEditResult: "ide:lsp.applyEditResult",
  ideLspDidOpen: "ide:lsp.didOpen",
  ideLspDidChange: "ide:lsp.didChange",
  ideLspDidClose: "ide:lsp.didClose",
  ideLspSetInterpreter: "ide:lsp.setInterpreter",
  ideDapLaunch: "ide:dap.launch",
  ideDapRequest: "ide:dap.request",
  ideDapTerminate: "ide:dap.terminate",
  ideDapDetectAdapter: "ide:dap.detect-adapter",
  ideDapInstallAdapter: "ide:dap.install-adapter",
  ideRefactor: "ide:refactor",
  ideRunStart: "ide:run.start",
  ideRunKill: "ide:run.kill",
  idePtySpawn: "ide:pty.spawn",
  idePtyWrite: "ide:pty.write",
  idePtyResize: "ide:pty.resize",
  idePtyKill: "ide:pty.kill",
  // APP-090: tear a terminal session out into a hardened secondary window / re-dock it.
  ideFloatingTerminalCreate: "ide:floatingTerminal.create",
  ideFloatingTerminalClose: "ide:floatingTerminal.close",
  ideGitStatus: "ide:git.status",
  ideGitDiff: "ide:git.diff",
  ideGitStage: "ide:git.stage",
  ideGitUnstage: "ide:git.unstage",
  ideGitCommit: "ide:git.commit",
  ideGitBranch: "ide:git.branch",
  ideGitBranches: "ide:git.branches",
  ideGitStash: "ide:git.stash",
  ideGitStashList: "ide:git.stashList",
  ideGitStashPop: "ide:git.stashPop",
  ideGitStashApply: "ide:git.stashApply",
  ideGitStashDrop: "ide:git.stashDrop",
  ideGitBlame: "ide:git.blame",
  ideGitMergeAbort: "ide:git.mergeAbort",
  ideGitCheckoutSide: "ide:git.checkoutSide",
  ideGitCheckoutCommit: "ide:git.checkoutCommit",
  ideGitCherryPick: "ide:git.cherryPick",
  ideGitRevert: "ide:git.revert",
  ideGitReset: "ide:git.reset",
  ideGitConflictVersions: "ide:git.conflictVersions",
  ideGitLog: "ide:git.log",
  ideGitPush: "ide:git.push",
  ideGitPull: "ide:git.pull",
  ideGitFetch: "ide:git.fetch",
  ideGitRebaseTodo: "ide:git.rebaseTodo",
  ideGitRebaseRun: "ide:git.rebaseRun",
  ideGitRebaseState: "ide:git.rebaseState",
  ideGitRebaseContinue: "ide:git.rebaseContinue",
  ideGitRebaseAbort: "ide:git.rebaseAbort",
  ideGitShow: "ide:git.show",
  ideGitApplyPatch: "ide:git.applyPatch",
  ideGitPrStatus: "ide:git.prStatus",
  ideGitPrList: "ide:git.prList",
  ideGitPrGet: "ide:git.prGet",
  ideGitPrComment: "ide:git.prComment",
  ideGitPrSetToken: "ide:git.prSetToken",
  // Task #5 (desktop parity): worktree isolation, backed by the SAME
  // `@prometheus/core/git-worktree` functions the CLI's `/worktree` slash calls.
  ideWorktreeList: "ide:worktree.list",
  ideWorktreeCreate: "ide:worktree.create",
  ideWorktreeRemove: "ide:worktree.remove",
  // Task #5 (desktop parity): sub-agent personas from markdown, via the SAME
  // `@prometheus/core/agent-files` `loadAgentFile` clamping the CLI's `spawn_agent` uses.
  ideAgentFilesList: "ide:agentFiles.list",
  // Task #5 (desktop parity): custom slash commands from markdown, via the SAME
  // `@prometheus/core/command-loader`/`command-gate` the CLI's `/command` loader uses.
  ideCommandFilesList: "ide:commandFiles.list",
  ideGate: "ide:gate",
  ideExec: "ide:exec",
  agentSystemTool: "agent:systemTool",
  agentEngineTool: "agent:engineTool",
  /** run ONE user-configured lifecycle hook (PreToolUse/PostToolUse/SessionStart) in MAIN. */
  agentHookRun: "agent:hookRun",
  /** record a tripped canary token (point 6b) — the renderer detects it, MAIN owns the disk. */
  agentCanaryTrip: "agent:canaryTrip",
  // Remembered "don't ask again" grants, on the SAME disk file the CLI uses.
  agentGrantsList: "agent:grants.list",
  agentGrantsAdd: "agent:grants.add",
  ideDetectBins: "ide:detect-bins",
  ideSearch: "ide:search",
  // APP-066: cancel an in-flight worker search + a worker-offloaded repo index walk.
  ideSearchCancel: "ide:searchCancel",
  ideWorkspaceIndex: "ide:workspaceIndex",
  // APP-076: structural (AST) search via the structsearch.py sidecar (read-only `match`).
  ideStructSearch: "ide:structsearch",
  ideTestDiscover: "ide:test.discover",
  ideTestRun: "ide:test.run",
  ideCoverageRun: "ide:coverage.run",
  ideCoverageImport: "ide:coverage.import",
  ideSqlConnect: "ide:sql.connect",
  ideSqlQuery: "ide:sql.query",
  ideSqlSchema: "ide:sql.schema",
  // ── live Jupyter kernel (APP-045) — one supervised session per notebook ──────
  ideKernelStart: "ide:kernel.start",
  ideKernelExecute: "ide:kernel.execute",
  ideKernelInterrupt: "ide:kernel.interrupt",
  ideKernelRestart: "ide:kernel.restart",
  ideKernelShutdown: "ide:kernel.shutdown",
  ideKernelDataframe: "ide:kernel.dataframe",
  // ── profiler (APP-046) — profile.py cProfile → flame folds, gated run ────────
  ideProfileStart: "ide:profile.start",
  ideProfileStop: "ide:profile.stop",
  // APP-089: memory/async modes ride ideProfileStart; snapshots + compare are new.
  ideProfileSnapshotSave: "ide:profile.snapshotSave",
  ideProfileSnapshotList: "ide:profile.snapshotList",
  ideProfileCompare: "ide:profile.compare",
  // ── terminal launcher (APP-048) — core profiles/AI presets/env → menu+resolve ─
  ideTerminalMenu: "ide:terminal.menu",
  ideTerminalResolve: "ide:terminal.resolve",
  // ── repo-map (APP-053) — repomap.py ranked symbol map for @codebase grounding ─
  ideRepoMap: "ide:repoMap",
  ideLintDetect: "ide:lintDetect",
  ideLintRun: "ide:lintRun",
  ideHistoryBind: "ide:historyBind",
  ideHistoryList: "ide:historyList",
  ideHistoryRead: "ide:historyRead",
  ideHistoryRevert: "ide:historyRevert",
  ideFsWalk: "ide:fsWalk",
  // ── MCP connectors (file 09 §2) — Studio as a client of external MCP servers ──
  mcpList: "mcp:list",
  mcpAdd: "mcp:add",
  mcpConnect: "mcp:connect",
  mcpDisconnect: "mcp:disconnect",
  mcpRemove: "mcp:remove",
  mcpSetEnabled: "mcp:set-enabled",
  mcpImport: "mcp:import",
  // The agent pane as an MCP CLIENT: the descriptors it needs to build tool defs, and the
  // one channel that actually calls a tool.
  mcpAgentTools: "mcp:agent-tools",
  mcpAgentCall: "mcp:agent-call",
  // APP-095: git-backed settings sync (keymap/themes/connectors, secrets redacted).
  settingsSyncPush: "settings-sync:push",
  settingsSyncPull: "settings-sync:pull",
  // ── settings tree (file 13 §2.1) — keyed/layered get/set/reset ──────────────
  settingsList: "settings:list",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  settingsReset: "settings:reset",
  // ── extension host (file 09 §5, APP-059/060) — install/activate/deactivate/list/rescan ──
  extList: "ext:list",
  extInstall: "ext:install",
  extActivate: "ext:activate",
  extDeactivate: "ext:deactivate",
  extRescan: "ext:rescan",
  // ── "@"-path completion (shared with the CLI's @prometheus/core/path-completion) ──
  pathCompletionList: "pathCompletion:list",
  pathCompletionRecordUse: "pathCompletion:recordUse",
  // ── the ONE saved autonomy level, shared with the CLI (@prometheus/core cliProfiles) ──
  // The renderer used to keep this in localStorage alone, so a level set in the terminal was
  // invisible here and clearing the app's data reset the posture with no file to recover from.
  authLevelGet: "authLevel:get",
  authLevelSet: "authLevel:set",
  // ── the ONE saved thinking-effort tier, shared with the CLI (same store, same file) ──
  effortGet: "effort:get",
  effortSet: "effort:set",
  /**
   * The third-party update report: vendor CLIs, package managers, local models, Prometheus
   * itself, and the install CONFLICTS between them.
   *
   * Studio had no update surface at all beyond Electron's own auto-updater, so a Studio-only
   * user could never learn that their `claude`, `codex`, `ollama` or models were out of date —
   * and never saw the conflicts that make an obvious `brew upgrade` a no-op.
   */
  updatesCheck: "updates:check",
  /**
   * The model catalogue — HuggingFace-backed, filtered to what this machine can run.
   *
   * Separate from `updates:check` because it is a SEARCH: the renderer supplies a query string,
   * and the result depends on it. `updates:check` takes one boolean and describes the machine.
   */
  catalogSearch: "model-catalog:search",
  // ── model health (shared with the CLI's @prometheus/core ai/model-health) ──
  modelHealthList: "modelHealth:list",
  modelHealthRecord: "modelHealth:record",
  // ── scheduled/autonomous runs (shared with the CLI's @prometheus/core agent/schedule) ──
  scheduleList: "schedule:list",
  scheduleUpsert: "schedule:upsert",
  scheduleRemove: "schedule:remove",
  // ── persona sharing (shared with the CLI's @prometheus/core agent/agent-files) ──
  personaList: "persona:list",
  personaExport: "persona:export",
  personaImportText: "persona:importText",
  personaImportPath: "persona:importPath",
  personaRemove: "persona:remove",
  // ── budget & spend visibility (roadmap point 4) — SETTING a cap reuses settings:set/get ──
  budgetStatus: "budget:status",
  // ── "meet your codebase" (roadmap point 6) ──
  codebaseOverview: "codebase:overview",
} as const;

/** One ranked directory entry for the "@"-path completion dropdown — a directory's name
 *  carries a trailing "/"; `positions` are the matched char indices for highlighting. */
export interface PathCompletionEntryView {
  name: string;
  isDir: boolean;
  positions: number[];
}

export interface PathCompletionListResult {
  ok: boolean;
  entries?: PathCompletionEntryView[];
  error?: string;
}

export interface PathCompletionRecordUseResult {
  ok: boolean;
  error?: string;
}

/** One endpoint's transport/breaker/context-window health, as of its last turn — mirrors
 *  @prometheus/core's `EndpointHealthRecord` (this file cannot import core's TS types across the
 *  preload/renderer sandbox boundary the way main.ts can, so the shape is restated here). */
export interface ModelHealthRecordView {
  endpointId: string;
  model: string;
  locality: "local" | "cloud";
  transport: "native" | "text";
  demonstrated: boolean;
  nativeCalls: number;
  textCallsWhileNative: number;
  textSyntaxCalls: number;
  nativeRejected: boolean;
  breakerState: "closed" | "open" | "half-open";
  breakerFailures: number;
  breakerOpenedAt: number | null;
  contextWindow: number;
  contextWindowSource: "ollama" | "ollama-loaded" | "openai-models" | "default" | "declared";
  lastUsedIso: string;
}

export type ModelHealthStoreView = Record<string, ModelHealthRecordView>;

export interface ModelHealthListResult {
  ok: boolean;
  store?: ModelHealthStoreView;
  error?: string;
}

export interface ModelHealthRecordResult {
  ok: boolean;
  error?: string;
}

/** One scheduled/autonomous task, as the renderer receives it — mirrors @prometheus/core's
 *  `agent.ScheduledTask` (restated here since this file cannot import core's TS types across
 *  the preload/renderer sandbox boundary the way main.ts can, same reasoning as
 *  ModelHealthRecordView above). */
export interface ScheduledTaskView {
  id: string;
  name: string;
  cronExpr: string;
  task: string;
  cwd?: string;
  autonomy: "readonly" | "edits" | "commands";
  enabled: boolean;
  createdIso: string;
  lastRunIso?: string;
  lastResult?: {
    ok: boolean;
    summary: string;
    ranIso: string;
    toolCalls: string[];
  };
}

export interface ScheduleListResult {
  ok: boolean;
  store?: Record<string, ScheduledTaskView>;
  error?: string;
}

export interface ScheduleUpsertResult {
  ok: boolean;
  error?: string;
}

export interface ScheduleRemoveResult {
  ok: boolean;
  error?: string;
}

/** One persona in the shared catalog, as the renderer receives it — mirrors @prometheus/core's
 *  `agent.LoadedAgent`, minus its `path` field: a real absolute filesystem path must never cross
 *  the sandbox boundary to the renderer (main strips it before returning). "imported" is clamped
 *  IDENTICALLY to "project" by core's `loadAgentFile` (model refused, forced read-only, tools
 *  only narrow) — this is the entire safety property that makes persona sharing safe to ship. */
export interface PersonaFileView {
  name: string;
  scope: "user" | "project" | "imported";
  description: string;
}

export interface PersonaListResult {
  ok: boolean;
  personas?: PersonaFileView[];
  error?: string;
}

export interface PersonaExportResult {
  ok: boolean;
  markdown?: string;
  scope?: "user" | "project" | "imported";
  error?: string;
}

export interface PersonaImportResult {
  ok: boolean;
  name?: string;
  replaced?: boolean;
  error?: string;
}

export interface PersonaRemoveResult {
  ok: boolean;
  error?: string;
}

/** The resolved budget caps, restated as plain data — mirrors @prometheus/core's
 *  `ai.BudgetConfig` (this file cannot import core's TS types across the preload/renderer
 *  sandbox boundary the way main.ts can, same reasoning as ModelHealthRecordView above). */
export interface BudgetConfigView {
  sessionUsd?: number;
  dailyUsd?: number;
  warnAtPercent?: number;
  unpricedPolicy?: "block" | "warn";
}

/** One counted bucket (a file extension or a top-level directory) — mirrors @prometheus/core's
 *  `tokenEconomy.OverviewCount`. */
export interface CodebaseOverviewCountView {
  key: string;
  count: number;
}

/** A friendly first-look read of the open workspace — mirrors @prometheus/core's
 *  `tokenEconomy.CodebaseOverview` (this file cannot import core's TS types across the
 *  preload/renderer sandbox boundary the way main.ts can, same reasoning as ModelHealthRecordView
 *  above). */
export interface CodebaseOverviewView {
  fileCount: number;
  truncated: boolean;
  topExtensions: CodebaseOverviewCountView[];
  topDirs: CodebaseOverviewCountView[];
  detectedStacks: string[];
  readmePath?: string;
  sampleSymbols: string[];
}

export interface CodebaseOverviewResult {
  ok: boolean;
  overview?: CodebaseOverviewView;
  error?: string;
}

/** Response to `budget:status` — a read-only spend snapshot (roadmap point 4). SETTING a cap is
 *  NOT a separate write here: it reuses the existing `settings:set` keys
 *  (`budget.sessionUsd`/`budget.dailyUsd`/`budget.warnAtPercent`/`budget.unpricedPolicy`). */
export interface BudgetStatusResult {
  ok: boolean;
  capped?: boolean;
  config?: BudgetConfigView;
  sessionSpentUsd?: number;
  dailySpentUsd?: number;
  /** distinct model ids with no price entry — excluded from both totals above. */
  unpriced?: string[];
  error?: string;
}

/**
 * The fire-and-forget channel the renderer uses to CANCEL a long-running op by
 * its runId. It is an `ipcRenderer.send` (one-way), not an `invoke`, because
 * cancellation has no meaningful return and must never block the renderer. The
 * MAIN process owns the AbortController registry keyed by runId (§4.3).
 */
export const IPC_CANCEL = "prometheus:cancel" as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/**
 * One-way MAIN→renderer event channels (ipcRenderer.on, not invoke). Used by the
 * streaming progress feed: the MAIN process forwards parsed engine stderr
 * progress events to the renderer so it can paint a live timeline. This is
 * BEST-EFFORT cosmetics — it NEVER carries a security decision (C5).
 */
export const IPC_EVENTS = {
  progress: "prometheus:progress",
  /**
   * The security progress feed (file 03 §6): threat-DB `update` and disinfect
   * runs stream their progress lines here, tagged with the op's runId. Separate
   * from the generic `progress` channel so the Threat-DB panel can subscribe
   * without seeing every install line. Cosmetic only — NO verdict crosses (C5).
   */
  securityProgress: "security:progress",
  /**
   * The model-streaming feed (§9c): text, thinking, and watchdog status deltas for one
   * `ai:stream` turn, tagged with its runId. Purely presentational — the turn's RESULT
   * (final text, tool calls, usage, timing) rides back in the invoke's typed reply, so a
   * dropped or duplicated delta can never change what the agent loop acts on.
   */
  aiProgress: "ai:progress",
  /**
   * The env/package progress feed (file 04 §8): long ops (upgrade, big template
   * installs, cuda.torch) stream their per-package progress lines here, tagged
   * with the op's runId so the Environments tab can paint a per-package progress
   * strip. Cosmetic only — NO gate verdict crosses (C5); the verdict rides back
   * in the op's typed result.
   */
  envProgress: "env:progress",
  /**
   * The Model-Hub progress feed (file 05 §5/§8): a download streams its staging
   * `{pct}` lines here, and a `serve` streams the supervisor's launch + poll
   * lifecycle (starting → ready/error) tagged with the profile id. Cosmetic only
   * for downloads (the gate VERDICT rides back in the op's typed result, C5); for
   * serve it carries the §2.4 status the Serving panel renders live.
   */
  modelProgress: "model:progress",
  /**
   * The Catalog / Repo progress feed (file 06 §4.3/§3.1): a long install,
   * uninstall, bundle, or apps/worldsim/models lifecycle op streams the engine's
   * parsed stderr progress lines here, tagged with the op's runId so the Catalog
   * tab can paint a live timeline; a repo clone/update streams its staging +
   * gate progress. Cosmetic only — the gate VERDICT rides back in the op's typed
   * result, NEVER over this feed (C5).
   */
  catalogProgress: "catalog:progress",
  /**
   * The IDE host feed (file 07 §3.2/§4/§5/§6): a SINGLE multiplexed MAIN→renderer
   * channel for the editor hosts — LSP diagnostics/notifications + server state,
   * DAP debug events + session state, PTY terminal output/exit, and fs change
   * batches. Each payload is a discriminated `IdeEvent` the renderer routes by its
   * `channel`. Cosmetic/data only — NO security verdict crosses here (C5); the
   * run-gate verdict rides back in the `ide:gate` typed result.
   */
  ideEvent: "ide:event",
  /**
   * The live test-run feed (APP-013): while `ide:test.run` executes, each per-test
   * JSON-line the testmgr sidecar streams is forwarded here as an `IdeTestEvent`
   * so the Test Explorer paints results live. Cosmetic/data only (C5) — the
   * terminal `{ok, summary}` rides back in the `ide:test.run` typed result.
   */
  ideTestEvent: "ide:test.event",
} as const;

export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

/* ── shared, renderer-safe data shapes ─────────────────────────────────────
 * Every payload below is JSON-serialisable (structured-clone safe). The
 * renderer NEVER receives an EngineClient, a ChildProcess, or a node:* handle.
 */

/** A detected agent/CLI/IDE row from `prometheus.py scan`. */
export interface AgentRow {
  name: string;
  label: string;
  kind: CatalogItem["kind"];
  present: boolean;
  where?: string;
}

/** Response to `IPC.scan`: the host OS string + the detected agents. */
export interface ScanResult {
  ok: boolean;
  os?: string;
  agents: AgentRow[];
  /** present only when the engine failed; the renderer shows it as an error. */
  error?: string;
}

/**
 * A provider row enriched with its EFFECTIVE tier + cost light (C11), already
 * sorted Tier-A-first by the MAIN process. `requiresTypedConfirm` is the literal
 * phrase the renderer must demand before enabling a metered (Tier-C) provider.
 */
export interface ProviderRow {
  id: string;
  label: string;
  tier: ProviderTier;
  costLight: CostLight;
  /** true for metered Tier-C providers — the renderer must show the cost modal. */
  needsCostWarning: boolean;
  /** the exact phrase the user must type to enable a metered provider, if any. */
  requiresTypedConfirm?: string;
  isEscapeHatch?: boolean;
  notes?: string;
}

/** Response to `IPC.providers`: Tier-A-first provider rows for the panel. */
export interface ProvidersResult {
  ok: boolean;
  providers: ProviderRow[];
  error?: string;
}

/**
 * Response to `IPC.gate`: the C3 SecurityVerdict the renderer paints with a
 * <VerdictBadge>. NEVER fabricated in JS — the MAIN process gets it from the
 * engine-bridge nemesis runner (fail-closed). The `verdict`/`severity` axes are
 * re-stated here so the renderer can type a badge without reaching into core.
 */
export interface GateResult {
  ok: boolean;
  verdict: VerdictTier;
  severity: Severity;
  riskScore: number;
  signed: boolean;
  findingsCount: number;
  target: string;
  scannedAt: string;
  /** populated only when the gate could not run (already folded into verdict). */
  error?: string;
  /** the full verdict, for a detail pane. */
  detail?: SecurityVerdict;
}

/** A generic engine-envelope response (info/list) the renderer can inspect. */
export interface EnvelopeResult {
  ok: boolean;
  /** the raw engine JSON envelope (already structured-clone safe). */
  data?: Record<string, unknown>;
  error?: string;
}

/** Response to `IPC.servers`: a snapshot of every supervised server (C8). */
export interface ServersResult {
  ok: boolean;
  servers: ServerStatus[];
  error?: string;
}

/** Options the renderer may pass to `install` (dry-run preview, forced override). */
export interface InstallOptions {
  /** preview only (`--dry-run`) — no filesystem changes. */
  dryRun?: boolean;
  /**
   * deep-red BLOCK override (`--force`). The renderer must FIRST obtain a typed
   * confirmation from the user; the MAIN process still re-runs nemesis and only
   * the engine decides. JS never fabricates a "safe" (C5).
   */
  forced?: boolean;
  /**
   * correlation id for the live progress feed + cancellation. The renderer mints
   * it (e.g. crypto.randomUUID) and passes the SAME id to `cancel(runId)` and to
   * the `onProgress` filter so a long install can be followed + aborted (§4.3).
   */
  runId?: string;
}

/** Options the renderer may pass to `uninstall` (dry-run preview + run correlation). */
export interface UninstallOptions {
  /** preview only (`--dry-run`) — no filesystem changes. */
  dryRun?: boolean;
  /** correlation id for the progress feed + cancellation (see InstallOptions). */
  runId?: string;
}

/** Response to `IPC.version`: the engine SCRIPT_VERSION (probed via `--version`). */
export interface VersionResult {
  ok: boolean;
  /** the prometheus.py SCRIPT_VERSION string, e.g. "0.15.0". */
  version?: string;
  error?: string;
}

/**
 * A MAIN→renderer progress event (IPC_EVENTS.progress). Mirrors engine-bridge's
 * ProgressEvent shape but is re-declared here as PLAIN DATA so the renderer never
 * imports engine-bridge. Cosmetic only — carries NO security verdict (C5).
 */
export interface ProgressFeedEvent {
  /**
   * correlation id of the long-running op this line belongs to. The renderer
   * filters its progress timeline by the runId it passed to install/uninstall,
   * so two concurrent ops never cross-contaminate each other's logs (§4.3).
   * Optional because some MAIN→renderer log lines (sidecar boot) are global.
   */
  runId?: string;
  phase: string;
  message: string;
  verdict?: VerdictTier;
  raw: string;
}

/**
 * Read-only engine/scanner health, surfaced as the title-bar status pill (§4.2).
 * Plain data — the renderer never holds the resolved paths as anything but
 * display strings. Mirrors engine-bridge's notion of a launch-time probe but is
 * re-declared here so the renderer never imports engine-bridge (C5).
 */
export interface HealthResult {
  ok: boolean;
  /** the engine SCRIPT_VERSION, when the read-only probe succeeded. */
  version?: string;
  /** does the `--json` contract behave (one object on stdout)? */
  contractOk: boolean;
  /** false ⇒ installs fail-closed; the renderer shows an amber "scanner missing". */
  nemesisPresent: boolean;
  /** human-readable setup hints for the pill tooltip (never secrets/paths-as-data). */
  problems: string[];
  error?: string;
}

/* ── security: the FULL nemesis.verdict/1 surface (file 03 §5,§7) ──────────
 * These shapes carry the RICH NemesisVerdict (and the remediation / threat-DB /
 * trust results) the security UI renders. Every payload is PLAIN DATA the MAIN
 * process obtained from engine-bridge — the renderer never recomputes a verdict
 * (C5). A failed/timed-out/unparseable scan arrives as `verdict: "error"` inside
 * the NemesisVerdict (a fail-closed BLOCK), never as a silent allow.
 */

/** Response to a rich gate/gateFull/audit-target: the full NemesisVerdict. */
export interface SecurityGateResult {
  ok: boolean;
  /** the full, typed nemesis.verdict/1 object (fail-closed on any failure). */
  verdict: NemesisVerdict;
  error?: string;
}

/** Discriminated arg the renderer sends to `security:remediate`. */
export type SecurityRemediateRequest =
  | { op: "disinfect"; target: string; out: string; runId?: string }
  | { op: "quarantineList"; target?: string; quarantineDir?: string }
  | {
      op: "restore";
      id: string;
      quarantineDir: string;
      /**
       * The exact string the human typed in the restore confirm (§4), plus the `path` it
       * was keyed to. Main re-checks `typedName === purgeBasename(path ?? id)` and refuses
       * otherwise — the same two-layer shape purge has always had, because restore puts an
       * artifact the gate refused back where it was found, executable again.
       */
      typedName?: string;
      path?: string;
    }
  | {
      op: "purge";
      target: string;
      kind: "source" | "file" | "quarantine";
      /** the EXACT basename the user typed in PurgeDialog to confirm. The main
       * process refuses the purge unless it equals purgeBasename(target) (§9.3). */
      typedName?: string;
      runId?: string;
    }
  | { op: "acceptFinding"; target: string; ruleId: string; path: string };

/** Response to `security:remediate`: the op echoed + its engine-bridge result. */
export interface SecurityRemediateResult {
  ok: boolean;
  op: SecurityRemediateRequest["op"];
  /** the engine-bridge result for the op (DisinfectResult / RestoreResult / …). */
  data?: Record<string, unknown>;
  error?: string;
}

/** Discriminated arg the renderer sends to `security:threatdb`. */
export type SecurityThreatDbRequest =
  | { op: "status" }
  | { op: "update"; force?: boolean; all?: boolean; feeds?: string[]; runId?: string }
  | { op: "authKey"; key: string }
  | { op: "cache"; action: "status" | "clear" };

/** Response to `security:threatdb`. `status` carries the typed ThreatDbStatus. */
export interface SecurityThreatDbResult {
  ok: boolean;
  op: SecurityThreatDbRequest["op"];
  /** present for `op:"status"` — the seeded/age/stale + indicators (§6 banner). */
  status?: ThreatDbStatus;
  /** present for update/cache — the engine's summary/status text. */
  message?: string;
  error?: string;
}

/** Discriminated arg the renderer sends to `security:urlAudit` (URL-injection L5). */
export type SecurityUrlAuditRequest =
  | { op: "audit"; quarantine?: boolean } // re-scan installed sources (default read-only)
  | { op: "list" } // list the quarantine vault
  | { op: "restore"; vault: string }; // re-instate a quarantined source

/** Response to `security:urlAudit`. Carries the engine's `skills-audit` envelope. */
export interface SecurityUrlAuditResult {
  ok: boolean;
  op: SecurityUrlAuditRequest["op"];
  /** present for op:"audit" — pin/drift/quarantine summary. */
  result?: {
    new: Array<{ path: string; kind: string; verdict: string; urls: number }>;
    clean: string[];
    repinned: Array<{ path: string; kind: string; verdict: string; diff?: string[] }>;
    quarantined: Array<{
      original: string;
      vault: string;
      verdict: string;
      restored_blessed?: boolean;
      first_seen?: boolean;
      blocking_reasons?: string[];
      diff?: string[];
    }>;
    missing: string[];
    errors: Array<{ path: string; error: string }>;
  };
  /** present for op:"list" — the quarantine vault entries. */
  quarantine?: Array<Record<string, unknown>>;
  /**
   * The engine's OWN payload for op:"audit" — a count map by status, and one row per source.
   *
   * `result` above is DERIVED from `skills` by engine-bridge's `urlSourceAudit`; the engine has
   * never emitted a `result` field. Reading only `result` is why the panel rendered nothing after
   * a full 45-source scan. Both are forwarded so a consumer can use the grouping or the rows.
   */
  summary?: Record<string, number>;
  skills?: Array<Record<string, unknown>>;
  error?: string;
}

/** Discriminated arg the renderer sends to `security:trust`. */
export type SecurityTrustRequest =
  | { op: "list" }
  | { op: "revoke"; name: string }
  | {
      op: "auditLog";
      forcedDanger?: boolean;
      blocks?: boolean;
      last24h?: boolean;
      /**
       * Include each row's `verdict_full` — the canonical signed verdict object.
       *
       * Off by default because it is ~97% of the payload: on this machine the live
       * `~/.nemesis/gate-audit.jsonl` is 1257 rows / 38 MB, mean row 31 KB, and 1248 of
       * those rows carry a `verdict_full`. The Security console reads twelve rows and has
       * no consumer for the blob at all, so every route mount was structured-cloning
       * ~38 MB across the contextBridge to render a dozen one-line summaries.
       *
       * Filtering is unaffected: `AuditLogFilter.rule` matches against `verdict_full`
       * inside engine-bridge, before this projection is applied.
       */
      includeVerdictFull?: boolean;
    }
  | { op: "verify"; file: string };

/** Response to `security:trust`. */
export interface SecurityTrustResult {
  ok: boolean;
  op: SecurityTrustRequest["op"];
  /** present for `op:"list"` — the parsed trust-store entries (§8). */
  trusted?: TrustedSource[];
  /** present for `op:"auditLog"` — newest-first gate-audit rows (§8). */
  auditLog?: AuditLogEntry[];
  /**
   * present for `op:"auditLog"` — the gate mode the NEXT engine spawn will actually inherit.
   *
   * Read from MAIN's `$PROMETHEUS_GATE`, which `safeChildEnv()` forwards verbatim to
   * prometheus.py, so this is a LIVE fact rather than an inference. The console previously had
   * only the audit history to go on, and an `enforce` row written by a previous session vouched
   * for a session now running `off` — a green "armed, fail-closed" banner over an unguarded
   * engine. `"unknown"` when the variable holds something unrecognised.
   */
  configuredGateMode?: "enforce" | "warn" | "off" | "unknown";
  /** present for `op:"verify"` — true ONLY when nemesis verify exited 0 (§8). */
  valid?: boolean;
  /** the engine's one-line message (revoke/verify). */
  message?: string;
  error?: string;
}

/** Options the renderer passes to a rich security gate/gateFull. */
export interface SecurityGateOptions {
  /** re-scan fresh (bypass the verdict cache) — maps to `--no-cache` (§4). */
  fresh?: boolean;
  /** HMAC-sign the verdict (`--sign`) for the audit-log Verify feature (§8). */
  sign?: boolean;
  /** the policy tier (default | pentest) — Studio writes no policy itself (§7). */
  tier?: "default" | "pentest";
  /** a custom `--policy FILE` (stricter-only; pentest floor is fixed — §7). */
  policyFile?: string;
}

/** Options the renderer passes to the gated security install (§5). */
/* ── §9c: model streaming, in MAIN ──────────────────────────────────────────── */

/**
 * One chat turn for `ai:stream`.
 *
 * Why this lives in MAIN and not the renderer: the production CSP is
 * `connect-src 'self'` (main/index.ts), so a renderer `fetch` to a model endpoint —
 * `http://localhost:11434/v1/chat/completions`, or any cloud provider — is REFUSED in the
 * packaged app. The renderer streamed models directly, which worked under the dev CSP
 * (`http://localhost:*`) and silently did not work in a build. Routing the request through
 * main both fixes that and restores the C5 rule the rest of the app follows: the renderer
 * reaches the outside world across the contextBridge, never on its own.
 *
 * The cloud policy is re-checked in main. The renderer checks it too, for a fast, local
 * error message — but the renderer's check is a courtesy and main's is the enforcement.
 */
export interface AiStreamRequest {
  /** correlates the invoke with its `ai:progress` deltas and with `ai:cancel`. */
  runId: string;
  endpoint: {
    id: string;
    baseUrl: string;
    model?: string;
    locality: "local" | "cloud";
    /**
     * The model's context window, so main can refuse an impossible request instead of paying
     * a provider 400 for it. The renderer has derived this from the catalogue all along (it
     * sizes the tool preamble); it simply never crossed the wire.
     */
    contextWindow?: number;
  };
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  /** OpenAI-shaped tool schemas; omitted/empty → a plain completion. */
  tools?: unknown[];
  /** the resolved reasoning-effort patch (`@prometheus/core/ai-effort`), already resolved. */
  effort?: unknown;
  /**
   * The LIVE session authorisation level, if the caller has one.
   *
   * Main takes `min(this, the persisted level)`, so a renderer can only ever TIGHTEN the
   * gate with it — which is why accepting it from the untrusted side is safe. It exists
   * because the coarse posture dial (`plan`, the GUI twin of Shift-Tab) is deliberately
   * session-scoped and never written to disk: without this field a read-only `plan` posture
   * still shipped conversations to a cloud provider, because main could only see the file.
   */
  sessionAuthLevel?: number;
  /** the workspace "never send to cloud" policy (§7.5). */
  neverSendToCloud?: boolean;
  /** (A) the user's inactivity-pause threshold in ms (default 10 min). Undefined ⇒ the
   *  default applies. Threaded across the IPC boundary so a desktop settings field (not
   *  built here) can eventually override it per-request. */
  idleTimeoutMs?: number;
}

/** One presentational delta on the `ai:progress` feed. */
export interface AiProgressEvent {
  runId: string;
  /** `text` = answer tokens · `reasoning` = thinking · `status` = watchdog heartbeat. */
  kind: "text" | "reasoning" | "status";
  text: string;
}

/** A tool call the model asked for, accumulated across SSE fragments. */
export interface AiToolCall {
  id: string;
  name: string;
  /** raw JSON string exactly as the model emitted it — parsed by the caller. */
  arguments: string;
}

/** The typed reply to `ai:stream` — the authoritative result of the turn. */
export interface AiStreamResult {
  ok: boolean;
  error?: string;
  /** the full assistant text (the same bytes the `text` deltas carried). */
  text: string;
  toolCalls: AiToolCall[];
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  timing?: { requestAt: number; firstByteAt?: number; firstTokenAt?: number; lastByteAt: number };
  /** the per-endpoint circuit breaker's state as of this call — main is the only process that
   *  holds the real instance, so it rides back here for the renderer's Model Health record. */
  breaker?: { state: "closed" | "open" | "half-open"; failures: number; openedAt: number | null };
  /**
   * (A)/(E) true iff this call ended because the INACTIVITY watchdog fired — a PAUSE, not a
   * completion and not a user cancel (`ai:cancel` still reports `ok:true` with `paused` simply
   * OMITTED, not an explicit `false` — the field is only ever set when it is `true`).
   * `text`/`toolCalls` carry whatever had already streamed before the pause, so the renderer's
   * LLMClient can fold it and surface a resumable `paused` LlmTurn instead of a silent `final`.
   */
  paused?: boolean;
  /**
   * WHY `paused` is true — omitted for the original inactivity-watchdog case (treat a missing
   * value as "idle", the historical/only meaning `paused` had before this field existed).
   * "resources-critical": the local runner this request needed was refused a restart (or was
   * itself just force-stopped) by the machine-wide RAM ceiling — ACTIVE EVICTION, see
   * engine-bridge's eviction-log.ts. Same resumable contract as an idle pause: just send the
   * message again once resources free up (Prometheus will bring the runner back automatically).
   */
  pausedReason?: "idle" | "resources-critical";
  /**
   * True iff the endpoint refused the request BECAUSE it carried tools.
   *
   * Only main can tell: the renderer sees an error STRING, while the decision needs the HTTP
   * status and the response body (`agent/protocol/negotiate.ts`'s `looksLikeToolsRejection`
   * requires both, because a 400 for a context overflow or a bad key has nothing to do with
   * tool support and demoting on one would strand a capable model on the weaker transport for
   * the rest of the session). The agentic CLI has acted on this since the text protocol
   * existed; the desktop never received it, so a tool-incapable endpoint failed every turn,
   * forever, with no path to the fallback that would have worked.
   */
  toolsRejected?: boolean;
}

/**
 * `ai:probeModels` (Task #18) — probe a LOCAL OpenAI-compatible runner (Ollama, llama.cpp, …)
 * for its served models: `GET {baseUrl}/models`.
 *
 * This used to be a direct renderer `fetch` (`endpoint-hook.ts`'s `probeServedModels`) — the
 * SAME production-CSP problem `ai:stream` above exists to fix (`connect-src 'self'` refuses
 * `fetch("http://127.0.0.1:<port>/models")` with `TypeError: Failed to fetch` in the packaged
 * app), except this one had no IPC hop at all, so every local runner silently vanished from the
 * Model Hub picker in a real build while working fine under the looser dev CSP. Moved to MAIN
 * for the same reason `ai:stream` is: the renderer reaches the outside world across the
 * contextBridge, never on its own (C5) — `connect-src` stays `'self'`, unchanged.
 */
export interface AiProbeModelsRequest {
  /** the local runner's base URL, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
}

/** Fail-soft by design: an unreachable/down/empty runner is `{ok:true, models:[]}`, never an
 *  error — the caller (`expandServedModels`) reads an empty list as "drop this endpoint". */
export interface AiProbeModelsResult {
  ok: boolean;
  models: string[];
  error?: string;
}

/**
 * `ai:probeEndpoint` — MEASURE one local model rather than guess at it.
 *
 * `ai:probeModels` above answers "which models does this runner serve"; this answers "and what
 * is that one actually like": its real context window, and the runner's own `capabilities`
 * array (`["completion","tools","thinking","vision",…]`).
 *
 * Both matter and neither was ever asked for in Studio. The window sizes the tool preamble and
 * compaction — every desktop endpoint carried the hard-coded 8192 floor, wrong by 32x for a
 * 262144-window model. The capability array is the ONLY thing that makes the effort chip work
 * on a locally-served model: `ai/effort/rules.ts`'s probe-driven rules outrank every model-name
 * guess, and without this the renderer's `effortFor()` had nothing to give them, so every local
 * model resolved to `UNKNOWN_CAPABILITY` and the chip reported "not available" — including for
 * models that advertise `thinking` in as many words.
 *
 * In MAIN for exactly the reason `ai:probeModels` is: the production CSP (`connect-src 'self'`)
 * refuses a renderer `fetch` to `http://127.0.0.1:<port>`, so the renderer reaches the runner
 * across the contextBridge or not at all (C5).
 */
export interface AiProbeEndpointRequest {
  /** the local runner's base URL, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  /** the served model name, e.g. `qwen3.6:latest`. */
  model: string;
}

/**
 * Fail-soft by design, and the failure is REPORTABLE rather than silent: `source: "default"`
 * means the probe ran and got nothing usable, which is a different thing from a model that
 * genuinely has an 8192 window. A caller must not present the former as the latter.
 */
export interface AiProbeEndpointResult {
  ok: boolean;
  contextWindow: number;
  /** `"ollama"` / `"openai-models"` ⇒ measured. `"default"` ⇒ the probe failed. */
  source: "ollama" | "ollama-loaded" | "openai-models" | "default";
  /** the runner's own capability array, when it reported one. */
  capabilities?: string[];
  /** opaque build identity for cache invalidation — see core's `ContextWindowResult.revision`. */
  revision?: string;
  error?: string;
}

/**
 * `ai:discoverRunners` — ASK the machine which local model servers it has.
 *
 * This replaces the only answer Studio ever had, which was a literal. The desktop's endpoint
 * list came from `LOCAL_AI_ENDPOINTS` (prometheus.py §6H) returned verbatim: five default URLs,
 * printed identically whether or not anything was listening, and the Chat runner dropdown was a
 * two-item array in `chat.tsx`. Neither consulted the machine, so Studio offered LM Studio to
 * people who do not have it and hid llama.cpp from people actively serving with it.
 *
 * In MAIN for the same reason `ai:probeModels` is: the production CSP (`connect-src 'self'`)
 * refuses a renderer `fetch` to `http://127.0.0.1:<port>`, so this crosses the contextBridge or
 * it does not happen (C5).
 *
 * The scan is METADATA-ONLY — `GET /api/tags` and `GET /v1/models`. It can never cause a model
 * load, which is what makes it safe to run on window open; `/v1/chat/completions` makes ollama
 * page in the weights before it can answer even a one-token ping (CLAUDE.md §2.3).
 */
export interface AiDiscoverRunnersResult {
  ok: boolean;
  runners: AiDiscoveredRunner[];
  /** one line naming the cheapest next step, when nothing is serving. */
  hint?: string;
  error?: string;
}

/**
 * `hostTools:list` — which EXTERNAL tools this machine has, and what each is for.
 *
 * The terminal's `/deps`. Studio had no equivalent and no reach into the manifest at all:
 * `probeHostTools`, `renderHostToolManifest` and `HOST_TOOLS` returned zero hits across
 * `apps/desktop/src`. So the agent was told in its prompt that `ffmpeg` and `imagemagick` were
 * available (the manifest rides the system prompt on both surfaces) while the user had no way
 * to see whether they actually were.
 *
 * The probe does NOT spawn. It is a pure `access(X_OK)` walk — `host-tool-probe.ts`'s header
 * explains why that matters: 14 forks per turn is the cost CLAUDE.md §2.3 exists to prevent.
 * It also re-adds the well-known bin directories, because a GUI-launched Electron app inherits
 * launchd's minimal PATH and would otherwise report every tool missing.
 */
export interface HostToolsResult {
  ok: boolean;
  tools: HostToolRow[];
  error?: string;
}

/** One external tool. `found` is the binary that resolved, or null when none did. */
export interface HostToolRow {
  id: string;
  /** the binaries that would satisfy it, in preference order. */
  bins: string[];
  /** what Prometheus uses it FOR — the reason a missing one matters. */
  purpose: string;
  /** the binary actually found on PATH, or null. */
  found: string | null;
  /** the package name per manager, for a copyable install line. */
  install: { brew?: string; apt?: string; dnf?: string; pacman?: string };
}

/** One runner's row. Mirrors core's `DiscoveredRunner`, flattened for the bridge. */
export interface AiDiscoveredRunner {
  id: string;
  name: string;
  baseUrl: string;
  host: string;
  port: number;
  /** `serving` ⇒ it answered. `installed` ⇒ binary present, nothing listening. `absent` ⇒ neither. */
  state: "serving" | "installed" | "absent";
  models: string[];
  canStart: boolean;
  canInstall: boolean;
  binPath?: string;
  detail?: string;
}

export interface SecurityInstallOptions {
  /** preview-first (`--dry-run`) — defaults true (§2.1/§5.1). */
  dryRun?: boolean;
  /** the §5.3 deep-red BLOCK override (`--force`), gated behind the typed token. */
  forced?: boolean;
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS install (§9a).
   *
   * `forced` alone is not enough: a renderer bug — or anything that reaches the
   * preload bridge — could set it and turn a deep-red BLOCK into a one-click
   * bypass. Main drops `forced` unless this is `true`, so the pair travels
   * together or the override does not happen. Never set it anywhere but the
   * ForceGate confirm handler.
   */
  confirmForce?: boolean;
  /** correlation id for the security progress feed + cancellation (§4.3). */
  runId?: string;
}

/**
 * The renderer-facing `window.prometheus.security.*` surface (file 03 §5,§7). It
 * consumes the RICH NemesisVerdict; the lightweight `gate()` on PrometheusApi
 * stays for the title-bar badge. RENDERER-FACING TYPES ONLY — the implementation
 * lives in the MAIN process (security-ipc.ts); preload forwards plain data.
 */
export interface SecurityApi {
  /**
   * Rich-gate an arbitrary target (path / git URL / pasted URL) through nemesis
   * and get the FULL NemesisVerdict (§4). Fail-closed: a missing/timed-out/
   * unparseable scanner resolves to `verdict: "error"` — the UI renders BLOCK.
   */
  gate(target: string, opts?: SecurityGateOptions): Promise<SecurityGateResult>;
  /** Alias of gate — the §4 rich gate (kept for the brief's `gateFull` name). */
  gateFull(target: string, opts?: SecurityGateOptions): Promise<SecurityGateResult>;
  /**
   * Read-only deep audit of one registry plugin (`prometheus.py audit <name>`),
   * surfaced as a rich verdict where possible (§4). No disk mutations.
   */
  audit(name: string): Promise<EnvelopeResult>;
  /**
   * Gated install (§5): the engine runs nemesis itself and returns a
   * forced_danger / ok:false envelope when blocked. The renderer must collect a
   * typed `install-dangerous` confirmation before passing `forced:true`.
   */
  install(name: string, opts?: SecurityInstallOptions): Promise<EnvelopeResult>;
  /** DISINFECT / QUARANTINE / PURGE / ACCEPT a finding (§9, §5.5). */
  remediate(req: SecurityRemediateRequest): Promise<SecurityRemediateResult>;
  /** Threat-DB status / update (streamed) / auth-key / cache (§6). */
  threatdb(req: SecurityThreatDbRequest): Promise<SecurityThreatDbResult>;
  /** Trusted-sources list / revoke + gate-audit log + verify (§8). */
  trust(req: SecurityTrustRequest): Promise<SecurityTrustResult>;
  /**
   * URL-injection L5: re-scan installed external sources (SKILL.md/AGENTS.md/MCP),
   * list the quarantine vault, or restore a quarantined source. Drift that re-gates
   * dangerous is quarantined fail-closed + reversible (url_injection_safeguard.md §9).
   */
  urlAudit(req: SecurityUrlAuditRequest): Promise<SecurityUrlAuditResult>;
  /**
   * Subscribe to the security progress feed (threat-DB update / disinfect lines).
   * Returns an unsubscribe fn. Cosmetic only — never a verdict (C5).
   */
  onProgress(listener: (event: ProgressFeedEvent) => void): () => void;
}

/* ── env: the Package & Environment Manager surface (file 04 §1,§3) ─────────
 * These shapes carry the env list / package list / gpu info / gated-install
 * results the Environments tab renders. Every payload is PLAIN DATA the MAIN
 * process obtained from engine-bridge's env client (the only python3 spawner).
 * A blocked/error install arrives as `ok:false, blocked:true` with the engine's
 * gate verdict attached — a VALID render target, never a thrown error and never
 * upgraded toward "allow" (C5/the SPINE).
 */

/** The camelCased gate summary an env install result carries (mirror of engine-bridge). */
export interface EnvGateSummary {
  verdict: "allow" | "warn" | "block" | "error";
  score: number;
  reasons: string[];
  signed: boolean;
  recommendation?: string;
  scannedAt?: string;
}

/** Response to `env:list`: the detected envs (engine-bridge `Env[]`, plain data). */
export interface EnvListResult {
  ok: boolean;
  envs: Record<string, unknown>[];
  error?: string;
}

/** Response to `pkg:list`: the env's packages (engine-bridge `Package[]`, plain data). */
export interface PkgListResult {
  ok: boolean;
  packages: Record<string, unknown>[];
  error?: string;
}

/** Response to `cuda:info`: the host GpuInfo (engine-bridge `GpuInfo`, plain data). */
export interface CudaInfoResult {
  ok: boolean;
  gpu?: Record<string, unknown>;
  error?: string;
}

/**
 * The unified gated-install result (file 04 §8). EVERY outcome is a returned
 * value — `ok:false, blocked:true` is a VALID render target, NOT a thrown error.
 * The engine's gate verdict rides through in `gate`; JS never decides safe.
 */
export interface EnvGatedResult {
  ok: boolean;
  command?: string;
  installed?: boolean;
  blocked?: boolean;
  needsConfirm?: boolean;
  planned?: boolean;
  verdict?: string;
  gate?: EnvGateSummary;
  forcedDanger?: Record<string, unknown>;
  message?: string;
  error?: string;
  /** the raw envelope (escape hatch for fields not modelled above). */
  data?: Record<string, unknown>;
}

/** A plain mutation result (no gate — use/delete/enable/disable/remove/doctor/export). */
export interface EnvMutationResult {
  ok: boolean;
  command?: string;
  executed?: boolean;
  message?: string;
  error?: string;
  /** the raw envelope (carries e.g. `python` for use, `requirements` for export). */
  data?: Record<string, unknown>;
}

/** Options the renderer passes to `env.create`. */
export interface EnvCreateRequest {
  name: string;
  kind?: "venv" | "virtualenv" | "conda";
  python?: string;
  location?: "project" | "global";
  templateId?: string;
  confirm?: boolean;
}

/** Options the renderer passes to `env.clone` (GATED reinstall). */
export interface EnvCloneRequest {
  from: string;
  to: string;
  confirm?: boolean;
  force?: boolean;
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   * Main drops `force` without it — the pair travels together or the nemesis BLOCK
   * override does not happen.
   */
  confirmForce?: boolean;
}

/** Options the renderer passes to `env.import` (GATED installs). */
export interface EnvImportRequest {
  file: string;
  name: string;
  python?: string;
  confirm?: boolean;
  force?: boolean;
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   * Main drops `force` without it — the pair travels together or the nemesis BLOCK
   * override does not happen.
   */
  confirmForce?: boolean;
}

/** Options the renderer passes to a gated `pkg.install` / `pkg.update`. */
export interface PkgInstallRequest {
  envId: string;
  spec: string | string[];
  scope?: "venv" | "global" | "conda" | "project" | "engine";
  confirm?: boolean;
  force?: boolean;
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   * Main drops `force` without it — the pair travels together or the nemesis BLOCK
   * override does not happen.
   */
  confirmForce?: boolean;
  runId?: string;
}

/** Options the renderer passes to the bulk `pkg.upgrade`. */
export interface PkgUpgradeRequest {
  envId: string;
  spec?: string | string[];
  confirm?: boolean;
  force?: boolean;
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   * Main drops `force` without it — the pair travels together or the nemesis BLOCK
   * override does not happen.
   */
  confirmForce?: boolean;
  runId?: string;
}

/** Options the renderer passes to the gated `cuda.torch`. */
export interface CudaTorchRequest {
  envId: string;
  index?: string;
  confirm?: boolean;
  force?: boolean;
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   * Main drops `force` without it — the pair travels together or the nemesis BLOCK
   * override does not happen.
   */
  confirmForce?: boolean;
  runId?: string;
}

/** Options the renderer passes to the gated `cuda.install`. */
export interface CudaInstallRequest {
  toolkit?: string;
  confirm?: boolean;
  force?: boolean;
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   * Main drops `force` without it — the pair travels together or the nemesis BLOCK
   * override does not happen.
   */
  confirmForce?: boolean;
  runId?: string;
}

/**
 * The renderer-facing `window.prometheus.env.*` surface (file 04 §1,§3). It
 * consumes the env list / packages / gpu info and drives the gated lifecycle
 * verbs. RENDERER-FACING TYPES ONLY — the implementation lives in the MAIN
 * process (env-ipc.ts → engine-bridge env client); preload forwards plain data.
 * Every fetching verb's gate decision is the ENGINE's; the renderer renders it,
 * it never decides "safe" (C5/the SPINE).
 */
export interface EnvApi {
  /** List every detected env (venv + conda + engine + system). Read-only. */
  list(): Promise<EnvListResult>;
  /** Create a venv/conda env (optionally from a template). */
  create(req: EnvCreateRequest): Promise<EnvMutationResult>;
  /** Clone an env (freeze → GATED reinstall of the frozen set). */
  clone(req: EnvCloneRequest): Promise<EnvGatedResult>;
  /** Delete a studio-managed env (typed confirm collected by the renderer). */
  delete(id: string, confirm?: boolean): Promise<EnvMutationResult>;
  /** Mark an env active (the editor/terminal pick up its interpreter). */
  use(id: string): Promise<EnvMutationResult>;
  /** Export the env's requirements / conda yaml. Read-only. */
  export(id: string, to?: string): Promise<EnvMutationResult>;
  /** Create + GATED-install from a requirements.txt / environment.yml. */
  import(req: EnvImportRequest): Promise<EnvGatedResult>;
  /** Run the env health doctor (interpreter runs? pip resolves? CUDA?). Read-only. */
  doctor(id: string): Promise<EnvMutationResult>;
  /** List one env's packages. Read-only. */
  pkgList(envId: string): Promise<PkgListResult>;
  /** GATED single-package install (stage → real nemesis → gated install). */
  pkgInstall(req: PkgInstallRequest): Promise<EnvGatedResult>;
  /** GATED single-package update to latest. */
  pkgUpdate(req: PkgInstallRequest): Promise<EnvGatedResult>;
  /** GATED bulk upgrade of the outdated set (one batched gate plan). */
  pkgUpgrade(req: PkgUpgradeRequest): Promise<EnvGatedResult>;
  /** Remove a package (keeps the pin → shows absent-but-expected). No gate. */
  pkgRemove(envId: string, pkgs: string | string[], confirm?: boolean): Promise<EnvMutationResult>;
  /** Remove AND forget a package (drop pin + cache). No gate. */
  pkgUninstall(
    envId: string,
    pkgs: string | string[],
    confirm?: boolean,
  ): Promise<EnvMutationResult>;
  /** Re-enable a disabled package (re-gates from cache). */
  pkgEnable(envId: string, pkg: string, confirm?: boolean): Promise<EnvMutationResult>;
  /** Disable a package via the reversible sentinel (pin kept). No gate. */
  pkgDisable(envId: string, pkg: string, confirm?: boolean): Promise<EnvMutationResult>;
  /** Host GPU/CUDA probe (driver/runtime/toolkit/VRAM). Read-only. */
  cudaInfo(): Promise<CudaInfoResult>;
  /** GATED install of the CUDA/CPU-matched torch wheel into an env (#1 real need). */
  cudaTorch(req: CudaTorchRequest): Promise<EnvGatedResult>;
  /** CUDA toolkit install — prints the OS plan + gates any downloaded installer. */
  cudaInstall(req?: CudaInstallRequest): Promise<EnvMutationResult>;
  /**
   * Subscribe to the env/package progress feed (long install / upgrade lines).
   * Returns an unsubscribe fn. Cosmetic only — never a gate verdict (C5).
   */
  onProgress(listener: (event: ProgressFeedEvent) => void): () => void;
}

/* ── whole-machine resource telemetry (`system:telemetry`) ─────────────────────
 * Plain data the MAIN process measured natively. `usedPct` (0-100) is the primary
 * field the bars + the guard read; byte fields are present when measurable.
 */

/** One measured resource. `measured:false` ⇒ the figure is n/a (draw a dashed bar). */
export interface ResourceMeter {
  /** total capacity in bytes (absent for CPU, which is a pure percent). */
  totalBytes?: number;
  usedBytes?: number;
  freeBytes?: number;
  /** 0-100 percent occupied — the field the bars + the guard use. */
  usedPct: number;
  /** true when this is a real reading; false ⇒ "n/a"/not exposed. */
  measured: boolean;
  /** human note, e.g. "unified memory", "not exposed by OS". */
  note?: string;
}

/** A GPU row: a VRAM meter when discrete + measurable, else a unified-memory note. */
export interface GpuMeter {
  name: string;
  vendor: "nvidia" | "apple" | "amd" | "intel" | "other";
  /** discrete VRAM meter (NVIDIA); unified GPUs share system RAM → undefined. */
  vram?: ResourceMeter;
  /** GPU core utilization 0-100 when measurable (NVIDIA), else undefined. */
  utilPct?: number;
  unifiedMemory: boolean;
  note?: string;
}

/** The neural accelerator. Present today essentially never exposes utilization. */
export interface NpuInfo {
  present: boolean;
  name?: string;
  utilPct?: number;
  note?: string;
}

/** The launch-guard verdict (don't saturate the machine Prometheus runs on). */
export interface ResourceGuard {
  /** may the app launch a new heavy process (model pull/serve/runner install) now? */
  allow: boolean;
  /** the ceiling CPU% and RAM% are each checked against (percent). */
  thresholdPct: number;
  cpuPct: number;
  ramPct: number;
  /** which resource(s) tripped the block. */
  tripped: ("cpu" | "ram")[];
  /** a user-facing one-liner when blocked. */
  reason?: string;
}

/** A whole-machine telemetry snapshot (+ the launch guard verdict). */
export interface SystemTelemetry {
  ok: boolean;
  platform: string;
  arch: string;
  /** OS family label the local-model install flow discriminates on. */
  osLabel: string;
  cpu: ResourceMeter & { model?: string; cores?: number };
  ram: ResourceMeter;
  disk: ResourceMeter & { mount?: string };
  gpus: GpuMeter[];
  npu: NpuInfo;
  guard: ResourceGuard;
  /** epoch ms when the snapshot was sampled (main sets it). */
  sampledAt: number;
  error?: string;
}

/* ── the renderer-facing API contract (window.prometheus) ──────────────────
 * The shape exposed via contextBridge. preload implements it by forwarding to
 * ipcRenderer.invoke; window.d.ts declares it on `window`. Keeping it here means
 * preload and the renderer can never drift.
 */
/** The renderer-facing model-streaming surface (§9c). */
export interface AiApi {
  /**
   * Run ONE chat turn. Resolves with the turn's authoritative result; live deltas arrive on
   * `onProgress`, keyed by the same `runId`.
   */
  stream(req: AiStreamRequest): Promise<AiStreamResult>;
  /** Abort an in-flight turn (the user hit stop, or re-prompted). */
  cancel(runId: string): Promise<boolean>;
  /** Subscribe to the delta feed for ALL runs; filter by `runId`. Returns an unsubscribe. */
  onProgress(listener: (event: AiProgressEvent) => void): () => void;
  /** Task #18: probe a LOCAL runner's served models (see AiProbeModelsResult for why in MAIN). */
  probeModels(baseUrl: string): Promise<AiProbeModelsResult>;
  /** Measure ONE local model: real context window + runner capabilities (see
   *  AiProbeEndpointResult — this is what makes the effort chip work on a local model). */
  probeEndpoint(baseUrl: string, model: string): Promise<AiProbeEndpointResult>;
  /** Scan this machine for local model servers (see AiDiscoverRunnersResult). */
  discoverRunners(): Promise<AiDiscoverRunnersResult>;
  /** The external-tool inventory — the terminal's `/deps` (see HostToolsResult). */
  hostTools(): Promise<HostToolsResult>;
}

export interface PrometheusApi {
  /**
   * Whole-machine resource telemetry (CPU/GPU/NPU/RAM/DISK free+occupied) plus the
   * launch guard verdict. Read-only native probe — the renderer polls it (~2s) for
   * the bottom-bar strip + the System panel; it never reads node:os itself (C5).
   */
  systemTelemetry(): Promise<SystemTelemetry>;
  /**
   * Read-only engine/scanner health for the title-bar status pill (§4.2). Uses
   * only non-mutating probes (`--version` + `doctor`). Resolves a HealthResult
   * even when the engine is absent (ok:false), never a thrown white screen.
   */
  health(): Promise<HealthResult>;
  /** Inventory detected agents (prometheus.py scan). */
  scan(): Promise<ScanResult>;
  /**
   * Security-gate an arbitrary path / git URL / owner-repo through nemesis (C4).
   * Fail-closed: a missing/timed-out/unparseable scanner resolves to
   * `verdict: "error"` — the renderer renders BLOCK, it never assumes safe.
   */
  gate(target: string): Promise<GateResult>;
  /** List the installable plugin/agent registry (prometheus.py list). */
  list(): Promise<EnvelopeResult>;
  /** Inspect one registry plugin by NAME (prometheus.py info <name>). */
  info(name: string): Promise<EnvelopeResult>;
  /**
   * Deep-audit one plugin's install targets through nemesis (prometheus.py
   * audit <name>). Read-only — returns the worst_verdict + per-agent findings
   * the security UI renders; a blocked audit is a VALID result, not an error (C5).
   */
  audit(name: string): Promise<EnvelopeResult>;
  /**
   * Installed-state of one plugin (prometheus.py status <name>) or the whole
   * registry (`"all"`). Read-only.
   */
  status(name: string): Promise<EnvelopeResult>;
  /** Where one plugin installs across agents (prometheus.py where <name>). Read-only. */
  where(name: string): Promise<EnvelopeResult>;
  /** Plugin × agent reach matrix (prometheus.py matrix). Read-only. */
  matrix(): Promise<EnvelopeResult>;
  /** List inference providers, Tier-A first, with cost lights (C11). */
  providers(): Promise<ProvidersResult>;
  /** List Python environments via the envmgr sidecar. */
  envList(): Promise<EnvelopeResult>;
  /** Probe host hardware for model-fit scoring via the modelhub sidecar. */
  modelHw(): Promise<EnvelopeResult>;
  /** Snapshot every supervised long-lived server (C8). */
  servers(): Promise<ServersResult>;
  /** Start a supervised server by its serve-profile id (C8). */
  startServer(id: string): Promise<ServersResult>;
  /** Stop a supervised server by id (C8). */
  stopServer(id: string): Promise<ServersResult>;

  /* ── the file 01 §5 full preload surface ────────────────────────────────
   * `install`, `env`, `model`, `provider`, `version`, `onProgress` round out
   * the exact narrow contextBridge contract the brief enumerates. The plural
   * `providers`/`envList`/`modelHw` above are retained for the M1 panels; the
   * singular aliases below are the canonical §5 names.
   */

  /**
   * Install a registry plugin by NAME through the engine (which runs nemesis
   * itself and returns a forced_danger / ok:false envelope when blocked — JS
   * never pre-judges "safe", C5). `dryRun` previews; `forced` is the typed-confirm
   * BLOCK override the renderer must gate behind a modal.
   */
  install(name: string, opts?: InstallOptions): Promise<EnvelopeResult>;
  /**
   * Remove an installed plugin by NAME (prometheus.py uninstall <name>). `dryRun`
   * previews the removal. A state-changing op — serialised through the engine.
   */
  uninstall(name: string, opts?: UninstallOptions): Promise<EnvelopeResult>;
  /** Enable an installed plugin's component (prometheus.py enable <name>). State-changing. */
  enable(name: string, component?: "hooks" | "mcp"): Promise<EnvelopeResult>;
  /** Disable an installed plugin's component (prometheus.py disable <name>). State-changing. */
  disable(name: string, component?: "hooks" | "mcp"): Promise<EnvelopeResult>;
  /**
   * Cancel an in-flight long op by its runId (fire-and-forget, §4.3). The MAIN
   * process aborts the matching child (SIGTERM→SIGKILL). No-op for an unknown id.
   */
  cancel(runId: string): void;
  /** Alias of modelHw: probe host hardware for model-fit scoring. */
  model(): Promise<EnvelopeResult>;
  /** Alias of providers: Tier-A-first provider rows with cost lights (C11). */
  provider(): Promise<ProvidersResult>;
  /** The engine SCRIPT_VERSION (probed via `prometheus.py --version`). */
  version(): Promise<VersionResult>;
  /**
   * Subscribe to the live MAIN→renderer progress feed (parsed engine stderr).
   * Returns an unsubscribe function. Cosmetic only — never a security verdict (C5).
   */
  onProgress(listener: (event: ProgressFeedEvent) => void): () => void;

  /**
   * The FULL security surface (file 03 §5,§7): rich NemesisVerdict gating,
   * remediation (disinfect/quarantine/purge/accept), threat-DB control, and the
   * audit-log / trusted-sources views. The lightweight `gate()` above stays for
   * the title-bar badge; `security.gate()` is the rich verdict the security UI
   * renders. Every answer is engine-computed — the renderer never decides safe.
   */
  security: SecurityApi;
  /** §9c: model chat streaming, run in MAIN (see AiStreamRequest). */
  ai: AiApi;

  /**
   * The Package & Environment Manager surface (file 04 §1,§3): venv/conda CRUD,
   * the eight package lifecycle verbs, and CUDA. Every FETCHING verb routes
   * through envmgr.py's gate (stage → REAL nemesis → gated install) — the
   * renderer renders the verdict, it never decides "safe" (C5/the SPINE).
   */
  env: EnvApi;

  /**
   * The Model Hub surface (file 05 §1,§7,§8): discover / fit / download / library
   * / serve / repoint. Named `models` (the existing `model()` alias above stays
   * for the M1 hw probe). Every DOWNLOAD's gate decision is the engine's nemesis
   * (stage → REAL nemesis → admit | quarantine) — the renderer renders the
   * verdict, it never decides "safe" (C5/the SPINE). SERVE drives the MAIN-process
   * C8 ServerSupervisor (spawn + poll {base_url}/models) — the renderer supplies
   * only ids/options, never a spawnable command.
   */
  models: ModelApi;

  /**
   * The Catalog manager surface (file 06 §4): the faithful front-end over
   * prometheus.py's six registries — plugins / skills / apps / worldsim / model-
   * tools / localai. READS project to CatalogItem[] in the renderer (via
   * @prometheus/core); every STATE-CHANGING verb (install/uninstall/enable/
   * disable/bundle/sync/scaffold + apps/worldsim/models lifecycle) routes through
   * the ENGINE, which runs nemesis ITSELF — the renderer renders the verdict, it
   * never decides "safe" (C5/the SPINE). `force` is refused without the paired
   * typed-confirm (§8).
   */
  catalog: CatalogApi;

  /**
   * The GitHub Repo Manager surface (file 06 §3, FEATURE #5a / 00-INDEX C6): the
   * ONLY arbitrary-URL clone path, hard-wired through _GIT_SAFE_FLAGS + the REAL
   * nemesis gate inside the repo.py sidecar (STAGE → gate → promote | quarantine).
   * A BLOCK arrives as `ok:false, blocked, quarantined`, never promoted — the
   * renderer renders the verdict, it never decides "safe" (C5). `force` is refused
   * without the paired typed-confirm (§8).
   */
  repo: RepoApi;

  /**
   * The Code-Editor / IDE surface (file 07 §3.2/§4/§5/§6/§9): fs read/write/tree/
   * watch, the LSP host (diagnostics/completion routing), the DAP host (debug
   * sessions), node-pty terminals (venv-inheriting), the RAW git panel backend,
   * and the RUN-GATE. The MAIN process owns ALL child processes + the fs (C5); the
   * renderer drives them over IPC and never spawns a child. The run-gate reuses the
   * REAL engine-bridge nemesis gate — the renderer renders the verdict, it never
   * decides "safe" (C5/the GOLDEN RULE).
   */
  ide: IdeApi;
  /** the SQL console backend (APP-042): connect / query (paged) / schema over sqlrunner.py. */
  sql: SqlApi;

  /**
   * The file-metadata control surface (file 0C — privacy protection): inspect / scrub /
   * edit / timestomp the metadata of ONE user-selected file. The MAIN process owns the
   * fs + spawns the metadata.py sidecar (C5); mutations are plan-only without `confirm`
   * (the renderer renders the plan + collects the typed-confirm, it never silently
   * mutates). `fileOpen` is the native file picker.
   */
  metadata: MetadataApi;

  /** Native open-file picker (electron dialog) — returns the chosen path or null. */
  fileOpen(opts?: { title?: string }): Promise<FileOpenResult>;

  /** Native open-FOLDER picker (electron dialog) — for the models-root chooser. */
  folderOpen(opts?: { title?: string }): Promise<FolderOpenResult>;

  /** Open a file/folder/app with the OS default handler, OUTSIDE the app (the same as
   *  double-clicking it in Finder/Explorer) — for "open this software/folder externally". */
  openPath(path: string): Promise<OpenPathResult>;
  /**
   * REVEAL a path in the OS file manager — show it, never run it.
   *
   * Distinct from `openPath` on purpose. The quarantine vault's Inspect action needs to let
   * an operator LOOK at an artifact nemesis refused, and `openPath` is the OS's "open",
   * which would hand that artifact to its default application. Revealing is the only
   * inspect verb that is safe on a file the whole point of which is that it never executes.
   */
  revealPath(path: string): Promise<OpenPathResult>;

  /** SPECTACULAR power-up: catalog cards + chat + local-models folder + harden. */
  spectacular: SpectacularApi;

  /** MCP connectors (file 09 §2): Studio as a client of external MCP servers. */
  mcp: McpApi;
  settingsSync: SettingsSyncApi;

  /** Keyed/layered settings tree (file 13 §2.1): get/set/reset over the core layering. */
  settings: SettingsApi;

  /** The ONE saved autonomy level, the same file the `prometheus` CLI reads and writes. */
  authLevel: AuthLevelApi;

  /** The ONE saved thinking-effort tier, likewise shared with the CLI. */
  effort: EffortPrefApi;
  /**
   * The THIRD-PARTY update report — vendor CLIs, package managers, local models, Prometheus
   * itself, and the install conflicts between them.
   *
   * Deliberately NOT called `updates`: that name is already taken by `UpdatesApi`, which drives
   * electron-updater and updates Studio's own binary. The two are unrelated, and collapsing them
   * would put "quit and install Studio" next to "brew upgrade ripgrep".
   *
   * `force: true` skips the 6-hour throttle — what a "Check now" button means. That boolean is
   * the ONLY thing the renderer supplies; every command, URL and argv in the result is built in
   * the main process from core's own frozen tables.
   */
  toolUpdates: { check(force?: boolean): Promise<UpdatesReportResult> };
  /**
   * Browse installable MODELS. The query is the ONLY thing the renderer supplies; the source,
   * the URL and the fit budget are all decided in main.
   *
   * Not `catalog`: that name already belongs to `CatalogApi`, the /invoke TOOL catalogue. Two
   * unrelated catalogues under one name is the same trap `updates` vs `toolUpdates` already
   * avoided once in this file.
   */
  modelCatalog: { search(query: string): Promise<CatalogSearchResult> };

  /** The "@"-path fuzzy completion feature (shared logic with the CLI). */
  pathCompletion: PathCompletionApi;

  /** Per-endpoint transport/breaker/context-window health, surfaced in Settings. */
  modelHealth: ModelHealthApi;

  /** Scheduled/autonomous cron-triggered agent runs, surfaced in Settings. */
  schedule: ScheduleApi;

  /** Persona sharing: export/import of sub-agent persona files, surfaced in Settings. */
  persona: PersonaApi;

  /** Budget & spend visibility, surfaced in Settings. */
  budget: BudgetApi;

  /** "Meet your codebase": an on-demand first-look overview of the open workspace. */
  codebaseOverview: CodebaseOverviewApi;

  /** Extension host (file 09 §5, APP-059): install/activate/deactivate/list. */
  ext: ExtApi;

  /** Auto-updater bridge (file 10 §5, APP-005): check/download/install + event feeds.
   *  UX only — ask-before-download / never-auto-install stay enforced in MAIN. */
  updates: UpdatesApi;
}

/* ── model: the Model Hub surface (file 05 §1,§7,§8) ────────────────────────
 * The plain-data shapes the Model-Hub tab renders + the gated download / C8
 * serve results. Each is JSON-serialisable; the renderer never receives an
 * engine-bridge client, a ChildProcess, or a node:* handle. A blocked download
 * arrives as `ok:false, blocked:true` with the engine's gate verdict — a VALID
 * render target, never a thrown error and never upgraded toward "allow" (C5).
 */

/** The camelCased gate summary a model download result carries (mirror of engine-bridge). */
export interface ModelGateSummary {
  verdict: "allow" | "warn" | "block" | "error";
  score: number;
  reasons: string[];
  signed: boolean;
  recommendation?: string;
  scannedAt?: string;
}

/** Response to `model:hardware`: the host HardwareProfile (engine-bridge, plain data). */
export interface ModelHardwareResult {
  ok: boolean;
  hardware?: Record<string, unknown>;
  error?: string;
}

/** Response to `model:search` / `model:library`: discovered/installed Model[] (plain data). */
export interface ModelSearchResult {
  ok: boolean;
  models: Record<string, unknown>[];
  error?: string;
}

/** Response to `model:info`: one Model (quants populated where available). */
export interface ModelInfoResult {
  ok: boolean;
  model?: Record<string, unknown>;
  error?: string;
}

/** Response to `model:fit`: the §4 FitResult (recommended + ranked + reasons). */
export interface ModelFitResult {
  ok: boolean;
  fit?: Record<string, unknown>;
  error?: string;
}

/**
 * The unified download / gate result (file 05 §5). EVERY outcome is a returned
 * value: `admitted` (stage→live), `blocked` (nemesis BLOCK/error/sha mismatch ⇒
 * QUARANTINED), `needsConfirm` (nemesis WARN), `planned` (the resumable plan, no
 * bytes). The gate verdict rides through in `gate`; JS never decides "safe" (C5).
 */
export interface ModelDownloadResult {
  ok: boolean;
  command?: string;
  id?: string;
  localPath?: string;
  manifest?: string;
  admitted?: boolean;
  blocked?: boolean;
  needsConfirm?: boolean;
  planned?: boolean;
  verdict?: string;
  gate?: ModelGateSummary;
  formatRisk?: { highRiskFiles: string[]; safeFiles: string[]; risk: "high" | "low" };
  /** the kept-for-inspection stage dir on a refusal (never auto-deleted). */
  quarantined?: string;
  stageDir?: string;
  forcedDanger?: Record<string, unknown>;
  message?: string;
  error?: string;
  /** the raw envelope (escape hatch). */
  data?: Record<string, unknown>;
}

/** Request to install a local model via the ollama runner (`model:pull`). */
export interface ModelPullRequest {
  id: string;
  /** ollama tag override; defaults to the catalog `ollama` field or the id. */
  tag?: string;
  /** correlation id so progress events can be routed to the right UI row. */
  runId?: string;
}

/** Result of a real ollama `pull` (the actual local-model install). */
export interface ModelPullResult {
  ok: boolean;
  command?: string;
  id?: string;
  tag?: string;
  runner?: string;
  installed?: boolean;
  /** the OpenAI-compatible endpoint the model is served at on success. */
  endpoint?: string;
  /** true when the failure is "ollama runner not installed" (actionable). */
  installable?: boolean;
  install?: string;
  /** set when the launch guard refused the pull (host CPU/RAM already ≥ 90%). */
  blockedByResources?: boolean;
  /**
   * The sidecar's actionable next step when it refuses — e.g. "pick a smaller model
   * (`model fit --id <id>` lists what fits), or re-run with --force".
   *
   * The sidecar's RAM-fit guard (`modelhub.py:1131`) correctly refuses a pull that will not fit,
   * and this projection used to copy the headline sentence and drop both this and `reasons`. The
   * desktop also exposes no `force`, so the result was a refusal with no stated way forward —
   * the user is told no and not told how. The terminal has always printed both.
   */
  hint?: string;
  /** per-quantisation explanations behind a fit refusal; empty unless the guard fired. */
  reasons?: string[];
  error?: string;
}

/** Request to auto-install a local model RUNNER on the user's behalf (`model:installRunner`). */
export interface ModelInstallRunnerRequest {
  /** the runner to install — only "ollama" is supported today. */
  runner?: "ollama";
  /** correlation id so the streamed progress routes to the right UI row. */
  runId?: string;
}

/**
 * Result of running the OS-appropriate runner install (macOS `brew install ollama`
 * / Linux `curl … install.sh | sh`) ON THE USER'S BEHALF — no copy-paste. Progress
 * streams over the `model:progress` event during the run.
 */
export interface ModelInstallRunnerResult {
  ok: boolean;
  runner?: string;
  /** the OS family the command was chosen for ("macOS" | "Linux" | …). */
  os?: string;
  /** the exact command Prometheus ran on the user's behalf (for transparency). */
  command?: string;
  /** true once the runner is present on PATH after the run. */
  installed?: boolean;
  /** true when the machine needs a manual step we can't safely automate (e.g. no
   *  Homebrew on macOS) — `install`/`url` then carry the actionable fallback. */
  manual?: boolean;
  install?: string;
  url?: string;
  error?: string;
  /** set when the launch guard refused (host already saturated). */
  blockedByResources?: boolean;
}

/** A plain mutation result (model:remove / model:unserve — no gate). */
export interface ModelMutationResult {
  ok: boolean;
  command?: string;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}

/** Response to `model:ollamaStart` — see ipc-contract.ts's docstring on the channel itself
 *  for why this is separate from `ModelServeRow`/`ModelMutationResult`. */
export interface ModelOllamaStartResult {
  /** true when THIS call started it; false means it was already up (still `ok`), or refused. */
  started: boolean;
  ok: boolean;
  /** the model now being served, when one is. */
  model?: string;
  /** present only when `ok` is false — the same vocabulary `ensureOllamaRunning` returns. */
  reason?: "not-installed" | "wedged" | "start-failed" | "no-model-served" | "resource-ceiling";
  /** set only alongside reason:"resource-ceiling" — which resource, and by how much. */
  resourceReason?: string;
}

/** LM Studio's twin of `ModelOllamaStartResult` — identical shape (`ensureLmStudioRunning`
 *  returns the same `EnsureOllamaResult`-flavoured result as `ensureOllamaRunning`), named for
 *  its own channel so a caller reading `model:lmstudioStart` isn't holding an "Ollama" type. */
export type ModelLmstudioStartResult = ModelOllamaStartResult;

/**
 * Response to `model:serve` / `model:serving` / `model:unserve`: the live
 * serve-profile rows the §7 Serving panel renders, each carrying the §2.4 status
 * the MAIN-process C8 ServerSupervisor reports (stopped→starting→ready/error).
 */
export interface ModelServeRow {
  id: string;
  modelId: string;
  quant: string;
  runner: "llamacpp" | "vllm" | "ollama";
  endpoint: { host: string; port: number; baseUrl: string };
  apiKey: string;
  args: {
    ctxLen: number;
    gpuLayers?: number;
    tensorParallel?: number;
    kvCacheDtype?: "auto" | "fp8";
    maxModelLen?: number;
    servedModelName: string;
  };
  status: "stopped" | "starting" | "ready" | "error";
  external?: boolean;
  pid?: number;
  lastError?: string;
}

/** Response carrying the current set of serve-profile rows + an op error. */
export interface ModelServeResult {
  ok: boolean;
  profiles: ModelServeRow[];
  error?: string;
}

/** Response to `model:endpoints`: LIVE local + open-weight endpoints (localai). */
export interface ModelEndpointsResult {
  ok: boolean;
  local: { name: string; baseUrl: string }[];
  openApi: { name: string; baseUrl: string }[];
  engine?: string;
  error?: string;
}

/** Response to `model:repoint`: the non-secret repoint env diff (localai show). */
export interface ModelRepointResult {
  ok: boolean;
  tool?: string;
  baseUrl?: string;
  patchable?: boolean;
  recipe?: string;
  /** the NON-SECRET env to write: base-URL + dummy KEY=ollama (never a real key). */
  proposedEnv?: Record<string, string>;
  referencedEnvVars?: string[];
  secretPolicy?: string;
  engine?: string;
  error?: string;
}

/** Options the renderer passes to `model:search`. */
export interface ModelSearchRequest {
  q?: string;
  modality?: string;
  source?: "hf" | "ollama";
  freeOnly?: boolean;
  limit?: number;
}

/** Options the renderer passes to `model:fit`. */
export interface ModelFitRequest {
  id?: string;
  params?: string;
  family?: string;
  ctx?: number;
  /** an hw.scan envelope OR the fit hardware shape, as JSON (re-score a saved profile). */
  hw?: unknown;
}

/** Options the renderer passes to a gated `model:download` (stage → nemesis → admit). */
export interface ModelDownloadRequest {
  id: string;
  quant?: string;
  source?: "hf" | "ollama" | "url";
  license?: string;
  /** a dir already holding the (fetched/planted) bytes → drives the gate. */
  staged?: string;
  /** {rfilename: sha256} — verified before the scan (mismatch ⇒ BLOCK). */
  sha256?: Record<string, string>;
  /** the deep-red BLOCK override (typed-confirm collected by the renderer first). */
  force?: boolean;
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   * Main drops `force` without it — the pair travels together or the nemesis BLOCK
   * override does not happen.
   */
  confirmForce?: boolean;
  runId?: string;
}

/** Options the renderer passes to `model:serve` (drives the C8 supervisor). */
export interface ModelServeRequest {
  id: string;
  quant?: string;
  runner?: "llamacpp" | "vllm" | "ollama";
  gguf?: string;
  ctx?: number;
  port?: number;
  hw?: unknown;
  autostart?: boolean;
  runId?: string;
}

/** Options the renderer passes to `model:repoint` (§6 the free-local-model wiring). */
export interface ModelRepointRequest {
  tool: string;
  baseUrl: string;
}

/* ── /hug: fetch (if needed) → convert → install-target, one copy shared everywhere ── */

/** Options for `model:fetchHf` — the ACTUAL raw-weights fetch (via HF's own `hf` CLI). */
export interface ModelFetchHfRequest {
  repo: string;
  out?: string;
  revision?: string;
  runId?: string;
}

/** Response to `model:fetchHf`. `installable:true` ⇒ offer `model:installHfCli`. */
export interface ModelFetchHfResult {
  ok: boolean;
  repo?: string;
  path?: string;
  installable?: boolean;
  error?: string;
}

/** Response to `model:installHfCli` (`pip install huggingface_hub[cli]`, once). */
export interface ModelInstallHfCliResult {
  ok: boolean;
  installed?: boolean;
  manual?: boolean;
  install?: string;
  error?: string;
}

/** Options for `model:convert` — HF dir → GGUF (+ quantize), llama.cpp's own tools only. */
export interface ModelConvertRequest {
  src: string;
  quant?: string;
  id?: string;
  out?: string;
  runId?: string;
}

/**
 * Response to `model:convert`. `installable:true` ⇒ offer `model:installConverter`.
 * `lowDisk:true` ⇒ the 7%-floor disk guard refused BEFORE writing anything (`hint`
 * carries the actionable next step: free space / remove a model / pick another disk).
 */
export interface ModelConvertResult {
  ok: boolean;
  id?: string;
  path?: string;
  /** the canonical open_models path — a symlink to `path` when `--out` pointed elsewhere. */
  canonicalPath?: string;
  quant?: string;
  sizeBytes?: number;
  sizeGb?: number;
  installable?: boolean;
  lowDisk?: boolean;
  hint?: string;
  error?: string;
}

/** Response to `model:installConverter` (fetch llama.cpp's own converter, once). */
export interface ModelInstallConverterResult {
  ok: boolean;
  installed?: boolean;
  path?: string;
  manual?: boolean;
  install?: string;
  error?: string;
}

/** Options for `model:installTarget` — wire a converted/GGUF model into ONE runtime. */
export interface ModelInstallTargetRequest {
  target: "ollama" | "llamacpp" | "vllm" | "lmstudio";
  id: string;
  /** required for llamacpp/lmstudio/ollama — an existing GGUF path. */
  gguf?: string;
  /** required for vllm — the HF-format directory (vLLM never needs the GGUF). */
  src?: string;
  quant?: string;
  runId?: string;
}

/** Response to `model:installTarget`. Never duplicates bytes — see the sidecar's own
 *  per-target notes surfaced in `note` (e.g. "no install step needed — vLLM reads..."). */
export interface ModelInstallTargetResult {
  ok: boolean;
  target?: string;
  id?: string;
  path?: string;
  endpoint?: string;
  method?: string;
  note?: string;
  error?: string;
}

/**
 * A MAIN→renderer Model-Hub progress / status event (IPC_EVENTS.modelProgress).
 * For a download: cosmetic `{pct}` staging lines (the gate VERDICT rides back in
 * the typed result, C5). For a serve: the live §2.4 status the supervisor reports
 * (starting → ready/error) tagged with the profile id. Plain data only.
 */
export interface ModelProgressEvent {
  /** correlation id (the download/serve runId) or the serve-profile id. */
  runId?: string;
  /** the profile id when this is a serve-lifecycle event. */
  profileId?: string;
  phase: string;
  message: string;
  /** 0..100 download progress when present. */
  pct?: number;
  /** the live serve status when this is a serve event. */
  status?: "stopped" | "starting" | "ready" | "error";
  raw: string;
}

/**
 * The renderer-facing `window.prometheus.model.*` surface (file 05 §1,§7,§8).
 * RENDERER-FACING TYPES ONLY — the implementation lives in the MAIN process
 * (model-ipc.ts → engine-bridge modelhub client + the C8 ServerSupervisor);
 * preload forwards plain data. Every DOWNLOAD's gate decision is the engine's;
 * the renderer renders it, it never decides "safe" (C5/the SPINE).
 */
export interface ModelApi {
  /** REAL host hardware detection (hw.scan) → a typed HardwareProfile. Read-only. */
  hardware(rescan?: boolean): Promise<ModelHardwareResult>;
  /** Catalog search (bundled open-models.json + best-effort HF). Read-only. */
  search(req?: ModelSearchRequest): Promise<ModelSearchResult>;
  /** Model detail (quants populated where available). Read-only. */
  info(id: string): Promise<ModelInfoResult>;
  /** The Cookbook fit-score: recommended quant + ranked + reasons (§4). Read-only. */
  fit(req: ModelFitRequest): Promise<ModelFitResult>;
  /**
   * GATED download (§5): stage → REAL nemesis → admit | quarantine. A BLOCK is a
   * VALID returned value (`ok:false, blocked:true` with the gate verdict), never a
   * throw. Without `staged` it returns the resumable plan (no bytes moved).
   */
  download(req: ModelDownloadRequest): Promise<ModelDownloadResult>;
  /**
   * REAL local-model install via the ollama runner (`ollama pull`). Actually fetches +
   * serves the weights; progress streams over the `model:progress` event. Returns an
   * actionable result (`installable:true` when the ollama runner itself is missing).
   */
  pull(req: ModelPullRequest): Promise<ModelPullResult>;
  /**
   * Auto-install the local RUNNER (ollama) ON THE USER'S BEHALF — OS-aware (macOS
   * `brew install ollama` / Linux `curl … install.sh | sh`), no copy-paste. Progress
   * streams over the `model:progress` event. `manual:true` when the host needs a step
   * we won't automate (e.g. no Homebrew on macOS) — `install`/`url` carry the fallback.
   */
  installRunner(req?: ModelInstallRunnerRequest): Promise<ModelInstallRunnerResult>;
  /** Installed models in the local library (+ Ollama index). Read-only. */
  library(modality?: string): Promise<ModelSearchResult>;
  /** Remove model files (refuses if a ServeProfile references it, unless force). */
  remove(id: string, opts?: { quant?: string; force?: boolean }): Promise<ModelMutationResult>;
  /**
   * Build a ServeProfile + fit-derived argv, then drive the MAIN-process C8
   * ServerSupervisor to spawn it + poll {base_url}/models. Returns the current
   * serve rows (the started profile is `starting`; the supervisor flips it to
   * `ready` on a 200, or `error` on exit/timeout — the renderer follows via
   * `onProgress`). The runner binary is absent in this env, so it will not become
   * ready — that is EXPECTED; the status-machine is real, never faked-as-ready.
   */
  serve(req: ModelServeRequest): Promise<ModelServeResult>;
  /** Stop a served runner (SIGTERM via the supervisor). */
  unserve(profileId: string): Promise<ModelServeResult>;
  /** Force-kill a served runner: SIGKILL on the next tick, no SIGTERM grace wait. */
  kill(profileId: string): Promise<ModelServeResult>;
  /** Snapshot every serve-profile row + its live supervisor status (§7). */
  serving(): Promise<ModelServeResult>;
  /**
   * Start (or confirm already-running) the raw Ollama daemon — the same
   * `ensureOllamaRunning` a chat prompt already triggers automatically. Distinct from
   * `serve`/`unserve`/`kill` above, which drive fit-derived HF ServeProfiles instead.
   */
  ollamaStart(): Promise<ModelOllamaStartResult>;
  /** LM Studio's twin of `ollamaStart` — the same `ensureLmStudioRunning` a chat prompt against
   *  an LM Studio endpoint already triggers automatically (`lms server start`). */
  lmstudioStart(): Promise<ModelLmstudioStartResult>;
  /** LIVE local + open-weight endpoints (localai endpoints passthrough). Read-only. */
  endpoints(): Promise<ModelEndpointsResult>;
  /** LIVE repoint env diff (localai show <tool> passthrough, §6). Non-secret only. */
  repoint(req: ModelRepointRequest): Promise<ModelRepointResult>;
  /**
   * /hug — the ACTUAL raw-weights fetch for an HF repo, via HF's own `hf`/
   * `huggingface-cli` downloader (never a hand-rolled HTTP client). Feeds `convert`'s
   * `src`. `installable:true` ⇒ the hf CLI isn't on PATH yet — offer `installHfCli`.
   */
  fetchHf(req: ModelFetchHfRequest): Promise<ModelFetchHfResult>;
  /** /hug — install HF's own `hf` CLI on the user's behalf (`pip install`), once. */
  installHfCli(): Promise<ModelInstallHfCliResult>;
  /**
   * /hug — HF directory → GGUF (+ quantize), ALWAYS via llama.cpp's own tools
   * (convert_hf_to_gguf.py / llama-quantize — never re-implemented here).
   * `installable:true` ⇒ offer `installConverter`; `lowDisk:true` ⇒ the sidecar's
   * own 7%-floor disk guard refused before writing anything.
   */
  convert(req: ModelConvertRequest): Promise<ModelConvertResult>;
  /** /hug — fetch llama.cpp's OWN convert_hf_to_gguf.py (a shallow git clone), once. */
  installConverter(): Promise<ModelInstallConverterResult>;
  /**
   * /hug — wire an already-converted (or already-GGUF) model into ONE target
   * runtime (ollama / llama.cpp / vLLM / LM Studio), never duplicating the payload.
   */
  installTarget(req: ModelInstallTargetRequest): Promise<ModelInstallTargetResult>;
  /**
   * Subscribe to the Model-Hub progress / serve-status feed. Returns an
   * unsubscribe fn. Download lines are cosmetic; serve lines carry the live §2.4
   * status — but NEVER a security verdict (C5).
   */
  onProgress(listener: (event: ModelProgressEvent) => void): () => void;
}

/* ── catalog: the catalog manager surface (file 06 §4) ──────────────────────
 * The plain-data shapes the Catalog browser renders. JSON-envelope READS ride
 * back as the raw engine envelope in `data` (the renderer projects them via
 * @prometheus/core normalize); HUMAN-TABLE reads (apps/worldsim/models/localai/
 * inventory — which print tables, no JSON) ride back as `lines`. STATE-CHANGING
 * verbs return the engine envelope + the surfaced `forcedDanger`. A blocked
 * install arrives as `ok:false` with `forcedDanger` set when forced — a VALID
 * render target, never a thrown error and never upgraded toward "allow" (C5).
 */

/** A JSON-envelope catalog read/mutation result (list/info/where/matrix/status/…). */
export interface CatalogEnvelopeResult {
  ok: boolean;
  /** the raw engine JSON envelope (structured-clone safe). */
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * The PROJECTED catalog (file 06 §2,§4): the MAIN process runs `list` + `matrix`
 * (+ `status all`) and projects the engine JSON into CatalogItem[] via the PURE
 * @prometheus/core normalize/reconcile — so the sandboxed renderer renders PLAIN
 * DATA and never bundles the Node-only core barrel (C5). `CatalogManagerItem` is a
 * type-only re-export (erased at compile time); the engine stays authoritative.
 */
export interface CatalogBrowseResult {
  ok: boolean;
  /** the rich CatalogItem[] the browser renders (plugins + documented, sorted). */
  items: CatalogManagerItem[];
  /** the detected agents (for the Reach Matrix columns). */
  agents?: string[];
  error?: string;
}

/**
 * A HUMAN-TABLE catalog read result (apps/worldsim/models list, localai *,
 * inventory). The engine prints a table on stdout with no JSON envelope; the
 * MAIN process returns the ANSI-stripped non-empty lines verbatim + the engine
 * that actually ran. Read-only — no security decision is made here (C5).
 */
export interface CatalogRawResult {
  ok: boolean;
  command: string;
  action?: string;
  lines: string[];
  engine?: string;
  error?: string;
  /** the full raw stdout (escape hatch). */
  raw?: string;
}

/** The camelCased forced-danger flag a gated install/bundle surfaces (mirror of C3). */
export interface CatalogForcedDanger {
  label: string;
  verdict: "block" | "error";
  riskScore?: number;
  blockingReasons: string[];
}

/**
 * The unified install / uninstall / bundle result (file 06 §4.3). The engine runs
 * nemesis ITSELF (prepare_nemesis → enforce_gate on each git_clone target) and
 * returns this envelope; a BLOCK force-installed via `--force` sets `ok:false` +
 * `forcedDanger` (the GUI renders the persistent deep-red card banner, §4.3). JS
 * never pre-judges "safe" (C5); `forcedDanger` is a RETURNED value, not a throw.
 */
export interface CatalogInstallResult {
  ok: boolean;
  command?: string;
  /** the per-target install events the engine emitted (_install_events_json). */
  installEvents?: Record<string, unknown>[];
  /** the summary block (counts of installed/blocked/skipped). */
  summary?: Record<string, unknown>;
  /** present iff a `--force` overrode a nemesis BLOCK (§4.3). */
  forcedDanger?: CatalogForcedDanger[];
  message?: string;
  error?: string;
  /** the raw engine envelope (escape hatch). */
  data?: Record<string, unknown>;
}

/** Options the renderer passes to `catalog.install` (file 06 §4.2 surgical surface). */
export interface CatalogInstallRequest {
  name: string;
  /** restrict to detected agents (the `--host` fan-out). */
  host?: string[];
  /** install ONLY these components (comma-sep, the `:sel`/`--only` surgical form). */
  only?: string;
  /** install all EXCEPT these (comma-sep, `--skip`). */
  skip?: string;
  /** auto-arm: write enabledPlugins + extraKnownMarketplaces (`--arm`). */
  arm?: boolean;
  /** preview the plan + verdict, change nothing (`--dry-run`). DEFAULT true. */
  dryRun?: boolean;
  /** non-interactive accept (`--yes`). DEFAULT false. */
  yes?: boolean;
  /** treat MEDIUM findings as block-worthy (`--strict`). */
  strict?: boolean;
  /**
   * the deep-red BLOCK override (`--force`). HONOURED ONLY when `confirmForce` is
   * ALSO true — the renderer must FIRST capture the typed-confirm (file 03's flow);
   * the MAIN process drops `force` without the paired confirm (C5/§8).
   */
  force?: boolean;
  /** the paired typed-confirm token that unlocks `force` (§8). */
  confirmForce?: boolean;
  runId?: string;
}

/** Options the renderer passes to `catalog.uninstall` (subset removal). */
export interface CatalogUninstallRequest {
  name: string;
  host?: string[];
  only?: string;
  skip?: string;
  dryRun?: boolean;
  yes?: boolean;
  runId?: string;
}

/** Options the renderer passes to `catalog.enable` / `catalog.disable`. */
export interface CatalogToggleRequest {
  name: string;
  only?: string;
  component?: "hooks" | "mcp";
  host?: string[];
}

/** Options the renderer passes to `catalog.bundle` (the one-run official set). */
export interface CatalogBundleRequest {
  host?: string[];
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  confirmForce?: boolean;
  runId?: string;
}

/** Options the renderer passes to `catalog.scaffoldSkill`. */
export interface CatalogScaffoldRequest {
  name: string;
  /** the TRIGGER — written as "Use when …" (sharper = more reliable auto-fire). */
  trigger?: string;
  body?: string;
  tools?: string;
  /** model-invocable auto-fire. DEFAULT true; false ⇒ manual /name only. */
  autoFire?: boolean;
}

/** Options the renderer passes to a catalog app/worldsim/model lifecycle action. */
export interface CatalogAppLifecycleRequest {
  surface: "apps" | "worldsim" | "models";
  /** install/uninstall/update/update-all/enable/disable/restart/status/logs/open/versions/rollback. */
  action: string;
  tool?: string;
  path?: string;
  version?: string;
  runId?: string;
}

/** Options the renderer passes to a HUMAN-TABLE catalog read. */
export interface CatalogRawRequest {
  surface: "apps" | "worldsim" | "models" | "localai";
  /** apps/worldsim read action (list/installed/status/logs/versions). */
  action?: string;
  tool?: string;
  path?: string;
  version?: string;
  /** localai sub-read (audit/models/endpoints/show). */
  localaiAction?: "audit" | "models" | "endpoints" | "show";
}

/**
 * A MAIN→renderer Catalog/Repo progress event (IPC_EVENTS.catalogProgress). A
 * long install/uninstall/bundle/lifecycle streams the engine's parsed stderr
 * lines here; a repo clone/update streams its staging + gate lines. Plain data,
 * cosmetic only — the gate VERDICT rides back in the typed result (C5).
 */
export interface CatalogProgressEvent {
  runId?: string;
  phase: string;
  message: string;
  raw: string;
}

/**
 * The renderer-facing `window.prometheus.catalog.*` surface (file 06 §4).
 * RENDERER-FACING TYPES ONLY — the implementation lives in the MAIN process
 * (catalog-ipc.ts → engine-bridge catalog + lifecycle clients); preload forwards
 * plain data. Every STATE-CHANGING verb's gate decision is the engine's nemesis;
 * the renderer renders it, it never decides "safe" (C5/the SPINE). The MAIN
 * process REFUSES `force` without the paired `confirmForce` (§8).
 */
export interface CatalogApi {
  /**
   * The PROJECTED catalog (§4): the MAIN process runs `list` + `matrix` (+ status)
   * and returns the rich CatalogItem[] projected via the PURE @prometheus/core
   * normalize — so the sandboxed renderer renders plain data and never bundles the
   * Node-only core barrel (C5). Read-only.
   */
  browse(): Promise<CatalogBrowseResult>;
  // ── raw JSON-envelope reads (escape hatch / power use) ────────────────────
  /** `list` → the raw six-registry catalog + detected agents envelope. Read-only. */
  list(): Promise<CatalogEnvelopeResult>;
  /** `info <name>` → the full Plugin detail. Read-only. */
  info(name: string): Promise<CatalogEnvelopeResult>;
  /** `where <name>` → per-agent install destinations. Read-only. */
  where(name: string): Promise<CatalogEnvelopeResult>;
  /** `matrix` → the plugin × agent reach matrix. Read-only. */
  matrix(): Promise<CatalogEnvelopeResult>;
  /** `status <name|"all">` → install + enabled/disabled per component. Read-only. */
  status(name: string): Promise<CatalogEnvelopeResult>;
  /**
   * `audit <name>` (scan, no install) → the nemesis verdict + findings. The
   * verdict the engine/nemesis returns rides through UNCHANGED; JS never
   * recomputes it (C5). `--strict`/`--gate-fresh` are GLOBAL flags.
   */
  audit(
    name: string,
    opts?: { strict?: boolean; gateFresh?: boolean },
  ): Promise<CatalogEnvelopeResult>;
  /** `superscan` → the deep per-agent install census. Read-only. */
  superscan(): Promise<CatalogEnvelopeResult>;
  /** `skills list` → on-disk SKILL.md folders + state. Read-only. */
  skillsList(): Promise<CatalogEnvelopeResult>;
  /** `vault status` → the archive snapshot state. Read-only. */
  vaultStatus(): Promise<CatalogEnvelopeResult>;
  // ── human-table reads (apps/worldsim/models list, localai *, inventory) ───
  /** `inventory [--host]` → ALL installed (managed + foreign). Read-only. */
  inventory(host?: string): Promise<CatalogRawResult>;
  /** apps/worldsim/models human-table READS + localai * (no JSON envelope). */
  raw(req: CatalogRawRequest): Promise<CatalogRawResult>;
  // ── state-changing (every mutation gated through nemesis by the engine) ───
  /**
   * `install <name>` (the gated install). Defaults `dryRun:true` so the FIRST
   * call previews the plan + verdict; the renderer renders it, then re-calls with
   * `dryRun:false, yes:true` only after the human OK. A BLOCK is a VALID returned
   * value (`ok:false` + `forcedDanger` when forced), never a throw (C5).
   */
  install(req: CatalogInstallRequest): Promise<CatalogInstallResult>;
  /** `uninstall <name>` (+host/only/skip). Defaults `dryRun:true`. */
  uninstall(req: CatalogUninstallRequest): Promise<CatalogInstallResult>;
  /** `enable <name>` (+only/component/host). State-changing. */
  enable(req: CatalogToggleRequest): Promise<CatalogEnvelopeResult>;
  /** `disable <name>` (reversible; same flags). State-changing. */
  disable(req: CatalogToggleRequest): Promise<CatalogEnvelopeResult>;
  /** `bundle` — install the one-run official Anthropic set. Gated. */
  bundle(req?: CatalogBundleRequest): Promise<CatalogInstallResult>;
  /** `sync <skill> --to <agent>` — replicate a SKILL.md cross-CLI. */
  sync(skill: string, to: string): Promise<CatalogEnvelopeResult>;
  /** `scaffold-skill <name>` — write an auto-firing SKILL.md. */
  scaffoldSkill(req: CatalogScaffoldRequest): Promise<CatalogEnvelopeResult>;
  /**
   * apps/worldsim/models LIFECYCLE (4th/8th/3rd fn). The engine gates the git-
   * clone/compose/model fetch through nemesis itself (C5). Returns the engine
   * envelope (JSON when the verb emits one, else the human stdout echoed).
   */
  appLifecycle(req: CatalogAppLifecycleRequest): Promise<CatalogEnvelopeResult>;
  /**
   * Subscribe to the Catalog/Repo progress feed. Returns an unsubscribe fn. The
   * lines are cosmetic — NEVER a security verdict (C5).
   */
  onProgress(listener: (event: CatalogProgressEvent) => void): () => void;
}

/* ── repo: the GitHub Repo Manager surface (file 06 §3 / FEATURE #5a) ───────
 * The plain-data shapes the Repo manager renders. The clone/update/pin/branch
 * path STAGES with _GIT_SAFE_FLAGS, runs the REAL nemesis on the staged tree, and
 * promotes | quarantines on the verdict — all inside the repo.py sidecar (the ONLY
 * arbitrary-URL clone path, 00-INDEX C6). A BLOCK arrives as `ok:false, blocked,
 * quarantined`, never promoted, never a throw, never upgraded toward "allow" (C5).
 */

/** The camelCased gate summary a repo clone/update/rescan carries (mirror engine-bridge). */
export interface RepoGateSummary {
  verdict: VerdictTier;
  score: number;
  reasons: string[];
  signed: boolean;
  recommendation?: string;
  scannedAt?: string;
}

/** The signed verdict ref bound to the cloned commit (extends the C3 ref). */
export interface RepoVerdictRef extends NemesisVerdictRef {
  commit?: string;
}

/** The forced-override flag a repo op surfaces when a block/error/warn was forced. */
export interface RepoForcedDanger {
  label: string;
  verdict: string;
  riskScore?: number;
  blockingReasons: string[];
}

/** A Studio-managed repo row (mirror of the engine-bridge / core CatalogRepo). */
export interface RepoRow {
  id: string;
  url: string;
  owner: string;
  name: string;
  localPath: string;
  branch: string;
  pinnedCommit?: string;
  commit?: string;
  lastFetched?: string;
  lastVerdict?: RepoVerdictRef;
  status: RepoStatus;
  linkedCatalogItemId?: string;
}

/**
 * The unified clone / update / pin / branch result (file 06 §3.1). EVERY outcome
 * is a RETURNED value: `promoted` (staged→live), `blocked` (nemesis BLOCK/error ⇒
 * QUARANTINED, not promoted), `needsConfirm` (nemesis WARN, no force). The gate
 * verdict rides through in `gate`/`verdictRef`; JS never decides "safe" (C5).
 */
export interface RepoCloneResult {
  ok: boolean;
  command?: string;
  id?: string;
  url?: string;
  owner?: string;
  name?: string;
  branch?: string;
  pinnedCommit?: string;
  commit?: string;
  localPath?: string;
  promoted?: boolean;
  blocked?: boolean;
  needsConfirm?: boolean;
  status?: RepoStatus;
  verdict?: VerdictTier;
  gate?: RepoGateSummary;
  verdictRef?: RepoVerdictRef;
  /** the kept-for-inspection quarantine dir on a refusal (never auto-deleted). */
  quarantined?: string;
  stageDir?: string;
  forcedDanger?: RepoForcedDanger;
  message?: string;
  error?: string;
}

/** The list result (every Studio-managed repo, on-disk status reconciled). */
export interface RepoListResult {
  ok: boolean;
  repos: RepoRow[];
  error?: string;
}

/** The rescan result (re-run the gate over the live tree; no fetch, no promote). */
export interface RepoRescanResult {
  ok: boolean;
  id?: string;
  verdict?: VerdictTier;
  gate?: RepoGateSummary;
  verdictRef?: RepoVerdictRef;
  gateFresh?: boolean;
  status?: RepoStatus;
  localPath?: string;
  message?: string;
  error?: string;
}

/** The remove result (drop the clone dir + index entry; idempotent on unknown id). */
export interface RepoRemoveResult {
  ok: boolean;
  id?: string;
  removedDir?: boolean;
  removedEntry?: boolean;
  found?: boolean;
  localPath?: string;
  error?: string;
}

/** Options the renderer passes to `repo.clone`. */
export interface RepoCloneRequest {
  url: string;
  branch?: string;
  /** detached-checkout this SHA on clone (the explicit pin). */
  pin?: string;
  /** a dir already holding the (fetched/planted) bytes → drives the gate offline. */
  staged?: string;
  /** if this clone backs a catalog git_clone install, the catalog item id. */
  linkedCatalogItemId?: string;
  /** the deep-red BLOCK override — HONOURED ONLY with the paired `confirmForce` (§8). */
  force?: boolean;
  confirmForce?: boolean;
  runId?: string;
}

/**
 * The renderer-facing `window.prometheus.repo.*` surface (file 06 §3).
 * RENDERER-FACING TYPES ONLY — the implementation lives in the MAIN process
 * (repo-ipc.ts → engine-bridge repo client → repo.py sidecar). The gate decision
 * is the REAL nemesis inside the sidecar; the renderer renders the verdict, it
 * never decides "safe" (C5). The MAIN process REFUSES `force` without
 * `confirmForce` (§8).
 */
export interface RepoApi {
  /** Clone an arbitrary GitHub URL: STAGE → REAL nemesis → promote | quarantine. */
  clone(req: RepoCloneRequest): Promise<RepoCloneResult>;
  /** List every Studio-managed repo (on-disk status reconciled). Read-only. */
  list(): Promise<RepoListResult>;
  /** Re-stage the new HEAD under safe flags → re-gate → promote on allow (pin-aware). */
  update(id: string, opts?: { force?: boolean; confirmForce?: boolean }): Promise<RepoCloneResult>;
  /** Detached `--pin` checkout under safe flags → re-gate the pinned tree. */
  pin(
    id: string,
    sha: string,
    opts?: { force?: boolean; confirmForce?: boolean },
  ): Promise<RepoCloneResult>;
  /** Switch branch under safe flags → re-gate (clears the pin). */
  branch(
    id: string,
    branch: string,
    opts?: { force?: boolean; confirmForce?: boolean },
  ): Promise<RepoCloneResult>;
  /** Re-run the REAL nemesis over the live tree (no fetch, no promote); refresh the ref. */
  rescan(id: string, opts?: { gateFresh?: boolean }): Promise<RepoRescanResult>;
  /** Drop the clone dir + index entry (idempotent-ok on an unknown id). */
  remove(id: string): Promise<RepoRemoveResult>;
}

/* ── ide: the Code-Editor / IDE surface (file 07 §3.2/§4/§5/§6/§9) ──────────
 * The plain-data shapes the editor renders. The MAIN process owns ALL child
 * processes (LSP/DAP/PTY/git) + the fs (C5); the renderer drives the hosts over
 * `ide:*` channels and never spawns a child. The RUN-GATE result carries a
 * RENDERED engine verdict — JS never decides "safe" (C5). Every payload is
 * JSON-serialisable; no live handle / ChildProcess / node:* ever crosses.
 */

/** One file-tree node (lazy: a dir's children load on expand). */
export interface IdeTreeNode {
  path: string;
  name: string;
  kind: "file" | "dir";
  hasChildren?: boolean;
}

/**
 * Response to `authLevel:get` / `authLevel:set`.
 *
 * `level` is null from `get` only when nothing has ever been saved — the caller then keeps its
 * own default rather than being handed one, so "never set" and "set to the default" stay
 * distinguishable.
 */
export interface AuthLevelResult {
  ok: boolean;
  level: number | null;
  /** the file consulted, for the settings UI and for support questions. */
  path?: string;
  error?: string;
}

/**
 * Response to `effort:get` / `effort:set`.
 *
 * `tier` is null from `get` only when nothing has ever been saved, so the caller keeps its own
 * default rather than being handed one. The tier here is always the REQUESTED one — what a
 * given model does with it is resolved per request and never stored.
 */
/**
 * One tool, as the renderer needs it.
 *
 * A FLATTENED projection of core's `ToolUpdateStatus`, not the type itself: the contextBridge
 * carries structured-clone data, and shipping core's shape across would couple the sandboxed
 * renderer to a module it must never import.
 */
export interface UpdateToolView {
  id: string;
  label: string;
  role: string;
  installed: boolean;
  /** single | duplicate | shadowed | ambiguous | absent. */
  state: string;
  current: string | null;
  latest: string | null;
  /** `null` = could not check. Distinct from `false` = nothing newer. */
  updateAvailable: boolean | null;
  source?: string;
  /** copyable commands that target the copy on PATH. */
  offer: { command: string; note?: string }[];
  /** commands that exist but act on a DIFFERENT copy, with the reason. */
  withheld: { command: string; reason: string }[];
  /** every install found, PATH order; `copies[0]` is what runs. */
  copies: { path: string; realPath: string; owner: string; version?: string }[];
  note?: string;
}

/** A package one of the machine's managers reports as upgradable. */
export interface UpdatePackageView {
  manager: string;
  managerLabel: string;
  name: string;
  installed?: string;
  available?: string;
  pinned?: boolean;
  /** the exact command for THIS package, with the manager's own flags. */
  command: string | null;
}

/** Where a manager's offer and the machine's reality disagree. */
export interface UpdateConflictView {
  kind: string;
  subject: string;
  summary: string;
  consequence: string;
  remedy?: string;
  /** a command that looks right and is not — named so the user does not find it elsewhere. */
  avoid?: string;
  severity: "high" | "medium" | "low";
}

/** One catalogue row, flattened for the sandboxed renderer. */
export interface CatalogRowView {
  id: string;
  name: string;
  source: string;
  summary: string;
  /** the download size, or null when the source publishes none — NEVER 0 for unknown. */
  sizeBytes: number | null;
  parameters?: string;
  contextTokens?: number;
  license?: string;
  downloads?: number;
  installed: boolean;
  /** fits | tight | too-big | unknown — computed in MAIN against the real memory probe. */
  fit: string;
  /** why it cannot run here. Set only when `fit` is "too-big". */
  blocked?: string;
  /** the exact `ollama pull` line, or null when there is no automatic route. */
  command: string | null;
  /** the tag to hand `/updates pull`. */
  tag: string;
  /** pre-formatted detail lines for the row's expanded view. */
  body: string[];
}

export interface CatalogSearchResult {
  ok: boolean;
  /** "" on success. NEVER an empty list passed off as "nothing matched". */
  error: string;
  rows: CatalogRowView[];
  /** what the machine can actually offer a model, after headroom. */
  usableBytes: number;
  /** HuggingFace's remaining request budget, when it said. */
  rateRemaining?: number;
}

export interface UpdatesReportResult {
  ok: boolean;
  error?: string;
  /** ISO timestamp of the check that produced this. */
  checkedAt?: string;
  /** true when this came from the ≤6h cache rather than a fresh sweep. */
  fromCache?: boolean;
  conflicts: UpdateConflictView[];
  tools: UpdateToolView[];
  packages: UpdatePackageView[];
  /** managers that could not be asked, or that failed — never folded into "up to date". */
  unavailableManagers: { manager: string; label: string; reason: string }[];
  models: { name: string; changed: boolean; newer: boolean; command: string; blockedBy?: string }[];
  self: {
    version: string;
    engine?: string;
    latest?: string;
    /** `null` = the lookup failed. */
    updateAvailable: boolean | null;
    command: string;
    steps: string[];
  };
  /** the one-line summary, identical to the terminal's startup nudge. */
  summary: string;
  /**
   * EXECUTABLE repair plans for the conflicts above — the terminal's `/updates fix`, in Studio.
   *
   * `UpdateConflictView` already carried two ADVISORY strings (`remedy`, `avoid`). These are the
   * other thing: argv the user can actually run, with the undo, the verification command, and
   * what the repair deliberately leaves alone.
   *
   * They were computed and thrown away. `updates-live/check.ts:385` builds them on every sweep
   * and attaches them at `:420`; this projection simply never read the field, so the whole
   * feature was terminal-only while the app re-ran the same expensive check to produce it.
   */
  remedies: UpdateRemedyView[];
  /**
   * Commands that must NEVER be offered, with the reason — `core`'s `NEVER_RUN`, verbatim.
   *
   * Shipped WITH the repairs, not instead of them, which is the terminal's rule and is
   * load-bearing: the user who is not told why `--zap` is dangerous will find it in a forum
   * answer and reach for it precisely because it sounds thorough. On this machine that one
   * deletes the vendor Claude install (1.2 GB, all five builds) plus `~/.claude.json*`.
   */
  neverRun: { command: string; because: string }[];
}

/** One step of a repair plan. `argv` is never joined into a shell string. */
export interface UpdateRemedyStepView {
  /** display form of the argv, shell-quoted for READING — not for execution. */
  command: string;
  purpose: string;
  risk: string;
  /** display form of the undo argv, when the step has one. */
  undo?: string;
  /**
   * A readable stand-in when the argv is correct but unreadable — the shell-init append is the
   * one real case. See `RemedyStep.displayAs` in core.
   */
  displayAs?: string[];
}

/** One conflict's repair plan. Mirrors core's `Remedy`, flattened for the bridge. */
export interface UpdateRemedyView {
  kind: string;
  subject: string;
  title: string;
  rationale: string;
  steps: UpdateRemedyStepView[];
  /** the command that PROVES the repair worked — every conflict here came from a command that
   *  reported success while changing nothing. */
  verify?: string;
  /** what the repair deliberately does not touch. */
  keeps?: string;
  /** authorisation rung required on the 0–7 ladder. */
  minAuthLevel: number;
  /** set when the repair must NOT be offered as executable; shown INSTEAD of the steps. */
  blocked?: string;
  /** true when running this makes the conflict stop being true, not merely stop being shown. */
  permanent: boolean;
}

export interface EffortPrefResult {
  ok: boolean;
  tier: string | null;
  /** the file consulted, for the settings UI and for support questions. */
  path?: string;
  error?: string;
}

/** Response to `ide:fs.read`. */
export interface IdeFsReadResult {
  ok: boolean;
  text?: string;
  encoding?: string;
  /** true when the file exceeds the large-file threshold (read-only, no-LSP, §3.1). */
  large?: boolean;
  error?: string;
}

/**
 * Response to `ide:steering.global` — the loaded `~/.prometheus` rule files.
 *
 * A dedicated channel rather than `fsRead` because the renderer does not know (and must not be
 * told how to construct) the home path: `fsRead` takes a `file://` URI that main path-guards,
 * and teaching it to expand `~` would widen that guard for every caller. Main resolves
 * `prometheusHome()` itself and hands back only these two files.
 */
export interface IdeSteeringGlobalResult {
  ok: boolean;
  sources: { kind: "agents" | "claude"; path: string; content: string }[];
  error?: string;
}

/** A generic plain ok/err for fs write / watch / pty write etc. */
export interface IdeOkResult {
  ok: boolean;
  error?: string;
  /**
   * Roots a PARTIALLY successful `ide:workingSet.set` refused.
   *
   * `ok:true` with some roots dropped is still a narrower scope than the renderer asked for, and
   * the caller could not tell: the refusals only reached main's stderr via `console.warn`, which
   * no user sees. Present only when non-empty.
   */
  refused?: readonly string[];
}

/** Response to `ide:lsp.ensure`: the stable serverId the renderer routes through. */
export interface IdeLspEnsureResult {
  ok: boolean;
  serverId?: string;
  error?: string;
}

/** One live LSP server (APP-077 federation). */
export interface IdeLspServerInfo {
  serverId: string;
  languageId: string;
  workspaceRoot: string;
  /** "starting" | "running" | "restarting" | "failed" | "stopped". */
  state: string;
}

/** Response to `ide:lsp.list`: every server the host currently tracks. */
export interface IdeLspListResult {
  ok: boolean;
  servers: IdeLspServerInfo[];
  error?: string;
}

/** Response to `ide:lsp.request`: the (id, result) so the renderer can cancel by id. */
export interface IdeLspRequestResult {
  ok: boolean;
  /** the LSP request id (for a later `ide:lsp.cancel`); -1 when the server was unknown. */
  requestId: number;
  /** the LSP result, structured-clone safe. */
  result?: unknown;
  error?: string;
}

/** One adapter exception-breakpoint filter (from the initialize capabilities, APP-079). */
export interface IdeDapExceptionFilter {
  filter: string;
  label: string;
  description?: string;
  default?: boolean;
  supportsCondition?: boolean;
}

/** The DAP `initialize` capabilities the debugger surface gates on (APP-079). */
export interface IdeDapCapabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsHitConditionalBreakpoints?: boolean;
  supportsLogPoints?: boolean;
  supportsExceptionFilterOptions?: boolean;
  /** the adapter honours `setVariable` — drives the editable variables tree (APP-080). */
  supportsSetVariable?: boolean;
  exceptionBreakpointFilters?: IdeDapExceptionFilter[];
}

/** Non-DAP options for `ide:dap.launch` (APP-080) — never forwarded to the adapter. */
export interface IdeDapLaunchOptions {
  /** the user confirmed a REMOTE (non-loopback) attach via the typed-confirm sheet. */
  allowRemote?: boolean;
}

/** One source's launch-time breakpoints in the launch plan (APP-079). */
export interface IdeDapSourcePlan {
  path: string;
  breakpoints: { line: number; condition?: string; hitCondition?: string; logMessage?: string }[];
}

/** The launch-time config plan the renderer hands the host so the host sequences the
 *  strict `initialized`→setBreakpoints/setExceptionBreakpoints→configurationDone phase. */
export interface IdeDapLaunchPlan {
  sources?: IdeDapSourcePlan[];
  exceptionFilters?: string[];
}

/** Response to `ide:dap.launch`. */
export interface IdeDapLaunchResult {
  ok: boolean;
  sessionId?: string;
  /** the adapter's initialize capabilities (drives exception-filter + logpoint UI). */
  capabilities?: IdeDapCapabilities;
  error?: string;
}

/** Response to a `ide:dap.request`. */
export interface IdeDapRequestResult {
  ok: boolean;
  body?: unknown;
  error?: string;
}

/** Response to `ide:dap.detect-adapter` (APP-029) — a REAL probe, never a guess. */
export interface IdeDapDetectAdapterResult {
  ok: boolean;
  type: string;
  available: boolean;
  detail: string;
}

/** Response to `ide:dap.install-adapter` (APP-029) — nemesis-gated, C5 fail-closed. */
export interface IdeDapInstallAdapterResult {
  ok: boolean;
  /** true when nemesis blocked the staged download — never installed. */
  blocked?: boolean;
  /** true on a WARN verdict awaiting a re-call with `confirm: true`. */
  needsConfirm?: boolean;
  output: string;
  error?: string;
}

/* ── ide:refactor (APP-026) — refactor.py structural transforms ─────────────*/

/** Common editor-coordinate fields (1-based line, 1-based UTF-16 col). */
interface IdeRefactorPos {
  file: string;
  line: number;
  col: number;
  /** rope project root (defaults sidecar-side to the file's directory). */
  root?: string;
}

/** `rename` — rope Rename of the symbol under line/col. */
export interface IdeRefactorRenameReq extends IdeRefactorPos {
  newName: string;
}
/** `extract` — rope ExtractMethod/ExtractVariable over a 1-based line span. */
export interface IdeRefactorExtractReq {
  file: string;
  startLine: number;
  endLine: number;
  name: string;
  kind?: "method" | "variable";
  /** optional 1-based inclusive cols narrowing the span to an expression. */
  startCol?: number;
  endCol?: number;
  root?: string;
}
/** `inline` — rope inline of the symbol under line/col. */
export type IdeRefactorInlineReq = IdeRefactorPos;
/** `move` — move a top-level def/class to an EXISTING module. */
export interface IdeRefactorMoveReq {
  file: string;
  symbol: string;
  dest: string;
  root?: string;
}
/** `change-signature` — order/remove speak ORIGINAL 0-based param indices. */
export interface IdeRefactorChangeSignatureReq extends IdeRefactorPos {
  order: number[];
  remove?: number;
}
/** `safe-delete` — line/col must point at the def/class NAME. */
export type IdeRefactorSafeDeleteReq = IdeRefactorPos;

/* gen-* generator verbs (APP-028) — single-file AST inserts; `line` is any 1-based
 * line INSIDE the target class (def for gen-docstring); no `root`. */

/** `gen-init`/`gen-repr`/`gen-eq` — optional explicit attribute selection. */
export interface IdeRefactorGenFieldsReq {
  file: string;
  line: number;
  attrs?: string[];
}
/** `gen-dataclass`/`gen-docstring` — the location alone. */
export interface IdeRefactorGenAtReq {
  file: string;
  line: number;
}
/** `gen-property` — the backing/exposed attribute name. */
export interface IdeRefactorGenPropertyReq extends IdeRefactorGenAtReq {
  attr: string;
}
/** `gen-override` — the base method to override (resolved in-module). */
export interface IdeRefactorGenOverrideReq extends IdeRefactorGenAtReq {
  method: string;
}
/** `gen-delegate` — delegate `method` to the `attr` field. */
export interface IdeRefactorGenDelegateReq extends IdeRefactorGenAtReq {
  attr: string;
  method: string;
}

/**
 * Response to `ide:refactor`. `edit` is the sidecar's LSP WorkspaceEdit passed
 * through VERBATIM (MAIN never reshapes it) — the renderer's
 * `normalizeWorkspaceEdit` (text-edit-apply.ts) is the single tolerant parser.
 */
export interface IdeRefactorResult {
  ok: boolean;
  /** the sidecar's WorkspaceEdit JSON, untouched. */
  edit?: unknown;
  /** `sorted(edit.changes)` convenience mirror from the sidecar. */
  files?: string[];
  error?: string;
  /** sidecar failure code (`rope-missing`, `usages-remain`, `empty-edit`). */
  code?: string;
  /** safe-delete blocker: live usage sites (1-based lines). */
  usages?: Array<{ uri: string; line: number }>;
}

/* ── ide:run — gated plain-Run execution (APP-032) ───────────────────────────*/

/** Request to `ide:run.start`: a PURE `buildRunInvocation` result + the gate
 *  identity. MAIN re-runs the fail-closed run-gate + the 90% telemetry launch
 *  guard BEFORE any spawn — the renderer never decides "safe" (C5). */
export interface IdeRunStartRequest {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  workspaceRoot: string;
  /** git HEAD sha when known (trust-store match, same as ide:gate). */
  head?: string;
  venv?: IdeActiveVenv | null;
}

/** Response to `ide:run.start`. A refusal carries WHY (verdict/guard), never throws. */
export interface IdeRunStartResult {
  ok: boolean;
  runId?: string;
  /** which stage refused: the engine gate or the telemetry launch guard. */
  refusedBy?: "gate" | "guard";
  /** the gate verdict when the gate refused (decision/reason for the panel). */
  gate?: IdeGateResult;
  error?: string;
}

/** Response to `ide:run.kill`. */
export interface IdeRunKillResult {
  ok: boolean;
  error?: string;
}

/** Response to `ide:pty.spawn`. */
export interface IdePtySpawnResult {
  ok: boolean;
  ptyId?: string;
  error?: string;
}

/* ── APP-090: tear-out terminal window ─────────────────────────────────────────*/

/** Request to tear a live terminal session out into a hardened secondary window. The
 *  PTY (spawned by the main window) is NOT re-created — the float ATTACHES to `ptyId`
 *  and filters the shared broadcast; tear-out/re-dock never kill it. */
export interface IdeFloatingTerminalCreateRequest {
  ptyId: string;
  title: string;
  /** the per-window color scheme (§3.5); omitted = follow the global theme. */
  scheme?: string;
}
export interface IdeFloatingTerminalResult {
  ok: boolean;
  error?: string;
}
export interface FloatingTerminalApi {
  /** open (or focus an existing) float for `ptyId`. Created ONLY in MAIN with the same
   *  hardened webPreferences/CSP as the main window (never `window.open`). */
  create(req: IdeFloatingTerminalCreateRequest): Promise<IdeFloatingTerminalResult>;
  /** re-dock: close the float for `ptyId` (MAIN emits `floatingTerminal.returned`). NEVER
   *  kills the PTY — the session returns to the main window with scrollback intact. */
  close(ptyId: string): Promise<IdeFloatingTerminalResult>;
}

/** The active venv a terminal inherits (resolved by MAIN from the env-store, §6.1). */
export interface IdeActiveVenv {
  root: string;
  platform?: "win32" | "posix";
}

/** A working-tree change kind. */
export type IdeGitChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

/** One changed path (staged/unstaged split). */
export interface IdeGitChange {
  path: string;
  staged?: IdeGitChangeKind;
  unstaged?: IdeGitChangeKind;
  origPath?: string;
}

/** Grouped git status (file 07 §6.2). */
export interface IdeGitStatus {
  ok: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  staged: IdeGitChange[];
  unstaged: IdeGitChange[];
  untracked: IdeGitChange[];
  conflicted: IdeGitChange[];
  error?: string;
}

/** A commit-log row. */
export interface IdeGitLogEntry {
  hash: string;
  /** parent commit hashes, in order (empty for a root commit, 2+ for a merge). */
  parents: string[];
  author: string;
  date: string;
  /** ref decorations (branch/tag/"HEAD"); a tag keeps its "tag: " prefix. */
  refs: string[];
  subject: string;
}

/** A plain git op result. */
export interface IdeGitOpResult {
  ok: boolean;
  message?: string;
  error?: string;
  /** a cherry-pick/revert left CONFLICTS to resolve (exit≠0 but not a hard error);
   *  the panel routes to the conflicted-files section (APP-037). */
  conflicted?: boolean;
}

/** Response to `ide:git.conflictVersions` (APP-039): the three merge-index stages
 *  (base/ours/theirs) + the working copy of a conflicted file. */
export interface IdeGitConflictVersionsResult {
  ok: boolean;
  base: string;
  ours: string;
  theirs: string;
  working: string;
  binary: boolean;
  error?: string;
}

/** Response to `ide:git.diff`: the unified diff body (read-only). */
export interface IdeGitDiffResult {
  ok: boolean;
  diff: string;
  error?: string;
}

/** Response to `ide:git.branches`. */
export interface IdeGitBranchesResult {
  ok: boolean;
  branches: string[];
  current?: string;
  error?: string;
}

/** Response to `ide:git.log`. */
export interface IdeGitLogResult {
  ok: boolean;
  entries: IdeGitLogEntry[];
  error?: string;
}

/* ── worktrees (Task #5, desktop parity) — the SAME `@prometheus/core/git-worktree` shapes
 * the CLI's `/worktree` slash renders, projected here so the renderer never imports core's
 * node-only `GitSpawn` machinery directly (C5: git only spawns in MAIN). */

/** One worktree row (mirrors core's `Worktree`). */
export interface IdeWorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked?: string | boolean;
  prunable?: string;
}

/** Response to `ide:worktree.list`. */
export interface IdeWorktreeListResult {
  ok: boolean;
  worktrees: IdeWorktreeEntry[];
  error?: string;
}

/** Response to `ide:worktree.create` / `ide:worktree.remove`. */
export interface IdeWorktreeOpResult {
  ok: boolean;
  path?: string;
  message: string;
}

/* ── sub-agent personas (Task #5, desktop parity) — the SAME `@prometheus/core/agent-files`
 * `LoadedAgent` shape the CLI's `spawn_agent` uses, already CLAMPED by scope in MAIN before it
 * ever crosses IPC (a project persona is already forced read-only, model-refused, etc.). */
export type IdeAgentFilePersona = agent.LoadedAgent;

/** Response to `ide:agentFiles.list`. */
export interface IdeAgentFilesListResult {
  ok: boolean;
  personas: IdeAgentFilePersona[];
  error?: string;
}

/* ── custom slash commands from markdown (Task #5, desktop parity) — the SAME
 * `@prometheus/core/command-loader` `CommandFile` shape the CLI's `command-files.ts` parses;
 * the renderer expands it with `@prometheus/core/command-gate` (both node-free, so this
 * crosses IPC only to get the raw parsed file — expansion happens client-side). */
export interface IdeCommandFileArg {
  name: string;
  description?: string;
  required?: boolean;
}
export interface IdeCommandFile {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
  args: IdeCommandFileArg[];
  template: string;
  fileRefs: string[];
  shellInjections: string[];
}
export type IdeCommandFileScope = "user" | "project";
export interface IdeLoadedCommandFile {
  file: IdeCommandFile;
  scope: IdeCommandFileScope;
  /** absolute path, for a "where did this come from" line. */
  path: string;
}

/** Response to `ide:commandFiles.list`. */
export interface IdeCommandFilesListResult {
  ok: boolean;
  commands: IdeLoadedCommandFile[];
  error?: string;
}

/** APP-082 interactive rebase: the todo action whitelist (mirrors the host + validator). */
export type IdeRebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";
/** One editable rebase todo row. `message` is used only for reword/squash. */
export interface IdeGitRebaseTodoRow {
  sha: string;
  subject: string;
  action: IdeRebaseAction;
  message?: string;
}
/** The commits of `base..HEAD` as an editable todo (oldest-first). */
export interface IdeGitRebaseTodoResult {
  ok: boolean;
  /** `base` resolved to a concrete commit sha (what `git rebase -i` receives). */
  base: string;
  rows: IdeGitRebaseTodoRow[];
  error?: string;
}
/** Whether a rebase is mid-flight (incl. after an app restart) + its conflict state. */
export interface IdeGitRebaseState {
  inProgress: boolean;
  conflicted: string[];
  /** the pre-rebase tip — Abort restores it. */
  origHead?: string;
  onto?: string;
  step?: number;
  total?: number;
  error?: string;
}

/** One stash entry (index 0 = most recent). */
export interface IdeGitStashEntry {
  index: number;
  ref: string;
  message: string;
}

/** Response to `ide:git.stashList`. */
export interface IdeGitStashListResult {
  ok: boolean;
  entries: IdeGitStashEntry[];
  error?: string;
}

/** One line's blame (1-based line). */
export interface IdeGitBlameEntry {
  line: number;
  /** the FULL 40-char commit sha (inline blame shows a short prefix; hover the full). */
  hash: string;
  author: string;
  date: string;
  summary: string;
  /** author-time as a Unix epoch (seconds) — source for the relative "3d ago" label. */
  epoch: number;
}

/** APP-085: gated PR/MR review shapes (mirrors the engine-bridge provider client). */
export interface IdePrSummary {
  number: number;
  title: string;
  author: string;
  branch: string;
  state: string;
  url: string;
}
export interface IdePrComment {
  author: string;
  body: string;
  createdAt: string;
}
export interface IdePrDetail extends IdePrSummary {
  description: string;
  comments: IdePrComment[];
  /** a unified diff string (feeds DiffView). */
  diff: string;
}
/** Whether the origin remote is a supported forge + whether a token is stored. */
export interface IdePrStatus {
  provider?: "github" | "gitlab";
  host?: string;
  slug?: string;
  hasToken: boolean;
}
export interface IdePrListResult {
  ok: boolean;
  prs: IdePrSummary[];
  error?: string;
}
export interface IdePrDetailResult {
  ok: boolean;
  detail?: IdePrDetail;
  error?: string;
}
export interface IdePrOpResult {
  ok: boolean;
  error?: string;
}

/** APP-083: one commit's metadata for the blame click-through (`git show --no-patch`). */
export interface IdeGitShowResult {
  ok: boolean;
  sha: string;
  author: string;
  email: string;
  /** strict ISO-8601 author date. */
  date: string;
  summary: string;
  body: string;
  error?: string;
}

/** Response to `ide:git.blame`. */
export interface IdeGitBlameResult {
  ok: boolean;
  entries: IdeGitBlameEntry[];
  error?: string;
}

/**
 * Response to `ide:gate` (the RUN-GATE, §5.2/§9). A RENDERED engine verdict, never
 * a JS-fabricated one (C5). `decision`: allow → launch · warn → "Run anyway?"
 * modal (default NO) · block → refuse + open Gate Log. `mayLaunch` is the single
 * boolean the launcher checks. Fail-closed: a failed scan ⇒ block.
 */
export interface IdeGateResult {
  ok: boolean;
  decision: "allow" | "warn" | "block";
  mayLaunch: boolean;
  trusted: boolean;
  workspaceRoot: string;
  reason: string;
  /** the C3 verdict tier + score when a fresh scan ran. */
  verdict?: VerdictTier;
  riskScore?: number;
  findingsCount?: number;
  error?: string;
}

/** A request the renderer sends to `ide:gate`. */
export interface IdeGateRequest {
  workspaceRoot: string;
  /** the current git HEAD sha (so a clean verdict bound to it skips the re-scan). */
  head?: string;
  runId?: string;
}

/**
 * A request to `ide:exec` — run ONE user-approved shell command in the workspace and
 * capture its output. The agentic tool-loop proposes the command; the user approves it
 * (§7.3 task card); main screens it (fail-closed blocklist) + spawns with a hardened env.
 */
export interface IdeExecRequest {
  command: string;
  /** the working directory (the workspace root); validated + non-sensitive in main. */
  cwd: string;
}

/**
 * A request to `agent:systemTool` — run ONE of core's shared system tools (Phase 6).
 *
 * This is the channel that ended the CLI/GUI split. `ide:exec` runs `shell -c <command>`
 * behind a regex denylist; this runs core's `runSystemTool`, which is the same six-layer
 * path the CLI uses (parse → registry → classify → nemesis → ladder → screen) and spawns
 * each program directly with NO shell anywhere.
 *
 * `name` is validated in main against core's own tool list, so the renderer cannot invent
 * a tool name, and the args are passed through for the tool's own validation.
 */
export interface AgentSystemToolRequest {
  name: string;
  args: Record<string, unknown>;
  /** the workspace root; the tool's default cwd and the root of its read scope. */
  cwd: string;
  /**
   * The operator's A0–A7 level, from the renderer's authorisation store.
   *
   * Needed because `run_command`'s OS sandbox (macOS Seatbelt) opens the network only at A5+,
   * the same ladder bit that already governs the `install` category. Omitting it means the
   * sandbox assumes the safe default and the pane's `curl` / `npm install` are refused by the
   * kernel however the pill is set — so the level has to travel with the call.
   *
   * Main CLAMPS it (`clampAuthLevel`) rather than trusting the number: the renderer is the
   * sandboxed side, and a level is an input like any other. Note this does NOT decide whether
   * a tool runs — the renderer's broker and the human's task card already did that — it only
   * tells main how tightly to confine a call that was already approved.
   */
  authLevel?: number;
}

/**
 * `agent:hookRun` — the renderer's proxy to the user's LIFECYCLE HOOKS, which only MAIN runs.
 *
 * Two ops on one channel because they are one capability with one guard: `"list"` returns the
 * hooks main resolved from settings (the renderer needs them for `tuning.hooks`, since core's
 * loop does the matching), and `"run"` executes ONE of them.
 *
 * `command` is checked in main against the configured list for the same `event`, verbatim. The
 * renderer therefore cannot use this channel to run a shell string of its own choosing — which
 * it otherwise trivially could, since a hook command IS a shell line by design.
 */
export interface AgentHookRunRequest {
  op: "list" | "run";
  /** required for `op:"run"`. */
  event?: "PreToolUse" | "PostToolUse" | "SessionStart";
  /** required for `op:"run"` — must match a configured command for `event` exactly. */
  command?: string;
  /** the event's JSON payload, written to the hook's stdin. */
  stdin?: string;
  timeoutMs?: number;
  /** the workspace root — the hook's working directory. */
  cwd?: string;
}

/** The result of `agent:hookRun`. `hooks` answers `op:"list"`; `outcome` answers `op:"run"`. */
export interface AgentHookRunResult {
  ok: boolean;
  error?: string;
  hooks?: {
    event: "PreToolUse" | "PostToolUse" | "SessionStart";
    matcher?: string;
    command: string;
  }[];
  outcome?: {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
    error?: string;
  };
}

/**
 * `agent:canaryTrip` — the renderer's proxy for recording a tripped canary token (point 6b, see
 * `@prometheus/core`'s `agent/canary.ts`). Core's loop detects the trip (it owns the token and
 * the model's streamed text); the renderer cannot write the audit file itself (C5), so it
 * forwards the trip here and MAIN appends it to `canary-audit.jsonl`.
 */
export interface AgentCanaryTripRequest {
  /** the streamed text chunk that contained the token, for the audit record. */
  textSnippet: string;
}

export interface AgentCanaryTripResult {
  ok: boolean;
}

/** The result of `agent:systemTool` — core's `ToolOutcome`, flattened for IPC. */
export interface AgentSystemToolResult {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
  /** set when the nemesis gate refused it, so the pane can abort the round like the CLI. */
  verdict?: { verdict: "block" | "error"; riskScore: number };
}

/**
 * `agent:engineTool` — run one `prometheus_*` verb through the engine (prometheus.py).
 *
 * A SEPARATE channel from `agent:systemTool` rather than another branch inside it, because the
 * two admit different things and are guarded by different lists: the system channel runs core's
 * host implementations against a workspace path, while this one hands argv to the engine and has
 * no cwd scope at all — the verbs are machine-global (they rewrite other agent CLIs' configs).
 * Folding them together would mean one guard deciding two unrelated questions.
 *
 * `name` is looked up in core's catalogue INSIDE main; the renderer supplies a name and args and
 * nothing else. It cannot supply argv, and it cannot supply a ToolDef whose `toArgv` it chose.
 */
/**
 * One connected server's live tool descriptors, as plain JSON.
 *
 * `McpConnectorView` carries only a `toolCount`, so the renderer knew HOW MANY tools a server
 * published and nothing about them — it could not build a single `ToolDef`, which is why the
 * pane could not call one. A `ToolDef` cannot cross IPC (it holds a function), so the
 * DESCRIPTORS cross and the renderer builds the defs with core's own `allMcpToolDefs`.
 */
export interface McpAgentServer {
  id: string;
  label: string;
  enabled: boolean;
  health: string;
  /** the nemesis verdict recorded when the server was added, if any. */
  verdict?: string;
  /** the raw MCP tool descriptors: `{name, title?, description?, inputSchema?, annotations?}`. */
  tools: Record<string, unknown>[];
}

export interface McpAgentToolsResult {
  ok: boolean;
  servers: McpAgentServer[];
  error?: string;
}

/** Call one tool on one connected MCP server. */
export interface McpAgentCallRequest {
  serverId: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * One remembered permission grant, as it crosses IPC.
 *
 * Deliberately the same shape as core's `Grant`, and deliberately NOT re-derived in main: the
 * store's own `add()` is what refuses an over-broad subject (`*`, `engine:*`, anything carrying
 * `--force`), and rehydrating around that door would let a hand-edited file express a grant the
 * UI would have refused.
 */
export interface AgentGrant {
  subject: string;
  decision: "allow" | "deny";
  scope: "project" | "user";
  /** a project grant binds to this workspace root. */
  root?: string;
  paths?: string[];
}

export interface AgentGrantsResult {
  ok: boolean;
  grants: AgentGrant[];
  error?: string;
}

export interface AgentEngineToolRequest {
  name: string;
  args: Record<string, unknown>;
}

/** The captured result of `ide:exec`. `blocked` ⇒ the screen/validator refused it. */
export interface IdeExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** true when the destructive-command screen or the validator refused to run it. */
  blocked?: boolean;
  /** true when the command was SIGKILLed for exceeding the timeout. */
  timedOut?: boolean;
  /** human-readable reason for a block / failure. */
  reason?: string;
  error?: string;
}

/**
 * A workspace search request (`ide:search`). Runs a bounded, gitignore-aware tree walk
 * in MAIN (the real backend, replacing the renderer's capped fallback walk). `mode`
 * "content" greps file contents; "path" matches the path substring.
 */
export interface IdeSearchRequest {
  root: string;
  query: string;
  mode?: "content" | "path";
  extensions?: string[];
  caseSensitive?: boolean;
  maxResults?: number;
  /** root-relative include globs — a file must match ≥1 to be searched (APP-024).
   *  Validated in MAIN: absolute / `..`-segment patterns are rejected. */
  include?: string[];
  /** root-relative exclude globs — matching paths are skipped before reading. */
  exclude?: string[];
  /** APP-066: opaque correlation id so the renderer can stream progress + `cancel` this
   *  search. Absent → no progress events, no cancel handle (one-shot request/response). */
  requestId?: string;
}

/** One search hit. */
export interface IdeSearchMatch {
  path: string;
  /** path relative to root (POSIX separators). */
  rel: string;
  /** 1-based line number of the first content match (content mode only). */
  line?: number;
  ext: string;
}

/** The result of `ide:search`. */
export interface IdeSearchResult {
  ok: boolean;
  matches: IdeSearchMatch[];
  /** files visited (after dir-ignore). */
  scanned: number;
  /** true when the walk hit maxResults and stopped early. */
  truncated: boolean;
  /** APP-066: true when a `cancel` stopped the walk (partial matches returned). */
  cancelled?: boolean;
  error?: string;
}

/** The result of `ide:workspaceIndex` — a worker-offloaded flat file walk (APP-066). */
export interface IdeWorkspaceIndexResult {
  ok: boolean;
  /** absolute file paths, sorted (empty on error). */
  files: string[];
  scanned: number;
  truncated: boolean;
  cancelled?: boolean;
  error?: string;
}

/** Generic ack for fire-and-forget IDE calls (e.g. `ide:searchCancel`, APP-066). */
export interface IdeAckResult {
  ok: boolean;
  error?: string;
}

/** One structural-search hit (APP-076) — an AST match with captured `$X` bindings. */
export interface IdeStructMatch {
  /** absolute file path. */
  file: string;
  /** 1-based line + 1-based char column of the matched node. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** the matched source text. */
  snippet: string;
  /** metavariable name → captured source (e.g. { X: "1 + 2" }). */
  bindings: Record<string, string>;
}

/** The result of `ide:structsearch` (read-only AST `match`). */
export interface IdeStructSearchResult {
  ok: boolean;
  matches: IdeStructMatch[];
  count: number;
  error?: string;
}

/** One discovered test node (mirrors the testmgr.py `discover` tree). */
export interface IdeTestNode {
  id: string;
  kind: "dir" | "file" | "class" | "case";
  label: string;
  file: string;
  line?: number;
  children?: IdeTestNode[];
}

/** The result of `ide:test.discover` (AST-scanned, never executes target code). */
export interface IdeTestDiscoverResult {
  ok: boolean;
  roots: IdeTestNode[];
  /** workspace-relative-or-absolute root that was scanned. */
  root?: string;
  caseCount?: number;
  error?: string;
}

/** APP-086: coverage per-file (covered `lines` + `missed` lines) + total % (mirrors
 *  engine-bridge CoverageReport). */
export interface IdeCoverageReport {
  perFile: Record<string, { lines: number[]; missed: number[]; branchPct?: number }>;
  totalPct: number;
}
export interface IdeCoverageResult {
  ok: boolean;
  report?: IdeCoverageReport;
  error?: string;
}

/** The framework a test run targets (the discover tree tags each node's framework —
 *  pytest ids are path::Class::test[param], unittest ids are dotted; never guess). */
export type IdeTestFramework = "pytest" | "unittest" | "vitest";

/** One live per-test result streamed over IPC_EVENTS.ideTestEvent (APP-013/APP-040). */
export interface IdeTestEvent {
  id: string;
  status: "pass" | "fail" | "skip";
  message?: string;
  durationMs?: number;
  /** captured output lines for this test (APP-040) — failures carry the traceback +
   *  any captured stdout/stderr; sent as a follow-up update after the live status. */
  output?: string[];
  /** the failing source location (APP-040) — the nearest in-workspace traceback frame. */
  file?: string;
  line?: number;
}

/** The terminal summary of an `ide:test.run` (the sidecar's LAST JSON line). */
export interface IdeTestRunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  exitCode?: number;
  durationMs?: number;
  /** pytest exit 5 (nothing collected) is a soft success carrying collected:0. */
  collected?: number;
}

/** The result of `ide:test.run` / a rerun-failed (which reuses the channel). */
export interface IdeTestRunResult {
  ok: boolean;
  summary?: IdeTestRunSummary;
  error?: string;
}

/**
 * A multiplexed MAIN→renderer IDE host event (IPC_EVENTS.ideEvent). Discriminated
 * by `channel`; the renderer routes each to the right surface. Cosmetic/data only
 * — NO security verdict crosses (C5).
 */
export type IdeEvent =
  | {
      channel: "lsp.diagnostics";
      serverId: string;
      uri: string;
      diagnostics: unknown[];
      version?: number;
    }
  | { channel: "lsp.notify"; serverId: string; method: string; params: unknown }
  | { channel: "lsp.state"; status: Record<string, unknown> }
  | { channel: "dap.event"; sessionId: string; event: string; body: unknown }
  | { channel: "dap.state"; status: Record<string, unknown> }
  | {
      /** a host-owned launch-time `setBreakpoints` response (APP-079) — the renderer
       *  store folds verified flags + adapter-adjusted lines from it. */
      channel: "dap.setbreakpoints";
      sessionId: string;
      path: string;
      sentLines: number[];
      breakpoints: unknown[];
    }
  | { channel: "pty.data"; ptyId: string; data: string }
  | { channel: "pty.exit"; ptyId: string; exitCode: number }
  // APP-090: a torn-out terminal's float window returned (closed / re-dock button) — the
  // main window re-shows that session's tab. Carries the ptyId the float was hosting.
  | { channel: "floatingTerminal.returned"; ptyId: string }
  /**
   * An OS drag-and-drop landed on a window and MAIN resolved it.
   *
   * The path comes from Chromium's own drop machinery (the `will-navigate` a dropped file
   * triggers), NOT from renderer JavaScript — which is the whole point. A renderer-supplied path
   * could not be trusted to earn a working-set grant, because self-granting is exactly what that
   * guard exists to prevent; a path main reads off the drop event is a real user gesture main can
   * verify. Main has already recorded the grant (folder) or the single-path approval (file) by
   * the time this event is sent.
   */
  | { channel: "shell.dropped"; path: string; kind: "folder" | "file" }
  | { channel: "run.data"; runId: string; data: string }
  | { channel: "run.exit"; runId: string; exitCode: number; signal?: number; killed: boolean }
  | { channel: "fs.change"; root: string; paths: string[] }
  // APP-066: a mid-search progress tick from the offloaded worker, keyed by the search's
  // requestId; `scanned` is the running visited-file count (cosmetic — drives a spinner).
  | { channel: "search.progress"; requestId: string; scanned: number }
  | { channel: "host.stderr"; source: "lsp" | "dap"; id: string; line: string }
  // APP-078: a server→client `workspace/applyEdit` REQUEST relayed to the renderer — the editor
  // applies the WorkspaceEdit (undoable) then acks via `lspApplyEditResult` so the server settles.
  | {
      channel: "lsp.applyEdit";
      serverId: string;
      workspaceRoot: string;
      requestId: number | string;
      params: unknown;
    }
  // APP-045: one NDJSON kernel event, tagged with its notebook session id. The `event`
  // payload is the raw kernel.py serve event (ready/stream/display_data/execute_result/
  // error/vars/inspect/done/exit); the renderer routes by sessionId + the cell `id`.
  | { channel: "kernel"; sessionId: string; event: IdeKernelStreamEvent };

/** One raw kernel.py serve NDJSON event (see engine-bridge KernelEvent / CONTRACT.md). */
export interface IdeKernelStreamEvent {
  event: string;
  /** the requesting cell id (null for lifecycle/fatal events). */
  id?: string | null;
  [k: string]: unknown;
}

/**
 * The renderer-facing `window.prometheus.ide.*` surface (file 07 §3.2/§4/§5/§6/§9).
 * RENDERER-FACING TYPES ONLY — the implementation lives in the MAIN process
 * (ide-ipc.ts → the LSP/DAP/PTY/git/fs hosts + the REAL engine-bridge run-gate);
 * preload forwards plain data. The renderer NEVER spawns a child; it drives the
 * hosts over IPC and decides nothing about safety — the run-gate verdict is the
 * engine's (C5).
 */
/* ── SQL console (APP-042) — the sqlrunner.py bridge shapes ────────────────────*/

export type IdeSqlCell = string | number | boolean | null;

export interface IdeSqlColumn {
  name: string;
  dtype: string;
  nullable: boolean;
  pk: boolean;
  /** APP-087: the referenced table+column when this column is a foreign key. */
  fk?: { table: string; to: string };
}

export interface IdeSqlTable {
  name: string;
  type: "table" | "view";
  columns: IdeSqlColumn[];
}

export interface IdeSqlConnectResult {
  ok: boolean;
  dialect?: string;
  database?: string;
  serverVersion?: string;
  /** set on a fail-closed missing-driver envelope — the pip package to install. */
  driverMissing?: string;
  error?: string;
}

export interface IdeSqlQueryRequest {
  conn: string;
  sql: string;
  params?: IdeSqlCell[];
  page?: number;
  pageSize?: number;
  timeoutS?: number;
}

export interface IdeSqlQueryResult {
  ok: boolean;
  columns?: string[];
  /** ONE page of the capped result (≤ pageSize rows); `rowCount` is the capped total. */
  rows?: IdeSqlCell[][];
  rowCount?: number;
  truncated?: boolean;
  page?: number;
  maxPage?: number;
  durationMs?: number;
  error?: string;
}

export interface IdeSqlSchemaResult {
  ok: boolean;
  tables?: IdeSqlTable[];
  count?: number;
  error?: string;
}

/** The narrow `window.prometheus.sql` surface — credentials go MAIN→sidecar only. */
export interface SqlApi {
  connect(conn: string): Promise<IdeSqlConnectResult>;
  query(req: IdeSqlQueryRequest): Promise<IdeSqlQueryResult>;
  schema(conn: string, table?: string): Promise<IdeSqlSchemaResult>;
}

/* ── live Jupyter kernel (APP-045) — the kernel.py serve bridge shapes ─────────*/

export interface IdeKernelStartResult {
  ok: boolean;
  /** the supervised session id (pass to execute/interrupt/restart/shutdown). */
  sessionId?: string;
  error?: string;
}
export interface IdeKernelOkResult {
  ok: boolean;
  error?: string;
}

/* ── APP-088: kernel introspection event payloads (Variables / SciView / DataFrame) ──
 * These ride the SAME `{channel:"kernel"}` onEvent feed as execution output; their
 * `event` discriminator is one of "vars" | "plots" | "dataframe". The notebook store
 * routes them into per-session Variables / SciView / DataFrame window state. `vars` and
 * `plots` are AUTO-emitted after every cell completes (no request, no polling); only
 * `dataframe` is on-demand via ide:kernel.dataframe. */

/** One row of the Variables window: an in-scope global with type/repr/byte-size. */
export interface IdeKernelVar {
  name: string;
  type: string;
  /** repr(), capped by the kernel (attacker-controlled text — render TEXT-only). */
  repr: string;
  /** sys.getsizeof(value) in bytes. */
  size: number;
}
/** The kernel `vars` event: the full in-scope variable table after a cell completes. */
export interface IdeKernelVarsEvent {
  event: "vars";
  vars: IdeKernelVar[];
}
/** The kernel `plots` event: base64 PNGs captured from matplotlib after a cell ran. */
export interface IdeKernelPlotsEvent {
  event: "plots";
  /** the cell that produced these figures. */
  cellId?: string;
  /** base64-encoded PNG bytes (wrap in a `data:image/png;base64,` URI — never innerHTML). */
  plots: string[];
}
/** One paged DataFrame view: ordered columns + rows of JSON-safe cells (NaN/Inf→null). */
export interface IdeKernelDataFrameEvent {
  event: "dataframe";
  name: string;
  found: boolean;
  columns?: string[];
  rows?: (string | number | boolean | null)[][];
  /** total row count of the frame (for the pager), when the object exposes a length. */
  totalRows?: number;
  offset?: number;
  limit?: number;
  error?: string;
}

/**
 * The renderer-facing kernel surface. MAIN owns the one child_process (via engine-bridge
 * spawnKernelSidecar); events arrive over the shared onEvent feed as `{channel:"kernel"}`.
 * A session is one supervised kernel per notebook; execute is fire-and-forget (results
 * stream back as events tagged by sessionId + cellId).
 */
export interface KernelApi {
  /** start a supervised kernel session for `cwd`; returns its sessionId. */
  start(cwd: string, env?: Record<string, string>): Promise<IdeKernelStartResult>;
  /** run `code` as cell `cellId`; outputs stream back over onEvent. */
  execute(sessionId: string, cellId: string, code: string): Promise<IdeKernelOkResult>;
  interrupt(sessionId: string): Promise<IdeKernelOkResult>;
  restart(sessionId: string): Promise<IdeKernelOkResult>;
  shutdown(sessionId: string): Promise<IdeKernelOkResult>;
  /** APP-088: request a paged DataFrame view; the frame arrives as a `dataframe` event. */
  dataframe(
    sessionId: string,
    name: string,
    offset: number,
    limit: number,
  ): Promise<IdeKernelOkResult>;
}

/* ── profiler (APP-046) — the profile.py flame-fold bridge shapes ─────────────*/

/** One flame FOLD sample: a call stack (root→leaf, "mod:fn") + a weight (µs). */
export interface IdeProfileSample {
  stack: string[];
  value: number;
}

/** APP-089: the profiling mode — cpu (µs) | memory (bytes) | async (samples). */
export type IdeProfileMode = "cpu" | "memory" | "async";

export interface IdeProfileStartRequest {
  /** the target script to profile (must resolve UNDER workspaceRoot). */
  path: string;
  workspaceRoot: string;
  cwd?: string;
  /** target argv (passed after a literal `--`). */
  args?: string[];
  timeoutS?: number;
  /** HEAD sha threaded into the run-gate (trusted-workspace fast path). */
  head?: string;
  /** APP-089: profiling mode (default "cpu"). */
  mode?: IdeProfileMode;
}

export interface IdeProfileResult {
  ok: boolean;
  samples?: IdeProfileSample[];
  totalUs?: number;
  /** cProfile folds are edge-reconstructed approximations (py-spy would be exact). */
  approx?: boolean;
  timedOut?: boolean;
  truncated?: boolean;
  error?: string;
  /** what refused a run that executed nothing: the gate, a bad path, or host load. */
  refusedBy?: "gate" | "path" | "load";
  /** the rendered gate verdict when refusedBy === "gate". */
  gate?: IdeGateResult;
  /** APP-089: the mode that produced these samples + the value unit ("us"|"bytes"|"samples"). */
  mode?: IdeProfileMode;
  unit?: string;
  /** APP-089 async: false when the target ran no asyncio tasks (fail-soft note). */
  sawTasks?: boolean;
  /** a short human note about the result (approx/partial/not-async). */
  note?: string;
  /**
   * The profiled script's OWN error, when it crashed.
   *
   * A run whose target raised still profiles successfully — the sampler ran, it just sampled
   * import machinery. `ok:true` with no signal read as "here is your profile", so this is the
   * field that distinguishes a real measurement from a flame graph of runpy.
   */
  runError?: string;
}

/* ── APP-089: saved-snapshot metadata + compare (delta) shapes ─────────────────*/

/** One saved profile snapshot's header (the samples live in the file, not here). */
export interface IdeProfileSnapshotMeta {
  id: string;
  name: string;
  mode: string;
  unit: string;
  savedAt: number;
  totalValue: number;
}
export interface IdeProfileSnapshotSaveRequest {
  name: string;
  mode: IdeProfileMode;
  unit: string;
  samples: IdeProfileSample[];
  totalValue: number;
}
export interface IdeProfileSaveResult {
  ok: boolean;
  id?: string;
  error?: string;
}
export interface IdeProfileListResult {
  ok: boolean;
  snapshots?: IdeProfileSnapshotMeta[];
  error?: string;
}
export interface IdeProfileCompareRequest {
  aId: string;
  bId: string;
}
/** One leaf's net delta in a compare summary (signed: + regression, − improvement). */
export interface IdeProfileDeltaEntry {
  name: string;
  delta: number;
}
export interface IdeProfileCompareResult {
  ok: boolean;
  /** the signed delta samples (value = b − a) — fold with flameSamplesToTree. */
  samples?: IdeProfileSample[];
  unit?: string;
  aMode?: string;
  bMode?: string;
  summary?: { regressions: IdeProfileDeltaEntry[]; improvements: IdeProfileDeltaEntry[] };
  error?: string;
}

/**
 * The profiler surface. Profiling EXECUTES the target, so start is GATED through the
 * same run-gate/nemesis seam as a run (fail-closed). MAIN owns the profile.py spawn.
 * Snapshots persist under the app-data dir (MAIN-owned path — never a renderer path).
 */
export interface ProfileApi {
  start(req: IdeProfileStartRequest): Promise<IdeProfileResult>;
  /** abort the in-flight profile run (fail-closed). */
  stop(): Promise<IdeOkResult>;
  /** APP-089: persist the current samples as a named snapshot under the app-data dir. */
  snapshotSave(req: IdeProfileSnapshotSaveRequest): Promise<IdeProfileSaveResult>;
  /** APP-089: list saved snapshots (headers only, newest first). */
  snapshotList(): Promise<IdeProfileListResult>;
  /** APP-089: compare two saved snapshots → a signed delta tree + regression summary. */
  compare(req: IdeProfileCompareRequest): Promise<IdeProfileCompareResult>;
}

/* ── terminal launcher (APP-048) — the core terminal-profiles bridge shapes ────*/

/** A plain env row the renderer forwards to MAIN (mapped to a core Env for env profiles). */
export interface IdeTerminalEnv {
  name: string;
  path: string;
  kind: string;
  pythonVersion?: string | null;
}

export interface IdeTerminalMenuRequest {
  workspaceRoot: string;
  /** the live [[04]] env list (for env profiles); omit for shells + AI presets only. */
  envs?: IdeTerminalEnv[];
}

/** One "+ New terminal ▾" entry, sourced from core (never renderer constants). */
export interface IdeTerminalMenuItem {
  id: string;
  title: string;
  subtitle?: string;
  kind: "shell" | "ai-preset" | "env";
  /** for AI presets: the bin to PATH-detect; absent bin → prime its install command. */
  detectBin?: string;
  /** a clean, runnable install command primed (not executed) when the bin is missing. */
  install?: string;
}

export interface IdeTerminalMenuResult {
  ok: boolean;
  items: IdeTerminalMenuItem[];
  error?: string;
}

export interface IdeTerminalResolveRequest {
  id: string;
  workspaceRoot: string;
  envs?: IdeTerminalEnv[];
  activeEnvPath?: string | null;
  fileDir?: string;
}

/** A resolved launch: everything the renderer needs to open one session. */
export interface IdeTerminalResolved {
  cwd: string;
  shell?: string;
  venv?: IdeActiveVenv | null;
  /** AI presets: the command to auto-run (autorun) or prime (install / no-autorun). */
  launch?: string;
  autorun?: boolean;
  title: string;
  kind: "shell" | "ai-preset" | "env";
  group: "project" | "ai" | "floating";
}

export interface IdeTerminalResolveResult {
  ok: boolean;
  resolved?: IdeTerminalResolved;
  error?: string;
}

/** The terminal-launcher surface: the menu + per-item resolution, both from core in MAIN. */
export interface TerminalApi {
  menu(req: IdeTerminalMenuRequest): Promise<IdeTerminalMenuResult>;
  resolve(req: IdeTerminalResolveRequest): Promise<IdeTerminalResolveResult>;
}

/* ── repo-map (APP-053) — the repomap.py ranked symbol map shapes ─────────────*/

export interface IdeRepoMapSymbol {
  name: string;
  kind: string;
  line: number;
  /** PageRank-style importance in [0,1] (widely-referenced symbols → higher). */
  rank: number;
}
export interface IdeRepoMapFile {
  path: string;
  symbols: IdeRepoMapSymbol[];
}
export interface IdeRepoMapRequest {
  root: string;
  /** re-rank the whole graph but emit ONLY these files' entries (incremental refresh). */
  files?: string[];
  /** token budget for the trim (~4 chars/token); default 8000. */
  budget?: number;
  /** query terms to personalize ranking (the @codebase query). */
  query?: string;
}
export interface IdeRepoMapResult {
  ok: boolean;
  files: IdeRepoMapFile[];
  generatedAt?: string;
  parser?: string;
  symbolCount?: number;
  truncated?: boolean;
  error?: string;
}

/** The repo-map surface: a ranked symbol map for @codebase grounding (MAIN owns the spawn). */
export interface RepoMapApi {
  build(req: IdeRepoMapRequest): Promise<IdeRepoMapResult>;
}

/* ── linter fan-in (APP-062): ruff/flake8/mypy/pylint → normalized Problems rows ─── */

/** One normalized linter finding (the linters.py sidecar's output shape). */
export interface IdeLintFinding {
  path: string;
  line: number; // 1-based
  col: number; // 1-based
  ruleId: string;
  tool: string;
  severity: string; // "error" | "warning" | "info" | "hint"
  message: string;
}

/** Which linters resolve in the selected interpreter's env. */
export interface IdeLintDetectResult {
  ok: boolean;
  /** installed tool names (ruff/flake8/mypy/pylint) with a resolved absolute path. */
  tools?: string[];
  missing?: string[];
  error?: string;
}

export interface IdeLintRunRequest {
  /** absolute file paths to lint (path-guarded main-side). */
  paths: string[];
  /** the selected interpreter (resolves venv-local linters); omit → PATH resolution. */
  python?: string;
  /** limit to a subset of ruff/flake8/mypy/pylint; omit → all available. */
  tools?: string[];
}

export interface IdeLintRunResult {
  ok: boolean;
  diagnostics?: IdeLintFinding[];
  /** tools that actually ran. */
  ran?: string[];
  /** tools skipped (not installed / errored), with a human reason. */
  skipped?: { tool: string; reason: string }[];
  error?: string;
}

/** The linter fan-in surface (MAIN owns the sidecar spawn; renderer never spawns, C5). */
export interface LintApi {
  detect(python?: string): Promise<IdeLintDetectResult>;
  run(req: IdeLintRunRequest): Promise<IdeLintRunResult>;
}

/* ── Local History (APP-063): per-file revision timeline, diff, revert, recover ─── */

/** One timeline entry: a revision's timestamp + label + line delta from the prior rev. */
export interface IdeHistoryEntry {
  ts: number;
  label?: string;
  added: number;
  removed: number;
}

export interface IdeHistoryListResult {
  ok: boolean;
  entries?: IdeHistoryEntry[];
  error?: string;
}

export interface IdeHistoryReadResult {
  ok: boolean;
  content?: string;
  error?: string;
}

/** Response to `ide:fsWalk` — a flat list of absolute file paths (ignore-pruned). */
export interface IdeFsWalkResult {
  ok: boolean;
  files?: string[];
  error?: string;
}

/** The Local History surface: capture happens main-side on save; this drives the window. */
export interface HistoryApi {
  /** bind (+ load) the active workspace root — captures target it, reads read from it. */
  bind(root: string): Promise<IdeOkResult>;
  /** the revision timeline for a file (newest → oldest). */
  list(root: string, uri: string): Promise<IdeHistoryListResult>;
  /** the content of one revision (uri + ts). */
  read(root: string, uri: string, ts: number): Promise<IdeHistoryReadResult>;
  /** revert a file on disk to a revision (the pre-revert state is captured first). */
  revert(root: string, uri: string, ts: number): Promise<IdeOkResult>;
}

export interface IdeApi {
  // ── fs (MAIN owns the filesystem; renderer never touches node:fs) ─────────
  fsRead(uri: string): Promise<IdeFsReadResult>;
  fsWrite(uri: string, text: string): Promise<IdeOkResult>;
  /** the user's own `~/.prometheus` AGENTS.md / CLAUDE.md (the `global` tier of the chain). */
  steeringGlobal(): Promise<IdeSteeringGlobalResult>;
  /**
   * handoff §3: declare the workspace roots MAIN gates every mutating fs call against.
   * An EMPTY list disables the scope check (no folder open ⇒ no working set).
   */
  setWorkingSet(roots: readonly string[]): Promise<IdeOkResult>;
  /**
   * handoff §3: register ONE absolute path the human explicitly approved writing OUTSIDE
   * the working set. Per-path, never a wildcard; cleared whenever the roots change.
   * `scope: "clear"` forgets every prior approval.
   */
  approveOutsideWorkingSet(
    path: string,
    scope?: "once" | "session" | "clear",
  ): Promise<IdeOkResult>;
  fsTree(dir: string): Promise<IdeTreeNode[]>;
  /** APP-065: walk the whole repo → a flat file list (ignore-pruned, no symlinks). */
  fsWalk(root: string): Promise<IdeFsWalkResult>;
  fsWatch(root: string): Promise<IdeOkResult>;
  fsUnwatch(root: string): Promise<IdeOkResult>;
  /** create an EMPTY file (fails if it exists); path-guarded in MAIN. */
  fsCreateFile(path: string): Promise<IdeOkResult>;
  /** create a directory (fails if it exists); path-guarded in MAIN. */
  fsMkdir(path: string): Promise<IdeOkResult>;
  /** rename / move a path (both src + dest path-guarded in MAIN). */
  fsRename(src: string, dest: string): Promise<IdeOkResult>;
  /** delete a file or directory (recursive); path-guarded in MAIN. */
  fsDelete(path: string): Promise<IdeOkResult>;
  // ── LSP (one server per languageId+workspaceRoot; routed by serverId) ─────
  lspEnsure(
    languageId: string,
    workspaceRoot: string,
    interpreterPath?: string,
  ): Promise<IdeLspEnsureResult>;
  /** APP-077: every live LSP server (for Cmd-T workspace-symbol federation). */
  lspList(): Promise<IdeLspListResult>;
  /** APP-078: ack a relayed server→client `workspace/applyEdit` so its request settles. */
  lspApplyEditResult(
    serverId: string,
    workspaceRoot: string,
    requestId: number | string,
    applied: boolean,
  ): Promise<IdeOkResult>;
  lspRequest(
    serverId: string,
    workspaceRoot: string,
    method: string,
    params?: unknown,
  ): Promise<IdeLspRequestResult>;
  lspCancel(serverId: string, workspaceRoot: string, requestId: number): void;
  lspDidOpen(
    serverId: string,
    workspaceRoot: string,
    uri: string,
    languageId: string,
    text: string,
    version?: number,
  ): void;
  lspDidChange(
    serverId: string,
    workspaceRoot: string,
    uri: string,
    text: string,
    version: number,
  ): void;
  lspDidClose(serverId: string, workspaceRoot: string, uri: string): void;
  lspSetInterpreter(
    serverId: string,
    workspaceRoot: string,
    interpreterPath: string,
  ): Promise<IdeOkResult>;
  // ── DAP (one adapter per debug session; routed by sessionId) ──────────────
  /** launch a debug session; `plan` carries the launch-time breakpoints + exception
   *  filters the host applies during the strict `initialized`→config phase (APP-079);
   *  `opts.allowRemote` confirms a remote (non-loopback) attach socket (APP-080). */
  dapLaunch(
    config: Record<string, unknown>,
    plan?: IdeDapLaunchPlan,
    opts?: IdeDapLaunchOptions,
  ): Promise<IdeDapLaunchResult>;
  dapRequest(sessionId: string, command: string, args?: unknown): Promise<IdeDapRequestResult>;
  dapTerminate(sessionId: string): Promise<IdeOkResult>;
  /** is `type`'s adapter actually runnable right now (APP-029)? a real probe. */
  dapDetectAdapter(type: string, pythonPath?: string): Promise<IdeDapDetectAdapterResult>;
  /** fetch+install `type`'s adapter dependency, nemesis-gated (APP-029). */
  dapInstallAdapter(
    type: string,
    opts?: { pythonPath?: string; confirm?: boolean },
  ): Promise<IdeDapInstallAdapterResult>;
  // ── refactor (refactor.py structural transforms → WorkspaceEdit, APP-026) ─
  // The sidecar only PROPOSES the edit; the renderer previews + applies it via
  // the same normalizeWorkspaceEdit/applyTextEdits path as an LSP rename.
  // ── plain Run (APP-032): gate → guard → spawn in MAIN; output via onEvent ──
  runStart(req: IdeRunStartRequest): Promise<IdeRunStartResult>;
  runKill(runId: string): Promise<IdeRunKillResult>;
  // ── live Jupyter kernel (APP-045): one supervised session per notebook ─────
  kernel: KernelApi;
  // ── profiler (APP-046): gated cProfile run → flame folds ───────────────────
  profile: ProfileApi;
  // ── terminal launcher (APP-048): core profiles/AI presets/env → menu+resolve ─
  terminal: TerminalApi;
  // ── repo-map (APP-053): ranked symbol map for @codebase grounding ──────────
  repoMap: RepoMapApi;

  /** linter fan-in (APP-062): ruff/flake8/mypy/pylint → normalized Problems rows. */
  lint: LintApi;

  /** Local History (APP-063): per-file revision timeline + diff + revert + recover. */
  history: HistoryApi;
  refactor: {
    rename(req: IdeRefactorRenameReq): Promise<IdeRefactorResult>;
    extract(req: IdeRefactorExtractReq): Promise<IdeRefactorResult>;
    inline(req: IdeRefactorInlineReq): Promise<IdeRefactorResult>;
    move(req: IdeRefactorMoveReq): Promise<IdeRefactorResult>;
    changeSignature(req: IdeRefactorChangeSignatureReq): Promise<IdeRefactorResult>;
    safeDelete(req: IdeRefactorSafeDeleteReq): Promise<IdeRefactorResult>;
    // gen-* AST-first generators (APP-028) — same channel, same preview path
    genInit(req: IdeRefactorGenFieldsReq): Promise<IdeRefactorResult>;
    genRepr(req: IdeRefactorGenFieldsReq): Promise<IdeRefactorResult>;
    genEq(req: IdeRefactorGenFieldsReq): Promise<IdeRefactorResult>;
    genDataclass(req: IdeRefactorGenAtReq): Promise<IdeRefactorResult>;
    genProperty(req: IdeRefactorGenPropertyReq): Promise<IdeRefactorResult>;
    genOverride(req: IdeRefactorGenOverrideReq): Promise<IdeRefactorResult>;
    genDelegate(req: IdeRefactorGenDelegateReq): Promise<IdeRefactorResult>;
    genDocstring(req: IdeRefactorGenAtReq): Promise<IdeRefactorResult>;
  };
  // ── PTY (node-pty terminals inheriting the active venv, §6.1) ─────────────
  ptySpawn(req: {
    cwd: string;
    shell?: string;
    cols?: number;
    rows?: number;
    venv?: IdeActiveVenv | null;
  }): Promise<IdePtySpawnResult>;
  ptyWrite(ptyId: string, data: string): void;
  ptyResize(ptyId: string, cols: number, rows: number): void;
  ptyKill(ptyId: string): void;
  // ── APP-090: tear-out terminal window (a hardened secondary BrowserWindow) ──
  floatingTerminal: FloatingTerminalApi;
  /**
   * Which of `bins` are executables on PATH (a lightweight `which`-style probe, no
   * child spawn). Used by the terminal's "+ ▾" CLI menu to show which agent CLIs
   * (claude/codex/gemini/…) are installed vs. need installing.
   */
  detectBins(bins: string[]): Promise<Record<string, boolean>>;
  // ── git (RAW git child process, §6.2) ─────────────────────────────────────
  gitStatus(root: string): Promise<IdeGitStatus>;
  gitDiff(root: string, file: string, staged?: boolean): Promise<IdeGitDiffResult>;
  gitStage(root: string, files: string[]): Promise<IdeGitOpResult>;
  gitUnstage(root: string, files: string[]): Promise<IdeGitOpResult>;
  gitCommit(root: string, message: string, opts?: { amend?: boolean }): Promise<IdeGitOpResult>;
  gitBranch(root: string, name: string, opts?: { create?: boolean }): Promise<IdeGitOpResult>;
  gitBranches(root: string): Promise<IdeGitBranchesResult>;
  gitStash(root: string, message?: string): Promise<IdeGitOpResult>;
  /** List stash entries (read-only). */
  gitStashList(root: string): Promise<IdeGitStashListResult>;
  /** Pop a stash (removes it); latest when index omitted. */
  gitStashPop(root: string, index?: number): Promise<IdeGitOpResult>;
  /** Apply a stash without removing it; latest when index omitted. */
  gitStashApply(root: string, index?: number): Promise<IdeGitOpResult>;
  /** Drop (delete) a stash; latest when index omitted. */
  gitStashDrop(root: string, index?: number): Promise<IdeGitOpResult>;
  /** Per-line blame for a file (read-only). */
  gitBlame(root: string, file: string): Promise<IdeGitBlameResult>;
  /** Abort an in-progress merge/rebase. */
  gitMergeAbort(root: string): Promise<IdeGitOpResult>;
  /** Resolve a conflicted file to one side (`--ours` / `--theirs`). */
  gitCheckoutSide(root: string, file: string, side: "ours" | "theirs"): Promise<IdeGitOpResult>;
  /** APP-037 commit actions — hash is a validated commit-ish (no leading `-`). */
  gitCheckoutCommit(root: string, hash: string): Promise<IdeGitOpResult>;
  gitCherryPick(root: string, hash: string): Promise<IdeGitOpResult>;
  gitRevert(root: string, hash: string): Promise<IdeGitOpResult>;
  gitReset(root: string, hash: string, mode: "soft" | "mixed" | "hard"): Promise<IdeGitOpResult>;
  /** APP-039: read a conflicted file's base/ours/theirs index stages + working copy. */
  gitConflictVersions(root: string, file: string): Promise<IdeGitConflictVersionsResult>;
  gitLog(root: string, limit?: number): Promise<IdeGitLogResult>;
  /** push the current branch to its upstream (`git push`); non-interactive (fails fast). */
  gitPush(root: string): Promise<IdeGitOpResult>;
  /** pull with rebase (`git pull --rebase`); non-interactive. */
  gitPull(root: string): Promise<IdeGitOpResult>;
  /** fetch + prune all remotes (`git fetch --all --prune`); non-interactive. */
  gitFetch(root: string): Promise<IdeGitOpResult>;
  /** APP-082: the commits of `base..HEAD` as an editable rebase todo (oldest-first). */
  gitRebaseTodo(root: string, base: string): Promise<IdeGitRebaseTodoResult>;
  /** Apply an edited rebase todo non-interactively (scripted editors, no shell/UI). */
  gitRebaseRun(root: string, base: string, todo: IdeGitRebaseTodoRow[]): Promise<IdeGitOpResult>;
  /** Is a rebase in progress (incl. after an app restart)? + conflict/step state. */
  gitRebaseState(root: string): Promise<IdeGitRebaseState>;
  /** Continue a conflict-paused rebase (`git rebase --continue`). */
  gitRebaseContinue(root: string): Promise<IdeGitOpResult>;
  /** Abort an in-progress rebase (`git rebase --abort`); restores the pre-rebase tip. */
  gitRebaseAbort(root: string): Promise<IdeGitOpResult>;
  /** APP-083: one commit's metadata for the blame click-through (read-only). */
  gitShow(root: string, sha: string): Promise<IdeGitShowResult>;
  /** APP-084: apply a per-hunk/per-line patch to the index (`git apply --cached [-R] -`). */
  gitApplyPatch(
    root: string,
    patch: string,
    opts?: { cached?: boolean; reverse?: boolean },
  ): Promise<IdeGitOpResult>;
  /** APP-085: is the origin a supported forge + is a token stored? (read-only). */
  gitPrStatus(root: string): Promise<IdePrStatus>;
  /** List open PRs/MRs for the origin forge (every call via the L6 safeFetch proxy). */
  gitPrList(root: string): Promise<IdePrListResult>;
  /** One PR/MR: description + comments + unified diff. */
  gitPrGet(root: string, number: number): Promise<IdePrDetailResult>;
  /** Post a review comment (POST via safeFetch; token from the keychain in MAIN). */
  gitPrComment(root: string, number: number, body: string): Promise<IdePrOpResult>;
  /** Store the forge auth token for the origin host (kept in MAIN's keychain only). */
  gitPrSetToken(root: string, token: string): Promise<IdePrOpResult>;
  // ── the RUN-GATE (§5.2/§9): trusted → skip; else REAL engine gate; fail-closed
  gate(req: IdeGateRequest): Promise<IdeGateResult>;
  /** run ONE user-approved, screened shell command in the workspace; capture output. */
  exec(req: IdeExecRequest): Promise<IdeExecResult>;
  /** Phase 6: run one of core's shared system tools — the same path the CLI runs. */
  systemTool(req: AgentSystemToolRequest): Promise<AgentSystemToolResult>;
  /** list, or run, one of the user's configured lifecycle hooks (main owns the spawn). */
  hookRun(req: AgentHookRunRequest): Promise<AgentHookRunResult>;
  /** record a tripped canary token (point 6b) — main owns the audit file, renderer cannot (C5). */
  canaryTrip(req: AgentCanaryTripRequest): Promise<AgentCanaryTripResult>;
  /** run one `prometheus_*` engine verb — the product's own surface, which the pane lacked. */
  engineTool(req: AgentEngineToolRequest): Promise<AgentSystemToolResult>;
  /** the persisted "don't ask again" grants (shared with the CLI). */
  grantsList(): Promise<AgentGrantsResult>;
  /** persist one grant. Rejected here if the store considers the subject too broad. */
  grantsAdd(grant: AgentGrant): Promise<AgentGrantsResult>;
  /** bounded, gitignore-aware workspace search (content grep or path match), offloaded
   *  to the utilityProcess worker with a graceful inline fallback (APP-066). */
  search(req: IdeSearchRequest): Promise<IdeSearchResult>;
  /** APP-066: cancel an in-flight `search` by its requestId (cooperative; no-op if done). */
  searchCancel(requestId: string): Promise<IdeAckResult>;
  /** APP-066: enumerate the repo's files (flat, sorted) via the offloaded worker walk. */
  workspaceIndex(root: string): Promise<IdeWorkspaceIndexResult>;
  /** APP-076: structural (AST) search — `pattern` uses `$X` metavariables (read-only). */
  structSearch(root: string, pattern: string): Promise<IdeStructSearchResult>;
  /** AST-discover tests under `root` via the testmgr sidecar (never executes code). */
  testDiscover(root: string): Promise<IdeTestDiscoverResult>;
  /** APP-086: run the suite under coverage → a CoverageReport (executes project code). */
  coverageRun(
    root: string,
    framework: "pytest" | "unittest",
    ids?: string[],
  ): Promise<IdeCoverageResult>;
  /** Import an external coverage.py JSON (or a prior Studio report) → a CoverageReport. */
  coverageImport(path: string): Promise<IdeCoverageResult>;
  /**
   * EXECUTE the given test node ids via testmgr.py `run` (APP-013). This RUNS
   * project code by design — user-initiated only. Per-test events stream over
   * onTestEvent; the terminal `{ok, summary}` rides back in the result.
   */
  testRun(root: string, framework: IdeTestFramework, ids: string[]): Promise<IdeTestRunResult>;
  /** Re-run ONLY the supplied failed ids (testmgr.py `rerun-failed`, same run path). */
  testRerunFailed(
    root: string,
    framework: IdeTestFramework,
    failedIds: string[],
  ): Promise<IdeTestRunResult>;
  /** Subscribe to the live per-test event stream (ide:test.event). Returns an
   *  unsubscribe fn. Cosmetic/data only — never a security verdict (C5). */
  onTestEvent(listener: (event: IdeTestEvent) => void): () => void;
  /**
   * Subscribe to the multiplexed IDE host feed (LSP/DAP/PTY/fs events). Returns an
   * unsubscribe fn. Cosmetic/data only — never a security verdict (C5).
   */
  onEvent(listener: (event: IdeEvent) => void): () => void;
  // ── worktrees (Task #5, desktop parity): create/list/remove git worktrees for parallel
  // sessions, via the SAME `@prometheus/core/git-worktree` functions the CLI's `/worktree`
  // slash calls. "switch" has no IPC of its own — the renderer repoints the workspace root
  // client-side against a `list()` row, mirroring the CLI's `ctx.setCwd`.
  worktreeList(root: string): Promise<IdeWorktreeListResult>;
  /** Create a worktree for `branch` (new or existing); `path` defaults to a repo-sibling dir. */
  worktreeCreate(root: string, branch: string, path?: string): Promise<IdeWorktreeOpResult>;
  /** Remove a worktree by path. Refuses a dirty or locked worktree (never `--force`). */
  worktreeRemove(root: string, path: string): Promise<IdeWorktreeOpResult>;
  // ── sub-agent personas (Task #5, desktop parity): markdown personas for `spawn_agent`,
  // via the SAME `@prometheus/core/agent-files` clamping the CLI applies.
  agentFilesList(root: string): Promise<IdeAgentFilesListResult>;
  // ── custom slash commands (Task #5, desktop parity): markdown commands, parsed by the
  // SAME `@prometheus/core/command-loader` the CLI's `/command` loader uses.
  commandFilesList(root: string): Promise<IdeCommandFilesListResult>;
}

/* ── metadata: atomic file-metadata control (file 0C — privacy protection) ───
 * The plain-data shapes the Metadata panel renders + drives. The MAIN process owns the
 * fs + spawns the metadata.py sidecar (C5); every mutating result is a PLAN unless the
 * renderer passed `confirm:true`. Mirrors @prometheus/engine-bridge's metadata types
 * (defined here so the renderer never imports engine-bridge). */

/** Filesystem-level metadata (os.stat). */
export interface MetaFs {
  size: number;
  mode: string;
  mtime: number;
  atime: number;
  ctime: number;
  birthtime?: number;
  uid?: number | null;
  gid?: number | null;
}

/** Which optional metadata tools the sidecar found. */
export interface MetaTools {
  exiftool: boolean;
  pil: boolean;
  pikepdf: boolean;
}

/** A full metadata read (the `inspect` verb). */
export interface MetadataInspectResult {
  ok: boolean;
  file?: string;
  mime?: string;
  fs?: MetaFs;
  xattrs?: string[];
  tagSource?: "exiftool" | "pil" | "pikepdf" | "zip" | "none";
  tags?: Record<string, string>;
  tagCount?: number;
  tools?: MetaTools;
  error?: string;
}

/** A scrub result (plan when `planned`, else the applied delta). */
export interface MetadataScrubResult {
  ok: boolean;
  file?: string;
  planned?: boolean;
  scrubbed?: boolean;
  before?: { tagCount: number; tags?: Record<string, string>; xattrs?: string[] };
  after?: { tagCount: number };
  removed?: number;
  xattrsRemoved?: number;
  note?: string;
  error?: string;
}

/** An edit result (plan unless confirmed). */
export interface MetadataEditResult {
  ok: boolean;
  file?: string;
  field?: string;
  value?: string;
  planned?: boolean;
  edited?: boolean;
  note?: string;
  error?: string;
}

/** A timestamp-normalize result (plan unless confirmed). */
export interface MetadataTimestompResult {
  ok: boolean;
  file?: string;
  mtime?: number;
  atime?: number;
  planned?: boolean;
  stomped?: boolean;
  current?: MetaFs;
  fs?: MetaFs;
  note?: string;
  error?: string;
}

/** The native open-file picker result. */
export interface FileOpenResult {
  ok: boolean;
  /** the chosen absolute path, or null when the user cancelled. */
  path: string | null;
  canceled: boolean;
}

/** The native open-FOLDER picker result (models-root chooser). */
export interface FolderOpenResult {
  ok: boolean;
  path: string | null;
  canceled: boolean;
  /** present when the user's chosen folder was inside Prometheus's OWN repo and `path` was
   *  redirected to the user's home directory instead — the ORIGINAL folder they picked. */
  redirectedFromOwnRepo?: string;
}

/** Result of opening a path with the OS default handler (external, outside the app). */
export interface OpenPathResult {
  ok: boolean;
  /** electron's shell.openPath returns "" on success, else an error string. */
  error?: string;
}

/* ── SPECTACULAR power-up renderer-facing shapes (plain data, no engine handles) ── */

/** describe <id> — the catalog card. */
export interface SpectacularCard {
  ok: boolean;
  id?: string;
  /** plugin | model_tool | app | model | documented */
  kind?: string;
  name?: string;
  summary?: string;
  repo?: string;
  license?: string;
  category?: string;
  tier?: string;
  security?: string;
  installable?: boolean;
  hasTutorial?: boolean;
  error?: string;
}

/** tutorial <id> — the deep dossier markdown ("Learn more"). */
export interface SpectacularTutorial {
  ok: boolean;
  id?: string;
  text?: string;
  error?: string;
}

/** methods <id> — every documented install method (markdown section). */
export interface SpectacularMethods {
  ok: boolean;
  id?: string;
  section?: string;
  error?: string;
}

/** harden — one defensive self-audit finding. */
export interface HardenFindingRow {
  severity: string;
  message: string;
  fix: string;
}
export interface SpectacularHarden {
  ok: boolean;
  findings: HardenFindingRow[];
  warnings: number;
  error?: string;
}

/** chat --local — the agentic local reply. */
export interface SpectacularChatLocal {
  ok: boolean;
  response?: string;
  model?: string;
  runner?: string;
  error?: string;
}

/** Options for a terminal-chat preview (mirrors engine-bridge ChatPreviewOpts). */
export interface SpectacularChatPreviewOpts {
  model?: string;
  systemPrompt?: string;
  replaceSystem?: boolean;
  bypass?: boolean;
  tmux?: string | boolean;
  cwd?: string;
  prompt?: string;
}

/** chat --cli (preview) — the assembled, injection-safe command the OPEN button runs. */
/**
 * Discriminated union so the compiler enforces the engine contract: on success
 * EVERY field the engine always sends is required (no spurious `undefined`); on
 * failure only `error` is present. Narrow with `if (r.ok)` before reading argv/cwd.
 */
export type SpectacularChatPreview =
  | {
      ok: true;
      cli: string;
      label: string;
      argv: string[];
      env: Record<string, string>;
      notes: string[];
      bypass: boolean;
      tmux: string | null;
      interactive: boolean;
      model: string | null;
      /** resolved working directory for the terminal session (GUI ptySpawn cwd). */
      cwd: string;
      error?: string;
    }
  | { ok: false; error: string };

/** models config — the default models install folder. */
export interface SpectacularModelsConfig {
  ok: boolean;
  modelsRoot?: string;
  exists?: boolean;
  error?: string;
}

/** models browse — one open model in the local-run catalog (the picker). */
export interface SpectacularModelRow {
  id: string;
  name: string;
  params: string;
  license: string;
  ollama: string;
  served: string;
  note: string;
}
export interface SpectacularModelsBrowse {
  ok: boolean;
  models: SpectacularModelRow[];
  error?: string;
}

/** The renderer-facing `window.prometheus.spectacular.*` surface. */
export interface SpectacularApi {
  describe(id: string): Promise<SpectacularCard>;
  tutorial(id: string): Promise<SpectacularTutorial>;
  methods(id: string): Promise<SpectacularMethods>;
  harden(): Promise<SpectacularHarden>;
  chatLocal(model: string, prompt: string, runner?: string): Promise<SpectacularChatLocal>;
  chatPreview(cli: string, opts?: SpectacularChatPreviewOpts): Promise<SpectacularChatPreview>;
  modelsConfig(setRoot?: string): Promise<SpectacularModelsConfig>;
  modelsBrowse(): Promise<SpectacularModelsBrowse>;
}

/** The renderer-facing `window.prometheus.metadata.*` surface (file 0C). */
export interface MetadataApi {
  /** Read all metadata for a file. */
  inspect(uri: string): Promise<MetadataInspectResult>;
  /** Strip all metadata (plan unless `confirm`). Copy-then-replace; original safe on fail. */
  scrub(uri: string, confirm?: boolean): Promise<MetadataScrubResult>;
  /** Set one metadata field (needs exiftool; plan unless `confirm`). */
  edit(uri: string, field: string, value: string, confirm?: boolean): Promise<MetadataEditResult>;
  /** Normalize file timestamps (plan unless `confirm`). */
  timestomp(
    uri: string,
    mtime: number,
    atime?: number,
    confirm?: boolean,
  ): Promise<MetadataTimestompResult>;
}

/* ── MCP connectors (file 09 §2): plain-data projection of a core McpServerConfig ── */

/** A renderer-safe view of one configured MCP connector (no nested engine objects). */
export interface McpConnectorView {
  id: string;
  label: string;
  /** "stdio" (spawned subprocess) or "http" (streamable URL). */
  transportKind: "stdio" | "http";
  /** the stdio launch command (transportKind === "stdio"). */
  command?: string;
  /** the http url (transportKind === "http"). */
  url?: string;
  enabled: boolean;
  /** unknown | starting | ready | error | blocked. */
  health: string;
  source: string;
  scope: string;
  /** number of tools the server advertised (once connected). */
  toolCount: number;
  /** the last nemesis verdict tier on the launch command / source (allow|warn|block|error). */
  verdict?: string;
}

/** Add a connector: a stdio command or an http url. */
export interface McpAddRequest {
  id: string;
  label: string;
  transport:
    | {
        kind: "stdio";
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
      }
    | { kind: "http"; url: string; headers?: Record<string, string> };
  scope?: "global" | "profile" | "workspace";
}

export interface McpListResult {
  ok: boolean;
  servers: McpConnectorView[];
  error?: string;
}

/** Result of an add/connect/disconnect/remove/toggle op. */
export interface McpOpResult {
  ok: boolean;
  server?: McpConnectorView;
  /** true when the add was refused by nemesis (verdict block/error). */
  blocked?: boolean;
  verdict?: string;
  error?: string;
}

export interface McpImportResult {
  ok: boolean;
  /** how many connectors were imported from other agents' configs. */
  imported: number;
  servers: McpConnectorView[];
  error?: string;
}

/** `window.prometheus.mcp.*` — the connector manager surface (file 09 §2). */
export interface McpApi {
  /** All configured connectors + their live health. */
  list(): Promise<McpListResult>;
  /** Add + nemesis-gate a connector (persisted disabled; blocked if the scan fails). */
  add(req: McpAddRequest): Promise<McpOpResult>;
  /** Connect a connector: spawn/handshake, list tools, cache caps, health=ready. */
  connect(id: string): Promise<McpOpResult>;
  /** Disconnect (config persists; reversible). */
  disconnect(id: string): Promise<McpOpResult>;
  /** Remove a connector entirely. */
  remove(id: string): Promise<McpOpResult>;
  /** Enable (connect) or disable (disconnect) a connector, persisting the flag. */
  setEnabled(id: string, enabled: boolean): Promise<McpOpResult>;
  /** Import connectors from other agents' on-disk configs (Claude/Cursor/Codex/…). */
  import(): Promise<McpImportResult>;
  /** The live tool DESCRIPTORS the agent pane turns into tool defs (it had only a count). */
  agentTools(): Promise<McpAgentToolsResult>;
  /** Call one tool on one connected server, already approved upstream by the pane's broker. */
  agentCall(req: McpAgentCallRequest): Promise<AgentSystemToolResult>;
}

/* ── APP-095: git-backed settings sync ─────────────────────────────────────────*/

/** The renderer's keymap slice pushed into the bundle (base preset id + override layer). */
export interface SettingsSyncKeymap {
  base: string;
  overrides: unknown[];
}
export interface SettingsSyncPushRequest {
  /** the local git repo directory the bundle is committed into + pushed from. */
  repoDir: string;
  keymap: SettingsSyncKeymap;
  /** custom (imported/authored) color schemes — no secrets by construction. */
  themes: unknown[];
}
export interface SettingsSyncResult {
  ok: boolean;
  message?: string;
  error?: string;
}
/** The pulled bundle (secrets already redacted at push time) — the renderer applies it
 *  only after an explicit confirm. */
export interface SettingsSyncBundle {
  version: number;
  keymap: SettingsSyncKeymap;
  themes: unknown[];
  connectors: unknown[];
}
export interface SettingsSyncPullResult {
  ok: boolean;
  bundle?: SettingsSyncBundle;
  error?: string;
}

/** `window.prometheus.settingsSync.*` — git-backed keymap/theme/connector sync (APP-095). */
export interface SettingsSyncApi {
  /** Gather + redact settings, write the bundle into the repo, commit, and push. */
  push(req: SettingsSyncPushRequest): Promise<SettingsSyncResult>;
  /** Pull + validate the repo's bundle and RETURN it (the renderer applies after confirm). */
  pull(req: { repoDir: string }): Promise<SettingsSyncPullResult>;
}

/* ── settings: the keyed/layered settings tree (file 13 §2.1/§2.7) ──────────
 * The renderer never imports @prometheus/core (C5) — SettingsRowView mirrors
 * core's SettingsNode + a resolved (value, layer) provenance pair, mapped in
 * MAIN. `layer` names which of the 4 §7.1 layers produced the effective value.
 */

/** Which layer produced a node's effective value (mirrors core's SettingsLayerName). */
export type SettingsLayer = "default" | "global" | "profile" | "workspace" | "unset";

/** The EDITABLE UI scope tabs (APP-058): default (read-only) ← user (global) ← project
 *  (workspace). The `profile` layer sits between user and project with NO tab (fixed bundle). */
export type SettingsUiScope = "default" | "user" | "project";

/** A settings-tree row as the renderer receives it: shape + resolved value/provenance. */
export interface SettingsRowView {
  id: string;
  title: string;
  category: string;
  ownerFile: string;
  control: string;
  schemaKey?: string;
  scope: string;
  value?: unknown;
  layer?: SettingsLayer;
  /** APP-058: the raw (pre-merge) value at each editable scope that SETS the key; a scope
   *  absent from the map = "not set at this scope" (never the merged effective value). */
  rawByScope?: Partial<Record<SettingsUiScope, unknown>>;
  /** APP-058: every layer that sets the key, precedence order — the "overrides …" chain. */
  definedIn?: SettingsLayer[];
  searchTerms?: string[];
  /** the closed value set for a `select` control, so the editor can render a real dropdown. */
  options?: readonly { value: string; label: string }[];
  children?: SettingsRowView[];
}

export interface SettingsListResult {
  ok: boolean;
  nodes?: SettingsRowView[];
  error?: string;
}

export interface SettingsGetResult {
  ok: boolean;
  value?: unknown;
  layer?: SettingsLayer;
  error?: string;
}

export type SettingsSetResult = IdeOkResult;
export type SettingsResetResult = IdeOkResult;

/**
 * The persistence scope a `set`/`reset` writes to. Built-in profiles (§7.1) are FIXED
 * bundles (Power-dev/Security-strict/Local-only) selected via the `profileId` key —
 * not a user-editable override layer — so only `global`/`workspace` are writable here;
 * switching profiles is `set("profileId", "<id>", "global")`.
 */
export type SettingsWriteScope = "global" | "workspace";

/** `window.prometheus.settings.*` — the keyed/layered settings surface (file 13 §2.1).
 *  `workspaceRoot` is optional everywhere (global-only settings work with no folder
 *  open) but REQUIRED to read/write the workspace layer — omitting it when a workspace
 *  override exists just means that override doesn't apply to the resolved value. */
export interface SettingsApi {
  /** The full tree with each leaf's effective value + layer/ownerFile provenance. */
  list(workspaceRoot?: string): Promise<SettingsListResult>;
  /** One key's effective value. */
  get(key: string, workspaceRoot?: string): Promise<SettingsGetResult>;
  /** Persist `value` at `key` in `scope`, atomically. Unknown key ⇒ a typed error.
   *  `workspaceRoot` is required when `scope === "workspace"`. */
  set(
    key: string,
    value: unknown,
    scope: SettingsWriteScope,
    workspaceRoot?: string,
  ): Promise<SettingsSetResult>;
  /** Remove `key`'s override in `scope`; the effective value falls back down the chain.
   *  `workspaceRoot` is required when `scope === "workspace"`. */
  reset(
    key: string,
    scope: SettingsWriteScope,
    workspaceRoot?: string,
  ): Promise<SettingsResetResult>;
}

/**
 * `window.prometheus.authLevel.*` — the persisted A0–A7 autonomy level.
 *
 * The GUI kept this in `localStorage`, the CLI in a file, and VS Code in a setting on a
 * different ladder: one name, three settings, none of which could see the others. This surface
 * is the app's view of the SHARED file (`~/.prometheus/config/authorisation.json`).
 *
 * `get` returns `null` when nothing has ever been saved, so the renderer can keep its own safe
 * default instead of being handed one — "never set" and "deliberately set to 1" are different
 * facts and only the first may be overwritten silently.
 */
export interface AuthLevelApi {
  /** The saved level, or null when the operator has never chosen one. */
  get(): Promise<AuthLevelResult>;
  /** Persist an EXPLICIT choice (the level picker). Clamped to the ladder by the store. */
  set(level: number): Promise<AuthLevelResult>;
}

/**
 * `window.prometheus.effort.*` — the persisted thinking-effort tier.
 *
 * The app's view of the SHARED file (`~/.prometheus/config/effort.json`). `get` returns `null`
 * when nothing has ever been saved, so a never-chosen tier and a deliberately-chosen one stay
 * distinguishable and only the first is overwritten silently.
 */
export interface EffortPrefApi {
  /** The saved tier, or null when the operator has never chosen one. */
  get(): Promise<EffortPrefResult>;
  /** Persist an EXPLICIT choice (the effort chip). Rejected unless it is a real ladder rung. */
  set(tier: string): Promise<EffortPrefResult>;
}

/** The "@"-path fuzzy completion feature (shared logic with the CLI). */
export interface PathCompletionApi {
  /** Rank one directory's entries against `query` (fragment/fuzzy, never a rigid prefix).
   *  Pass `useFrecency: true` (with `workspaceRoot`) to boost this project's remembered
   *  top-used paths — the "Tools ▸ Path Completion" setting; the caller decides whether
   *  that setting is on, this call always honors whatever it's told. */
  list(
    dir: string,
    query: string,
    workspaceRoot?: string,
    useFrecency?: boolean,
  ): Promise<PathCompletionListResult>;
  /** Record that `path` was just "@"-completed, for the opt-in frecency memory. */
  recordUse(workspaceRoot: string, path: string): Promise<PathCompletionRecordUseResult>;
}

/** Model health: per-endpoint transport/breaker/context-window state, persisted globally
 *  (never workspace-scoped — endpoints are not tied to one project). */
export interface ModelHealthApi {
  /** Every endpoint this install has ever recorded a turn against. */
  list(): Promise<ModelHealthListResult>;
  /** Persist one endpoint's health record after a turn (fire-and-forget from the caller's
   *  point of view; the returned promise is there for callers that want to know it landed). */
  record(record: ModelHealthRecordView): Promise<ModelHealthRecordResult>;
}

/** Scheduled/autonomous runs: cron-triggered agent turns, bounded by a per-task autonomy
 *  ladder (readonly/edits/commands) — persisted globally (never workspace-scoped). MAIN owns
 *  the store at a fixed userData path; the renderer only ever sees these plain task views. */
export interface ScheduleApi {
  /** Every scheduled task this install has registered. */
  list(): Promise<ScheduleListResult>;
  /** Create or update one task (keyed by `id`). */
  upsert(task: ScheduledTaskView): Promise<ScheduleUpsertResult>;
  /** Remove one task by id. A no-op (not an error) when the id is already gone. */
  remove(id: string): Promise<ScheduleRemoveResult>;
}

/** Persona sharing: export one of the user's OWN personas as plain text, and import a persona
 *  someone else shared — ALWAYS as "imported" scope, clamped identically to "project" (model
 *  refused, forced read-only, tools only narrow) regardless of what the shared file requests. */
export interface PersonaApi {
  /** Every persona in the shared catalog (user's own, this project's, and imported). */
  list(): Promise<PersonaListResult>;
  /** One persona's raw markdown, verbatim, for the user to copy/paste or hand to someone else. */
  export(name: string): Promise<PersonaExportResult>;
  /** Import pasted/typed markdown text as a new persona (always written to the imported scope). */
  importText(suggestedName: string, markdown: string): Promise<PersonaImportResult>;
  /** Import a LOCAL file by absolute path (from the native file picker) — never a URL. */
  importPath(path: string): Promise<PersonaImportResult>;
  /** Remove an imported persona by name. Cannot touch the user's own or a project's personas. */
  remove(name: string): Promise<PersonaRemoveResult>;
}

/** Budget & spend visibility (roadmap point 4). Read-only — setting a cap goes through the
 *  existing `window.prometheus.settings.set("budget.sessionUsd", …, "global")` etc. */
export interface BudgetApi {
  status(): Promise<BudgetStatusResult>;
}

/** "Meet your codebase" (roadmap point 6): an on-demand, friendly first-look overview of the
 *  currently open workspace. Nothing runs until the renderer explicitly calls `generate()`. */
export interface CodebaseOverviewApi {
  generate(): Promise<CodebaseOverviewResult>;
}

/* ── extension host (file 09 §5, APP-059) ───────────────────────────────────
 * The renderer drives install/activate/deactivate/list; the REAL host runs in an
 * Electron utility process (main owns it, C5). Plain data crosses IPC — a manifest
 * summary, not the live host object.
 */

/** A stored/last nemesis scan result for an extension (compact — drives the VerdictChip). */
export interface ExtStoredVerdictView {
  /** "allow" | "warn" | "block" | "error" (the marketplace WorstVerdict maps 1:1). */
  tier: string;
  riskScore: number;
  findingsCount: number;
  scannedAt: string;
}

/** One installed extension, as the marketplace/list UI receives it. */
export interface ExtInfoView {
  id: string;
  label: string;
  version: string;
  installPath: string;
  /** whether the extension is currently activated in the utility process. */
  active: boolean;
  /** APP-060: the user's persisted desired enabled state (authoritative at startup). */
  enabled: boolean;
  /** the human-readable declared-permission summary (from core permissionSummary). */
  permissions: string[];
  /** APP-060: the stored verdict (absent → the chip shows unknown, never a fake GREEN). */
  verdict?: ExtStoredVerdictView;
}

/** One finding surfaced in the install/rescan verdict card (plain data, rendered as TEXT). */
export interface ExtFindingView {
  ruleId: string;
  severity: string;
  detail: string;
}

/** Response to `ext:rescan` — the fresh verdict + its findings for the row's chip + card. */
export interface ExtRescanResult {
  ok: boolean;
  verdict?: {
    tier: string;
    riskScore: number;
    scannedAt: string;
    findings: ExtFindingView[];
  };
  error?: string;
}

export interface ExtListResult {
  ok: boolean;
  extensions?: ExtInfoView[];
  error?: string;
}

export interface ExtInstallResult {
  ok: boolean;
  id?: string;
  installPath?: string;
  /** the typed failure code on `ok:false` (bad-zip | bad-manifest | incompatible | blocked | io). */
  code?: string;
  error?: string;
}

export type ExtActivateResult = IdeOkResult;
export type ExtDeactivateResult = IdeOkResult;

/** `window.prometheus.ext.*` — the extension-host surface (file 09 §5). */
export interface ExtApi {
  list(): Promise<ExtListResult>;
  /** install a `.promext` at an absolute path (gated); returns the id or a typed error. */
  install(archivePath: string): Promise<ExtInstallResult>;
  activate(id: string): Promise<ExtActivateResult>;
  deactivate(id: string): Promise<ExtDeactivateResult>;
  /** APP-060: re-scan an installed extension's gate target; stores + returns the verdict. */
  rescan(id: string): Promise<ExtRescanResult>;
}

/* ── updates: the auto-updater surface (file 10 §5, APP-005) ─────────────────
 * Thin bridge over main/updater.ts. The renderer only ever sees these PLAIN
 * shapes — main maps electron-updater results/events before they cross IPC
 * (raw UpdateCheckResult carries a live cancellationToken → DataCloneError).
 * Policy invariants live in MAIN (@prometheus/core update-policy): ask-before-
 * download, never-auto-install — this surface is UX over those gates only.
 */

/** The invoke channels — MUST match main/updater.ts's ipcMain.handle strings. */
export const IPC_UPDATE = {
  check: "update:check",
  download: "update:download",
  install: "update:install",
} as const;

/** The MAIN→renderer event channels — MUST match main/updater.ts's sends. */
export const IPC_UPDATE_EVENTS = {
  available: "update:available",
  progress: "update:progress",
  ready: "update:ready",
} as const;

/** `update:check` result. In dev (electron-updater absent / unsigned build) the
 *  invoke may REJECT (no handler) or resolve ok:false — both mean "no banner". */
export interface UpdateCheckResult {
  ok: boolean;
  /** null when already up to date. */
  version?: string | null;
  releaseDate?: string | null;
  error?: string;
}

export interface UpdateDownloadResult {
  ok: boolean;
  files?: string[];
  error?: string;
}

export interface UpdateInstallResult {
  ok: boolean;
  error?: string;
}

/** The plain slice of electron-updater's UpdateInfo forwarded on update:available. */
export interface UpdateAvailableInfo {
  version?: string;
  releaseDate?: string;
}

/** download-progress payload — `percent` is a FLOAT 0-100, round before display. */
export interface UpdateProgressInfo {
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
}

/** `window.prometheus.updates.*` — check/download/install + the three event feeds.
 *  Each `on*` returns an unsubscribe; events lost before subscription are tolerated
 *  (check() re-polls current state so the banner can reconstruct). */
export interface UpdatesApi {
  check(): Promise<UpdateCheckResult>;
  download(): Promise<UpdateDownloadResult>;
  /** quitAndInstall — the ONLY apply path, reachable strictly after update:ready. */
  install(): Promise<UpdateInstallResult>;
  onAvailable(listener: (info: UpdateAvailableInfo) => void): () => void;
  onProgress(listener: (p: UpdateProgressInfo) => void): () => void;
  onReady(listener: () => void): () => void;
}

/** The global key the API is exposed under in the renderer. */
export const BRIDGE_KEY = "prometheus" as const;
