// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
import { describeEngineFailure } from "@prometheus/engine-bridge";
import { ipcMain } from "electron";

import {
  DEFAULT_AUTH_LEVEL,
  MAX_AUTH_LEVEL,
  authLevelMeta,
  authLevelName,
} from "@prometheus/core/agent-authorization";

import { type AuthLevelResult, IPC } from "../shared/ipc-contract.js";

/** The production consent: a native dialog naming both levels. Fails CLOSED. */
async function nativeApproveRaise(from: number, to: number): Promise<boolean> {
  try {
    const electron = (await import("electron")) as unknown as {
      dialog?: { showMessageBox: (o: unknown) => Promise<{ response: number }> };
    };
    if (!electron.dialog) return false;
    const meta = authLevelMeta(to);
    const r = await electron.dialog.showMessageBox({
      type: "warning",
      buttons: ["Cancel", "Raise"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: `Raise the agent's autonomy from A${from} to A${to} (${meta.name})?`,
      detail:
        "The agent will run more without asking you — in Studio and in `prometheus` on the " +
        "terminal, which shares this setting.",
    });
    return r.response === 1;
  } catch {
    return false;
  }
}

// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

/**
 * Register `authLevel:get` / `authLevel:set`. Returns a disposer, like every other IPC module
 * here, so a window teardown does not leave a second handler behind on re-register.
 *
 * `home` is the OS home, injected for tests; production omits it and the store resolves the one
 * Prometheus home ($PROMETHEUS_HOME, else `~/.prometheus`).
 */
export function registerAuthLevelIpcHandlers(
  opts: {
    home?: string;
    /**
     * Native consent for RAISING the saved level. The saved level is the ceiling every main-side
     * check clamps the renderer's claim to (agent:systemTool's ladder and sandbox, the cloud-model
     * refusal) and the level the CLI starts at — so a renderer that could raise it with a bare
     * IPC call could lift every one of those clamps at once. Lowering never asks. Injected for
     * tests; production shows Electron's dialog.
     */
    approveRaise?: (from: number, to: number) => Promise<boolean>;
  } = {},
): () => void {
  const { home } = opts;
  const approveRaise = opts.approveRaise ?? nativeApproveRaise;

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
      const current = cliProfiles.readSavedAuthLevel(home) ?? DEFAULT_AUTH_LEVEL;
      const wanted = Math.max(0, Math.min(Math.trunc(level), MAX_AUTH_LEVEL));
      if (wanted > current && !(await approveRaise(current, wanted))) {
        return {
          ok: false,
          level: cliProfiles.readSavedAuthLevel(home),
          path: cliProfiles.authLevelPath(home),
          declined: true,
          error: `raising the autonomy level to ${authLevelName(wanted)} was not confirmed`,
        };
      }
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
