/**
 * main/index.ts — the Electron MAIN process entry (Electron 33 / Node 20, C10).
 *
 * Responsibilities (and ONLY these — the renderer is a sandboxed view):
 *   - create the BrowserWindow with a HARDENED webPreferences (C5):
 *       contextIsolation:true · nodeIntegration:false · sandbox:true · preload + CSP.
 *   - own the FOUR-process model (file 01 §5): this MAIN process, the sandboxed
 *     RENDERER, the offloaded WORKER (WorkerHost → utilityProcess), and the
 *     supervised SIDECARS (SidecarSupervisor) + long-lived servers (ServerSupervisor).
 *   - register the typed ipcMain handlers (the only EngineClient lives there);
 *     the IpcBroker mirrors that routing for testability.
 *   - forward the live engine progress feed MAIN→renderer (cosmetic, C5).
 *   - tear everything down cleanly on quit.
 *
 * This is the ONLY place (with main/ipc.ts) allowed to import engine-bridge +
 * core. The renderer reaches the engine exclusively across the contextBridge
 * seam handled here.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserWindow,
  type UtilityProcess,
  app,
  dialog,
  nativeImage,
  safeStorage,
  shell,
  utilityProcess,
} from "electron";

import { ServerSupervisor } from "@prometheus/core";
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
import { registerCatalogIpcHandlers } from "./catalog-ipc.js";
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
import { FsWatchHost } from "./ide/fs-watch.js";
import { GitHost } from "./ide/git-host.js";
import { LocalHistoryManager } from "./ide/history-store.js";
import { type LspChild, LspHost } from "./ide/lsp-host.js";
import { type PtyBackend, PtyHost, nodePtyBackend } from "./ide/pty-host.js";
import { RunHost } from "./ide/run-host.js";
import type { TestRunSpawn } from "./ide/test-run-host.js";
import { registerIpcHandlers } from "./ipc.js";
import { registerMcpIpcHandlers } from "./mcp-ipc.js";
import { registerMetadataIpcHandlers } from "./metadata-ipc.js";
import { registerModelIpcHandlers } from "./model-ipc.js";
import { registerRepoIpcHandlers } from "./repo-ipc.js";
import { repairPath } from "./resolve-path.js";
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
  process.env.PROMETHEUS_SERVE_PROFILES ??
  join("/Users/dev/ALPHA/PROMETHEUS/studio", "config", "serve-profiles.json");

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
 * The branded app icon (the Prometheus flame, build/icon.png — replace with the
 * final artwork; electron-builder derives .icns/.ico from it for packaging).
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
    const isLocalFile = url.startsWith("file://");
    if (!isDev && !isLocalFile) event.preventDefault();
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0b0e",
    title: "Prometheus Studio",
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
    backgroundColor: "#0b0b0e",
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
async function runHeadlessSmoke(): Promise<void> {
  disposeIpc = registerIpcHandlers({
    supervisor,
    sidecarSupervisor,
    providersConfigPath:
      "/Users/dev/ALPHA/PROMETHEUS/studio/config/providers.config.json",
    serveProfilesPath: SERVE_PROFILES_PATH,
  });
  // The FULL security surface (file 03 §5,§7) — its own handler set + disposer.
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
  // MCP connectors (file 09 §2): the manager persists to userData + gates every server.
  disposeMcpIpc = registerMcpIpcHandlers({
    storePath: `${app.getPath("userData")}/mcp-servers.json`,
  });
  // APP-095: git-backed settings sync (reads the SAME mcp store, redacts secrets).
  disposeSettingsSyncIpc = registerSettingsSyncIpcHandlers({
    mcpStorePath: `${app.getPath("userData")}/mcp-servers.json`,
  });
  // Keyed/layered settings tree (file 13 §2.1) — global layer persists to userData;
  // the workspace layer (if any) is resolved per-call from the renderer's workspaceRoot.
  disposeSettingsIpc = registerSettingsIpcHandlers({
    globalPath: `${app.getPath("userData")}/settings.json`,
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
    providersConfigPath:
      "/Users/dev/ALPHA/PROMETHEUS/studio/config/providers.config.json",
    serveProfilesPath: SERVE_PROFILES_PATH,
  });
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
  // MCP connectors (file 09 §2): the manager persists to userData + gates every server.
  disposeMcpIpc = registerMcpIpcHandlers({
    storePath: `${app.getPath("userData")}/mcp-servers.json`,
  });
  // APP-095: git-backed settings sync (reads the SAME mcp store, redacts secrets).
  disposeSettingsSyncIpc = registerSettingsSyncIpcHandlers({
    mcpStorePath: `${app.getPath("userData")}/mcp-servers.json`,
  });
  // Keyed/layered settings tree (file 13 §2.1) — global layer persists to userData;
  // the workspace layer (if any) is resolved per-call from the renderer's workspaceRoot.
  disposeSettingsIpc = registerSettingsIpcHandlers({
    globalPath: `${app.getPath("userData")}/settings.json`,
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
  // APP-090: close any torn-out terminal floats so they never orphan the quit.
  closeAllFloatingTerminals();
  // APP-063: flush any pending Local History write-behind so no revision is lost on quit.
  void localHistoryManager?.flush();
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
