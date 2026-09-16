/**
 * main/effort-ipc.ts — the `effort:*` handlers: ONE saved thinking-effort tier for the app and
 * the terminal alike.
 *
 * RELAY-ONLY (mirrors auth-level-ipc.ts, which does the same job for the autonomy level):
 * validate the renderer's arg, delegate to the shared store in `@prometheus/core`'s
 * `cliProfiles` barrel, return a renderer-safe shape.
 *
 * The renderer kept its tier in `localStorage` under `prometheus.ai.effort.v1` — the same split
 * the autonomy level had, with the same two consequences: a `/think max` in the terminal was
 * invisible in the app, and clearing the app's data reset the tier with nothing on disk to
 * recover it from.
 *
 * ## Renderer-supplied input
 *
 * Only a TIER STRING crosses this boundary, and it is validated against the ladder before it is
 * written. No path, no scope, no file name: the destination is decided here, by `cliProfiles`,
 * never by the caller.
 */
import { cliProfiles } from "@prometheus/core";
import { isEffortTier } from "@prometheus/core/ai-effort";
import { ipcMain } from "electron";

import { type EffortPrefResult, IPC } from "../shared/ipc-contract.js";

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Register `effort:get` / `effort:set`. Returns a disposer, like every other IPC module here.
 *
 * `home` is the OS home, injected for tests; production omits it and the store resolves the one
 * Prometheus home ($PROMETHEUS_HOME, else `~/.prometheus`).
 */
export function registerEffortIpcHandlers(opts: { home?: string } = {}): () => void {
  const { home } = opts;

  ipcMain.handle(IPC.effortGet, async (): Promise<EffortPrefResult> => {
    try {
      return {
        ok: true,
        tier: cliProfiles.readSavedEffort(home),
        path: cliProfiles.effortPath(home),
      };
    } catch (e) {
      // A tier we cannot read is not a reason to fail the window — the renderer keeps its own
      // default, which is a middle rung rather than an expensive one.
      return { ok: false, tier: null, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.effortSet, async (_e, arg: unknown): Promise<EffortPrefResult> => {
    try {
      const a = (arg ?? {}) as Record<string, unknown>;
      const tier = a.tier;
      if (!isEffortTier(tier)) {
        return { ok: false, tier: null, error: `not an effort tier: ${String(tier)}` };
      }
      // The REQUESTED tier. The renderer's chip sends what the operator picked; the clamp to a
      // given model's vocabulary happens per request in `resolveEffort` and is never stored —
      // storing it would ratchet the preference down to whichever model was bound at the time.
      cliProfiles.saveEffort(tier, home);
      return {
        ok: true,
        tier: cliProfiles.readSavedEffort(home),
        path: cliProfiles.effortPath(home),
      };
    } catch (e) {
      return { ok: false, tier: null, error: errString(e) };
    }
  });

  return () => {
    for (const channel of [IPC.effortGet, IPC.effortSet]) {
      ipcMain.removeHandler(channel);
    }
  };
}
