/**
 * main/auth-level-ipc.ts — the `authLevel:*` handlers: ONE saved autonomy level for the app and
 * the terminal alike.
 *
 * RELAY-ONLY (mirrors settings-ipc.ts): validate the renderer's arg, delegate to the shared
 * store in `@prometheus/core`'s `cliProfiles` barrel, return a renderer-safe shape.
 *
 * ## Why this exists
 *
 * The renderer kept the level in `localStorage` under `prometheus.authorisation.v1`. The store's
 * own docstring called the split out honestly — "a level set in the GUI does not follow you into
 * `prometheus` on the terminal … unifying them needs a main-process handler over that file" —
 * and this is that handler. Two consequences of the old arrangement, both real:
 *
 *   - A6 in the terminal and A1 in the app, on one machine, with no indication either was wrong.
 *   - Clearing the app's data reset the posture to the default with nothing on disk to recover
 *     it from, because localStorage was the only copy.
 *
 * ## Renderer-supplied input
 *
 * Only a NUMBER crosses this boundary, and it is clamped to the ladder by the core store before
 * it is written. No path, no scope, no file name: the destination is decided here, by
 * `cliProfiles`, never by the caller.
 */
import { cliProfiles } from "@prometheus/core";
import { ipcMain } from "electron";

import { type AuthLevelResult, IPC } from "../shared/ipc-contract.js";

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Register `authLevel:get` / `authLevel:set`. Returns a disposer, like every other IPC module
 * here, so a window teardown does not leave a second handler behind on re-register.
 *
 * `home` is the OS home, injected for tests; production omits it and the store resolves the one
 * Prometheus home ($PROMETHEUS_HOME, else `~/.prometheus`).
 */
export function registerAuthLevelIpcHandlers(opts: { home?: string } = {}): () => void {
  const { home } = opts;

  ipcMain.handle(IPC.authLevelGet, async (): Promise<AuthLevelResult> => {
    try {
      return {
        ok: true,
        level: cliProfiles.readSavedAuthLevel(home),
        path: cliProfiles.authLevelPath(home),
      };
    } catch (e) {
      // A level we cannot read is not a reason to fail the window — the renderer keeps its own
      // safe default, which is lower than anything a user would have chosen deliberately.
      return { ok: false, level: null, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.authLevelSet, async (_e, arg: unknown): Promise<AuthLevelResult> => {
    try {
      const a = (arg ?? {}) as Record<string, unknown>;
      const level = a.level;
      if (typeof level !== "number" || !Number.isFinite(level)) {
        return { ok: false, level: null, error: "level must be a finite number" };
      }
      // Only an EXPLICIT choice reaches this channel — the GUI's level picker. The renderer's
      // permission-mode dial syncs the live level without calling it, exactly as Shift-Tab does
      // in the terminal, because mode→level is lossy and persisting the derived value is what
      // destroyed the operator's explicit choice on the CLI side.
      cliProfiles.saveAuthLevel(level, home);
      return {
        ok: true,
        level: cliProfiles.readSavedAuthLevel(home),
        path: cliProfiles.authLevelPath(home),
      };
    } catch (e) {
      return { ok: false, level: null, error: errString(e) };
    }
  });

  return () => {
    for (const channel of [IPC.authLevelGet, IPC.authLevelSet]) {
      ipcMain.removeHandler(channel);
    }
  };
}
