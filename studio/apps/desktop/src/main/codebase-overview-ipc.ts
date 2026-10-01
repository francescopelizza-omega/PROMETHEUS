// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/codebase-overview-ipc.ts — the `codebase:overview` ipcMain handler for "meet your
 * codebase" (roadmap point 6, RELAY-ONLY, mirrors persona-ipc.ts's workspace-root handling).
 *
 * ONE read-only channel, on demand: it walks the CURRENTLY OPEN workspace root (a getter, read
 * fresh on every request — folders can be opened/switched across the app's lifetime, exactly
 * like persona-ipc.ts's own reasoning) with `@prometheus/core`'s already-built, already-tested
 * `token-economy/repo-map.ts` walker, then reads it through `codebase-overview.ts`'s
 * `summarizeCodebase` — the SAME pair the CLI's `prometheus meet` uses, so the two surfaces can
 * never disagree about what a repo looks like.
 *
 * ON DEMAND, NOT AUTOMATIC: this only ever runs when the renderer explicitly invokes it (a
 * button click), never on workspace-open or app-start. An unannounced full-repo walk the moment
 * a folder opens risks a visible stall on a large repo before the user asked for anything — the
 * CLI's own `/repomap` already defaults OFF for exactly this reason.
 *
 * The walk itself is a SYNCHRONOUS recursive function (`walkRepo` has no internal await), so a
 * very large repo does block the main process for its duration — an accepted, disclosed tradeoff
 * this shares with the CLI's `/repomap refresh` (also synchronous, also user-triggered, also
 * bounded by the same file cap), not a regression this handler introduces on its own.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describeEngineFailure } from "@prometheus/engine-bridge";

import { tokenEconomy } from "@prometheus/core";
import { ipcMain } from "electron";

import type { CodebaseOverviewResult } from "../shared/ipc-contract.js";
import { IPC } from "../shared/ipc-contract.js";

/** The real filesystem adapter — the ONLY node:fs binding this handler needs (core stays
 *  IO-free), mirroring the CLI's own `nodeRepoFs` in commands/meet-cmd.ts exactly. */
function nodeRepoFs(): tokenEconomy.RepoFs {
  return {
    readdir: (dir) =>
      readdirSync(dir || ".", { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isSymlink: d.isSymbolicLink(),
      })),
    readFile: (p) => readFileSync(p, "utf8"),
    statSize: (p) => statSync(p).size,
  };
}

// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

/**
 * Register the `codebase:overview` handler. `workspaceRoot` is a GETTER — called fresh on every
 * request, never captured once at registration (see module header). Returns a disposer (mirrors
 * sibling IPC modules).
 */
export function registerCodebaseOverviewIpcHandlers(
  workspaceRoot: () => string | undefined,
): () => void {
  ipcMain.handle(IPC.codebaseOverview, async (): Promise<CodebaseOverviewResult> => {
    const root = workspaceRoot();
    if (!root) {
      return { ok: false, error: "no workspace folder is open" };
    }
    try {
      if (!statSync(root).isDirectory()) {
        return { ok: false, error: `"${root}" is not a directory` };
      }
      const map = tokenEconomy.walkRepo(nodeRepoFs(), root);
      const overview = tokenEconomy.summarizeCodebase(map);
      return { ok: true, overview };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  return () => {
    ipcMain.removeHandler(IPC.codebaseOverview);
  };
}
