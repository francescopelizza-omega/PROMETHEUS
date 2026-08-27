/**
 * main/index.ts — the Electron MAIN process entry (Electron 33 / Node 20, C10).
 *
 * Responsibilities (and ONLY these — the renderer is a sandboxed view):
 *   - create the BrowserWindow with a HARDENED webPreferences (C5):
 *       contextIsolation:true · nodeIntegration:false · sandbox:true · preload + CSP.
 *   - own the FOUR-process model (file 01 §5): this MAIN process, the sandboxed
 *     RENDERER, the offloaded WORKER (WorkerHost → utilityProcess), and the
 *     supervised SIDECARS (SidecarSupervisor) + long-lived servers (ServerSupervisor).
 *   - register the typed ipcMain handlers (the only EngineClient lives there).
 *   - forward the live engine progress feed MAIN→renderer (cosmetic, C5).
 *   - tear everything down cleanly on quit.
 *
 * This is the ONLY place (with main/ipc.ts) allowed to import engine-bridge +
 * core. The renderer reaches the engine exclusively across the contextBridge
 * seam handled here.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserWindow,
  type UtilityProcess,
  app,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  shell,
  utilityProcess,
} from "electron";

import { ServerSupervisor, ai, type settings as coreSettings } from "@prometheus/core";
import {
  createEngineClient,
  gateFull as engineGateFull,
  safeChildEnv,
  safeFetch,
} from "@prometheus/engine-bridge";
import { type PrGateway, createPrGateway, createTokenSecretsStore } from "./pr-gateway.js";

import {
  IPC_EVENTS,
  type IdeEvent,
  type IdeTestEvent,
  type ModelProgressEvent,
} from "../shared/ipc-contract.js";
import { runTask } from "../worker/tasks.js";
import { setHookSettings } from "./agent-hooks.js";

/**
 * A native Yes/No dialog for one-time-per-workspace hook trust (`setHookSettings`'s `confirm`).
 * Attached to whichever window currently has focus — falls back to a parentless dialog if none
 * does (e.g. the confirm fires from a background settings republish), mirroring `folderOpen`'s
 * own `win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)` pattern.
 */
async function confirmHookTrust(prompt: string): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const opts = {
    type: "question" as const,
    title: "New project hooks",
    message: "This project wants to run new lifecycle hooks",
    detail: prompt,
    buttons: ["Trust and run", "Don't run"],
    defaultId: 1,
    cancelId: 1,
  };
  const res = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  return res.response === 0;
}
import {
  adoptSecurityPosture,
  freeLocalModels,
  registerAiIpc,
  setSecurityPosture,
} from "./ai-ipc.js";
import { destroyAgentBrowser } from "./browser-tool-host.js";
import { initBudgetGate, setBudgetSettings } from "./budget-gate.js";
import { registerBudgetIpcHandlers } from "./budget-ipc.js";
import { registerCatalogIpcHandlers } from "./catalog-ipc.js";
import { registerCodebaseOverviewIpcHandlers } from "./codebase-overview-ipc.js";
import { registerEnvIpcHandlers } from "./env-ipc.js";
import { registerExtIpcHandlers } from "./ext-ipc.js";
import { type RunWorkerTask, registerIdeIpcHandlers } from "./ide-ipc.js";
import {
  detectDapAdapter,
  installDapAdapter,
  makeRealGateTarget,
  realCmdRunner,
  realProbe,
} from "./ide/dap-adapter-install.js";
import { type DapChild, DapHost, type DapSocket } from "./ide/dap-host.js";
import { classifyNavigation, isOwnRendererUrl } from "./ide/drop-target.js";
import { FsWatchHost } from "./ide/fs-watch.js";
import { GitHost } from "./ide/git-host.js";
import { LocalHistoryManager } from "./ide/history-store.js";
import { type LspChild, LspHost } from "./ide/lsp-host.js";
import {
  approveOutsideWorkingSet,
  assertNotSensitivePath,
  getDeclaredRoots,
  getWorkingSetRoots,
  grantWorkingSetRoot,
  initGrantedRoots,
} from "./ide/path-guard.js";
import { type PtyBackend, PtyHost, nodePtyBackend } from "./ide/pty-host.js";
import { RunHost } from "./ide/run-host.js";
import type { TestRunSpawn } from "./ide/test-run-host.js";
import { registerIpcHandlers } from "./ipc.js";
import { registerMcpIpcHandlers } from "./mcp-ipc.js";
import { migrateMcpStore, sharedMcpStorePath } from "./mcp-store-path.js";
import { registerMetadataIpcHandlers } from "./metadata-ipc.js";
import { registerModelHealthIpcHandlers } from "./model-health-ipc.js";
import { migrateModelHealthStore, sharedModelHealthStorePath } from "./model-health-store-path.js";
import { registerModelIpcHandlers } from "./model-ipc.js";
import { registerPathCompletionIpcHandlers } from "./path-completion-ipc.js";
import { registerPersonaIpcHandlers } from "./persona-ipc.js";
import { registerRepoIpcHandlers } from "./repo-ipc.js";
import { repairPath } from "./resolve-path.js";
import { registerScheduleIpcHandlers } from "./schedule-ipc.js";
import { migrateScheduleStore, sharedScheduleStorePath } from "./schedule-store-path.js";
import { registerSecurityIpcHandlers } from "./security-ipc.js";
import { ServeSupervisor } from "./serve-supervisor.js";
import { registerSettingsIpcHandlers } from "./settings-ipc.js";
import { registerSettingsSyncIpcHandlers } from "./settings-sync-ipc.js";
import { SidecarSupervisor } from "./sidecar-supervisor.js";
import { registerSpectacularIpcHandlers } from "./spectacular-ipc.js";
import { registerTelemetryIpcHandlers } from "./telemetry-ipc.js";
import { registerUpdater } from "./updater.js";
import { type WorkerHandle, WorkerHost } from "./worker-host.js";
import { makeWorkerTaskSeam } from "./worker-task-seam.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A file under `studio/config/`, resolved RELATIVE to this module — packaged app first
 * (`Resources/config/`), else the dev tree (`out/main` → up 4 = `studio`).
 *
 * Never hard-code an absolute path here. These strings are compiled into `app.asar`, so a
 * developer's home directory becomes part of every published release — it identifies the
 * author and maps their filesystem, and it resolves on exactly one machine besides.
 */
function bundledConfig(file: string): string {
  const res = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (res) {
    const packaged = join(res, "config", file);
    if (existsSync(packaged)) return packaged;
  }
  return join(__dirname, "..", "..", "..", "..", "config", file);
}

// APP-PATH: repair PATH for GUI (Finder/Dock) launches BEFORE any engine/sidecar/
// detection spawn. A launchd-inherited PATH omits /opt/homebrew/bin, ~/.local/bin,
// etc., so the engine can't find git/claude/ollama/hf/brew → installs fail and host
// detection reports false-negatives. safeChildEnv forwards process.env.PATH to every
// child, so fixing it here fixes installs AND detection app-wide. Runs once, sync.
repairPath();

/** The Local History manager (APP-063), lazily created after `app` is ready (getPath). */
let localHistoryManager: LocalHistoryManager | null = null;
function getLocalHistory(): LocalHistoryManager {
  if (!localHistoryManager) {
    localHistoryManager = new LocalHistoryManager({
      dir: `${app.getPath("userData")}/local-history`,
    });
  }
  return localHistoryManager;
}

/** The single long-lived-server supervisor the main process owns (C8). */
const supervisor = new ServerSupervisor();

/**
 * The Model-Hub serve status-machine over the C8 supervisor (file 05 §8): it
 * drives `supervisor` to spawn a runner + polls {base_url}/models, flipping the
 * §2.4 status stopped→starting→ready/error. The MAIN process owns it; the runner
 * binary is absent in this env so a spawn never becomes ready — that is expected
 * (the status-machine is real, never faked-as-ready).
 */
const serveSupervisor = new ServeSupervisor({ supervisor });

/** The dual-mode (one-shot + long-lived) sidecar supervisor (file 01 §5). */
const sidecarSupervisor = new SidecarSupervisor();

/**
 * The offloaded WORKER host (file 01 §5). It spawns the worker as an Electron
 * utilityProcess; the worker entry (worker/index.js) speaks the TaskRequest/
 * TaskResponse protocol. The host is decoupled from Electron — we inject the
 * utilityProcess.fork as its spawn fn, so the SAME host is node:test-covered
 * with a child_process.fork in the test.
 */
const workerHost = new WorkerHost({
  spawn: (): WorkerHandle => {
    const child: UtilityProcess = utilityProcess.fork(join(__dirname, "worker.js"), [], {
      stdio: "inherit",
    });
    // Adapt utilityProcess's event surface to the host's WorkerHandle. The host
    // only ever calls on("message"|"exit"|"error"); utilityProcess emits
    // "message"(value) and "exit"(code) (no "error" — transport faults surface
    // as exit), so we route the two it has and ignore "error".
    const handle: WorkerHandle = {
      postMessage: (message: unknown) => child.postMessage(message),
      on: ((event: string, listener: (...a: unknown[]) => void) => {
        if (event === "message") child.on("message", (v: unknown) => listener(v));
        else if (event === "exit") child.on("exit", (code: number) => listener(code));
      }) as WorkerHandle["on"],
      kill: () => {
        child.kill();
      },
    };
    return handle;
  },
});

/**
 * APP-066: the seam ide-ipc uses to OFFLOAD workspace search + repo indexing to the
 * worker (with a graceful inline fallback on any worker failure). Built by the tested
 * factory so the fallback path is node:test-covered without a live utilityProcess.
 */
const runWorkerTask: RunWorkerTask = makeWorkerTaskSeam(workerHost, runTask, (kind, msg) =>
  console.warn(`[worker] task "${kind}" fell back to inline (main): ${msg}`),
);

/* ── the Code-Editor / IDE hosts (file 07 §1) — MAIN process owns every child ──
 * The renderer NEVER spawns a child (C5): these hosts own the LSP / DAP / PTY /
 * git children + the fs watcher, and the renderer drives them over the `ide:*` IPC
 * (ide-ipc.ts). The spawn fns are INJECTED so the hosts stay decoupled from the
 * actual binaries (pyright/debugpy/node-pty are absent in this env). A real spawn
 * that fails (missing binary) is handled by each host's supervision — it never
 * crashes the main process. git IS installed, so GitHost runs REAL git. */

/** Spawn a real LSP server child via node:child_process (the injected LspSpawn). */
function spawnLspChild(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> },
): LspChild {
  const child: ChildProcess = nodeSpawn(cmd, [...args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
  // ChildProcess's stdio is non-null with the "pipe" config above; adapt to LspChild.
  return child as unknown as LspChild;
}

/** The LSP server host (one server per languageId+workspaceRoot, §4). */
const lspHost = new LspHost({ spawn: spawnLspChild });

/** Spawn a real DAP adapter child via node:child_process (the injected DapSpawn). */
function spawnDapChild(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> },
): DapChild {
  const child: ChildProcess = nodeSpawn(cmd, [...args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
  return child as unknown as DapChild;
}

/** Dial a remote/attach DAP target over TCP (the injected DapConnect, APP-080). The
 *  host gates loopback-vs-remote + waits on the socket's `'connect'` event; this only
 *  opens the connecting socket. `node:net`'s Socket is a superset of `DapSocket`. */
function connectDapSocket(host: string, port: number): DapSocket {
  return netConnect({ host, port }) as unknown as DapSocket;
}

/** The DAP debug-adapter host (one adapter per session, §5). Detect/install (APP-029)
 *  are wired to the REAL probe/stage/gate/install pipeline — no chosen distribution
 *  yet for js-debug/codelldb (§5.3), so install stays python/debugpy-only there too. */
const dapHost = new DapHost({
  spawn: spawnDapChild,
  connect: connectDapSocket,
  detector: (type, pythonPath) => detectDapAdapter(type, pythonPath, realProbe),
  installer: (type, opts) => installDapAdapter(type, opts, realCmdRunner, makeRealGateTarget()),
});

/**
 * The node-pty terminal backend (§6.1). node-pty is a native addon + an `external`
 * in the build; it is absent in this env, so the backend is lazy — a spawn only
 * fails when actually attempted without the addon. The MAIN process owns the PTYs.
 */
const ptyBackend: PtyBackend = nodePtyBackend();
const ptyHost = new PtyHost({ backend: ptyBackend });
// named run sessions (APP-032) — same backend seam; gate+guard live in ide-ipc.
const runHost = new RunHost({ backend: ptyBackend });

/** The RAW-git panel backend (§6.2) — runs the REAL `git` binary (installed). */
const gitHost = new GitHost();

/** APP-085: the gated PR-review gateway — lazily built after app-ready (safeStorage
 *  needs it). Token persists to userData encrypted via the OS keychain; every network
 *  call runs through the L6 safeFetch proxy inside the engine-bridge provider client. */
let prGatewaySingleton: PrGateway | undefined;
function ensurePrGateway(): PrGateway {
  if (!prGatewaySingleton) {
    const tokenSecrets = createTokenSecretsStore(
      {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: (plain) => safeStorage.encryptString(plain).toString("base64"),
        decryptString: (encoded) => safeStorage.decryptString(Buffer.from(encoded, "base64")),
      },
      `${app.getPath("userData")}/pr-tokens.json`,
    );
    prGatewaySingleton = createPrGateway({ git: gitHost, secrets: tokenSecrets, fetch: safeFetch });
  }
  return prGatewaySingleton;
}

/** The debounced recursive fs watcher + fs read/write/tree (§6 / §3.2). */
const fsWatchHost = new FsWatchHost();

/** Removes the registered ipcMain handlers; set after registration. */
let disposeIpc: (() => void) | null = null;

/** Removes the registered `security:*` ipcMain handlers (file 03 §5,§7). */
let disposeSecurityIpc: (() => void) | null = null;

/** Removes the registered `env:* / pkg:* / cuda:*` ipcMain handlers (file 04 §1,§3). */
let disposeEnvIpc: (() => void) | null = null;

/** Removes the registered `model:*` ipcMain handlers (file 05 §1,§7,§8). */
let disposeModelIpc: (() => void) | null = null;

/** Removes the registered `catalog:*` ipcMain handlers (file 06 §4). */
let disposeCatalogIpc: (() => void) | null = null;

/** Removes the registered `repo:*` ipcMain handlers (file 06 §3, FEATURE #5a). */
let disposeRepoIpc: (() => void) | null = null;

/** Removes the registered `metadata:*` + `file:open` ipcMain handlers (file 0C). */
let disposeMetadataIpc: (() => void) | null = null;
let disposeSpectacularIpc: (() => void) | null = null;

/** Removes the registered `ide:*` ipcMain handlers + host listeners (file 07 §3.2). */
let disposeIdeIpc: (() => void) | null = null;
let disposeMcpIpc: (() => void) | null = null;
let disposeSettingsSyncIpc: (() => void) | null = null;
let disposeSettingsIpc: (() => void) | null = null;
/** Removes the registered `pathCompletion:*` ipcMain handlers (the "@"-path feature). */
let disposePathCompletionIpc: (() => void) | null = null;
/** Removes the registered `modelHealth:*` ipcMain handlers. */
let disposeModelHealthIpc: (() => void) | null = null;
/** Removes the registered `schedule:*` ipcMain handlers. */
let disposeScheduleIpc: (() => void) | null = null;
/** Removes the registered `persona:*` ipcMain handlers. */
let disposePersonaIpc: (() => void) | null = null;
/** Removes the registered `budget:status` ipcMain handler. */
let disposeBudgetIpc: (() => void) | null = null;
/** Removes the registered `codebase:overview` ipcMain handler. */
let disposeCodebaseOverviewIpc: (() => void) | null = null;
let disposeExtIpc: (() => void) | null = null;
/** Removes the registered `system:telemetry` ipcMain handler (resource telemetry + guard). */
let disposeTelemetryIpc: (() => void) | null = null;

/**
 * Push a Model-Hub progress / serve-status event to EVERY live renderer window
 * (the §2.4 live serve feed + download staging lines). Injected into the model
 * IPC so that module stays window-agnostic (C5: cosmetic only — no verdict).
 */
function broadcastModel(event: ModelProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC_EVENTS.modelProgress, event);
    } catch {
      /* a closing window is fine — drop the cosmetic event. */
    }
  }
}

/**
 * Push an IDE host event (LSP diagnostics, DAP events, PTY output, fs changes) to
 * EVERY live renderer window. Injected into the IDE IPC so that module stays
 * window-agnostic (C5: cosmetic/data only — NO verdict crosses; the run-gate
 * verdict rides back in the `ide:gate` typed result).
 */
function broadcastIde(event: IdeEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC_EVENTS.ideEvent, event);
    } catch {
      /* a closing window is fine — drop the cosmetic event. */
    }
  }
}

/**
 * Push one live per-test result (ide:test.event, APP-013) to EVERY live renderer
 * window — the Test Explorer paints the run as it streams. Cosmetic/data only (C5);
 * the terminal summary rides back in the `ide:test.run` typed result.
 */
function broadcastTestEvent(event: IdeTestEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC_EVENTS.ideTestEvent, event);
    } catch {
      /* a closing window is fine — drop the cosmetic event. */
    }
  }
}

/**
 * The injected STREAMING spawn for testmgr `run`/`rerun-failed` (APP-013): argv
 * verbatim, NO shell, safe child env — the same spawn discipline as the
 * engine-bridge sidecar runner, but line-streamed by the test-run host.
 */
const testRunSpawn: TestRunSpawn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, {
    cwd: opts.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    // APP-040: PYTHONUNBUFFERED forces pytest/python to flush per line into the pipe
    // (belt-and-suspenders with testmgr's `-u`), so statuses stream live, not at exit.
    env: { ...safeChildEnv(), PYTHONUNBUFFERED: "1" },
  });

/** serve-profiles.json location (next to the bundled config). */
const SERVE_PROFILES_PATH =
  process.env.PROMETHEUS_SERVE_PROFILES ?? bundledConfig("serve-profiles.json");

/** Vite dev server URL injected by electron-vite in dev; absent in production. */
const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL;

// ── App identity (so the running app is "Prometheus Studio", not "Electron") ──
// Without this, an `electron-vite dev` run shows "Electron" in the macOS menu bar /
// dock / About panel and groups under the generic Electron id on Windows. Set as
// early as possible (before whenReady) so the menu/dock pick it up. The PACKAGED
// build also reads productName from electron-builder, but setting it here keeps dev
// and prod identical and brands the dev run too.
app.setName("Prometheus Studio");
// Windows taskbar grouping + notification identity — must match electron-builder appId.
app.setAppUserModelId("ai.prometheus.studio");

/**
 * The branded app icon (HANDOFF_2 §8): the pixel-art human Prometheus, build/icon.png.
 * This IS the final artwork — regenerate the platform set with
 * `node scripts/build-app-icon.mjs`, never hand-edit build/icon.*.
 * electron-builder derives the packaged formats from build/ (buildResources).
 *
 * A PACKAGED macOS app uses the bundle's .icns and ignores a window/dock icon; but
 * in DEV (and for Win/Linux window chrome) we load this PNG so the dock / taskbar /
 * window show the flame instead of the generic Electron icon. `__dirname` is
 * apps/desktop/out/main in dev, so the source build/ dir is two levels up. The PNG
 * is NOT packed into the asar (electron-builder `files` only takes out/** ), so in
 * prod the image is empty → we simply skip it and the OS uses the real bundle icon.
 */
const APP_ICON_PATH = join(__dirname, "../../build/icon.png");
const appIcon = nativeImage.createFromPath(APP_ICON_PATH);

/**
 * Hand a renderer-supplied URL to the OS browser ONLY for web/mail schemes. Without
 * this allowlist a compromised renderer (or a malicious link in rendered catalog/skill
 * content) could `window.open("file:///…")` / `smb://` / a custom `vscode://`-style URI
 * and have the main process ask the OS to launch the external handler — defeating the
 * sandbox. Anything else (incl. unparseable URLs) is dropped.
 */
function openExternalSafe(url: string): void {
  try {
    const proto = new URL(url).protocol;
    if (proto === "https:" || proto === "http:" || proto === "mailto:") {
      void shell.openExternal(url);
    }
  } catch {
    /* unparseable URL — drop it */
  }
}

/**
 * The HARDENED renderer webPreferences (C5) — these five flags are non-negotiable and
 * MUST be byte-identical across EVERY window (main + the APP-090 tear-out float): a copy
 * that drops one flag is the classic secondary-window privilege-escalation hole. So the
 * float and the main window both derive their prefs here.
 */
function hardenedWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(__dirname, "../preload/index.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // defence in depth: no remote module, no insecure content.
    webSecurity: true,
    allowRunningInsecureContent: false,
  };
}

// CSP (defence in depth). PRODUCTION locks the renderer to its own origin + inline styles
// only (Vite injects styles); no remote script/connect — the renderer talks to the engine
// ONLY across the contextBridge (C5). DEV (loaded from the Vite dev server) MUST additionally
// allow Vite's inline @react-refresh preamble + HMR websocket: under the strict
// `script-src 'self'` the inline preamble is CSP-refused, `@vitejs/plugin-react` throws
// "can't detect preamble", and React never mounts → a BLACK window. Gated on RENDERER_DEV_URL,
// so the SHIPPED app keeps the strict policy unchanged. Shared by main + float (APP-090).
const PROD_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'";
const DEV_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' ws: wss: http://localhost:*; " +
  // Monaco's TS/JSON/CSS/editor web workers (file 07 §12) load from blob: URLs.
  "worker-src 'self' blob:; " +
  "object-src 'none'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'";

/**
 * Apply the shared window hardening to ANY window (main + float, APP-090): the response-header
 * CSP, the deny-all `setWindowOpenHandler` (external links go to the OS browser, scheme-gated),
 * and the will-navigate lock (no drive-by navigation off our own renderer).
 */
/** Where the packaged renderer's own page lives — the one `file://` that is NOT a drop. */
function rendererEntryPath(): string {
  return join(__dirname, "../renderer/index.html");
}

function applyWindowHardening(win: BrowserWindow): void {
  const csp = RENDERER_DEV_URL ? DEV_CSP : PROD_CSP;
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] },
    });
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const isDev = !!RENDERER_DEV_URL && url.startsWith(RENDERER_DEV_URL);
    if (isDev || isOwnRendererUrl(url, rendererEntryPath())) return;
    /**
     * ANY other `file://` navigation is a DROP (or a drive-by), never in-app routing.
     *
     * The old test was `url.startsWith("file://")`, which allowed every local file — and in a
     * packaged build the renderer itself is a `file://` URL, so the check could not tell the app's
     * own page from a file the user had just dragged onto the window. Dropping anything therefore
     * NAVIGATED THE APP AWAY to that file: the whole UI, and the session with it, replaced by the
     * dropped document.
     *
     * Preventing it is the fix for that. Treating it as a drop is the feature: this event is
     * Chromium's own report of an OS-level drag-and-drop, so the path is one MAIN observed rather
     * than one the renderer asked for — the only kind that can honestly earn a grant.
     */
    event.preventDefault();
    const decision = classifyNavigation(url, rendererEntryPath(), statSync);
    if (decision.kind === "folder") {
      // The drag-and-drop equivalent of File ▸ Open Folder — same gesture, same grant.
      grantWorkingSetRoot(decision.path);
      broadcastIde({ channel: "shell.dropped", path: decision.path, kind: "folder" });
      return;
    }
    if (decision.kind === "file") {
      // A dropped credential is still a credential: the guard decides, not the gesture.
      try {
        assertNotSensitivePath(decision.path);
      } catch {
        return;
      }
      approveOutsideWorkingSet(decision.path);
      broadcastIde({ channel: "shell.dropped", path: decision.path, kind: "file" });
    }
  });
}

/** A positive integer from the environment, or `fallback`. Used only by the e2e pins. */
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function createMainWindow(): BrowserWindow {
  // e2e pins the window so screenshots are comparable run-to-run (e2e/electron-app.ts sets
  // PROM_E2E_WIDTH/HEIGHT). Outside e2e these resolve to the shipped defaults.
  const win = new BrowserWindow({
    width: envInt("PROM_E2E_WIDTH", 1280),
    height: envInt("PROM_E2E_HEIGHT", 820),
    // handoff §2: the island shell needs room — a 46px rail + a 330px chat rail + a
    // usable centre column stop being usable below this.
    minWidth: 1100,
    minHeight: 680,
    show: false,
    // the §1 navy ground — this is what paints during the pre-first-paint frame, so it
    // must match --bg-app or the window flashes the old near-black.
    backgroundColor: "#070d18",
    title: "Prometheus Studio",
    // handoff §2.1: the renderer draws its own 42px TopBar, and the macOS traffic lights
    // sit INSIDE it. `hiddenInset` keeps the native buttons (and their OS behaviour) while
    // handing the whole client area to us; the y centres the 12px buttons in the 42px bar.
    // Windows/Linux keep the native frame — there are no OS-drawn controls to inset there,
    // and drawing our own would mean re-implementing minimise/maximise/close.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 13, y: 15 },
        }
      : {}),
    // Win/Linux window + taskbar icon (macOS ignores this and uses the bundle icon).
    // Skipped when the image is empty (packaged build — the OS uses the real icon).
    ...(appIcon.isEmpty() ? {} : { icon: appIcon }),
    webPreferences: hardenedWebPreferences(),
  });

  applyWindowHardening(win);

  // Stream the live engine progress feed to THIS window (cosmetic only, C5).
  const onProgress = (_id: string, stream: "stdout" | "stderr", line: string): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(IPC_EVENTS.progress, {
      phase: stream === "stderr" ? "info" : "info",
      message: line,
      raw: line,
    });
  };
  sidecarSupervisor.on("log", onProgress);
  win.once("closed", () => sidecarSupervisor.off("log", onProgress));

  win.once("ready-to-show", () => win.show());

  if (RENDERER_DEV_URL) {
    void win.loadURL(RENDERER_DEV_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

/* ── APP-090: tear-out terminal windows ────────────────────────────────────────
 * A registry of live floats keyed by the ptyId each hosts. Tearing out opens (or focuses)
 * a hardened secondary window with the SAME webPreferences/CSP as the main window (never
 * `window.open`); re-dock / window-close emits `floatingTerminal.returned` so the main
 * window re-shows the session tab. The PTY (owned by the main window) is NEVER killed here —
 * it outlives its hosting window; only an explicit session close kills it. */
const floatingTerminals = new Map<string, BrowserWindow>();

function createFloatingTerminalWindow(req: {
  ptyId: string;
  title: string;
  scheme?: string;
}): void {
  // duplicate tear-out for a live ptyId focuses the existing float (never a second window
  // that would double-attach the same stream).
  const existing = floatingTerminals.get(req.ptyId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 720,
    height: 480,
    minWidth: 320,
    minHeight: 200,
    show: false,
    // the §1 navy ground — matches --bg-app, so a torn-out terminal does not flash the
    // pre-redesign near-black before its renderer paints.
    backgroundColor: "#070d18",
    title: req.title,
    ...(appIcon.isEmpty() ? {} : { icon: appIcon }),
    webPreferences: hardenedWebPreferences(),
  });
  applyWindowHardening(win);
  floatingTerminals.set(req.ptyId, win);

  win.once("ready-to-show", () => win.show());

  // pass ptyId/title/scheme via the URL query (never a shared global — two floats collide);
  // Electron URL-encodes the query. DEV loads the page off the Vite dev server; PROD the file.
  const query: Record<string, string> = { ptyId: req.ptyId, title: req.title };
  if (req.scheme) query.scheme = req.scheme;
  if (RENDERER_DEV_URL) {
    const qs = new URLSearchParams(query).toString();
    void win.loadURL(`${RENDERER_DEV_URL}/floating-terminal.html?${qs}`);
  } else {
    void win.loadFile(join(__dirname, "../renderer/floating-terminal.html"), { query });
  }

  // window closed (re-dock button → close(), OS close, or app quit): drop the registry
  // entry and tell the main window the session RETURNED so it re-shows the tab. Idempotent —
  // both the user-close and the close() paths funnel through this single `closed` handler.
  win.once("closed", () => {
    floatingTerminals.delete(req.ptyId);
    broadcastIde({ channel: "floatingTerminal.returned", ptyId: req.ptyId });
  });
}

/** Re-dock: close the float for `ptyId` (its `closed` handler emits the returned event). */
function closeFloatingTerminal(ptyId: string): void {
  const win = floatingTerminals.get(ptyId);
  if (win && !win.isDestroyed()) win.close();
}

/** Close every live float (app quit) so none orphan. */
function closeAllFloatingTerminals(): void {
  for (const win of floatingTerminals.values()) {
    if (!win.isDestroyed()) win.destroy();
  }
  floatingTerminals.clear();
}

/** The ide-ipc controller seam (injected into registerIdeIpcHandlers). */
const floatingTerminalController = {
  create: createFloatingTerminalWindow,
  close: closeFloatingTerminal,
};

/**
 * HEADLESS SMOKE entry (PROM_SMOKE=1): boot the MAIN process WITHOUT a visible
 * window, drive the scan handler through the engine seam, assert we got a
 * scan envelope, log SMOKE_OK, and quit(0). Lets CI boot-test the whole 4-process
 * wiring (engine-bridge + core + sidecar/worker hosts) without a display.
 */
/**
 * The workspace folder that is OPEN, for read-only features.
 *
 * "Which folder is open" and "which roots may be written to" are different questions.
 * `getWorkingSetRoots()` answers the second: it is the approved WRITE scope, and it is empty
 * whenever the open folder was never granted (opened from recents, drag-drop, a worktree
 * switch). Keying read-only features to it made "Meet your codebase" answer
 * "no workspace folder is open" with a folder plainly open on screen, and made persona discovery
 * silently find nothing. Reproduced through the real `codebase:overview` handler.
 *
 * Prefers the granted root when there is one (identical behaviour to before in the ordinary
 * picker case), and falls back to what the renderer declared. No write guard consults this.
 */
function openFolderRoot(): string | undefined {
  return getWorkingSetRoots()[0] ?? getDeclaredRoots()[0];
}

async function runHeadlessSmoke(): Promise<void> {
  disposeIpc = registerIpcHandlers({
    supervisor,
    sidecarSupervisor,
    providersConfigPath: bundledConfig("providers.config.json"),
    serveProfilesPath: SERVE_PROFILES_PATH,
  });
  // The FULL security surface (file 03 §5,§7) — its own handler set + disposer.
  //
  // The posture is adopted BEFORE the AI handlers exist, and awaited. `registerSettingsIpcHandlers`
  // also publishes it, but it registers later and publishes asynchronously — which would leave a
  // window, however brief, in which a model call could be served under the permissive default
  // while a locked-down profile sat on disk. A security control with a startup race is a
  // security control with a bypass.
  await adoptSecurityPosture(`${app.getPath("userData")}/settings.json`);
  /**
   * The SPEND CAP, armed for the same reason and in the same place as the posture.
   *
   * It must exist before `registerAiIpc` can serve a model call, or the first turn of a
   * session runs uncapped — the same startup race the comment above describes, with money
   * instead of egress. `initBudgetGate` only arms the gate; an unconfigured cap still costs
   * nothing (it never reads the accounting store).
   */
  initBudgetGate(app.getPath("userData"), ai.loadPricing());
  /**
   * The agent's write-scope ceiling, loaded before any IPC handler can serve a write.
   *
   * The grants are the directories a human picked in MAIN's own folder dialog. They persist
   * because the choice does: the recents list lives in the RENDERER's localStorage, so
   * reopening a project never touches the native picker, and without the persisted grants the
   * scope guard would fall back to "nothing granted" on the path almost every user takes.
   */
  initGrantedRoots(app.getPath("userData"));
  registerAiIpc(ipcMain);
  disposeSecurityIpc = registerSecurityIpcHandlers();
  // The Package & Environment Manager surface (file 04 §1,§3) — its own handler set.
  disposeEnvIpc = registerEnvIpcHandlers();
  // The Model Hub surface (file 05 §1,§7,§8) — discover/fit/download/serve(C8).
  disposeModelIpc = registerModelIpcHandlers({ serveSupervisor, broadcast: broadcastModel });
  // The Catalog manager surface (file 06 §4) — plugins/skills/apps/worldsim/models.
  disposeCatalogIpc = registerCatalogIpcHandlers();
  // The GitHub Repo Manager surface (file 06 §3, FEATURE #5a) — staged + gated clones.
  disposeRepoIpc = registerRepoIpcHandlers();
  // The file-metadata control surface (file 0C — privacy protection) — inspect/scrub/
  // edit/timestomp via the metadata.py sidecar + the native file picker.
  disposeMetadataIpc = registerMetadataIpcHandlers();
  // Whole-machine resource telemetry (CPU/GPU/NPU/RAM/DISK) + the launch guard —
  // the renderer polls `system:telemetry` for the bottom-bar strip + System panel.
  disposeTelemetryIpc = registerTelemetryIpcHandlers();
  // SPECTACULAR power-up: catalog cards (describe/tutorial/methods) + chat
  // (agentic-local reply + terminal preview) + models folder + harden self-audit.
  disposeSpectacularIpc = registerSpectacularIpcHandlers();
  // The Code-Editor / IDE surface (file 07 §3.2/§4/§5/§6/§9) — LSP/DAP/PTY/git/fs
  // hosts + the REAL engine-bridge run-gate. The renderer drives them over IPC (C5).
  disposeIdeIpc = registerIdeIpcHandlers({
    lsp: lspHost,
    dap: dapHost,
    pty: ptyHost,
    git: gitHost,
    fsWatch: fsWatchHost,
    localHistory: getLocalHistory(),
    runHost,
    broadcast: broadcastIde,
    testSpawn: testRunSpawn,
    broadcastTest: broadcastTestEvent,
    runWorkerTask,
    prGateway: ensurePrGateway(),
    profileSnapshotDir: `${app.getPath("userData")}/profile-snapshots`,
    floatingTerminal: floatingTerminalController,
  });
  // "@"-path fuzzy completion (shared logic with the CLI) — list one directory + rank it,
  // and the opt-in per-workspace frecency memory ("Tools ▸ Path Completion" setting).
  disposePathCompletionIpc = registerPathCompletionIpcHandlers();
  // Model health (per-endpoint transport/breaker/context-window state) — one global file,
  // never workspace-scoped, SHARED with the CLI's own store (model-health-store-path.ts's
  // header: these used to be two different, never-synced files).
  const adoptedModelHealth = migrateModelHealthStore(app.getPath("userData"));
  if (adoptedModelHealth > 0) {
    console.info(
      `[model-health] adopted ${adoptedModelHealth} endpoint record(s) from the old app-private store into ${sharedModelHealthStorePath()}`,
    );
  }
  disposeModelHealthIpc = registerModelHealthIpcHandlers(sharedModelHealthStorePath());
  // Scheduled/autonomous runs (cron-triggered agent turns) — one global file, never
  // workspace-scoped, SHARED with the CLI's own store: schedule-runner.ts (the only code that
  // ever executes a due task, via `prometheus tasks run-due`) reads this exact path, so a task
  // created here is now something the CLI's installed cron entry can actually run
  // (schedule-store-path.ts's header: a GUI-only task used to persist to a file nothing ever
  // read for execution, and could never run at all).
  const adoptedSchedules = migrateScheduleStore(app.getPath("userData"));
  if (adoptedSchedules > 0) {
    console.info(
      `[schedule] adopted ${adoptedSchedules} task(s) from the old app-private store into ${sharedScheduleStorePath()}`,
    );
  }
  disposeScheduleIpc = registerScheduleIpcHandlers(sharedScheduleStorePath());
  // Persona sharing (export/import of sub-agent persona files) — the SHARED ~/.prometheus/agents
  // catalog the CLI also reads (never an Electron userData-private file, unlike the two stores
  // above): project-scope discovery needs to know the CURRENTLY OPEN workspace root, which can
  // change across the app's lifetime, so this is a getter re-read fresh on every request.
  // The OPEN folder, not the write-grant list — see `getDeclaredRoots`. Persona discovery is
  // read-only, and keying it to the grants made it silently empty in any project opened by a
  // route that records no grant.
  disposePersonaIpc = registerPersonaIpcHandlers(() => openFolderRoot());
  // Budget & spend visibility (roadmap point 4) — read-only; setting a cap reuses settings:set.
  disposeBudgetIpc = registerBudgetIpcHandlers();
  // "Meet your codebase" (roadmap point 6) — on-demand only, never runs until the renderer asks.
  disposeCodebaseOverviewIpc = registerCodebaseOverviewIpcHandlers(() => openFolderRoot());
  /**
   * MCP connectors (file 09 §2), in the file the CLI also reads.
   *
   * These used to point at `<userData>/mcp-servers.json` — same format as the CLI's store, a
   * different file. A connector added with `prometheus mcp add` never appeared in Studio, and
   * one added in Studio never appeared in a terminal session; both sides reported success and
   * listed a different set. `migrateMcpStore` folds any desktop-only entries into the shared
   * file once, and says how many it adopted rather than doing it silently.
   */
  const adoptedMcp = migrateMcpStore(app.getPath("userData"));
  if (adoptedMcp > 0) {
    console.info(
      `[mcp] adopted ${adoptedMcp} connector(s) from the old app-private store into ${sharedMcpStorePath()}`,
    );
  }
  disposeMcpIpc = registerMcpIpcHandlers({ storePath: sharedMcpStorePath() });
  // APP-095: git-backed settings sync (reads the SAME mcp store, redacts secrets).
  disposeSettingsSyncIpc = registerSettingsSyncIpcHandlers({
    mcpStorePath: sharedMcpStorePath(),
  });
  // Keyed/layered settings tree (file 13 §2.1) — global layer persists to userData;
  // the workspace layer (if any) is resolved per-call from the renderer's workspaceRoot.
  disposeSettingsIpc = registerSettingsIpcHandlers({
    globalPath: `${app.getPath("userData")}/settings.json`,
    // The four security settings become ENFORCED here. Without this the profile a user picks
    // ("Local-only", "Security-strict") is a label: `cloudModelsEnabled` and `defaultNetwork`
    // had no consumer anywhere, so selecting a locked-down profile changed nothing at all.
    onEffective: (effective, raw) => {
      setSecurityPosture(effective);
      // The budget windows ride the SAME publish as the posture, so editing a cap in settings
      // takes effect on the next turn rather than on the next app launch.
      setBudgetSettings(effective);
      // …and the user's lifecycle hooks, so editing one takes effect on the next turn. The RAW
      // layers go in (never `effective`, which has already been through the array-replace
      // merge) so a workspace-supplied hook is narrowed/scanned/confirmed exactly like the CLI.
      void setHookSettings(raw.global as coreSettings.Settings, raw.workspace, {
        ...(raw.workspaceRoot ? { cwd: raw.workspaceRoot } : {}),
        confirm: confirmHookTrust,
        onRefusal: (r) => {
          console.warn(`[hooks] refused (${r.event}): ${r.command} — ${r.reason}`);
        },
      });
    },
  });

  let code = 0;
  try {
    // Drive the one-shot engine path directly (the same client ipc.ts uses).
    const env = await sidecarSupervisor.oneShot.scan();
    if (!env || typeof env.command !== "string") {
      throw new Error("scan did not return an engine envelope");
    }
    const ver = await sidecarSupervisor.engineVersion().catch(() => ({ ok: false }));
    // eslint-disable-next-line no-console
    console.log(
      `SMOKE_OK command=${env.command} ok=${env.ok} version=${"version" in ver ? ver.version : "?"}`,
    );
  } catch (e) {
    code = 1;
    // eslint-disable-next-line no-console
    console.error(`SMOKE_FAIL ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    disposeIpc?.();
    disposeIpc = null;
    disposeSecurityIpc?.();
    disposeSecurityIpc = null;
    disposeEnvIpc?.();
    disposeEnvIpc = null;
    disposeModelIpc?.();
    disposeModelIpc = null;
    disposeCatalogIpc?.();
    disposeCatalogIpc = null;
    disposeRepoIpc?.();
    disposeRepoIpc = null;
    disposeMetadataIpc?.();
    disposeMetadataIpc = null;
    disposeSpectacularIpc?.();
    disposeSpectacularIpc = null;
    disposeIdeIpc?.();
    disposeIdeIpc = null;
    disposeMcpIpc?.();
    disposeMcpIpc = null;
    disposeSettingsSyncIpc?.();
    disposeSettingsSyncIpc = null;
    disposeSettingsIpc?.();
    disposeSettingsIpc = null;
    disposePathCompletionIpc?.();
    disposePathCompletionIpc = null;
    disposeModelHealthIpc?.();
    disposeModelHealthIpc = null;
    disposeScheduleIpc?.();
    disposeScheduleIpc = null;
    disposePersonaIpc?.();
    disposePersonaIpc = null;
    disposeBudgetIpc?.();
    disposeBudgetIpc = null;
    disposeCodebaseOverviewIpc?.();
    disposeCodebaseOverviewIpc = null;
    disposeExtIpc?.();
    disposeExtIpc = null;
    disposeTelemetryIpc?.();
    disposeTelemetryIpc = null;
    lspHost.dispose();
    await dapHost.dispose().catch(() => {});
    ptyHost.dispose();
    runHost.dispose();
    fsWatchHost.dispose();
    workerHost.dispose();
    await sidecarSupervisor.dispose().catch(() => {});
    await serveSupervisor.stopAll().catch(() => {});
    await supervisor.stopAll().catch(() => {});
    app.exit(code);
  }
}

// Process-level safety net: a stray async rejection or thrown error in a
// supervisor / host must NOT silently kill the main process (which would leave a
// dead window with no live IPC). Log and stay alive; the renderer's per-call
// fail-closed handling surfaces anything user-facing.
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException (kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection (kept alive):", reason);
});

// Single-instance: a second launch must not spawn a duplicate main that fights
// over the same sidecars / PTYs / serve ports. Hand focus to the running window.
const gotSingleInstanceLock = process.env.PROM_SMOKE === "1" || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      createMainWindow();
    }
  });

  // macOS dock re-open — registered at top level so it survives even if the
  // whenReady startup below throws.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  // A throw during startup (handler registration / host construction) must surface
  // a visible error and exit cleanly — NOT a silent blank/zombie window.
  bootstrap().catch((err) => {
    console.error("[main] startup failed:", err);
    try {
      dialog.showErrorBox(
        "Prometheus failed to start",
        err instanceof Error ? `${err.message}\n\n${err.stack ?? ""}` : String(err),
      );
    } catch {
      /* dialog itself may be unavailable pre-ready — the console log remains */
    }
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  if (process.env.PROM_SMOKE === "1") {
    await runHeadlessSmoke();
    return;
  }

  // macOS DEV dock icon: a packaged .app already shows the bundle .icns, but an
  // `electron-vite dev` run shows the generic Electron diamond. Set it from the
  // branded PNG when present (empty in a packaged build → left to the bundle icon).
  if (process.platform === "darwin" && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }

  // Register the engine/IPC seam BEFORE the window so the renderer's on-mount
  // calls (scan/providers) always find a live handler.
  disposeIpc = registerIpcHandlers({
    supervisor,
    sidecarSupervisor,
    providersConfigPath: bundledConfig("providers.config.json"),
    serveProfilesPath: SERVE_PROFILES_PATH,
  });
  /**
   * The SPEND CAP, armed BEFORE `registerAiIpc` for the same reason `runHeadlessSmoke` arms it
   * first: an unconfigured cap still costs nothing (it never reads the accounting store), but
   * `registerAiIpc` calling `getBudgetGate()` before this ever ran would serve the whole
   * session uncapped rather than merely defaulted-open.
   */
  initBudgetGate(app.getPath("userData"), ai.loadPricing());
  /**
   * The agent's write-scope ceiling, in the WINDOWED boot path as well as the headless one.
   *
   * Deliberately duplicated rather than hoisted: this file already carries a comment about a
   * handler that existed in `runHeadlessSmoke` and never made it here, so a packaged app could
   * not complete a turn. The same shape of mistake here would leave the scope guard unarmed
   * for every real user while every test that boots headless passed.
   */
  initGrantedRoots(app.getPath("userData"));
  /**
   * `ai:stream` / `ai:cancel` (file 07 §7/§9c) — the desktop's model-streaming transport.
   *
   * REAL BUG (found live, by an e2e chat-turn test that actually clicked Send in the built
   * app rather than calling `runAiStream` directly the way the unit tests do): this call was
   * present in `runHeadlessSmoke` but never made it into the normal windowed boot path, so
   * a packaged app's AI pane could not complete a single turn — every send failed immediately
   * with "No handler registered for 'ai:stream'". Registered here, before the window, for the
   * same reason every other handler above is: the renderer's on-mount calls must always find
   * a live handler.
   */
  registerAiIpc(ipcMain);
  // The FULL security surface (file 03 §5,§7) — registered alongside the main
  // ipc so the renderer's security panels find a live handler from boot.
  disposeSecurityIpc = registerSecurityIpcHandlers();
  // The Package & Environment Manager surface (file 04 §1,§3) — registered
  // alongside the main ipc so the Environments tab finds a live handler from boot.
  disposeEnvIpc = registerEnvIpcHandlers();
  // The Model Hub surface (file 05 §1,§7,§8) — registered alongside the main ipc
  // so the Models tab finds a live handler from boot (discover/fit/download/serve).
  disposeModelIpc = registerModelIpcHandlers({ serveSupervisor, broadcast: broadcastModel });
  // The Catalog manager surface (file 06 §4) — registered alongside the main ipc
  // so the Catalog tab finds a live handler from boot (plugins/skills/apps/…).
  disposeCatalogIpc = registerCatalogIpcHandlers();
  // The GitHub Repo Manager surface (file 06 §3, FEATURE #5a) — registered
  // alongside the main ipc so the Repos tab finds a live handler from boot.
  disposeRepoIpc = registerRepoIpcHandlers();
  // The file-metadata control surface (file 0C — privacy protection) — inspect/scrub/
  // edit/timestomp via the metadata.py sidecar + the native file picker.
  disposeMetadataIpc = registerMetadataIpcHandlers();
  // Whole-machine resource telemetry (CPU/GPU/NPU/RAM/DISK) + the launch guard —
  // the renderer polls `system:telemetry` for the bottom-bar strip + System panel.
  disposeTelemetryIpc = registerTelemetryIpcHandlers();
  // SPECTACULAR power-up: catalog cards (describe/tutorial/methods) + chat
  // (agentic-local reply + terminal preview) + models folder + harden self-audit.
  disposeSpectacularIpc = registerSpectacularIpcHandlers();
  // The Code-Editor / IDE surface (file 07 §3.2/§4/§5/§6/§9) — registered alongside
  // the main ipc so the editor's hosts (LSP/DAP/PTY/git/fs + run-gate) are live from
  // boot. The renderer never spawns a child; it drives these hosts over IPC (C5).
  disposeIdeIpc = registerIdeIpcHandlers({
    lsp: lspHost,
    dap: dapHost,
    pty: ptyHost,
    git: gitHost,
    fsWatch: fsWatchHost,
    localHistory: getLocalHistory(),
    runHost,
    broadcast: broadcastIde,
    testSpawn: testRunSpawn,
    broadcastTest: broadcastTestEvent,
    runWorkerTask,
    prGateway: ensurePrGateway(),
    profileSnapshotDir: `${app.getPath("userData")}/profile-snapshots`,
    floatingTerminal: floatingTerminalController,
  });
  // "@"-path fuzzy completion (shared logic with the CLI) — list one directory + rank it,
  // and the opt-in per-workspace frecency memory ("Tools ▸ Path Completion" setting).
  disposePathCompletionIpc = registerPathCompletionIpcHandlers();
  // Model health (per-endpoint transport/breaker/context-window state) — one global file,
  // never workspace-scoped, SHARED with the CLI's own store (model-health-store-path.ts's
  // header: these used to be two different, never-synced files).
  const adoptedModelHealth = migrateModelHealthStore(app.getPath("userData"));
  if (adoptedModelHealth > 0) {
    console.info(
      `[model-health] adopted ${adoptedModelHealth} endpoint record(s) from the old app-private store into ${sharedModelHealthStorePath()}`,
    );
  }
  disposeModelHealthIpc = registerModelHealthIpcHandlers(sharedModelHealthStorePath());
  // Scheduled/autonomous runs (cron-triggered agent turns) — one global file, never
  // workspace-scoped, SHARED with the CLI's own store: schedule-runner.ts (the only code that
  // ever executes a due task, via `prometheus tasks run-due`) reads this exact path, so a task
  // created here is now something the CLI's installed cron entry can actually run
  // (schedule-store-path.ts's header: a GUI-only task used to persist to a file nothing ever
  // read for execution, and could never run at all).
  const adoptedSchedules = migrateScheduleStore(app.getPath("userData"));
  if (adoptedSchedules > 0) {
    console.info(
      `[schedule] adopted ${adoptedSchedules} task(s) from the old app-private store into ${sharedScheduleStorePath()}`,
    );
  }
  disposeScheduleIpc = registerScheduleIpcHandlers(sharedScheduleStorePath());
  // Persona sharing (export/import of sub-agent persona files) — the SHARED ~/.prometheus/agents
  // catalog the CLI also reads (never an Electron userData-private file, unlike the two stores
  // above): project-scope discovery needs to know the CURRENTLY OPEN workspace root, which can
  // change across the app's lifetime, so this is a getter re-read fresh on every request.
  // The OPEN folder, not the write-grant list — see `openFolderRoot`.
  disposePersonaIpc = registerPersonaIpcHandlers(() => openFolderRoot());
  // Budget & spend visibility (roadmap point 4) — read-only; setting a cap reuses settings:set.
  disposeBudgetIpc = registerBudgetIpcHandlers();
  // "Meet your codebase" (roadmap point 6) — on-demand only, never runs until the renderer asks.
  disposeCodebaseOverviewIpc = registerCodebaseOverviewIpcHandlers(() => openFolderRoot());
  /**
   * MCP connectors (file 09 §2), in the file the CLI also reads.
   *
   * These used to point at `<userData>/mcp-servers.json` — same format as the CLI's store, a
   * different file. A connector added with `prometheus mcp add` never appeared in Studio, and
   * one added in Studio never appeared in a terminal session; both sides reported success and
   * listed a different set. `migrateMcpStore` folds any desktop-only entries into the shared
   * file once, and says how many it adopted rather than doing it silently.
   */
  const adoptedMcp = migrateMcpStore(app.getPath("userData"));
  if (adoptedMcp > 0) {
    console.info(
      `[mcp] adopted ${adoptedMcp} connector(s) from the old app-private store into ${sharedMcpStorePath()}`,
    );
  }
  disposeMcpIpc = registerMcpIpcHandlers({ storePath: sharedMcpStorePath() });
  // APP-095: git-backed settings sync (reads the SAME mcp store, redacts secrets).
  disposeSettingsSyncIpc = registerSettingsSyncIpcHandlers({
    mcpStorePath: sharedMcpStorePath(),
  });
  // Keyed/layered settings tree (file 13 §2.1) — global layer persists to userData;
  // the workspace layer (if any) is resolved per-call from the renderer's workspaceRoot.
  disposeSettingsIpc = registerSettingsIpcHandlers({
    globalPath: `${app.getPath("userData")}/settings.json`,
    // The four security settings become ENFORCED here. Without this the profile a user picks
    // ("Local-only", "Security-strict") is a label: `cloudModelsEnabled` and `defaultNetwork`
    // had no consumer anywhere, so selecting a locked-down profile changed nothing at all.
    onEffective: (effective, raw) => {
      setSecurityPosture(effective);
      // The budget windows ride the SAME publish as the posture, so editing a cap in settings
      // takes effect on the next turn rather than on the next app launch.
      setBudgetSettings(effective);
      // …and the user's lifecycle hooks, so editing one takes effect on the next turn. The RAW
      // layers go in (never `effective`, which has already been through the array-replace
      // merge) so a workspace-supplied hook is narrowed/scanned/confirmed exactly like the CLI.
      void setHookSettings(raw.global as coreSettings.Settings, raw.workspace, {
        ...(raw.workspaceRoot ? { cwd: raw.workspaceRoot } : {}),
        confirm: confirmHookTrust,
        onRefusal: (r) => {
          console.warn(`[hooks] refused (${r.event}): ${r.command} — ${r.reason}`);
        },
      });
    },
  });
  // Extension host (file 09 §5, APP-059): the .promext pipeline + the utility-process runner.
  // The Electron seams the PURE host injects are wired HERE (the plan gotcha): the nemesis
  // gate = engine-bridge (sole JS→engine gateway), the runner fork = utilityProcess.fork of
  // the extRunner entry (built beside worker.js), and safeStorage for encrypted secrets.
  const extEngineClient = createEngineClient({});
  disposeExtIpc = registerExtIpcHandlers({
    extensionsDir: `${app.getPath("userData")}/extensions`,
    stagingRoot: app.getPath("temp"),
    secretsDir: `${app.getPath("userData")}/ext-secrets`,
    registryPath: `${app.getPath("userData")}/ext-registry.json`,
    studioVersion: app.getVersion(),
    gate: (target) =>
      extEngineClient.gate(target).then((v) => ({
        verdict: v.verdict,
        ...(v.findings?.length ? { reason: `${v.findings.length} finding(s)` } : {}),
      })),
    // APP-060 rescan: the RICH nemesis verdict + findings for the marketplace card.
    gateFull: (target) =>
      engineGateFull(target, {}, {}).then((v) => ({
        verdict: v.verdict,
        riskScore: v.risk_score,
        scannedAt: v.scanned_at,
        findings: (v.top_findings ?? []).map((f) => ({
          ruleId: f.rule_id,
          severity: f.severity,
          detail: f.detail,
        })),
      })),
    spawnRunner: (): WorkerHandle => {
      const child: UtilityProcess = utilityProcess.fork(join(__dirname, "extRunner.js"), [], {
        stdio: "inherit",
      });
      return {
        postMessage: (message: unknown) => child.postMessage(message),
        on: ((event: string, listener: (...a: unknown[]) => void) => {
          if (event === "message") child.on("message", (v: unknown) => listener(v));
          else if (event === "exit") child.on("exit", (code: number) => listener(code));
        }) as WorkerHandle["on"],
        kill: () => {
          child.kill();
        },
      };
    },
    safeStorage,
  });

  // C8: autostart any serve-profiles flagged autostart. A missing file is a
  // no-op (the supervisor's loader returns [] for a missing/bad file).
  try {
    await supervisor.autostart(SERVE_PROFILES_PATH);
  } catch {
    /* boot-resilient: never block window creation on supervisor autostart. */
  }

  const mainWin = createMainWindow();
  // Wire the consent-gated auto-updater (no-op in dev where electron-updater is
  // absent; idempotent so window recreation on `activate` never double-registers).
  void registerUpdater(mainWin).catch(() => {
    /* updates are a best-effort packaged-app feature — never block boot. */
  });
  // ("activate" is registered at top level so it survives a startup throw.)
}

// Quit when all windows close (except on macOS, per platform convention).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Stop every supervised child cleanly before the process exits (C8 + §5).
app.on("before-quit", (event) => {
  const serversLive = supervisor.list().some((s) => s.state === "running");
  const sidecarsLive = sidecarSupervisor
    .list()
    .some((s) => s.state === "running" || s.state === "restarting");

  // Always tear down the worker host (no async needed — it kills synchronously).
  workerHost.dispose();
  // The agent's own hidden browser tab (browser_navigate/_screenshot/_extract_text) — nothing
  // this process started outlives it, same rule as every other host.
  destroyAgentBrowser();
  // APP-090: close any torn-out terminal floats so they never orphan the quit.
  closeAllFloatingTerminals();
  // APP-063: flush any pending Local History write-behind so no revision is lost on quit.
  void localHistoryManager?.flush();
  // §9c: release any local model we pinned with `keep_alive` — quitting Studio should not
  // leave several GB resident for the next half hour. Fire-and-forget: it is self-deadlined
  // and must never be able to hold up the quit.
  void freeLocalModels();
  // Tear down the IDE hosts (kill LSP/DAP/PTY children + stop the fs watcher).
  lspHost.dispose();
  void dapHost.dispose().catch(() => {});
  ptyHost.dispose();
  runHost.dispose();
  fsWatchHost.dispose();

  if (serversLive || sidecarsLive) {
    event.preventDefault();
    // Race the graceful stop against a 3s deadline so a hung host can never trap
    // the app in a never-quits zombie state — we exit regardless.
    const graceful = Promise.allSettled([
      serveSupervisor.stopAll(),
      supervisor.stopAll(),
      sidecarSupervisor.dispose(),
    ]);
    const deadline = new Promise<void>((r) => {
      const t = setTimeout(r, 3000);
      if (typeof t.unref === "function") t.unref();
    });
    void Promise.race([graceful, deadline]).finally(() => {
      disposeIpc?.();
      disposeIpc = null;
      disposeSecurityIpc?.();
      disposeSecurityIpc = null;
      disposeEnvIpc?.();
      disposeEnvIpc = null;
      disposeModelIpc?.();
      disposeModelIpc = null;
      disposeCatalogIpc?.();
      disposeCatalogIpc = null;
      disposeRepoIpc?.();
      disposeRepoIpc = null;
      disposeMetadataIpc?.();
      disposeMetadataIpc = null;
      disposeSpectacularIpc?.();
      disposeSpectacularIpc = null;
      disposeIdeIpc?.();
      disposeIdeIpc = null;
      disposeMcpIpc?.();
      disposeMcpIpc = null;
      disposeSettingsIpc?.();
      disposeSettingsIpc = null;
      disposePathCompletionIpc?.();
      disposePathCompletionIpc = null;
      disposeModelHealthIpc?.();
      disposeModelHealthIpc = null;
      disposeScheduleIpc?.();
      disposeScheduleIpc = null;
      disposePersonaIpc?.();
      disposePersonaIpc = null;
      disposeBudgetIpc?.();
      disposeBudgetIpc = null;
      disposeCodebaseOverviewIpc?.();
      disposeCodebaseOverviewIpc = null;
      disposeExtIpc?.();
      disposeExtIpc = null;
      disposeTelemetryIpc?.();
      disposeTelemetryIpc = null;
      app.exit(0);
    });
  } else {
    disposeIpc?.();
    disposeIpc = null;
    disposeSecurityIpc?.();
    disposeSecurityIpc = null;
    disposeEnvIpc?.();
    disposeEnvIpc = null;
    disposeModelIpc?.();
    disposeModelIpc = null;
    disposeCatalogIpc?.();
    disposeCatalogIpc = null;
    disposeRepoIpc?.();
    disposeRepoIpc = null;
    disposeMetadataIpc?.();
    disposeMetadataIpc = null;
    disposeSpectacularIpc?.();
    disposeSpectacularIpc = null;
    disposeIdeIpc?.();
    disposeIdeIpc = null;
    disposeMcpIpc?.();
    disposeMcpIpc = null;
    disposeSettingsSyncIpc?.();
    disposeSettingsSyncIpc = null;
    disposeSettingsIpc?.();
    disposeSettingsIpc = null;
    disposePathCompletionIpc?.();
    disposePathCompletionIpc = null;
    disposeModelHealthIpc?.();
    disposeModelHealthIpc = null;
    disposeScheduleIpc?.();
    disposeScheduleIpc = null;
    disposePersonaIpc?.();
    disposePersonaIpc = null;
    disposeBudgetIpc?.();
    disposeBudgetIpc = null;
    disposeCodebaseOverviewIpc?.();
    disposeCodebaseOverviewIpc = null;
    disposeExtIpc?.();
    disposeExtIpc = null;
    disposeTelemetryIpc?.();
    disposeTelemetryIpc = null;
  }
});

// Harden: forbid creating extra BrowserWindows / webviews with weak prefs.
app.on("web-contents-created", (_evt, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });
});
