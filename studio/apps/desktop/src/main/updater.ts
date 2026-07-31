/**
 * main/updater.ts — electron-updater wiring (file 10 §5).
 *
 * Rules baked in (the §5 invariants, enforced via @prometheus/core's update-policy):
 *   - NEVER auto-install (autoDownload=false, autoInstallOnAppQuit=false): a security
 *     IDE silently swapping its own binary contradicts the ethos. Download on consent,
 *     install on an explicit click.
 *   - Signature verification is electron-updater's native job (mac code-sig / win
 *     publisher); Linux GPG is verified before apply.
 *   - The channel is user-switchable in Settings.
 *
 * `electron-updater` is a packaging-time dependency and is NOT installed in the dev
 * env, so it is loaded via a NON-LITERAL dynamic import — `tsc -p apps/desktop` stays
 * green without it, and in dev `registerUpdater` no-ops (updates are a packaged-app
 * feature). The renderer shows a non-modal toast (file 08) and calls the IPC handlers.
 */
import { AUTO_DOWNLOAD, AUTO_INSTALL } from "@prometheus/core";
import { type BrowserWindow, ipcMain } from "electron";

import { IPC_UPDATE, IPC_UPDATE_EVENTS } from "../shared/ipc-contract.js";

// Loaded via a variable specifier so the type-checker does not require the module.
const UPDATER_MODULE = "electron-updater";

/** The slice of electron-updater's autoUpdater we touch. */
interface AutoUpdaterLike {
  channel: string;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

/** The window updater events are forwarded to (updated on each registerUpdater call). */
let updaterWindow: BrowserWindow | null = null;
/** Guard so the autoUpdater listeners + ipcMain handlers are wired EXACTLY once
 *  (registerUpdater may run again when the window is recreated on `activate`). */
let updaterWired = false;

function sendToUpdaterWindow(channel: string, payload?: unknown): void {
  const w = updaterWindow;
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/**
 * Wire auto-update for the main window. Returns false (no-op) when electron-updater
 * is absent (dev). The channel comes from settings (default "latest"). Idempotent:
 * subsequent calls just retarget the window / channel — never a double-registration.
 */
export async function registerUpdater(window: BrowserWindow, channel = "latest"): Promise<boolean> {
  updaterWindow = window; // always retarget to the live window
  let autoUpdater: AutoUpdaterLike;
  try {
    const mod = (await import(UPDATER_MODULE)) as { autoUpdater: AutoUpdaterLike };
    autoUpdater = mod.autoUpdater;
  } catch {
    return false; // not packaged / dev — updates are a packaged-app feature.
  }

  autoUpdater.channel = channel;
  autoUpdater.autoDownload = AUTO_DOWNLOAD; // §5: ASK before downloading
  autoUpdater.autoInstallOnAppQuit = AUTO_INSTALL; // §5: NEVER auto-install

  if (updaterWired) return true; // listeners + handlers already in place
  updaterWired = true;

  // Events cross IPC as PLAIN slices only (same DataCloneError rule as the invokes
  // below — never forward an electron-updater object to the renderer, APP-005).
  autoUpdater.on("update-available", (info) => {
    const i = info as { version?: string; releaseDate?: string } | undefined;
    sendToUpdaterWindow(IPC_UPDATE_EVENTS.available, {
      version: i?.version,
      releaseDate: i?.releaseDate,
    });
  });
  autoUpdater.on("download-progress", (p) => {
    const d = p as
      | { percent?: number; bytesPerSecond?: number; transferred?: number; total?: number }
      | undefined;
    sendToUpdaterWindow(IPC_UPDATE_EVENTS.progress, {
      percent: d?.percent,
      bytesPerSecond: d?.bytesPerSecond,
      transferred: d?.transferred,
      total: d?.total,
    });
  });
  autoUpdater.on("update-downloaded", () => sendToUpdaterWindow(IPC_UPDATE_EVENTS.ready));

  // NOTE: never return the raw electron-updater results — UpdateCheckResult carries
  // a live cancellationToken (non-clonable) → DataCloneError over IPC. Map to plain
  // data, and wrap every call so a network/no-feed rejection becomes {ok,error}.
  ipcMain.handle(IPC_UPDATE.check, async () => {
    try {
      const r = (await autoUpdater.checkForUpdates()) as {
        updateInfo?: { version?: string; releaseDate?: string };
      } | null;
      return {
        ok: true,
        version: r?.updateInfo?.version ?? null,
        releaseDate: r?.updateInfo?.releaseDate ?? null,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC_UPDATE.download, async () => {
    try {
      const files = await autoUpdater.downloadUpdate();
      return { ok: true, files: Array.isArray(files) ? files.map(String) : [] };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle(IPC_UPDATE.install, () => {
    try {
      autoUpdater.quitAndInstall();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return true;
}
