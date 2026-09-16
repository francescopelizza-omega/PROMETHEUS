/**
 * main/ide-ipc.ts — the typed `ide:*` ipcMain handlers (file 07 §3.2/§4/§5/§6/§9).
 *
 * The trusted side of the contextBridge seam for the Code-Editor / IDE surface. It
 * is RELAY-ONLY (mirrors security-ipc.ts / env-ipc.ts): every handler
 *   1. zod-validates the renderer's arg at the seam (ide-validate.ts),
 *   2. delegates to the MAIN-process host that owns the child process / fs
 *      (LspHost / DapHost / PtyHost / GitHost / FsWatchHost) or the engine-bridge
 *      RUN-GATE (gate.ts → the only nemesis spawner, C5), and
 *   3. maps the result down to a renderer-safe plain-data shape, never letting a
 *      live handle / ChildProcess cross back.
 *
 * GOLDEN RULE (C5): the renderer NEVER spawns a child; it drives the hosts over
 * IPC. The RUN-GATE verdict is the ENGINE's — this file performs NO scoring, NO
 * allowlist, NO heuristic, and never upgrades a verdict toward allow. The hosts'
 * events (LSP diagnostics, DAP events, PTY output, fs changes) are multiplexed to
 * the renderer over the single `ide:event` push (cosmetic/data only — no verdict).
 *
 * The hosts are INJECTED via wiring so this module is decoupled from the actual
 * binaries (pyright/debugpy/node-pty absent here) — main/index.ts constructs them
 * with the real node:child_process / node-pty spawn fns; node:test injects fakes.
 *
 * Node/Electron only at runtime (privileged main process). It imports the hosts +
 * engine-bridge — which the renderer is forbidden from doing. The pure, testable
 * arg-validation lives in ide-validate.ts (zod-double-tested, no electron).
 */

import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { ipcMain } from "electron";

import {
  type EngineConfig,
  type SidecarEnvelope,
  type SqlClient,
  createEngineClient,
  createSqlClient,
  runSidecar as runSidecarScript,
  safeFetch,
} from "@prometheus/engine-bridge";

import {
  cliProfiles,
  agent as coreAgent,
  rules as coreRules,
  settings as coreSettings,
} from "@prometheus/core";
import { DEFAULT_AUTH_LEVEL } from "@prometheus/core/agent-authorization";
import { isHostDispatchTool } from "@prometheus/core/agent-system";
import { isPathAllowed, pathArgsOf, scopedAbsolute } from "@prometheus/core/agent-system-host";
import {
  appendCanaryAudit,
  prometheusHome,
  readGrants,
  runBrowserTool,
  runEngineVerb,
  runSystemTool,
  runWebTool,
  saveGrants,
} from "@prometheus/core/agent-system-host";

import { browserToolHostDeps } from "./browser-tool-host.js";

import {
  IPC,
  IPC_EVENTS,
  type IdeAckResult,
  type IdeAgentFilesListResult,
  type IdeCommandFilesListResult,
  type IdeCoverageReport,
  type IdeCoverageResult,
  type IdeDapDetectAdapterResult,
  type IdeDapInstallAdapterResult,
  type IdeDapLaunchResult,
  type IdeDapRequestResult,
  type IdeEvent,
  type IdeExecResult,
  type IdeFloatingTerminalResult,
  type IdeFsReadResult,
  type IdeFsWalkResult,
  type IdeGateRequest,
  type IdeGateResult,
  type IdeGitBlameResult,
  type IdeGitBranchesResult,
  type IdeGitConflictVersionsResult,
  type IdeGitDiffResult,
  type IdeGitLogResult,
  type IdeGitOpResult,
  type IdeGitRebaseState,
  type IdeGitRebaseTodoResult,
  type IdeGitShowResult,
  type IdeGitStashListResult,
  type IdeGitStatus,
  type IdeHistoryListResult,
  type IdeHistoryReadResult,
  type IdeKernelOkResult,
  type IdeKernelStartResult,
  type IdeKernelStreamEvent,
  type IdeLintDetectResult,
  type IdeLintFinding,
  type IdeLintRunResult,
  type IdeLspEnsureResult,
  type IdeLspListResult,
  type IdeLspRequestResult,
  type IdeOkResult,
  type IdePrDetailResult,
  type IdePrListResult,
  type IdePrOpResult,
  type IdePrStatus,
  type IdeProfileCompareResult,
  type IdeProfileListResult,
  type IdeProfileMode,
  type IdeProfileResult,
  type IdeProfileSample,
  type IdeProfileSaveResult,
  type IdeProfileSnapshotMeta,
  type IdePtySpawnResult,
  type IdeRefactorResult,
  type IdeRepoMapFile,
  type IdeRepoMapResult,
  type IdeRunKillResult,
  type IdeRunStartResult,
  type IdeSearchResult,
  type IdeSqlCell,
  type IdeSqlConnectResult,
  type IdeSqlQueryResult,
  type IdeSqlSchemaResult,
  type IdeStructMatch,
  type IdeStructSearchResult,
  type IdeTerminalMenuResult,
  type IdeTerminalResolveResult,
  type IdeTestDiscoverResult,
  type IdeTestEvent,
  type IdeTestNode,
  type IdeTestRunResult,
  type IdeTreeNode,
  type IdeWorkspaceIndexResult,
  type IdeWorktreeListResult,
  type IdeWorktreeOpResult,
  type SystemTelemetry,
} from "../shared/ipc-contract.js";
import type {
  AgentCanaryTripRequest,
  AgentCanaryTripResult,
  AgentEngineToolRequest,
  AgentGrant,
  AgentGrantsResult,
  AgentHookRunRequest,
  AgentHookRunResult,
  AgentSystemToolRequest,
  AgentSystemToolResult,
  IdeSteeringGlobalResult,
} from "../shared/ipc-contract.js";
import {
  type FileSearchQuery,
  type TaskRequest,
  type TaskResponse,
  runTask,
} from "../worker/tasks.js";
import { listHooks, runConfiguredHook } from "./agent-hooks.js";
import { getSecurityPosture } from "./ai-ipc.js";
import {
  validateCoverageImport,
  validateCoverageRun,
  validateDapDetectAdapter,
  validateDapInstallAdapter,
  validateDapLaunch,
  validateDapRequest,
  validateDapTerminate,
  validateExec,
  validateFloatingTerminalClose,
  validateFloatingTerminalCreate,
  validateFsPath,
  validateFsRead,
  validateFsRename,
  validateFsTree,
  validateFsWatch,
  validateFsWrite,
  validateGate,
  validateGitApplyPatch,
  validateGitBlame,
  validateGitBranch,
  validateGitCheckoutSide,
  validateGitCommit,
  validateGitCommitRef,
  validateGitConflictVersions,
  validateGitDiff,
  validateGitFiles,
  validateGitLog,
  validateGitPrComment,
  validateGitPrGet,
  validateGitPrSetToken,
  validateGitRebaseRun,
  validateGitRebaseTodo,
  validateGitReset,
  validateGitRoot,
  validateGitStash,
  validateGitStashRef,
  validateGitWorktreeCreate,
  validateGitWorktreeRemove,
  validateKernelDataframe,
  validateKernelExecute,
  validateKernelSession,
  validateKernelStart,
  validateLspCancel,
  validateLspDoc,
  validateLspEnsure,
  validateLspRequest,
  validateLspSetInterpreter,
  validateProfileCompare,
  validateProfileSnapshotSave,
  validateProfileStart,
  validatePtyKill,
  validatePtyResize,
  validatePtySpawn,
  validatePtyWrite,
  validateRefactor,
  validateRepoMap,
  validateRunKill,
  validateRunStart,
  validateSearch,
  validateSearchCancel,
  validateSqlConnect,
  validateSqlQuery,
  validateSqlSchema,
  validateStructSearch,
  validateTerminalMenu,
  validateTerminalResolve,
  validateTestRun,
} from "./ide-validate.js";
import { loadAgentFiles } from "./ide/agent-files-host.js";
import { loadCommandFiles } from "./ide/command-files-host.js";
import type { DapHost, DapLaunchOptions, DapLaunchPlan } from "./ide/dap-host.js";
import { type ExecRunner, defaultExecRunner } from "./ide/exec-host.js";

import { screenCommand } from "./ide/exec-screen.js";
import { assertExecuteAllowed } from "./ide/execute-guards.js";
import {
  type FsWatchHost,
  fsCreateFile,
  fsDelete,
  fsMkdir,
  fsRead,
  fsRename,
  fsTree,
  fsWalk,
  fsWrite,
  isLargeFile,
} from "./ide/fs-watch.js";
import { type RunGateResult, runGate } from "./ide/gate.js";
import type { GitHost } from "./ide/git-host.js";
import type { LocalHistoryManager } from "./ide/history-store.js";
import { KernelHost, type KernelSpawner } from "./ide/kernel-host.js";
import type { LspHost } from "./ide/lsp-host.js";
import {
  approveOutsideWorkingSet,
  assertInsideWorkingSet,
  assertNotSensitivePath,
  clearOutsideApprovals,
  getWorkingSetRoots,
  grantWorkingSetRoot,
  isGrantedRoot,
  isInsideWorkingSet,
  setWorkingSetRoots,
  uriToFsPath,
} from "./ide/path-guard.js";
import type { PtyHost } from "./ide/pty-host.js";
import { type RefactorRunner, runRefactorVerb } from "./ide/refactor-host.js";
import { type RunHost, startGatedRun } from "./ide/run-host.js";
import { SqlHost } from "./ide/sql-host.js";
import { buildTerminalMenuItems, resolveTerminalItem } from "./ide/terminal-menu.js";
import { type TestRunSpawn, runTestVerb } from "./ide/test-run-host.js";
import {
  createWorktreeChecked,
  listWorktreesChecked,
  removeWorktreeChecked,
} from "./ide/worktree-host.js";
import type { PrGateway } from "./pr-gateway.js";
import { runSidecar } from "./sidecar.js";
import { readTelemetry } from "./telemetry.js";

/** Hard ceiling for one `ide:exec` command before SIGKILL (120s). */
const EXEC_TIMEOUT_MS = 120_000;

/** Coerce an unknown caught value to a short error string. */
function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "unknown error";
}

/**
 * APP-042: a sqlite conn "string" is a FILESYSTEM path — run it through the same
 * sensitive-path guard as the fs IPC before it reaches the sidecar. Returns an error
 * string when the path is refused, else null (pg/mysql network DSNs skip the guard).
 */
function guardSqliteConn(conn: string): string | null {
  const m = /^sqlite:\/*(.*)$/i.exec(conn.trim());
  if (!m) return null;
  const p = (m[1] ?? "").trim();
  if (!p || p === ":memory:") return null;
  try {
    assertNotSensitivePath(p.startsWith("/") ? p : `/${p}`);
    return null;
  } catch (e) {
    return errString(e);
  }
}

/**
 * The minimal `{ send }` surface to push an IdeEvent back to a window. Extracted
 * WITHOUT importing the electron event type (mirrors the sibling IPC modules).
 */
function senderOf(evt: unknown): { send(channel: string, payload: IdeEvent): void } | undefined {
  if (!evt || typeof evt !== "object") return undefined;
  const sender = (evt as { sender?: unknown }).sender;
  if (sender && typeof (sender as { send?: unknown }).send === "function") {
    return sender as { send(channel: string, payload: IdeEvent): void };
  }
  return undefined;
}

/** A run handle for a task dispatched to the offloaded worker (APP-066). */
export interface WorkerTaskHandle {
  /** the correlation id (used to `cancel`). */
  id: string;
  /** resolves with the worker's response — or the inline-fallback response on failure. */
  result: Promise<TaskResponse>;
  /** cooperatively cancel this task (no-op after it resolves). */
  cancel(): void;
}

/**
 * Dispatch a heavy task to the offloaded utilityProcess worker (APP-066). Injected from
 * main/index.ts (backed by WorkerHost with an inline fallback); defaults to a pure inline
 * runner so ide-ipc stays constructible/testable WITHOUT Electron or a live worker.
 */
export type RunWorkerTask = (
  req: Omit<TaskRequest, "id">,
  opts?: { onProgress?: (scanned: number) => void },
) => WorkerTaskHandle;

/** The hosts + config the IDE IPC relays to (injected so the binaries stay decoupled). */
export interface IdeIpcWiring {
  lsp: LspHost;
  dap: DapHost;
  pty: PtyHost;
  git: GitHost;
  fsWatch: FsWatchHost;
  /** APP-063: the Local History manager (captures pre-write snapshots + persists). Absent →
   *  history features fail-soft (a save still writes; the timeline is just empty). */
  localHistory?: LocalHistoryManager;
  /** engine config threaded into the RUN-GATE's engine-bridge gate (C2). */
  engineConfig?: EngineConfig;
  /** injectable command runner for `ide:exec` (default = the real shell capture runner). */
  execRunner?: ExecRunner;
  /**
   * broadcast an IdeEvent to EVERY live renderer (the host feeds are global, like
   * the model serve feed). Injected so this module stays window-agnostic; main/
   * index.ts supplies a BrowserWindow fan-out. Defaults to a no-op (tests assert on
   * the host listeners directly).
   */
  broadcast?: (event: IdeEvent) => void;
  /**
   * injectable spawner for the STREAMING testmgr `run`/`rerun-failed` verbs
   * (APP-013). `runSidecar` is request/response, so live per-test events need a
   * direct spawn seam — main/index.ts supplies node:child_process spawn with the
   * safe child env; node:test injects a fake. Absent → `ide:test.run` fails soft.
   */
  testSpawn?: TestRunSpawn;
  /** injectable SqlClient for the ide:sql.* console bridge (APP-042); default = the
   *  real sqlrunner.py wrapper. node:test injects a fake returning canned envelopes. */
  sqlClient?: SqlClient;
  /**
   * broadcast one live per-test event to EVERY live renderer over
   * IPC_EVENTS.ideTestEvent (same BrowserWindow fan-out as `broadcast`).
   * Defaults to a no-op (tests assert on the injected fn directly).
   */
  broadcastTest?: (event: IdeTestEvent) => void;
  /**
   * the named-run session host (APP-032). Absent → `ide:run.start` fails soft
   * (tests that don't exercise runs need no fake).
   */
  runHost?: RunHost;
  /**
   * injectable telemetry reader for the 90% CPU/RAM launch guard (APP-032).
   * Default = the REAL readTelemetry; a throw BLOCKS the launch (fail-closed,
   * mirroring telemetry-ipc's errorTelemetry guard).
   */
  readTelemetry?: () => Promise<SystemTelemetry>;
  /**
   * injectable refactor.py runner for `ide:refactor` (APP-026). Default = the
   * fail-closed engine-bridge `runSidecar` (NOT main/sidecar.ts's wrapper, which
   * throws on `error`-carrying envelopes — refactor.py's legitimate refusals
   * like `rope-missing`/`usages-remain` DO carry `error` and must surface as
   * ok:false data, not a rejection). node:test injects a fake.
   */
  refactorRun?: RefactorRunner;
  /**
   * injectable kernel-session spawner for the notebook kernel bridge (APP-045).
   * Default = the real engine-bridge `spawnKernelSidecar`; node:test injects a fake
   * kernel (node stands in for python3) so the handlers run without ipykernel.
   */
  kernelSpawn?: KernelSpawner;
  /**
   * injectable profile.py runner (APP-046). Default = the fail-closed engine-bridge
   * `runSidecar` (NOT main/sidecar.ts's wrapper — profile.py's legitimate refusals
   * `load`/`option-injection`/`not-found` carry an `error` and must surface as ok:false
   * DATA, not a rejection). node:test injects a fake returning canned fold envelopes.
   */
  profileRun?: ProfileRunner;
  /**
   * APP-089: absolute dir where profile snapshots persist (MAIN passes
   * app.getPath("userData")/profile-snapshots — a MAIN-owned path, never renderer-supplied).
   * Absent → a per-user tmp dir (tests + a headless run still work).
   */
  profileSnapshotDir?: string;
  /**
   * APP-066: dispatch workspace search + repo indexing to the offloaded utilityProcess
   * worker (with a graceful inline fallback). Absent → the handlers run the SAME task
   * INLINE in main (current behaviour) — tests need no worker.
   */
  runWorkerTask?: RunWorkerTask;
  /**
   * APP-085: the gated PR-review gateway (git remote → forge, token from keychain,
   * every call via the L6 safeFetch proxy). Absent → the `ide:git.pr*` handlers report
   * "PR review unavailable" (the panel hides its section); tests inject a fake.
   */
  prGateway?: PrGateway;
  /**
   * APP-090: the tear-out terminal window controller (MAIN owns BrowserWindow creation).
   * Injected from index.ts where the hardened-webPreferences factory + RENDERER_DEV_URL
   * live. Absent → the `ide:floatingTerminal.*` handlers report "unavailable" (the ⧉ action
   * no-ops); tests inject a fake. NEVER kills the PTY — the session outlives its window.
   */
  floatingTerminal?: FloatingTerminalController;
}

/** MAIN-side controller the ide-ipc seam calls to open/close a tear-out terminal window. */
export interface FloatingTerminalController {
  /** open (or focus an existing) hardened float hosting `ptyId`. */
  create(req: { ptyId: string; title: string; scheme?: string }): void;
  /** close the float for `ptyId` (re-dock) — MAIN emits `floatingTerminal.returned`. */
  close(ptyId: string): void;
}

/** Runs profile.py `run` and returns its raw envelope; `signal` aborts an in-flight run. */
export type ProfileRunner = (argv: string[], signal?: AbortSignal) => Promise<SidecarEnvelope>;

/** Hard ceiling for one profile run before SIGKILL (the sidecar also caps in-process). */
const PROFILE_TIMEOUT_MS = 180_000;

/** Map the gate.ts RunGateResult → the renderer-safe IdeGateResult. */
function toGateResult(r: RunGateResult): IdeGateResult {
  const out: IdeGateResult = {
    ok: r.mayLaunch,
    decision: r.decision,
    mayLaunch: r.mayLaunch,
    trusted: r.trusted,
    workspaceRoot: r.workspaceRoot,
    reason: r.reason,
  };
  if (r.verdict) {
    out.verdict = r.verdict.verdict;
    out.riskScore = r.verdict.risk_score;
    out.findingsCount = r.verdict.findings.length;
  }
  return out;
}

/**
 * Which of `bins` are executables on PATH — a lightweight `which`-style probe that
 * scans the PATH directories with `fs.access(X_OK)` (NO child spawn, NO gate). Only
 * bare command names are probed (a name containing a path separator is rejected → not
 * a PATH lookup). Windows honours PATHEXT. Backs the terminal's CLI menu (installed vs
 * needs-install) without running anything.
 */
async function detectBinsOnPath(bins: readonly string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  const isWin = process.platform === "win32";
  const pathVar = (isWin ? (process.env.Path ?? process.env.PATH) : process.env.PATH) ?? "";
  const dirs = pathVar.split(isWin ? ";" : ":").filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  await Promise.all(
    bins.map(async (bin) => {
      if (!bin || /[\\/]/.test(bin)) {
        out[bin] = false;
        return;
      }
      for (const dir of dirs) {
        for (const ext of exts) {
          try {
            await access(join(dir, bin + ext), fsConstants.X_OK);
            out[bin] = true;
            return;
          } catch {
            /* not in this dir — keep scanning */
          }
        }
      }
      out[bin] = false;
    }),
  );
  return out;
}

/**
 * Register the `ide:*` ipcMain handlers + wire the host event feeds to the
 * renderer. Returns a disposer that removes the handlers AND detaches the host
 * listeners (so a re-register in tests / a window reload never double-binds).
 */
/**
 * Elevated-privilege clamp for the operator's A0–A7 level (the desktop half of the CLI's sudo
 * gate).
 *
 * The CLI stops for a red acknowledgement before opening a session as root, and the readline and
 * headless hosts now clamp too. The desktop had NO notion of elevation at all: launched with
 * `sudo`, it restored whatever level the operator had persisted and auto-approved against it as
 * the superuser, where a single auto-approved `run_command` or `write_file` reaches the whole
 * machine rather than the workspace.
 *
 * The clamp lives in MAIN rather than the renderer on purpose. The renderer is the least-trusted
 * surface in our own app (C5) and it supplies `authLevel` on every request, so a warning painted
 * in the UI would be advisory; enforcing it here means no renderer — ours, or one that has been
 * compromised — can hand the system-tool path a full-autonomy level while running as root.
 *
 * 5 is the same ceiling the CLI's decline path applies: everything short of the full-autonomy
 * tiers still works, so an elevated session is usable, just never silent.
 */
/**
 * Apply the security POSTURE's auto-approve rule to the operator's level.
 *
 * `Settings.autoApprove` is set by the Security-strict profile — whose stated posture is
 * "gate --strict, NO auto-approve" — and was read by nothing at all, so selecting that profile
 * tightened the gate and the force ban and left auto-approval exactly as it was. Level 0
 * ("paranoid — ask before EVERY action, even reading a file") is what "no auto-approve" means
 * on the ladder. Every other `autoApprove` in the codebase is the unrelated per-grant
 * `AgentToolGrant.autoApprove`, which the ladder drives and which never consults settings.
 */
export function clampAuthLevelForPosture(
  level: number,
  posture: { autoApprove?: boolean } = getSecurityPosture(),
): number {
  return posture.autoApprove === false ? 0 : level;
}

/**
 * The PERSISTED authorisation level is a CEILING the renderer may lower and never raise.
 *
 * `agent:systemTool` took the level straight off the request — and that level is what
 * `run_command`'s OS sandbox consults to decide whether the call may reach the network. The
 * renderer is the surface this whole file exists not to trust, so a compromised or merely
 * buggy renderer could hand main an A7 and open egress on a machine whose operator had
 * chosen A1. `main/ai-ipc.ts` already refuses a cloud model on the saved level; this is the
 * same rule for the other transport that can leave the box.
 *
 * MIN, not "use the disk value": a session that wants to work at a LOWER level than its
 * saved preference is a legitimate, safer choice, and clamping upward would undo it.
 *
 * Fail-CLOSED on an unreadable store: `readSavedAuthLevel` returns null, and the ladder's
 * own default (A1) applies — the same value a first launch gets.
 */
export function clampAuthLevelToSaved(
  level: number,
  readSaved: () => number | null = cliProfiles.readSavedAuthLevel,
): number {
  let saved: number | null = null;
  try {
    saved = readSaved();
  } catch {
    /* unreadable ⇒ the default below */
  }
  return Math.min(level, saved ?? DEFAULT_AUTH_LEVEL);
}

export function clampAuthLevelForElevation(level: number): number {
  const elevated =
    process.env.SUDO_USER !== undefined ||
    process.env.SUDO_UID !== undefined ||
    (typeof process.getuid === "function" && process.getuid() === 0);
  return elevated ? Math.min(level, 5) : level;
}

export function registerIdeIpcHandlers(wiring: IdeIpcWiring): () => void {
  const { lsp, dap, pty, git, fsWatch, prGateway } = wiring;
  const history = wiring.localHistory; // APP-063: Local History (optional; fail-soft)
  const config = wiring.engineConfig ?? {};
  const broadcast = wiring.broadcast ?? (() => {});
  const execRunner = wiring.execRunner ?? defaultExecRunner;
  const testSpawn = wiring.testSpawn;
  const broadcastTest = wiring.broadcastTest ?? (() => {});
  // live testmgr children register a killer here; the disposer reaps them on
  // window close so no orphaned pytest process outlives its renderer.
  const testKills = new Set<() => void>();
  const sqlHost = new SqlHost(wiring.sqlClient ?? createSqlClient());
  const kernelHost = new KernelHost(wiring.kernelSpawn);

  // APP-066: dispatch heavy walks to the offloaded worker. Default = a pure INLINE runner
  // (runs the SAME `runTask` in main) so ide-ipc needs no Electron/worker under test.
  let inlineSeq = 0;
  const runWorkerTask: RunWorkerTask =
    wiring.runWorkerTask ??
    ((req, opts) => {
      const id = `inline${++inlineSeq}`;
      const hooks = opts?.onProgress ? { onProgress: opts.onProgress } : undefined;
      return {
        id,
        result: Promise.resolve(runTask({ ...req, id } as TaskRequest, hooks)),
        cancel: () => {},
      };
    });
  // requestId → the in-flight search handle, so `ide:searchCancel` can reach it.
  const activeSearches = new Map<string, WorkerTaskHandle>();

  // ── multiplex the host feeds onto the single `ide:event` push ─────────────
  const onLspDiag = (e: {
    serverId: string;
    params: { uri: string; diagnostics: unknown[]; version?: number };
  }): void => {
    const ev: IdeEvent = {
      channel: "lsp.diagnostics",
      serverId: e.serverId,
      uri: e.params.uri,
      diagnostics: e.params.diagnostics,
      ...(e.params.version !== undefined ? { version: e.params.version } : {}),
    };
    broadcast(ev);
  };
  const onLspNotify = (e: { serverId: string; method: string; params: unknown }): void =>
    broadcast({ channel: "lsp.notify", serverId: e.serverId, method: e.method, params: e.params });
  const onLspState = (s: Record<string, unknown>): void =>
    broadcast({ channel: "lsp.state", status: s });
  const onLspStderr = (e: { serverId: string; line: string }): void =>
    broadcast({ channel: "host.stderr", source: "lsp", id: e.serverId, line: e.line });
  // APP-078: relay a server→client workspace/applyEdit to the renderer (which applies + acks).
  const onLspApplyEdit = (e: {
    serverId: string;
    workspaceRoot: string;
    requestId: number | string;
    params: unknown;
  }): void =>
    broadcast({
      channel: "lsp.applyEdit",
      serverId: e.serverId,
      workspaceRoot: e.workspaceRoot,
      requestId: e.requestId,
      params: e.params,
    });

  const onDapEvent = (e: { sessionId: string; event: string; body: unknown }): void =>
    broadcast({ channel: "dap.event", sessionId: e.sessionId, event: e.event, body: e.body });
  const onDapState = (s: Record<string, unknown>): void =>
    broadcast({ channel: "dap.state", status: s });
  const onDapStderr = (e: { sessionId: string; line: string }): void =>
    broadcast({ channel: "host.stderr", source: "dap", id: e.sessionId, line: e.line });
  // APP-079: a host-owned launch-time setBreakpoints response → the renderer store
  // folds verified flags + adapter-adjusted lines (the host, not the renderer, sends it).
  const onDapConfigApplied = (e: {
    sessionId: string;
    path: string;
    sentLines: number[];
    breakpoints: unknown[];
  }): void =>
    broadcast({
      channel: "dap.setbreakpoints",
      sessionId: e.sessionId,
      path: e.path,
      sentLines: e.sentLines,
      breakpoints: e.breakpoints,
    });

  const onPtyData = (e: { ptyId: string; data: string }): void =>
    broadcast({ channel: "pty.data", ptyId: e.ptyId, data: e.data });
  const onPtyExit = (e: { ptyId: string; exitCode: number }): void =>
    broadcast({ channel: "pty.exit", ptyId: e.ptyId, exitCode: e.exitCode });

  const onFsChange = (e: { root: string; paths: string[] }): void =>
    broadcast({ channel: "fs.change", root: e.root, paths: e.paths });

  // APP-045: kernel NDJSON events → the shared push, tagged with their sessionId.
  const onKernelEvent = (e: { sessionId: string; event: IdeKernelStreamEvent }): void =>
    broadcast({ channel: "kernel", sessionId: e.sessionId, event: e.event });
  kernelHost.on("event", onKernelEvent);

  lsp.on("diagnostics", onLspDiag);
  lsp.on("notify", onLspNotify);
  lsp.on("state", onLspState as (s: unknown) => void);
  lsp.on("stderr", onLspStderr);
  lsp.on("applyEdit", onLspApplyEdit);
  dap.on("event", onDapEvent);
  dap.on("state", onDapState as (s: unknown) => void);
  dap.on("stderr", onDapStderr);
  dap.on("configApplied", onDapConfigApplied);
  pty.on("data", onPtyData);
  pty.on("exit", onPtyExit);
  fsWatch.on("change", onFsChange);

  /* ── fs ──────────────────────────────────────────────────────────────────*/
  ipcMain.handle(IPC.ideFsRead, async (_e, arg: unknown): Promise<IdeFsReadResult> => {
    const v = validateFsRead(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      // assertNotSensitivePath returns the normalized fs path (a `file://` tab URI →
      // real path). readFile can't take a `file://` STRING, so use the returned path —
      // this also fixes editor opens reading ENOENT (empty) for `file://` uris.
      const path = assertNotSensitivePath(v.value.uri);
      const large = await isLargeFile(path);
      const r = await fsRead(path);
      return { ok: true, text: r.text, encoding: r.encoding, large };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  /**
   * The GLOBAL (`~/.prometheus`) steering tier. Main owns the home path — see the channel's
   * doc in the contract for why this is not a `fsRead` with a `~` in it. The renderer still
   * reads the PROJECT files itself (it is the one that knows the workspace root); this supplies
   * the half of `DEFAULT_PRECEDENCE` that the desktop pane had no way to reach at all.
   *
   * A file whose content is a remote URL is a fetch directive, not guidance, and is dropped
   * here rather than handed over — same posture as the CLI's steering loader and the pane's own
   * project-file filter.
   */
  ipcMain.handle(IPC.ideSteeringGlobal, async (): Promise<IdeSteeringGlobalResult> => {
    try {
      const home = prometheusHome();
      const sources: IdeSteeringGlobalResult["sources"] = [];
      for (const cand of coreRules.steeringCandidates(home, home, join)) {
        if (cand.scope !== "global") continue;
        const r = await fsRead(cand.path).catch(() => undefined);
        const text = r?.text;
        if (typeof text !== "string" || !text.trim()) continue;
        if (coreRules.isRemoteInstruction(text)) continue;
        sources.push({ kind: cand.kind, path: cand.path, content: text });
      }
      return { ok: true, sources };
    } catch (e) {
      return { ok: false, sources: [], error: errString(e) };
    }
  });
  // handoff §3: the working-set declaration + the per-path out-of-scope approval. These
  // are the ONLY two ways the main-process scope guard's answer can change.
  ipcMain.handle(IPC.ideSetWorkingSet, (_e, arg: unknown): IdeOkResult => {
    const o = arg as { roots?: unknown } | null;
    const roots = Array.isArray(o?.roots)
      ? o.roots.filter((r): r is string => typeof r === "string")
      : [];
    try {
      // NARROWING ONLY — a declared root outside anything the human picked in main's own
      // folder dialog is refused. Reported rather than dropped in silence: an attempt to
      // widen the agent's write scope from the renderer is exactly the event this guard
      // exists to notice, and a guard that discards its own evidence proves nothing.
      const { accepted, refused } = setWorkingSetRoots(roots);
      if (refused.length > 0) {
        console.warn(
          `[path-guard] refused ${refused.length} working-set root(s) not granted by a folder the user opened: ${refused.join(", ")}`,
        );
      }
      // A PARTIAL acceptance is still a narrowing the caller did not ask for — report which
      // roots were dropped rather than answering a bare `ok:true` and leaving the renderer to
      // believe its whole declaration took effect.
      return accepted > 0 || refused.length === 0
        ? refused.length > 0
          ? { ok: true, refused }
          : { ok: true }
        : {
            ok: false,
            error: `none of the declared roots are inside a folder you opened: ${refused.join(", ")}`,
          };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideApproveOutside, (_e, arg: unknown): IdeOkResult => {
    const o = arg as { path?: unknown; scope?: unknown } | null;
    try {
      if (o?.scope === "clear") {
        clearOutsideApprovals();
        return { ok: true };
      }
      if (typeof o?.path !== "string" || !o.path) return { ok: false, error: "path required" };
      // a path already inside the set needs no approval — recording it would only grow
      // the exception list with entries that mean nothing.
      if (!isInsideWorkingSet(o.path)) approveOutsideWorkingSet(o.path);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideFsWrite, async (_e, arg: unknown): Promise<IdeOkResult> => {
    const v = validateFsWrite(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const path = assertNotSensitivePath(v.value.uri); // normalize + deny sensitive targets
      // handoff §3: the applier's scope guard, in MAIN, ON REGARDLESS of what the
      // renderer's permission card did or did not show.
      assertInsideWorkingSet(path);
      // APP-063: snapshot the PRE-write on-disk content BEFORE writing, so revert-by-one lands
      // on the previous state (not the incoming buffer). A brand-new file (ENOENT) has nothing
      // to snapshot → skip; capture never blocks or fails the save (fail-soft).
      if (history) {
        try {
          const prev = await fsRead(path);
          if (!(await isLargeFile(path))) history.capture(path, prev.text, "save");
        } catch {
          /* ENOENT (first save) / unreadable → nothing to snapshot */
        }
      }
      await fsWrite(path, v.value.text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideFsTree, async (_e, arg: unknown): Promise<IdeTreeNode[]> => {
    const v = validateFsTree(arg);
    if (!v.ok) return [];
    /**
     * The sensitive-path guard every sibling handler applies — and this one did NOT.
     *
     * `ide:fs.tree` listed `~/.ssh`, `~/.aws` and the rest straight back to the renderer, so the
     * one handler whose whole job is enumerating a directory was the one with no denylist. The
     * comment on `ideFsWalk` below claimed its root was "path-guarded exactly like fsTree",
     * which was true only in the sense that neither was guarded here.
     *
     * The contract is `IdeTreeNode[]` with no error channel, so a refusal is an EMPTY tree —
     * the same answer this handler already gives for invalid input. Nothing leaks either way.
     */
    let dir: string;
    try {
      dir = assertNotSensitivePath(uriToFsPath(v.value.dir));
    } catch {
      return [];
    }
    return fsTree(dir);
  });

  // APP-065: walk the whole repo → a flat file list (ignore-pruned, no symlinks). Root is
  // path-guarded with the same `assertNotSensitivePath` as fsTree above, so a symlinked or
  // sensitive target cannot escape.
  ipcMain.handle(IPC.ideFsWalk, async (_e, arg: unknown): Promise<IdeFsWalkResult> => {
    const a = (arg ?? {}) as { root?: unknown };
    if (typeof a.root !== "string" || !a.root) return { ok: false, error: "root is required" };
    try {
      const root = assertNotSensitivePath(a.root);
      return { ok: true, files: await fsWalk(root) };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  /**
   * Watch/unwatch carry the sensitive-path guard for the same reason `ide:fs.tree` above
   * does. `fsWatchSchema` is a charset/length check on the string, nothing more, and
   * `FsWatchHost.watch` applies no guard of its own — so a renderer-supplied `~/.ssh` was
   * watched and every change under it streamed back over `onFsChange`. A recursive watcher
   * is an enumeration channel with a subscription attached.
   *
   * Both handlers MUST guard identically: `FsWatchHost` keys its map by the exact string it
   * is given, so normalising the root on watch but not on unwatch would strand live
   * watchers under their canonical key with no way to remove them. `assertNotSensitivePath`
   * already calls `uriToFsPath` internally and returns the canonical absolute path.
   */
  ipcMain.handle(IPC.ideFsWatch, async (_e, arg: unknown): Promise<IdeOkResult> => {
    const v = validateFsWatch(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      fsWatch.watch(assertNotSensitivePath(v.value.root));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideFsUnwatch, async (_e, arg: unknown): Promise<IdeOkResult> => {
    const v = validateFsWatch(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      fsWatch.unwatch(assertNotSensitivePath(v.value.root));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  // ── fs CRUD (leap #8): each path-guarded (assertNotSensitivePath) before any write ──
  ipcMain.handle(IPC.ideFsCreateFile, async (_e, arg: unknown): Promise<IdeOkResult> => {
    const v = validateFsPath(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      await fsCreateFile(assertInsideWorkingSet(assertNotSensitivePath(v.value.path)));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideFsMkdir, async (_e, arg: unknown): Promise<IdeOkResult> => {
    const v = validateFsPath(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      await fsMkdir(assertInsideWorkingSet(assertNotSensitivePath(v.value.path)));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideFsRename, async (_e, arg: unknown): Promise<IdeOkResult> => {
    const v = validateFsRename(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      // guard BOTH endpoints — a rename can move a file INTO a sensitive location too.
      await fsRename(
        assertInsideWorkingSet(assertNotSensitivePath(v.value.src)),
        assertInsideWorkingSet(assertNotSensitivePath(v.value.dest)),
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideFsDelete, async (_e, arg: unknown): Promise<IdeOkResult> => {
    const v = validateFsPath(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      await fsDelete(assertInsideWorkingSet(assertNotSensitivePath(v.value.path)));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  /* ── LSP ─────────────────────────────────────────────────────────────────*/
  ipcMain.handle(IPC.ideLspEnsure, async (_e, arg: unknown): Promise<IdeLspEnsureResult> => {
    const v = validateLspEnsure(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const { serverId } = lsp.ensure(v.value.languageId, {
        rootUri: v.value.workspaceRoot,
        ...(v.value.interpreterPath ? { interpreterPath: v.value.interpreterPath } : {}),
      });
      return { ok: true, serverId };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  // APP-077: the live LSP server list — read-only status snapshot (no spawn).
  ipcMain.handle(IPC.ideLspList, async (): Promise<IdeLspListResult> => {
    try {
      const servers = lsp.list().map((s) => ({
        serverId: s.serverId,
        languageId: s.languageId,
        workspaceRoot: s.workspaceRoot,
        state: s.state,
      }));
      return { ok: true, servers };
    } catch (e) {
      return { ok: false, servers: [], error: errString(e) };
    }
  });
  // APP-078: the renderer's ack for a relayed workspace/applyEdit → settle the server request.
  ipcMain.handle(IPC.ideLspApplyEditResult, async (_e, arg: unknown): Promise<IdeOkResult> => {
    const o = (arg ?? {}) as {
      serverId?: unknown;
      workspaceRoot?: unknown;
      requestId?: unknown;
      applied?: unknown;
    };
    if (
      typeof o.serverId !== "string" ||
      typeof o.workspaceRoot !== "string" ||
      (typeof o.requestId !== "number" && typeof o.requestId !== "string")
    ) {
      return { ok: false, error: "invalid applyEdit ack" };
    }
    try {
      lsp.respondApplyEdit(o.serverId, o.workspaceRoot, o.requestId, o.applied === true);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideLspRequest, async (_e, arg: unknown): Promise<IdeLspRequestResult> => {
    const v = validateLspRequest(arg);
    if (!v.ok) return { ok: false, requestId: -1, error: v.error.message };
    const { id, result } = lsp.request(
      v.value.serverId,
      v.value.workspaceRoot,
      v.value.method,
      v.value.params,
    );
    try {
      const res = await result;
      return { ok: true, requestId: id, result: res };
    } catch (e) {
      return { ok: false, requestId: id, error: errString(e) };
    }
  });
  ipcMain.on(IPC.ideLspCancel, (_e, arg: unknown) => {
    const v = validateLspCancel(arg);
    if (v.ok) lsp.cancel(v.value.serverId, v.value.workspaceRoot, v.value.requestId);
  });
  ipcMain.on(IPC.ideLspDidOpen, (_e, arg: unknown) => {
    const v = validateLspDoc(arg);
    if (v.ok && v.value.languageId !== undefined && v.value.text !== undefined) {
      lsp.didOpen(
        v.value.serverId,
        v.value.workspaceRoot,
        v.value.uri,
        v.value.languageId,
        v.value.text,
        v.value.version,
      );
    }
  });
  ipcMain.on(IPC.ideLspDidChange, (_e, arg: unknown) => {
    const v = validateLspDoc(arg);
    if (v.ok && v.value.text !== undefined && v.value.version !== undefined) {
      lsp.didChange(
        v.value.serverId,
        v.value.workspaceRoot,
        v.value.uri,
        v.value.text,
        v.value.version,
      );
    }
  });
  ipcMain.on(IPC.ideLspDidClose, (_e, arg: unknown) => {
    const v = validateLspDoc(arg);
    if (v.ok) lsp.didClose(v.value.serverId, v.value.workspaceRoot, v.value.uri);
  });
  ipcMain.handle(IPC.ideLspSetInterpreter, async (_e, arg: unknown): Promise<IdeOkResult> => {
    const v = validateLspSetInterpreter(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      lsp.setInterpreter(v.value.serverId, v.value.workspaceRoot, v.value.interpreterPath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /* ── DAP ─────────────────────────────────────────────────────────────────*/
  ipcMain.handle(IPC.ideDapLaunch, async (_e, arg: unknown): Promise<IdeDapLaunchResult> => {
    const v = validateDapLaunch(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      // split the launch-time config plan (APP-079) + the non-DAP allowRemote flag
      // (APP-080) out of the DAP launch args: `config` keeps `connect` (the adapter's
      // attach argument) but never carries the plan or the confirm flag to the adapter.
      const { breakpoints, exceptionFilters, allowRemote, ...config } = v.value;
      const plan: DapLaunchPlan = {};
      if (breakpoints !== undefined) plan.sources = breakpoints;
      if (exceptionFilters !== undefined) plan.exceptionFilters = exceptionFilters;
      const opts: DapLaunchOptions = {};
      if (allowRemote !== undefined) opts.allowRemote = allowRemote;
      const { sessionId, capabilities } = await dap.launch(config, plan, opts);
      return { ok: true, sessionId, capabilities };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideDapRequest, async (_e, arg: unknown): Promise<IdeDapRequestResult> => {
    const v = validateDapRequest(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const body = await dap.request(v.value.sessionId, v.value.command, v.value.args);
      return { ok: true, body };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideDapTerminate, async (_e, arg: unknown): Promise<IdeOkResult> => {
    const v = validateDapTerminate(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      await dap.terminate(v.value.sessionId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(
    IPC.ideDapDetectAdapter,
    async (_e, arg: unknown): Promise<IdeDapDetectAdapterResult> => {
      const v = validateDapDetectAdapter(arg);
      if (!v.ok) return { ok: false, type: "", available: false, detail: v.error.message };
      try {
        const r = await dap.detectAdapter(v.value.type, v.value.pythonPath);
        return { ok: true, ...r };
      } catch (e) {
        return { ok: false, type: v.value.type, available: false, detail: errString(e) };
      }
    },
  );
  ipcMain.handle(
    IPC.ideDapInstallAdapter,
    async (_e, arg: unknown): Promise<IdeDapInstallAdapterResult> => {
      const v = validateDapInstallAdapter(arg);
      if (!v.ok) return { ok: false, output: "", error: v.error.message };
      try {
        const opts: { pythonPath?: string; confirm?: boolean } = {};
        if (v.value.pythonPath !== undefined) opts.pythonPath = v.value.pythonPath;
        if (v.value.confirm !== undefined) opts.confirm = v.value.confirm;
        return await dap.installAdapter(v.value.type, opts);
      } catch (e) {
        return { ok: false, output: "", error: errString(e) };
      }
    },
  );

  /* ── refactor (refactor.py → WorkspaceEdit proposal, APP-026) ────────────*/
  const refactorRun: RefactorRunner =
    wiring.refactorRun ?? ((script, argv) => runSidecarScript(script, argv));
  ipcMain.handle(IPC.ideRefactor, async (_e, arg: unknown): Promise<IdeRefactorResult> => {
    const v = validateRefactor(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return runRefactorVerb(v.value, refactorRun);
  });

  /* ── plain Run (APP-032): fail-closed gate → telemetry guard → spawn ─────*/
  const runHost = wiring.runHost;
  const readTele = wiring.readTelemetry ?? readTelemetry;
  const onRunData = (e: { runId: string; data: string }): void =>
    broadcast({ channel: "run.data", runId: e.runId, data: e.data });
  const onRunExit = (e: {
    runId: string;
    exitCode: number;
    signal?: number;
    killed: boolean;
  }): void =>
    broadcast({
      channel: "run.exit",
      runId: e.runId,
      exitCode: e.exitCode,
      ...(e.signal !== undefined ? { signal: e.signal } : {}),
      killed: e.killed,
    });
  runHost?.on("data", onRunData);
  runHost?.on("exit", onRunExit);
  ipcMain.handle(IPC.ideRunStart, async (_e, arg: unknown): Promise<IdeRunStartResult> => {
    const v = validateRunStart(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    if (!runHost) return { ok: false, error: "run host unavailable" };
    // the tested APP-032 spine: fail-closed gate → telemetry guard → spawn. A
    // gate refusal additionally carries the FULL rendered verdict for the panel.
    let lastGate: RunGateResult | undefined;
    const outcome = await startGatedRun(
      {
        cmd: v.value.cmd,
        args: v.value.args,
        cwd: v.value.cwd,
        ...(v.value.env ? { env: v.value.env } : {}),
        ...(v.value.venv ? { venv: v.value.venv } : {}),
        workspaceRoot: v.value.workspaceRoot,
        ...(v.value.head ? { head: v.value.head } : {}),
      },
      {
        gate: async (id) => {
          lastGate = await runGate(id, { engineConfig: config });
          return lastGate;
        },
        readTelemetry: readTele,
        start: (req) => runHost.start(req),
      },
    );
    const out: IdeRunStartResult = { ok: outcome.ok };
    if (outcome.runId !== undefined) out.runId = outcome.runId;
    if (outcome.refusedBy !== undefined) out.refusedBy = outcome.refusedBy;
    if (outcome.error !== undefined) out.error = outcome.error;
    if (outcome.refusedBy === "gate" && lastGate) out.gate = toGateResult(lastGate);
    return out;
  });
  ipcMain.handle(IPC.ideRunKill, async (_e, arg: unknown): Promise<IdeRunKillResult> => {
    const v = validateRunKill(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    if (!runHost) return { ok: false, error: "run host unavailable" };
    return runHost.kill(v.value.runId) ? { ok: true } : { ok: false, error: "no such run" };
  });

  /* ── PTY ─────────────────────────────────────────────────────────────────*/
  ipcMain.handle(IPC.idePtySpawn, async (_e, arg: unknown): Promise<IdePtySpawnResult> => {
    const v = validatePtySpawn(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      const { ptyId } = pty.spawn({
        cwd: v.value.cwd,
        ...(v.value.shell ? { shell: v.value.shell } : {}),
        ...(v.value.cols !== undefined ? { cols: v.value.cols } : {}),
        ...(v.value.rows !== undefined ? { rows: v.value.rows } : {}),
        ...(v.value.venv ? { venv: v.value.venv } : {}),
      });
      return { ok: true, ptyId };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.on(IPC.idePtyWrite, (_e, arg: unknown) => {
    const v = validatePtyWrite(arg);
    if (v.ok) pty.write(v.value.ptyId, v.value.data);
  });
  ipcMain.on(IPC.idePtyResize, (_e, arg: unknown) => {
    const v = validatePtyResize(arg);
    if (v.ok) pty.resize(v.value.ptyId, v.value.cols, v.value.rows);
  });
  ipcMain.on(IPC.idePtyKill, (_e, arg: unknown) => {
    const v = validatePtyKill(arg);
    if (v.ok) pty.kill(v.value.ptyId);
  });
  // APP-090: tear a terminal session out into a hardened secondary window / re-dock it.
  // The window is created ONLY in MAIN (never window.open) by the injected controller;
  // absent → the feature reports unavailable (the ⧉ action no-ops). NEVER kills the PTY.
  ipcMain.handle(
    IPC.ideFloatingTerminalCreate,
    async (_e, arg: unknown): Promise<IdeFloatingTerminalResult> => {
      const v = validateFloatingTerminalCreate(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      if (!wiring.floatingTerminal) return { ok: false, error: "floating terminal unavailable" };
      try {
        wiring.floatingTerminal.create(v.value);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );
  ipcMain.handle(
    IPC.ideFloatingTerminalClose,
    async (_e, arg: unknown): Promise<IdeFloatingTerminalResult> => {
      const v = validateFloatingTerminalClose(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      if (!wiring.floatingTerminal) return { ok: false, error: "floating terminal unavailable" };
      try {
        wiring.floatingTerminal.close(v.value.ptyId);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );
  ipcMain.handle(IPC.ideDetectBins, async (_e, arg: unknown): Promise<Record<string, boolean>> => {
    const raw = Array.isArray(arg) ? arg : (arg as { bins?: unknown })?.bins;
    const bins = Array.isArray(raw) ? raw.filter((b): b is string => typeof b === "string") : [];
    return detectBinsOnPath(bins);
  });

  /* ── git (RAW git, runs LIVE) ──────────────────────────────────────────────*/
  ipcMain.handle(IPC.ideGitStatus, async (_e, arg: unknown): Promise<IdeGitStatus> => {
    const v = validateGitRoot(arg);
    if (!v.ok) {
      return {
        ok: false,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        error: v.error.message,
      };
    }
    return git.status(v.value.root);
  });
  ipcMain.handle(IPC.ideGitDiff, async (_e, arg: unknown): Promise<IdeGitDiffResult> => {
    const v = validateGitDiff(arg);
    if (!v.ok) return { ok: false, diff: "", error: v.error.message };
    const diff = await git.diff(v.value.root, v.value.file, v.value.staged);
    return { ok: true, diff };
  });
  ipcMain.handle(IPC.ideGitStage, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitFiles(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.stage(v.value.root, v.value.files);
  });
  ipcMain.handle(IPC.ideGitUnstage, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitFiles(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.unstage(v.value.root, v.value.files);
  });
  ipcMain.handle(IPC.ideGitCommit, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitCommit(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.commit(v.value.root, v.value.message, { amend: v.value.amend });
  });
  ipcMain.handle(IPC.ideGitBranch, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitBranch(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.branch(v.value.root, v.value.name, { create: v.value.create });
  });
  ipcMain.handle(IPC.ideGitBranches, async (_e, arg: unknown): Promise<IdeGitBranchesResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, branches: [], error: v.error.message };
    const [branches, current] = await Promise.all([
      git.listBranches(v.value.root),
      git.currentBranch(v.value.root),
    ]);
    return { ok: true, branches, ...(current ? { current } : {}) };
  });
  ipcMain.handle(IPC.ideGitStash, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitStash(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.stash(v.value.root, v.value.message);
  });
  ipcMain.handle(IPC.ideGitStashList, async (_e, arg: unknown): Promise<IdeGitStashListResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, entries: [], error: v.error.message };
    return { ok: true, entries: await git.stashList(v.value.root) };
  });
  ipcMain.handle(IPC.ideGitStashPop, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitStashRef(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.stashPop(v.value.root, v.value.index);
  });
  ipcMain.handle(IPC.ideGitStashApply, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitStashRef(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.stashApply(v.value.root, v.value.index);
  });
  ipcMain.handle(IPC.ideGitStashDrop, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitStashRef(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.stashDrop(v.value.root, v.value.index);
  });
  ipcMain.handle(IPC.ideGitBlame, async (_e, arg: unknown): Promise<IdeGitBlameResult> => {
    const v = validateGitBlame(arg);
    if (!v.ok) return { ok: false, entries: [], error: v.error.message };
    return { ok: true, entries: await git.blame(v.value.root, v.value.file) };
  });
  ipcMain.handle(IPC.ideGitMergeAbort, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.abortMerge(v.value.root);
  });
  ipcMain.handle(IPC.ideGitCheckoutSide, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitCheckoutSide(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.checkoutSide(v.value.root, v.value.file, v.value.side);
  });
  ipcMain.handle(IPC.ideGitCheckoutCommit, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitCommitRef(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.checkoutCommit(v.value.root, v.value.hash);
  });
  ipcMain.handle(IPC.ideGitCherryPick, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitCommitRef(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.cherryPick(v.value.root, v.value.hash);
  });
  ipcMain.handle(IPC.ideGitRevert, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitCommitRef(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.revertCommit(v.value.root, v.value.hash);
  });
  ipcMain.handle(IPC.ideGitReset, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitReset(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.reset(v.value.root, v.value.hash, v.value.mode);
  });
  ipcMain.handle(
    IPC.ideGitConflictVersions,
    async (_e, arg: unknown): Promise<IdeGitConflictVersionsResult> => {
      const v = validateGitConflictVersions(arg);
      if (!v.ok) {
        return {
          ok: false,
          base: "",
          ours: "",
          theirs: "",
          working: "",
          binary: false,
          error: v.error.message,
        };
      }
      return git.conflictVersions(v.value.root, v.value.file);
    },
  );
  ipcMain.handle(IPC.ideGitLog, async (_e, arg: unknown): Promise<IdeGitLogResult> => {
    const v = validateGitLog(arg);
    if (!v.ok) return { ok: false, entries: [], error: v.error.message };
    const entries = await git.log(v.value.root, v.value.limit);
    return { ok: true, entries };
  });
  ipcMain.handle(IPC.ideGitPush, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.push(v.value.root);
  });
  ipcMain.handle(IPC.ideGitPull, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.pull(v.value.root);
  });
  ipcMain.handle(IPC.ideGitFetch, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.fetch(v.value.root);
  });
  // APP-082: interactive rebase — todo shas are strict lowercase hex, actions whitelisted,
  // messages ride files (never argv); git rebase -i runs via scripted editors, no shell/UI.
  ipcMain.handle(
    IPC.ideGitRebaseTodo,
    async (_e, arg: unknown): Promise<IdeGitRebaseTodoResult> => {
      const v = validateGitRebaseTodo(arg);
      if (!v.ok) return { ok: false, base: "", rows: [], error: v.error.message };
      return git.rebaseTodo(v.value.root, v.value.base);
    },
  );
  ipcMain.handle(IPC.ideGitRebaseRun, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitRebaseRun(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.rebaseRun(v.value.root, v.value.base, v.value.todo);
  });
  ipcMain.handle(IPC.ideGitRebaseState, async (_e, arg: unknown): Promise<IdeGitRebaseState> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { inProgress: false, conflicted: [], error: v.error.message };
    return git.rebaseState(v.value.root);
  });
  ipcMain.handle(IPC.ideGitRebaseContinue, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.rebaseContinue(v.value.root);
  });
  ipcMain.handle(IPC.ideGitRebaseAbort, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.rebaseAbort(v.value.root);
  });
  // APP-083: commit detail for the blame click-through — the sha is a validated commit-ish
  // (validateGitCommitRef: no leading '-', no whitespace) and rides behind `--` in the host.
  ipcMain.handle(IPC.ideGitShow, async (_e, arg: unknown): Promise<IdeGitShowResult> => {
    const v = validateGitCommitRef(arg);
    if (!v.ok) {
      return {
        ok: false,
        sha: "",
        author: "",
        email: "",
        date: "",
        summary: "",
        body: "",
        error: v.error.message,
      };
    }
    return git.show(v.value.root, v.value.hash);
  });
  // APP-084: per-hunk/per-line staging — the patch rides over STDIN in the host (never
  // argv/shell); the root is path-guarded and the patch is size-capped + NUL-free.
  ipcMain.handle(IPC.ideGitApplyPatch, async (_e, arg: unknown): Promise<IdeGitOpResult> => {
    const v = validateGitApplyPatch(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return git.applyPatch(v.value.root, v.value.patch, {
      cached: v.value.cached,
      reverse: v.value.reverse,
    });
  });

  // APP-085: gated PR/MR review. Every network call runs inside prGateway → the
  // engine-bridge provider client → the L6 safeFetch proxy (SSRF-guarded, fail-closed).
  // The token lives in MAIN's keychain and reaches the sidecar via env — never the renderer.
  ipcMain.handle(IPC.ideGitPrStatus, async (_e, arg: unknown): Promise<IdePrStatus> => {
    const v = validateGitRoot(arg);
    if (!v.ok || !prGateway) return { hasToken: false };
    return prGateway.status(v.value.root);
  });
  ipcMain.handle(IPC.ideGitPrList, async (_e, arg: unknown): Promise<IdePrListResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, prs: [], error: v.ok ? "" : v.error.message };
    if (!prGateway) return { ok: false, prs: [], error: "PR review is unavailable" };
    return prGateway.list(v.value.root);
  });
  ipcMain.handle(IPC.ideGitPrGet, async (_e, arg: unknown): Promise<IdePrDetailResult> => {
    const v = validateGitPrGet(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    if (!prGateway) return { ok: false, error: "PR review is unavailable" };
    return prGateway.get(v.value.root, v.value.number);
  });
  ipcMain.handle(IPC.ideGitPrComment, async (_e, arg: unknown): Promise<IdePrOpResult> => {
    const v = validateGitPrComment(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    if (!prGateway) return { ok: false, error: "PR review is unavailable" };
    return prGateway.comment(v.value.root, v.value.number, v.value.body);
  });
  ipcMain.handle(IPC.ideGitPrSetToken, async (_e, arg: unknown): Promise<IdePrOpResult> => {
    const v = validateGitPrSetToken(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    if (!prGateway) return { ok: false, error: "PR review is unavailable" };
    return prGateway.setToken(v.value.root, v.value.token);
  });

  /* ── worktrees (Task #5, desktop parity) — the SAME `@prometheus/core/git-worktree`
   * functions the CLI's `/worktree` slash calls (CLI-054); "switch" has no handler of its
   * own — the renderer repoints the workspace root client-side against a `list()` row. */
  ipcMain.handle(IPC.ideWorktreeList, async (_e, arg: unknown): Promise<IdeWorktreeListResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, worktrees: [], error: v.error.message };
    return listWorktreesChecked(v.value.root);
  });
  ipcMain.handle(IPC.ideWorktreeCreate, async (_e, arg: unknown): Promise<IdeWorktreeOpResult> => {
    const v = validateGitWorktreeCreate(arg);
    if (!v.ok) return { ok: false, message: v.error.message };
    const created = await createWorktreeChecked(v.value.root, v.value.branch, v.value.path);
    /**
     * A worktree INHERITS its parent repo's grant — and only that.
     *
     * Switching to a worktree left the guard pinned to the old root, so every save in the
     * worktree on screen was refused. The grant is derived, never new: it is recorded only when
     * the repo the worktree was cut FROM is itself already granted, so this creates no authority
     * that did not already exist. A worktree of an ungranted repo stays ungranted, exactly as
     * before.
     */
    if (created.ok && created.path && isGrantedRoot(v.value.root)) {
      grantWorkingSetRoot(created.path);
    }
    return created;
  });
  ipcMain.handle(IPC.ideWorktreeRemove, async (_e, arg: unknown): Promise<IdeWorktreeOpResult> => {
    const v = validateGitWorktreeRemove(arg);
    if (!v.ok) return { ok: false, message: v.error.message };
    return removeWorktreeChecked(v.value.root, v.value.path);
  });

  /* ── sub-agent personas (Task #5, desktop parity) — the SAME `@prometheus/core/agent-files`
   * `loadAgentFile` clamping the CLI's `spawn_agent` applies; already scoped/clamped here in
   * MAIN before the list crosses IPC. */
  ipcMain.handle(
    IPC.ideAgentFilesList,
    async (_e, arg: unknown): Promise<IdeAgentFilesListResult> => {
      const v = validateGitRoot(arg);
      if (!v.ok) return { ok: false, personas: [], error: v.error.message };
      try {
        return { ok: true, personas: loadAgentFiles(v.value.root) };
      } catch (err) {
        return {
          ok: false,
          personas: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  /* ── custom slash commands (Task #5, desktop parity) — the SAME
   * `@prometheus/core/command-loader`/`command-gate` the CLI's `/command` loader uses; the
   * renderer expands the returned templates client-side (both are node-free subpaths). */
  ipcMain.handle(
    IPC.ideCommandFilesList,
    async (_e, arg: unknown): Promise<IdeCommandFilesListResult> => {
      const v = validateGitRoot(arg);
      if (!v.ok) return { ok: false, commands: [], error: v.error.message };
      try {
        return { ok: true, commands: loadCommandFiles(v.value.root) };
      } catch (err) {
        return {
          ok: false,
          commands: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  /* ── the RUN-GATE (§5.2/§9) — REAL engine-bridge gate; fail-closed ─────────*/
  ipcMain.handle(IPC.ideGate, async (evt: unknown, arg: unknown): Promise<IdeGateResult> => {
    const v = validateGate(arg);
    if (!v.ok) {
      // a bad arg is fail-closed: never a silent allow.
      const root =
        arg && typeof arg === "object" && typeof (arg as IdeGateRequest).workspaceRoot === "string"
          ? (arg as IdeGateRequest).workspaceRoot
          : "";
      return {
        ok: false,
        decision: "block",
        mayLaunch: false,
        trusted: false,
        workspaceRoot: root,
        reason: v.error.message,
        error: v.error.message,
      };
    }
    const sender = senderOf(evt);
    try {
      const result = await runGate(
        { workspaceRoot: v.value.workspaceRoot, ...(v.value.head ? { head: v.value.head } : {}) },
        {
          engineConfig: config,
          onStderr: (line) => {
            // forward gate progress as a host.stderr line (cosmetic; no verdict, C5).
            if (sender)
              sender.send(IPC_EVENTS.ideEvent, {
                channel: "host.stderr",
                source: "dap",
                id: "gate",
                line,
              });
          },
        },
      );
      return toGateResult(result);
    } catch (e) {
      // runGate is documented to fail closed; a hard crash still BLOCKS.
      return {
        ok: false,
        decision: "block",
        mayLaunch: false,
        trusted: false,
        workspaceRoot: v.value.workspaceRoot,
        reason: `gate crashed: ${errString(e)}`,
        error: errString(e),
      };
    }
  });

  /* ── gated command exec (§7.3) — user-approved + screened, fail-closed ─────*/
  ipcMain.handle(IPC.ideExec, async (_e, arg: unknown): Promise<IdeExecResult> => {
    const v = validateExec(arg);
    if (!v.ok) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        blocked: true,
        reason: v.error.message,
        error: v.error.message,
      };
    }
    // defense in depth: the destructive-command screen BLOCKS catastrophic commands
    // outright, even though the user already approved this run (§7.3 task card).
    const screen = screenCommand(v.value.command);
    if (screen.blocked) {
      return {
        ok: false,
        exitCode: 126,
        stdout: "",
        stderr: "",
        blocked: true,
        reason: screen.reason,
      };
    }
    try {
      // normalize + refuse a sensitive cwd (same guard as fs writes).
      const cwd = assertNotSensitivePath(v.value.cwd);
      return await execRunner(v.value.command, cwd, EXEC_TIMEOUT_MS);
    } catch (e) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "", error: errString(e) };
    }
  });

  /* ── the shared system tools (Phase 6) — the SAME path the CLI runs ───────*/
  /**
   * `agent:systemTool` — Studio's replacement for its own executor.
   *
   * What this channel removed: `ide:exec` spawns `shell -c <command>` and the only thing
   * standing in front of it is an 11-pattern regex denylist plus a human click. That
   * denylist blocks `sudo`; it does not block `${IFS}sudo`, `$(echo c3Vkbw== | base64 -d)`
   * or `eval "$X"`. Meanwhile the CLI had six structural layers and no shell at all. Two
   * surfaces of one product, and the weaker one was the GUI most people use.
   *
   * `runSystemTool` is that CLI path, imported rather than re-implemented — which is the
   * only way the two stay identical, since every previous attempt at "keep them in sync by
   * being careful" is what produced the split.
   */
  ipcMain.handle(IPC.agentSystemTool, async (_e, arg: unknown): Promise<AgentSystemToolResult> => {
    const req = arg as AgentSystemToolRequest | null;
    if (!req || typeof req.name !== "string" || typeof req.cwd !== "string") {
      return { ok: false, summary: "agent:systemTool: malformed request" };
    }
    // The renderer may not invent a tool name. `HOST_DISPATCH_TOOLS` is the single list this
    // guard and the renderer's own pre-flight check BOTH consult — they were two hand-kept
    // copies, and they diverged the first time one was widened: main learned the Tier-W
    // mutators and the renderer did not, so `delete_file` was offered to the model, approved
    // by the human, and then refused client-side as "not available in the editor".
    if (!isHostDispatchTool(req.name)) {
      return { ok: false, summary: `agent:systemTool: unknown tool "${req.name}"` };
    }
    try {
      const cwd = assertNotSensitivePath(req.cwd);
      // web_fetch / web_search — the only tools here that leave the machine, so the network
      // policy is applied before the request is built. `defaultNetwork` was declared, shown in
      // Settings and read by nothing but the model endpoint; this is its first real consumer
      // for the web, and "mcp-only" (the shipped default) means these two refuse and SAY why.
      const web = runWebTool(req.name, req.args ?? {}, safeFetch, {
        env: process.env,
        egress: () => coreSettings.egressAllowed("web", getSecurityPosture()),
      });
      if (web) {
        const out = await web;
        return {
          ok: out.ok,
          summary: out.summary ?? "",
          ...(out.data ? { data: out.data as Record<string, unknown> } : {}),
          ...(out.verdict ? { verdict: out.verdict as AgentSystemToolResult["verdict"] } : {}),
        };
      }
      // browser_navigate / browser_screenshot / browser_extract_text — a scoped MVP (drive a
      // dedicated, isolated tab to a URL; look at it; read it — no click/type). `navigate`
      // gets the SAME network-policy gate as web_fetch/web_search, for the same reason: it is
      // the one of the three that actually leaves the machine.
      const browser = runBrowserTool(req.name, req.args ?? {}, browserToolHostDeps, safeFetch, {
        env: process.env,
        egress: () => coreSettings.egressAllowed("web", getSecurityPosture()),
      });
      if (browser) {
        const out = await browser;
        return {
          ok: out.ok,
          summary: out.summary ?? "",
          ...(out.data ? { data: out.data as Record<string, unknown> } : {}),
          ...(out.verdict ? { verdict: out.verdict as AgentSystemToolResult["verdict"] } : {}),
        };
      }
      /**
       * FAIL-CLOSED WORKING-SET SCOPE CHECK — the CLI has one, this host did not.
       *
       * `runSystemTool` takes `roots` but its READ tools never consult them: the only path guard
       * inside it is `guardSecretPath`, which matches credential FILENAMES (`.env`, `*.pem`,
       * `.ssh/*`). Everything else on the disk was reachable. The CLI enforces scope one layer
       * above, in `agent-runtime`'s dispatcher (`pathArgsOf` + `isPathAllowed`); this handler
       * called `runSystemTool` directly, so the same agent had no scope at all here.
       *
       * Proven through this very handler with the working set declared as `/tmp/r10ws`:
       *   read_file /etc/passwd      → ok:true, full contents
       *   read_file ~/.zsh_history   → ok:true, the user's real shell history
       * Tool output is folded into the model's thread, and the thread may go to a cloud
       * endpoint — so this was personal data leaving the workspace the user chose.
       *
       * Same helpers, same order as the CLI: `scopedAbsolute` expands `~` BEFORE resolving (or
       * `~/.ssh/id_rsa` tests as `<cwd>/~/.ssh/id_rsa`, which does not exist, so the walk falls
       * back to `<cwd>` and ALLOWS it while the tool opens the real home file). A path the human
       * approved through the out-of-scope seam stays exempt.
       */
      {
        const scopeRoots = getWorkingSetRoots();
        const roots = scopeRoots.length > 0 ? [...scopeRoots] : [cwd];
        for (const p of pathArgsOf(req.args ?? {})) {
          const abs = scopedAbsolute(p, cwd);
          if (isInsideWorkingSet(abs)) continue;
          if (!isPathAllowed(abs, roots)) {
            return { ok: false, summary: `path outside the working set (denied): ${p}` };
          }
        }
      }
      const out = await runSystemTool(req.name, req.args ?? {}, {
        cwd,
        roots: [cwd],
        home: prometheusHome(),
        // The gate posture is passed EXPLICITLY rather than left to core's default, and it is
        // resolved through the security profile's floor: `gateStrict` means "never weaker than
        // enforce". Relying on the default happened to be correct, which is a different thing
        // from being enforced — the moment a caller passed a mode, the floor would not have
        // applied.
        gateMode: coreSettings.effectiveGateMode("enforce", getSecurityPosture()),
        // The operator's A0–A7 level, CLAMPED — see AgentSystemToolRequest.authLevel. It is
        // what `run_command`'s OS sandbox consults to decide whether this call may reach the
        // network, and it is what the exec audit records. Absent ⇒ core's safe default.
        ...(typeof req.authLevel === "number"
          ? {
              authLevel: clampAuthLevelToSaved(
                clampAuthLevelForPosture(
                  clampAuthLevelForElevation(Math.max(0, Math.min(Math.trunc(req.authLevel), 7))),
                ),
              ),
            }
          : {}),
      });
      if (!out)
        return { ok: false, summary: `agent:systemTool: "${req.name}" is not a system tool` };
      return {
        ok: out.ok,
        summary: out.summary ?? "",
        ...(out.data ? { data: out.data as Record<string, unknown> } : {}),
        ...(out.verdict ? { verdict: out.verdict as AgentSystemToolResult["verdict"] } : {}),
      };
    } catch (e) {
      return { ok: false, summary: errString(e) };
    }
  });

  /* ── remembered grants — "don't ask again", finally meaning it ────────────*/
  /**
   * `agent:grants.list` / `agent:grants.add` — the persisted permission grants.
   *
   * `ScopedPermissionStore` has had `project` and `user` scopes from the start, the grants file
   * has persisted them, and `withRememberedGrants` has consulted them on every call. NO host on
   * ANY surface ever returned `remember`, so the entire mechanism was reachable only by
   * hand-editing the file. This is main's half of fixing that.
   *
   * The file is `<config>/grants.json` — the SAME one the CLI reads. A grant is a security
   * decision the user makes once, and keeping a separate copy per surface would mean answering
   * "always" twice for the same tool and reasonably concluding it had not been recorded.
   *
   * Adding goes through the store's own `add()`, never around it: that is what refuses an
   * over-broad subject, and this is a plain JSON file a hostile process could write to.
   */
  ipcMain.handle(IPC.agentGrantsList, async (): Promise<AgentGrantsResult> => {
    try {
      return { ok: true, grants: readGrants() as AgentGrant[] };
    } catch (e) {
      return { ok: false, grants: [], error: errString(e) };
    }
  });

  ipcMain.handle(IPC.agentGrantsAdd, async (_e, arg: unknown): Promise<AgentGrantsResult> => {
    const g = arg as AgentGrant | null;
    if (!g || typeof g.subject !== "string" || (g.scope !== "project" && g.scope !== "user")) {
      return { ok: false, grants: [], error: "agent:grants.add: malformed grant" };
    }
    try {
      // Read → add → save, rather than appending to the file: `add()` is the door that refuses
      // an over-broad subject, and a live grant and a rehydrated one must pass the same one.
      const store = new coreAgent.ScopedPermissionStore();
      for (const prior of readGrants()) store.add(prior);
      const added = store.add({
        subject: g.subject,
        decision: g.decision === "deny" ? "deny" : "allow",
        scope: g.scope,
        ...(g.root ? { root: g.root } : {}),
        ...(g.paths ? { paths: g.paths } : {}),
      });
      // `add()` returns `{ok, reason}`, not a boolean — an object is always truthy, so a plain
      // falsiness check here would report an over-broad grant as saved.
      if (!added.ok) {
        return {
          ok: false,
          grants: readGrants() as AgentGrant[],
          error: added.reason ?? "that grant is too broad to remember",
        };
      }
      saveGrants(store);
      return { ok: true, grants: readGrants() as AgentGrant[] };
    } catch (e) {
      return { ok: false, grants: [], error: errString(e) };
    }
  });

  /* ── the engine verbs — the product's own surface, reachable from the pane ─*/
  /**
   * `agent:engineTool` — run one `prometheus_*` verb through prometheus.py.
   *
   * The pane's allow-list used to exclude all 14 with a comment saying the pane had no seam to
   * the engine. That was true and it was a large hole: the GUI could not scan a machine, list
   * what was installed, or install anything — the things the product exists to do — while the
   * CLI agent could do all of them. A user had to open a terminal to ask for the product's own
   * feature.
   *
   * The dispatch, the arg validation and the VERDICT extraction all live in core's
   * `runEngineVerb`, shared with the CLI. The verdict is the part that must not be
   * re-implemented: `forced_danger` on the envelope means nemesis said block and the engine was
   * forced through anyway, and the loop aborts the round on it. A host that forgot to lift it
   * would not fail loudly — the gate would simply stop firing here.
   *
   * NO cwd, deliberately. These verbs are machine-global (they rewrite other agent CLIs'
   * configs), so a workspace root would be a scope that reads as a guarantee and is not one.
   */
  /**
   * `agent:hookRun` — list, or run, ONE of the user's configured lifecycle hooks.
   *
   * The spawn lives here and only here: the renderer is C5-sandboxed and could not run a shell
   * command if it tried, and "which shell lines may execute" must not be a decision made by the
   * surface that renders model output. `runConfiguredHook` refuses any command that is not
   * verbatim one the user configured for that same event, so this channel cannot be turned into
   * a general-purpose exec.
   *
   * Never rejects. Every failure comes back as `{ok:false}` or as an `outcome.error`, which
   * core's `runPreToolUseHooks` reads as "no hook fired" rather than as a deny — a broken hook
   * must not become an invisible veto over every tool call.
   */
  ipcMain.handle(IPC.agentHookRun, async (_e, arg: unknown): Promise<AgentHookRunResult> => {
    const req = arg as AgentHookRunRequest | null;
    if (!req || (req.op !== "list" && req.op !== "run")) {
      return { ok: false, error: "agent:hookRun: malformed request" };
    }
    if (req.op === "list") return { ok: true, hooks: listHooks() };
    const event = req.event;
    if (event !== "PreToolUse" && event !== "PostToolUse" && event !== "SessionStart") {
      return { ok: false, error: "agent:hookRun: unknown event" };
    }
    if (typeof req.command !== "string" || req.command.length === 0) {
      return { ok: false, error: "agent:hookRun: command is required" };
    }
    let cwd: string | undefined;
    try {
      cwd = typeof req.cwd === "string" && req.cwd ? assertNotSensitivePath(req.cwd) : undefined;
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
    const outcome = await runConfiguredHook(
      {
        event,
        command: req.command,
        ...(typeof req.stdin === "string" ? { stdin: req.stdin } : {}),
        ...(typeof req.timeoutMs === "number" ? { timeoutMs: req.timeoutMs } : {}),
      },
      { ...(cwd ? { cwd } : {}) },
    );
    return { ok: true, outcome };
  });

  /**
   * `agent:canaryTrip` — point 6b. Core's loop (running IN the renderer, since it is
   * C5-safe) detects the trip; it cannot write `canary-audit.jsonl` itself, so this channel
   * exists purely to hand the detection off to the process that owns the disk. No gate, no
   * scan, no branch on content — a trip is already the signal, and this handler's only job is
   * to make sure it is not lost.
   */
  ipcMain.handle(IPC.agentCanaryTrip, async (_e, arg: unknown): Promise<AgentCanaryTripResult> => {
    const req = arg as AgentCanaryTripRequest | null;
    if (!req || typeof req.textSnippet !== "string") {
      return { ok: false };
    }
    appendCanaryAudit(prometheusHome(), {
      event: "canary-tripped",
      textSnippet: req.textSnippet,
    });
    return { ok: true };
  });

  ipcMain.handle(IPC.agentEngineTool, async (_e, arg: unknown): Promise<AgentSystemToolResult> => {
    const req = arg as AgentEngineToolRequest | null;
    if (!req || typeof req.name !== "string") {
      return { ok: false, summary: "agent:engineTool: malformed request" };
    }
    // The client is built per call from the same EngineConfig the run-gate uses. Building it
    // here rather than holding one keeps this handler honest when the config is absent: it
    // resolves (and fails) exactly like every other engine call in the app.
    const out = runEngineVerb(
      req.name,
      req.args ?? {},
      (argv) =>
        createEngineClient(config).runPrometheus(argv) as unknown as Promise<
          Record<string, unknown>
        >,
    );
    if (!out) return { ok: false, summary: `agent:engineTool: unknown verb "${req.name}"` };
    try {
      const r = await out;
      return {
        ok: r.ok,
        summary: r.summary ?? "",
        ...(r.data ? { data: r.data as Record<string, unknown> } : {}),
        ...(r.verdict ? { verdict: r.verdict as AgentSystemToolResult["verdict"] } : {}),
      };
    } catch (e) {
      return { ok: false, summary: errString(e) };
    }
  });

  /* ── workspace search (§6.3) — bounded gitignore-aware walk, OFFLOADED to the ──
   * utilityProcess worker (APP-066) with a graceful inline fallback. A `requestId`
   * opts into live progress (search.progress events) + `ide:searchCancel`. */
  ipcMain.handle(IPC.ideSearch, async (_e, arg: unknown): Promise<IdeSearchResult> => {
    const v = validateSearch(arg);
    if (!v.ok) {
      return { ok: false, matches: [], scanned: 0, truncated: false, error: v.error.message };
    }
    const requestId = v.value.requestId;
    try {
      const root = assertNotSensitivePath(v.value.root);
      const q: FileSearchQuery = {
        root,
        ...(v.value.mode === "path" ? { contains: v.value.query } : { grep: v.value.query }),
        ...(v.value.extensions ? { extensions: v.value.extensions } : {}),
        ...(v.value.caseSensitive !== undefined ? { caseSensitive: v.value.caseSensitive } : {}),
        ...(v.value.maxResults !== undefined ? { maxResults: v.value.maxResults } : {}),
        ...(v.value.include ? { include: v.value.include } : {}),
        ...(v.value.exclude ? { exclude: v.value.exclude } : {}),
      };
      const handle = runWorkerTask(
        { kind: "file.search", payload: q },
        requestId
          ? {
              onProgress: (scanned) =>
                broadcast({ channel: "search.progress", requestId, scanned }),
            }
          : undefined,
      );
      if (requestId) activeSearches.set(requestId, handle);
      let res: TaskResponse;
      try {
        res = await handle.result;
      } finally {
        if (requestId) activeSearches.delete(requestId);
      }
      if (!res.ok)
        return { ok: false, matches: [], scanned: 0, truncated: false, error: res.error };
      if (res.kind !== "file.search") {
        return {
          ok: false,
          matches: [],
          scanned: 0,
          truncated: false,
          error: "unexpected task kind",
        };
      }
      const r = res.result;
      return {
        ok: true,
        matches: r.matches.map((m) => ({
          path: m.path,
          rel: m.rel,
          ext: m.ext,
          ...(m.matchLine !== undefined ? { line: m.matchLine } : {}),
        })),
        scanned: r.scanned,
        truncated: r.truncated,
        ...(r.cancelled ? { cancelled: true } : {}),
      };
    } catch (e) {
      if (requestId) activeSearches.delete(requestId);
      return { ok: false, matches: [], scanned: 0, truncated: false, error: errString(e) };
    }
  });

  /* ── APP-066: cancel an in-flight worker search by requestId (cooperative) ──*/
  ipcMain.handle(IPC.ideSearchCancel, async (_e, arg: unknown): Promise<IdeAckResult> => {
    const v = validateSearchCancel(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    activeSearches.get(v.value.requestId)?.cancel();
    return { ok: true };
  });

  /* ── APP-076: structural (AST) search via the structsearch.py sidecar (read-only) ──*/
  ipcMain.handle(IPC.ideStructSearch, async (_e, arg: unknown): Promise<IdeStructSearchResult> => {
    const v = validateStructSearch(arg);
    if (!v.ok) return { ok: false, matches: [], count: 0, error: v.error.message };
    try {
      const root = assertNotSensitivePath(v.value.root); // path-guarded, fail-closed
      // argv as DISTINCT entries (option-injection safe) — a pattern starting with `-` stays a value.
      const res = await runSidecar("structsearch", "match", [
        "--path",
        root,
        "--pattern",
        v.value.pattern,
      ]);
      const raw = (res.data as { matches?: unknown; count?: unknown }) ?? {};
      const rows = Array.isArray(raw.matches) ? (raw.matches as Record<string, unknown>[]) : [];
      const matches: IdeStructMatch[] = rows.map((m) => ({
        file: String(m.file ?? ""),
        line: typeof m.line === "number" ? m.line : 1,
        col: typeof m.col === "number" ? m.col : 1,
        endLine:
          typeof m.end_line === "number" ? m.end_line : typeof m.line === "number" ? m.line : 1,
        endCol: typeof m.end_col === "number" ? m.end_col : 0,
        snippet: String(m.snippet ?? ""),
        bindings:
          m.bindings && typeof m.bindings === "object"
            ? (m.bindings as Record<string, string>)
            : {},
      }));
      return {
        ok: true,
        matches,
        count: typeof raw.count === "number" ? raw.count : matches.length,
      };
    } catch (e) {
      return { ok: false, matches: [], count: 0, error: errString(e) };
    }
  });

  /* ── APP-066: repo file index — a filter-free walk OFFLOADED to the worker ──*/
  ipcMain.handle(
    IPC.ideWorkspaceIndex,
    async (_e, arg: unknown): Promise<IdeWorkspaceIndexResult> => {
      const v = validateGitRoot(arg);
      if (!v.ok)
        return { ok: false, files: [], scanned: 0, truncated: false, error: v.error.message };
      try {
        const root = assertNotSensitivePath(v.value.root);
        const res = await runWorkerTask({ kind: "file.index", payload: { root } }).result;
        if (!res.ok)
          return { ok: false, files: [], scanned: 0, truncated: false, error: res.error };
        if (res.kind !== "file.index") {
          return {
            ok: false,
            files: [],
            scanned: 0,
            truncated: false,
            error: "unexpected task kind",
          };
        }
        const r = res.result;
        return {
          ok: true,
          files: r.files,
          scanned: r.scanned,
          truncated: r.truncated,
          ...(r.cancelled ? { cancelled: true } : {}),
        };
      } catch (e) {
        return { ok: false, files: [], scanned: 0, truncated: false, error: errString(e) };
      }
    },
  );

  /* ── test discovery (§9) — testmgr.py AST scan; NEVER executes target code ──*/
  ipcMain.handle(IPC.ideTestDiscover, async (_e, arg: unknown): Promise<IdeTestDiscoverResult> => {
    const v = validateGitRoot(arg);
    if (!v.ok) return { ok: false, roots: [], error: v.error.message };
    try {
      // Discovery never executes project code, but the ROOT still reaches a spawned sidecar —
      // the same normalize + sensitive-cwd denial every sibling path applies.
      const res = await runSidecar("testmgr", "discover", [
        "--path",
        assertNotSensitivePath(v.value.root),
      ]);
      const data = res.data as { tree?: unknown; root?: unknown; caseCount?: unknown };
      return {
        ok: true,
        roots: Array.isArray(data.tree) ? (data.tree as IdeTestNode[]) : [],
        ...(typeof data.root === "string" ? { root: data.root } : {}),
        ...(typeof data.caseCount === "number" ? { caseCount: data.caseCount } : {}),
      };
    } catch (e) {
      return { ok: false, roots: [], error: errString(e) };
    }
  });

  // APP-086: coverage RUN executes the target suite under coverage.py (user-initiated,
  // like APP-013 run) → a CoverageReport; import reshapes an external coverage.py JSON.
  const coerceReport = (data: unknown): IdeCoverageReport => {
    const d = (data ?? {}) as { perFile?: unknown; totalPct?: unknown };
    const perFile: IdeCoverageReport["perFile"] = {};
    if (d.perFile && typeof d.perFile === "object" && !Array.isArray(d.perFile)) {
      for (const [file, raw] of Object.entries(d.perFile as Record<string, unknown>)) {
        const e = (raw ?? {}) as { lines?: unknown; missed?: unknown; branchPct?: unknown };
        const entry: IdeCoverageReport["perFile"][string] = {
          lines: Array.isArray(e.lines)
            ? e.lines.filter((n): n is number => typeof n === "number")
            : [],
          missed: Array.isArray(e.missed)
            ? e.missed.filter((n): n is number => typeof n === "number")
            : [],
        };
        if (typeof e.branchPct === "number") entry.branchPct = e.branchPct;
        perFile[file] = entry;
      }
    }
    return { perFile, totalPct: typeof d.totalPct === "number" ? d.totalPct : 0 };
  };
  ipcMain.handle(IPC.ideCoverageRun, async (_e, arg: unknown): Promise<IdeCoverageResult> => {
    const v = validateCoverageRun(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      /**
       * Coverage RUNS the project's test suite — the same arbitrary-code execution `ide:test.run`
       * guards, and it had none of those guards.
       *
       * `coverage run -m pytest` imports the workspace's conftest.py, its plugins and every test
       * module, so a repo whose gate verdict is block/error — or that was never scanned at all —
       * still had its code executed by MAIN. The observable asymmetry: press "Run tests" on an
       * untrusted workspace and it is refused with "run gate refused: …"; press "Run coverage"
       * and the identical suite runs. The 90% CPU/RAM launch guard was skipped too, and the root
       * reached the sidecar without the sensitive-path check every sibling execute path applies.
       *
       * Same three guards, same order, same refusal wording as the twin above, so the two cannot
       * report a refusal differently.
       */
      const guard = await assertExecuteAllowed(v.value.root, "coverage run", {
        assertNotSensitivePath,
        runGate: (r) => runGate({ workspaceRoot: r }, { engineConfig: config }),
        readTele,
        errString,
      });
      if (!guard.ok) return { ok: false, error: guard.error };
      const root = guard.root;
      const idArgs = v.value.ids.flatMap((id) => ["--id", id]);
      const res = await runSidecar("coverage", "run", [
        "--path",
        root,
        "--framework",
        v.value.framework,
        ...idArgs,
      ]);
      return { ok: true, report: coerceReport(res.data) };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideCoverageImport, async (_e, arg: unknown): Promise<IdeCoverageResult> => {
    const v = validateCoverageImport(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    try {
      // The sibling coverage.run above canonicalises its root through the same guard; this
      // one handed the renderer's string to the sidecar untouched. `assertNotSensitivePath`
      // both applies the denylist and returns an ABSOLUTE path, which also rules out a
      // flag-shaped value being read as another argument. The throw is caught below.
      const inPath = assertNotSensitivePath(v.value.path);
      const res = await runSidecar("coverage", "import", ["--in", inPath]);
      return { ok: true, report: coerceReport(res.data) };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  /* ── test RUN (APP-013) — EXECUTES the given node ids via testmgr.py `run`/
     `rerun-failed`; user-initiated only (the discover contract stays never-execute).
     Per-test events stream over ide:test.event; the terminal summary rides back. ──*/
  ipcMain.handle(IPC.ideTestRun, async (_e, arg: unknown): Promise<IdeTestRunResult> => {
    const v = validateTestRun(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    if (!testSpawn) return { ok: false, error: "test runner unavailable (no spawn wired)" };
    try {
      // APP-040: running target code EXECUTES project code — it must cross the SAME
      // fail-closed run-gate + telemetry launch-guard as ide:run.start, not just the
      // discovery never-execute path. Refusals name their stage. Shared with coverage.run,
      // which had NONE of these until the two were made one implementation.
      const guard = await assertExecuteAllowed(v.value.root, "test run", {
        assertNotSensitivePath,
        runGate: (r) => runGate({ workspaceRoot: r }, { engineConfig: config }),
        readTele,
        errString,
      });
      if (!guard.ok) return { ok: false, error: guard.error };
      const root = guard.root;
      return await runTestVerb(testSpawn, { ...v.value, root }, broadcastTest, {
        kills: testKills,
      });
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── SQL console (APP-042): sqlrunner.py bridge — redacted + paged in SqlHost ──
  ipcMain.handle(IPC.ideSqlConnect, async (_e, arg: unknown): Promise<IdeSqlConnectResult> => {
    const v = validateSqlConnect(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const guard = guardSqliteConn(v.value.conn);
    if (guard) return { ok: false, error: guard };
    return sqlHost.connect(v.value.conn);
  });
  ipcMain.handle(IPC.ideSqlQuery, async (_e, arg: unknown): Promise<IdeSqlQueryResult> => {
    const v = validateSqlQuery(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const guard = guardSqliteConn(v.value.conn);
    if (guard) return { ok: false, error: guard };
    return sqlHost.query({
      conn: v.value.conn,
      sql: v.value.sql,
      ...(v.value.params ? { params: v.value.params as IdeSqlCell[] } : {}),
      ...(v.value.page !== undefined ? { page: v.value.page } : {}),
      ...(v.value.pageSize !== undefined ? { pageSize: v.value.pageSize } : {}),
      ...(v.value.timeoutS !== undefined ? { timeoutS: v.value.timeoutS } : {}),
    });
  });
  ipcMain.handle(IPC.ideSqlSchema, async (_e, arg: unknown): Promise<IdeSqlSchemaResult> => {
    const v = validateSqlSchema(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    const guard = guardSqliteConn(v.value.conn);
    if (guard) return { ok: false, error: guard };
    return sqlHost.schema(v.value.conn, v.value.table);
  });

  /* ── live Jupyter kernel (APP-045): one supervised session per notebook ─────*/
  ipcMain.handle(IPC.ideKernelStart, async (_e, arg: unknown): Promise<IdeKernelStartResult> => {
    const v = validateKernelStart(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    // path-guard the working dir the same way the fs IPC guards reads (C5).
    try {
      assertNotSensitivePath(v.value.cwd);
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
    try {
      const sessionId = kernelHost.start(v.value.cwd, v.value.env);
      return { ok: true, sessionId };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });
  ipcMain.handle(IPC.ideKernelExecute, async (_e, arg: unknown): Promise<IdeKernelOkResult> => {
    const v = validateKernelExecute(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return kernelHost.execute(v.value.sessionId, v.value.cellId, v.value.code)
      ? { ok: true }
      : { ok: false, error: "no such kernel session" };
  });
  ipcMain.handle(IPC.ideKernelInterrupt, async (_e, arg: unknown): Promise<IdeKernelOkResult> => {
    const v = validateKernelSession(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return kernelHost.interrupt(v.value.sessionId)
      ? { ok: true }
      : { ok: false, error: "no such kernel session" };
  });
  ipcMain.handle(IPC.ideKernelRestart, async (_e, arg: unknown): Promise<IdeKernelOkResult> => {
    const v = validateKernelSession(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return kernelHost.restart(v.value.sessionId)
      ? { ok: true }
      : { ok: false, error: "no such kernel session" };
  });
  ipcMain.handle(IPC.ideKernelShutdown, async (_e, arg: unknown): Promise<IdeKernelOkResult> => {
    const v = validateKernelSession(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    kernelHost.shutdown(v.value.sessionId); // idempotent — an unknown id is still ok
    return { ok: true };
  });
  // APP-088: request a paged DataFrame view; the frame streams back as a `dataframe` event.
  ipcMain.handle(IPC.ideKernelDataframe, async (_e, arg: unknown): Promise<IdeKernelOkResult> => {
    const v = validateKernelDataframe(arg);
    if (!v.ok) return { ok: false, error: v.error.message };
    return kernelHost.dataframe(v.value.sessionId, v.value.name, v.value.offset, v.value.limit)
      ? { ok: true }
      : { ok: false, error: "no such kernel session" };
  });

  /* ── profiler (APP-046): GATED cProfile run → flame folds ───────────────────*/
  const profileRun: ProfileRunner =
    wiring.profileRun ??
    ((argv, signal) =>
      runSidecarScript("profile.py", argv, {
        timeoutMs: PROFILE_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      }));
  // at most one profile run in flight; `stop` aborts it fail-closed.
  let profileAbort: AbortController | undefined;
  ipcMain.handle(IPC.ideProfileStart, async (_e, arg: unknown): Promise<IdeProfileResult> => {
    const v = validateProfileStart(arg);
    if (!v.ok) return { ok: false, error: v.error.message, refusedBy: "path" };
    // 1) the target MUST resolve under the workspace root (no profiling outside it).
    const root = resolve(v.value.workspaceRoot);
    const target = resolve(v.value.path);
    if (target !== root && !target.startsWith(root + sep)) {
      return { ok: false, error: "target script is outside the workspace root", refusedBy: "path" };
    }
    try {
      assertNotSensitivePath(target);
      if (v.value.cwd) assertNotSensitivePath(v.value.cwd);
    } catch (e) {
      return { ok: false, error: errString(e), refusedBy: "path" };
    }
    // 2) profiling EXECUTES the target — cross the SAME fail-closed run-gate as a run.
    let gate: RunGateResult;
    try {
      gate = await runGate(
        { workspaceRoot: v.value.workspaceRoot, ...(v.value.head ? { head: v.value.head } : {}) },
        { engineConfig: config },
      );
    } catch (e) {
      return { ok: false, error: `gate crashed: ${errString(e)}`, refusedBy: "gate" };
    }
    if (!gate.mayLaunch) {
      return {
        ok: false,
        refusedBy: "gate",
        gate: toGateResult(gate),
        error: gate.reason ?? "profiling refused by the gate",
      };
    }
    // 3) run it (abortable). argv: target args ride AFTER a literal `--`.
    const argv = ["run", "--path", target];
    if (v.value.mode) argv.push("--mode", v.value.mode);
    if (v.value.cwd) argv.push("--cwd", v.value.cwd);
    if (v.value.timeoutS !== undefined) argv.push("--timeout", String(v.value.timeoutS));
    if (v.value.args?.length) argv.push("--", ...v.value.args);
    profileAbort?.abort(); // supersede any previous in-flight run
    const controller = new AbortController();
    profileAbort = controller;
    try {
      const env = await profileRun(argv, controller.signal);
      if (env.ok === false) {
        return { ok: false, error: typeof env.error === "string" ? env.error : "profile failed" };
      }
      return {
        ok: true,
        samples: Array.isArray(env.samples) ? (env.samples as IdeProfileSample[]) : [],
        totalUs: typeof env.totalUs === "number" ? env.totalUs : 0,
        approx: env.approx === true,
        timedOut: env.timedOut === true,
        truncated: env.truncated === true,
        mode: (typeof env.mode === "string" ? env.mode : "cpu") as IdeProfileMode,
        unit: typeof env.unit === "string" ? env.unit : "us",
        sawTasks: env.sawTasks === true,
        ...(typeof env.note === "string" ? { note: env.note } : {}),
        /**
         * The TARGET's own crash, forwarded.
         *
         * The sidecar reports it (`profile.py` sets `runError: "RuntimeError: boom"`) and this
         * mapper dropped it, so profiling a script that raises on its first line returned
         * `ok:true` with a flame graph built entirely from runpy/import overhead — 963µs of
         * machinery and none of the user's code. The panel showed a normal-looking chart and no
         * error, so the user believed they had profiled something that never ran.
         */
        ...(typeof env.runError === "string" && env.runError ? { runError: env.runError } : {}),
      };
    } catch (e) {
      return { ok: false, error: errString(e) };
    } finally {
      if (profileAbort === controller) profileAbort = undefined;
    }
  });
  ipcMain.handle(IPC.ideProfileStop, async (): Promise<IdeOkResult> => {
    profileAbort?.abort();
    profileAbort = undefined;
    return { ok: true };
  });

  /* ── APP-089: profile snapshots (save/list) + compare, under a MAIN-owned dir ──*/
  const snapDir =
    wiring.profileSnapshotDir ?? join(homedir(), ".prometheus-studio", "profile-snapshots");
  ipcMain.handle(
    IPC.ideProfileSnapshotSave,
    async (_e, arg: unknown): Promise<IdeProfileSaveResult> => {
      const v = validateProfileSnapshotSave(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const body = JSON.stringify({
        name: v.value.name,
        mode: v.value.mode,
        unit: v.value.unit,
        samples: v.value.samples,
        totalValue: v.value.totalValue,
      });
      const env = await runSidecarScript(
        "profile.py",
        ["snapshot", "--op", "save", "--dir", snapDir, "--name", v.value.name],
        { timeoutMs: 30_000, input: body },
      );
      if (env.ok === false) {
        return {
          ok: false,
          error: typeof env.error === "string" ? env.error : "snapshot save failed",
        };
      }
      return { ok: true, ...(typeof env.id === "string" ? { id: env.id } : {}) };
    },
  );
  ipcMain.handle(IPC.ideProfileSnapshotList, async (): Promise<IdeProfileListResult> => {
    const env = await runSidecarScript(
      "profile.py",
      ["snapshot", "--op", "list", "--dir", snapDir],
      {
        timeoutMs: 15_000,
      },
    );
    if (env.ok === false) {
      return {
        ok: false,
        error: typeof env.error === "string" ? env.error : "snapshot list failed",
      };
    }
    return {
      ok: true,
      snapshots: Array.isArray(env.snapshots) ? (env.snapshots as IdeProfileSnapshotMeta[]) : [],
    };
  });
  ipcMain.handle(
    IPC.ideProfileCompare,
    async (_e, arg: unknown): Promise<IdeProfileCompareResult> => {
      const v = validateProfileCompare(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      const env = await runSidecarScript(
        "profile.py",
        ["compare", "--dir", snapDir, "--a", v.value.aId, "--b", v.value.bId],
        { timeoutMs: 15_000 },
      );
      if (env.ok === false) {
        return { ok: false, error: typeof env.error === "string" ? env.error : "compare failed" };
      }
      return {
        ok: true,
        samples: Array.isArray(env.samples) ? (env.samples as IdeProfileSample[]) : [],
        unit: typeof env.unit === "string" ? env.unit : "us",
        aMode: typeof env.aMode === "string" ? env.aMode : "cpu",
        bMode: typeof env.bMode === "string" ? env.bMode : "cpu",
        summary:
          env.summary && typeof env.summary === "object"
            ? (env.summary as IdeProfileCompareResult["summary"])
            : { regressions: [], improvements: [] },
      };
    },
  );

  /* ── terminal launcher (APP-048): core profiles/AI presets/env → menu+resolve */
  const termPlatform = process.platform === "win32" ? ("win32" as const) : ("posix" as const);
  ipcMain.handle(IPC.ideTerminalMenu, async (_e, arg: unknown): Promise<IdeTerminalMenuResult> => {
    const v = validateTerminalMenu(arg);
    if (!v.ok) return { ok: false, items: [], error: v.error.message };
    try {
      return { ok: true, items: buildTerminalMenuItems(v.value.envs) };
    } catch (e) {
      return { ok: false, items: [], error: errString(e) };
    }
  });
  ipcMain.handle(
    IPC.ideTerminalResolve,
    async (_e, arg: unknown): Promise<IdeTerminalResolveResult> => {
      const v = validateTerminalResolve(arg);
      if (!v.ok) return { ok: false, error: v.error.message };
      try {
        const resolved = resolveTerminalItem(v.value.id, {
          workspaceRoot: v.value.workspaceRoot,
          home: homedir(),
          platform: termPlatform,
          ...(v.value.envs ? { envs: v.value.envs } : {}),
          ...(v.value.activeEnvPath ? { activeEnvPath: v.value.activeEnvPath } : {}),
          ...(v.value.fileDir ? { fileDir: v.value.fileDir } : {}),
        });
        if (!resolved) return { ok: false, error: `unknown terminal profile '${v.value.id}'` };
        return { ok: true, resolved };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  /**
   * repo-map (APP-053): repomap.py ranked symbol map for @codebase grounding.
   *
   * KNOWN GAP (point 7, prompt-injection defense plan): unlike the shared TS `walkRepo`
   * (`@prometheus/core`'s `token-economy/repo-map.ts`, used by codebase-overview and covered by
   * `system-tools.ts`'s untrusted-file-data framing), this path shells out to a Python sidecar
   * and its output — extracted symbol NAMES, not raw file content — is injected into the model's
   * context unframed and unscanned. Narrow (names only, not bodies/comments/strings), but real: a
   * maliciously-named identifier could carry an injected phrase into `@codebase` grounding.
   * Deferred rather than fixed here because it requires touching `python/sidecar/repomap.py`, a
   * different subsystem/language than the rest of this effort.
   */
  ipcMain.handle(IPC.ideRepoMap, async (_e, arg: unknown): Promise<IdeRepoMapResult> => {
    const v = validateRepoMap(arg);
    if (!v.ok) return { ok: false, files: [], error: v.error.message };
    let root: string;
    try {
      // resolve → an absolute path (never a leading-dash flag) + sensitive-path guard.
      root = assertNotSensitivePath(v.value.root);
    } catch (e) {
      return { ok: false, files: [], error: errString(e) };
    }
    // argv is verbatim (shell:false): every user value rides behind its own flag, so no
    // string can become a flag (files joined by comma — repomap splits on it).
    const argv: string[] = v.value.files?.length ? ["refresh", root] : ["map", root];
    if (v.value.files?.length) argv.push("--files", v.value.files.join(","));
    if (v.value.budget !== undefined) argv.push("--budget", String(v.value.budget));
    if (v.value.query) argv.push("--query", v.value.query);
    // the scan can be slow on a big repo — a generous timeout, async (never blocks the UI).
    const env = await runSidecarScript("repomap.py", argv, { timeoutMs: 120_000 });
    if (env.ok === false) {
      return {
        ok: false,
        files: [],
        error: typeof env.error === "string" ? env.error : "repo-map failed",
      };
    }
    return {
      ok: true,
      files: Array.isArray(env.files) ? (env.files as IdeRepoMapFile[]) : [],
      ...(typeof env.generatedAt === "string" ? { generatedAt: env.generatedAt } : {}),
      ...(typeof env.parser === "string" ? { parser: env.parser } : {}),
      ...(typeof env.symbolCount === "number" ? { symbolCount: env.symbolCount } : {}),
      ...(env.truncated === true ? { truncated: true } : {}),
    };
  });

  // ── linter fan-in (APP-062): detect + run ruff/flake8/mypy/pylint over the sidecar ──
  ipcMain.handle(IPC.ideLintDetect, async (_e, arg: unknown): Promise<IdeLintDetectResult> => {
    const a = (arg ?? {}) as { python?: unknown };
    const argv = ["detect"];
    if (typeof a.python === "string" && a.python) argv.push("--python", a.python);
    const env = await runSidecarScript("linters.py", argv, { timeoutMs: 30_000 });
    if (env.ok === false) {
      return { ok: false, error: typeof env.error === "string" ? env.error : "detect failed" };
    }
    const tools = env.tools && typeof env.tools === "object" ? Object.keys(env.tools) : [];
    return {
      ok: true,
      tools,
      ...(Array.isArray(env.missing) ? { missing: env.missing as string[] } : {}),
    };
  });

  ipcMain.handle(IPC.ideLintRun, async (_e, arg: unknown): Promise<IdeLintRunResult> => {
    const a = (arg ?? {}) as { paths?: unknown; python?: unknown; tools?: unknown };
    const rawPaths = Array.isArray(a.paths)
      ? a.paths.filter((p): p is string => typeof p === "string")
      : [];
    if (rawPaths.length === 0) return { ok: false, error: "no paths given" };
    // path-guard EVERY user path → an absolute fs path (never a leading-dash flag, never a
    // sensitive target); a bad path aborts the whole run fail-closed.
    let paths: string[];
    try {
      paths = rawPaths.map((p) => assertNotSensitivePath(p));
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
    // argv: flags FIRST, then `--`, then the guarded absolute paths (option-injection guard).
    const argv = ["run"];
    if (typeof a.python === "string" && a.python) argv.push("--python", a.python);
    if (Array.isArray(a.tools) && a.tools.length) {
      argv.push("--tools", a.tools.filter((t): t is string => typeof t === "string").join(","));
    }
    argv.push("--", ...paths);
    const env = await runSidecarScript("linters.py", argv, { timeoutMs: 120_000 });
    if (env.ok === false) {
      return { ok: false, error: typeof env.error === "string" ? env.error : "lint run failed" };
    }
    return {
      ok: true,
      diagnostics: Array.isArray(env.diagnostics) ? (env.diagnostics as IdeLintFinding[]) : [],
      ...(Array.isArray(env.ran) ? { ran: env.ran as string[] } : {}),
      ...(Array.isArray(env.skipped)
        ? { skipped: env.skipped as { tool: string; reason: string }[] }
        : {}),
    };
  });

  // ── Local History (APP-063): bind / list / read / revert ──────────────────
  ipcMain.handle(IPC.ideHistoryBind, async (_e, arg: unknown): Promise<IdeOkResult> => {
    if (!history) return { ok: false, error: "local history unavailable" };
    const a = (arg ?? {}) as { root?: unknown };
    if (typeof a.root !== "string" || !a.root) return { ok: false, error: "root is required" };
    try {
      await history.bind(a.root);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.ideHistoryList, async (_e, arg: unknown): Promise<IdeHistoryListResult> => {
    if (!history) return { ok: true, entries: [] };
    const a = (arg ?? {}) as { root?: unknown; uri?: unknown };
    if (typeof a.root !== "string" || typeof a.uri !== "string") {
      return { ok: false, error: "root + uri are required" };
    }
    try {
      const path = assertNotSensitivePath(a.uri);
      return { ok: true, entries: history.list(a.root, path) };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.ideHistoryRead, async (_e, arg: unknown): Promise<IdeHistoryReadResult> => {
    if (!history) return { ok: false, error: "local history unavailable" };
    const a = (arg ?? {}) as { root?: unknown; uri?: unknown; ts?: unknown };
    if (typeof a.root !== "string" || typeof a.uri !== "string" || typeof a.ts !== "number") {
      return { ok: false, error: "root + uri + ts are required" };
    }
    try {
      const path = assertNotSensitivePath(a.uri);
      const content = history.read(a.root, path, a.ts);
      if (content === undefined) return { ok: false, error: "revision not found" };
      return { ok: true, content };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.ideHistoryRevert, async (_e, arg: unknown): Promise<IdeOkResult> => {
    if (!history) return { ok: false, error: "local history unavailable" };
    const a = (arg ?? {}) as { root?: unknown; uri?: unknown; ts?: unknown };
    if (typeof a.root !== "string" || typeof a.uri !== "string" || typeof a.ts !== "number") {
      return { ok: false, error: "root + uri + ts are required" };
    }
    try {
      // Revert WRITES. `ide:history.list`/`read` above are reads and keep the denylist only,
      // but every other write path in this file goes through the working-set grant as well —
      // this one did not, so a renderer-supplied uri outside the granted roots was written.
      const path = assertInsideWorkingSet(assertNotSensitivePath(a.uri));
      const content = history.read(a.root, path, a.ts);
      if (content === undefined) return { ok: false, error: "revision not found" };
      // capture the CURRENT on-disk state first (so the revert is itself undoable), then write.
      try {
        const cur = await fsRead(path);
        history.capture(path, cur.text, "before revert");
      } catch {
        /* the file may not exist (recover-deleted) — nothing to snapshot */
      }
      await fsWrite(path, content);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  // ── disposer: remove handlers + detach host listeners ─────────────────────
  // Task #10: an audit found 25 of the ~108 `ipcMain.handle(...)` channels above were
  // NEVER added here (missing since their own PRs) — a SECOND registerIdeIpcHandlers()
  // (window reload/recreation) would throw "Attempted to register a second handler"
  // for any of them. This list is now exhaustive; see ide-ipc.test.ts's
  // register→dispose→register round-trip, which enumerates every channel so a future
  // handler added without a matching disposer entry fails that test, not a live reload.
  return () => {
    for (const channel of [
      IPC.ideFsRead,
      IPC.ideSteeringGlobal,
      IPC.ideSetWorkingSet,
      IPC.ideApproveOutside,
      IPC.ideFsWrite,
      IPC.ideFsTree,
      IPC.ideFsWatch,
      IPC.ideFsUnwatch,
      IPC.ideFsCreateFile,
      IPC.ideFsMkdir,
      IPC.ideFsRename,
      IPC.ideFsDelete,
      IPC.ideLspEnsure,
      IPC.ideLspList,
      IPC.ideLspApplyEditResult,
      IPC.ideLspRequest,
      IPC.ideLspSetInterpreter,
      IPC.ideDapLaunch,
      IPC.ideDapRequest,
      IPC.ideDapTerminate,
      IPC.ideDapDetectAdapter,
      IPC.ideDapInstallAdapter,
      IPC.ideRefactor,
      IPC.ideRunStart,
      IPC.ideRunKill,
      IPC.idePtySpawn,
      IPC.ideFloatingTerminalCreate,
      IPC.ideFloatingTerminalClose,
      IPC.ideGitStatus,
      IPC.ideGitDiff,
      IPC.ideGitStage,
      IPC.ideGitUnstage,
      IPC.ideGitCommit,
      IPC.ideGitBranch,
      IPC.ideGitBranches,
      IPC.ideGitStash,
      IPC.ideGitStashList,
      IPC.ideGitStashPop,
      IPC.ideGitStashApply,
      IPC.ideGitStashDrop,
      IPC.ideGitBlame,
      IPC.ideGitMergeAbort,
      IPC.ideGitCheckoutSide,
      IPC.ideGitCheckoutCommit,
      IPC.ideGitCherryPick,
      IPC.ideGitRevert,
      IPC.ideGitReset,
      IPC.ideGitConflictVersions,
      IPC.ideGitLog,
      IPC.ideGitPush,
      IPC.ideGitPull,
      IPC.ideGitFetch,
      IPC.ideGitRebaseTodo,
      IPC.ideGitRebaseRun,
      IPC.ideGitRebaseState,
      IPC.ideGitRebaseContinue,
      IPC.ideGitRebaseAbort,
      IPC.ideGitShow,
      IPC.ideGitApplyPatch,
      IPC.ideGitPrStatus,
      IPC.ideGitPrList,
      IPC.ideGitPrGet,
      IPC.ideGitPrComment,
      IPC.ideGitPrSetToken,
      IPC.ideWorktreeList,
      IPC.ideWorktreeCreate,
      IPC.ideWorktreeRemove,
      IPC.ideAgentFilesList,
      IPC.ideCommandFilesList,
      IPC.ideGate,
      IPC.ideExec,
      IPC.agentSystemTool,
      IPC.agentGrantsList,
      IPC.agentGrantsAdd,
      IPC.agentEngineTool,
      IPC.ideDetectBins,
      IPC.ideSearch,
      IPC.ideSearchCancel,
      IPC.ideWorkspaceIndex,
      IPC.ideStructSearch,
      IPC.ideTestDiscover,
      IPC.ideCoverageRun,
      IPC.ideCoverageImport,
      IPC.ideTestRun,
      IPC.ideSqlConnect,
      IPC.ideSqlQuery,
      IPC.ideSqlSchema,
      IPC.ideKernelStart,
      IPC.ideKernelExecute,
      IPC.ideKernelInterrupt,
      IPC.ideKernelRestart,
      IPC.ideKernelShutdown,
      IPC.ideKernelDataframe,
      IPC.ideProfileStart,
      IPC.ideProfileStop,
      IPC.ideProfileSnapshotSave,
      IPC.ideProfileSnapshotList,
      IPC.ideProfileCompare,
      IPC.ideTerminalMenu,
      IPC.ideTerminalResolve,
      IPC.ideRepoMap,
      IPC.ideLintDetect,
      IPC.ideLintRun,
      IPC.ideHistoryBind,
      IPC.ideHistoryList,
      IPC.ideHistoryRead,
      IPC.ideHistoryRevert,
      IPC.ideFsWalk,
      IPC.agentHookRun,
      IPC.agentCanaryTrip,
    ]) {
      ipcMain.removeHandler(channel);
    }
    // abort any in-flight profile run so a window close never leaves one dangling.
    profileAbort?.abort();
    // reap any live test-run children (window close must not orphan pytest).
    for (const kill of testKills) kill();
    testKills.clear();
    // reap every live kernel session (window close must not orphan an ipykernel).
    kernelHost.off("event", onKernelEvent as (...a: unknown[]) => void);
    kernelHost.disposeAll();
    for (const channel of [
      IPC.ideLspCancel,
      IPC.ideLspDidOpen,
      IPC.ideLspDidChange,
      IPC.ideLspDidClose,
      IPC.idePtyWrite,
      IPC.idePtyResize,
      IPC.idePtyKill,
    ]) {
      ipcMain.removeAllListeners(channel);
    }
    lsp.off("diagnostics", onLspDiag as (...a: unknown[]) => void);
    lsp.off("notify", onLspNotify as (...a: unknown[]) => void);
    lsp.off("state", onLspState as (...a: unknown[]) => void);
    lsp.off("stderr", onLspStderr as (...a: unknown[]) => void);
    lsp.off("applyEdit", onLspApplyEdit as (...a: unknown[]) => void);
    dap.off("event", onDapEvent as (...a: unknown[]) => void);
    dap.off("state", onDapState as (...a: unknown[]) => void);
    dap.off("stderr", onDapStderr as (...a: unknown[]) => void);
    dap.off("configApplied", onDapConfigApplied as (...a: unknown[]) => void);
    pty.off("data", onPtyData as (...a: unknown[]) => void);
    pty.off("exit", onPtyExit as (...a: unknown[]) => void);
    runHost?.off("data", onRunData as (...a: unknown[]) => void);
    runHost?.off("exit", onRunExit as (...a: unknown[]) => void);
    fsWatch.off("change", onFsChange as (...a: unknown[]) => void);
  };
}
