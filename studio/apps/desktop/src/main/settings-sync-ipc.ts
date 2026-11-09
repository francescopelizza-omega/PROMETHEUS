// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/settings-sync-ipc.ts — git-backed Studio settings sync (`settings-sync:*`, APP-095).
 *
 * Push: gather the renderer's keymap + custom themes, add the (SECRET-REDACTED) MCP connector
 * configs from the disk store, write ONE bundle file into a user-chosen git repo, then
 * `git add` → `git commit` → `git push` through GitHost's argv-guarded / safe-env spawn seam
 * (never a shell-interpolated path). Pull: `git pull` → read + VALIDATE the bundle → RETURN it
 * to the renderer, which applies it only after an explicit confirm (a poisoned repo can never
 * silently rewrite the keymap/connectors). The repo dir is path-guarded like every fs op.
 *
 * Node/Electron main only (spawns git + touches disk) — never importable into the renderer.
 */
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeEngineFailure } from "@prometheus/engine-bridge";

import type { mcpHost } from "@prometheus/core";
import { ipcMain } from "electron";

import {
  IPC,
  type SettingsSyncPullResult,
  type SettingsSyncPushRequest,
  type SettingsSyncResult,
} from "../shared/ipc-contract.js";
import { GitHost } from "./ide/git-host.js";
import { assertNotSensitivePath } from "./ide/path-guard.js";
import {
  type SettingsBundle,
  buildSettingsBundle,
  serializeBundle,
  validateSettingsBundle,
} from "./settings-bundle.js";

type McpServerConfig = mcpHost.McpServerConfig;

const BUNDLE_FILE = "prometheus-settings.json";

// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

/** Read the FULL (unredacted) connector configs from the disk store — redaction happens in
 *  buildSettingsBundle, so the token bytes never leave this process. Fail-soft → []. */
function readConnectors(storePath: string): McpServerConfig[] {
  try {
    const raw = JSON.parse(readFileSync(storePath, "utf8")) as { servers?: McpServerConfig[] };
    return Array.isArray(raw.servers) ? raw.servers : [];
  } catch {
    return [];
  }
}

export interface SettingsSyncIpcOptions {
  /** the disk MCP config store (userData/mcp-servers.json) — read for the connector bundle. */
  mcpStorePath: string;
  /** injectable GitHost (tests pass a fake-runner-backed one). */
  git?: GitHost;
}

/**
 * The bundle must be a plain file of sane size, or absent. A pulled repo is someone else's
 * content: `prometheus-settings.json` as a symlink to `~/.zshrc` made the next Push overwrite
 * that file with JSON, and a link to `/dev/zero` or a FIFO hung main on the read.
 */
const MAX_BUNDLE_BYTES = 1024 * 1024;
export function notARegularBundle(file: string): string | null {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    return null; // absent — the push creates it, the pull reports it missing
  }
  if (st.isSymbolicLink()) return `${BUNDLE_FILE} is a symlink — refusing to follow it`;
  if (!st.isFile()) return `${BUNDLE_FILE} is not a regular file`;
  if (st.size > MAX_BUNDLE_BYTES) return `${BUNDLE_FILE} is too large (${st.size} bytes)`;
  return null;
}

/** Register the `settings-sync:*` handlers; returns a disposer. */
export function registerSettingsSyncIpcHandlers(opts: SettingsSyncIpcOptions): () => void {
  const git = opts.git ?? new GitHost();

  /** Guard the repo dir the same way the fs IPC guards every path (C5). */
  function guardedRepo(dir: unknown): string | { error: string } {
    if (typeof dir !== "string" || !dir.trim()) return { error: "a repo directory is required" };
    try {
      // a plain path, not `file://${dir}`: as a URL, a `?` or `#` in the directory name became a
      // delimiter and the guard checked a different path from the one used below
      return assertNotSensitivePath(dir);
    } catch (e) {
      return { error: errString(e) };
    }
  }

  ipcMain.handle(IPC.settingsSyncPush, async (_e, arg: unknown): Promise<SettingsSyncResult> => {
    const req = (arg ?? {}) as SettingsSyncPushRequest;
    const repo = guardedRepo(req.repoDir);
    if (typeof repo !== "string") return { ok: false, error: repo.error };
    if (!(await git.isRepo(repo))) return { ok: false, error: "not a git repository" };
    try {
      const bundle: SettingsBundle = buildSettingsBundle({
        keymap: {
          base: typeof req.keymap?.base === "string" ? req.keymap.base : "default",
          overrides: Array.isArray(req.keymap?.overrides) ? req.keymap.overrides : [],
        },
        themes: Array.isArray(req.themes) ? req.themes : [],
        connectors: readConnectors(opts.mcpStorePath),
      });
      const file = join(repo, BUNDLE_FILE);
      const why = notARegularBundle(file);
      if (why) return { ok: false, error: why };
      // Never commit someone else's work: `git commit -m` commits the WHOLE index, so changes a
      // user had staged in that repo were committed under our message and pushed.
      const st = await git.status(repo);
      const others = (st.staged ?? []).filter((f) => f.path !== BUNDLE_FILE);
      if (others.length > 0) {
        return {
          ok: false,
          error: `that repository has other staged changes (${others.length}) — commit or unstage them first`,
        };
      }
      writeFileSync(file, serializeBundle(bundle));
      const staged = await git.stage(repo, [file]);
      if (!staged.ok) return { ok: false, error: staged.error ?? "git add failed" };
      const committed = await git.commit(repo, "chore: sync Prometheus Studio settings", {
        paths: [BUNDLE_FILE],
      });
      // an empty commit (nothing changed) is not a failure — still try to push.
      const pushed = await git.push(repo);
      if (!pushed.ok) {
        return {
          ok: false,
          error: `${committed.ok ? "committed but " : ""}push failed: ${pushed.error ?? "unknown"}`,
        };
      }
      return { ok: true, message: "pushed prometheus-settings.json" };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(
    IPC.settingsSyncPull,
    async (_e, arg: unknown): Promise<SettingsSyncPullResult> => {
      const req = (arg ?? {}) as { repoDir?: unknown };
      const repo = guardedRepo(req.repoDir);
      if (typeof repo !== "string") return { ok: false, error: repo.error };
      if (!(await git.isRepo(repo))) return { ok: false, error: "not a git repository" };
      try {
        const pulled = await git.pull(repo);
        if (!pulled.ok) return { ok: false, error: pulled.error ?? "git pull failed" };
        let text: string;
        const file = join(repo, BUNDLE_FILE);
        const why = notARegularBundle(file);
        if (why) return { ok: false, error: why };
        try {
          text = readFileSync(file, "utf8");
        } catch {
          return { ok: false, error: "no prometheus-settings.json in the repo" };
        }
        const result = validateSettingsBundle(text);
        if ("error" in result) return { ok: false, error: `invalid bundle: ${result.error}` };
        // RETURN the bundle — the renderer applies it only after an explicit confirm.
        return { ok: true, bundle: result };
      } catch (e) {
        return { ok: false, error: errString(e) };
      }
    },
  );

  return () => {
    for (const ch of [IPC.settingsSyncPush, IPC.settingsSyncPull]) {
      ipcMain.removeHandler(ch);
    }
  };
}
