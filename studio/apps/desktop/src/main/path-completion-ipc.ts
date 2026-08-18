/**
 * main/path-completion-ipc.ts — the `pathCompletion:*` ipcMain handlers for the "@"-path
 * fuzzy completion feature (shared with the CLI). RELAY-ONLY (mirrors settings-ipc.ts):
 * validates the renderer's arg, path-guards it (assertNotSensitivePath — the renderer is
 * sandboxed and cannot readdir itself, C5), lists via the existing fsTree, and ranks via
 * @prometheus/core/path-completion's pure fuzzy scorer + optional frecency boost from
 * path-frecency-store.ts (the opt-in per-workspace memory).
 */
import {
  type PathEntry,
  frecencyForDirectory,
  rankEntries,
} from "@prometheus/core/path-completion";
import { ipcMain } from "electron";

import {
  IPC,
  type PathCompletionListResult,
  type PathCompletionRecordUseResult,
} from "../shared/ipc-contract.js";
import { fsTree } from "./ide/fs-watch.js";
import { assertNotSensitivePath } from "./ide/path-guard.js";
import { loadPathFrecency, recordPathUse } from "./path-frecency-store.js";

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Register the `pathCompletion:*` handlers. Returns a disposer (mirrors sibling IPC modules). */
export function registerPathCompletionIpcHandlers(): () => void {
  ipcMain.handle(
    IPC.pathCompletionList,
    async (_e, arg: unknown): Promise<PathCompletionListResult> => {
      try {
        const a = (arg ?? {}) as Record<string, unknown>;
        const dir = typeof a.dir === "string" ? a.dir : undefined;
        const query = typeof a.query === "string" ? a.query : "";
        const rawWorkspaceRoot = typeof a.workspaceRoot === "string" ? a.workspaceRoot : undefined;
        const useFrecency = a.useFrecency === true;
        if (!dir) return { ok: false, error: "dir is required" };

        const absDir = assertNotSensitivePath(dir);
        const nodes = await fsTree(absDir);
        // dotfile hiding unless the user explicitly typed a leading dot (mirrors the CLI).
        const visible = nodes.filter((n) => query.startsWith(".") || !n.name.startsWith("."));
        const entries: PathEntry[] = visible.map((n) => ({
          name: n.name,
          isDir: n.kind === "dir",
        }));

        let frecencyByName = new Map<string, number>();
        // workspaceRoot is guarded exactly like `dir` — it's about to become a SECOND
        // fs-read target (the frecency store path), not just a lookup key, so it must not
        // bypass the same sensitive-path denylist `dir` and `path` are already held to.
        if (useFrecency && rawWorkspaceRoot) {
          const workspaceRoot = assertNotSensitivePath(rawWorkspaceRoot);
          const store = await loadPathFrecency(workspaceRoot);
          frecencyByName = frecencyForDirectory(store, absDir, Date.now());
        }
        const ranked = rankEntries(query, entries, frecencyByName);
        return {
          ok: true,
          entries: ranked.map((r) => ({
            name: r.isDir ? `${r.name}/` : r.name,
            isDir: r.isDir,
            positions: r.positions,
          })),
        };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  ipcMain.handle(
    IPC.pathCompletionRecordUse,
    async (_e, arg: unknown): Promise<PathCompletionRecordUseResult> => {
      try {
        const a = (arg ?? {}) as Record<string, unknown>;
        const rawWorkspaceRoot = typeof a.workspaceRoot === "string" ? a.workspaceRoot : undefined;
        const path = typeof a.path === "string" ? a.path : undefined;
        if (!rawWorkspaceRoot || !path) {
          return { ok: false, error: "workspaceRoot and path are required" };
        }
        // workspaceRoot determines WHERE main writes the frecency-store file — guard it just
        // like `path`, or a compromised/buggy renderer could make main create a new file
        // inside any directory on disk, including one this same guard denylists (e.g. ~/.ssh).
        const workspaceRoot = assertNotSensitivePath(rawWorkspaceRoot);
        await recordPathUse(workspaceRoot, assertNotSensitivePath(path), Date.now());
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  return () => {
    for (const channel of [IPC.pathCompletionList, IPC.pathCompletionRecordUse]) {
      ipcMain.removeHandler(channel);
    }
  };
}
