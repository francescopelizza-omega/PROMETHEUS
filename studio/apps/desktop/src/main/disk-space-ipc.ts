// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/disk-space-ipc.ts — the Disk Space panel's channels.
 *
 * Every channel is a thin, validated call into engine-bridge's disk-space facade, which runs
 * the `disk_map.py` sidecar (never as root). The renderer cannot invent a path the sidecar
 * would misread: paths must be absolute or `~`-relative, NUL-free and bounded, and the facade
 * always puts them after `--`.
 *
 * Two doors need more than a path:
 *  - `disk:delete` runs only with `confirm: true` (the dialog's explicit click), and passes
 *    `ackHighRisk` only when the renderer says the human typed "yes". `disk:deletePlan` can
 *    never delete. The sidecar re-checks every protection at confirm time.
 *  - `disk:rescanAsRoot` asks the sidecar for the exact root command and hands it to the
 *    privileged gate — the human approves that command in the approval dialog, and the
 *    password goes to sudo through the askpass helper. Nothing else here can elevate.
 *  - `disk:openAdmin` is the same door for disk_space.py's own interactive TUI: the sidecar
 *    names the exact root command, the gate asks the human and then sudo's native password
 *    dialog (every time), and runs it on a pseudo-terminal whose screen streams to the window
 *    that asked. Only that window can type into it or stop it; Ctrl+D ends it.
 */
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { ipcMain } from "electron";

import type { PrivilegedGate } from "@prometheus/core/agent-system-host";
import {
  type DiskSpaceClient,
  type DiskToolPaths,
  createDiskSpaceClient,
  diskSpaceToolPaths,
} from "@prometheus/engine-bridge";

import {
  type DiskAdminResultView,
  type DiskDeleteModeView,
  type DiskDeletePlanView,
  type DiskDeleteRunView,
  type DiskFilesView,
  type DiskLevelsView,
  type DiskMapView,
  type DiskMountsView,
  type DiskNodeView,
  IPC,
} from "../shared/ipc-contract.js";
import { type KeyInput, cursorKeysMode, keyToTerminalBytes } from "./terminal-keys.js";

const MAX_PATH = 4096;
const MAX_PATHS = 200;
const DEFAULT_MAX_NODES = 5000;
/** How much of a root rescan's stdout (its JSON map) to keep. */
const ROOT_MAP_CAPTURE_BYTES = 64 * 1024 * 1024;
/** An admin session's screen is streamed, not parsed: keep only a little of it. */
const ADMIN_CAPTURE_BYTES = 64 * 1024;
/** the pty's size until the root window's terminal has fitted itself and said */
const ROOT_WINDOW_COLS = 120;
const ROOT_WINDOW_ROWS = 36;
/** An interactive root session is ended by the human (Stop / Ctrl+D / q), not by a job timer. */
const ADMIN_SESSION_TIMEOUT_MS = 12 * 60 * 60_000;

/** A bare interpreter name (`python3` in a dev run) as an absolute path: the gate hashes the relay
 *  here but the child opens it from `/`, so it accepts absolute paths only. */
function absoluteExecutable(p: string): string {
  if (isAbsolute(p)) return p;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, p);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return p;
}
const CTRL_D = "\u0004";

type Clean<T> = { ok: true; value: T } | { ok: false; error: string };

function cleanPath(v: unknown): Clean<string> {
  if (typeof v !== "string" || !v) return { ok: false, error: "a path is required" };
  if (v.length > MAX_PATH) return { ok: false, error: "path too long" };
  if (v.includes("\u0000")) return { ok: false, error: "path contains NUL" };
  const exact = v.startsWith("hex:") && /^hex:[0-9a-f]+$/i.test(v);
  if (!(exact || v.startsWith("/") || v === "~" || v.startsWith("~/"))) {
    return { ok: false, error: "the path must be absolute or start with ~" };
  }
  return { ok: true, value: v };
}

function cleanPaths(v: unknown): Clean<string[]> {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PATHS) {
    return { ok: false, error: `between 1 and ${MAX_PATHS} paths are required` };
  }
  const out: string[] = [];
  for (const p of v) {
    const c = cleanPath(p);
    if (!c.ok) return c;
    out.push(c.value);
  }
  return { ok: true, value: out };
}

function cleanMode(v: unknown): Clean<DiskDeleteModeView> {
  return v === "trash" || v === "permanent"
    ? { ok: true, value: v }
    : { ok: false, error: "mode must be trash or permanent" };
}

function intIn(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.max(lo, Math.min(hi, Math.trunc(v)))
    : dflt;
}

const errOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

interface IpcSender {
  id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  once?(event: "destroyed", cb: () => void): unknown;
  on?(event: string, cb: (...args: never[]) => void): unknown;
  removeListener?(event: string, cb: (...args: never[]) => void): unknown;
}

/**
 * The window a root program is shown in (`root-terminal-window.ts`). Its keys reach main ONLY
 * through `onKey`, fed by Electron's `before-input-event` — real keyboard input, which no page
 * script can synthesise. There is no IPC channel by which any renderer can type into root.
 */
export interface RootTerminalWindow {
  webContentsId: number;
  data(chunk: string): void;
  status(text: string): void;
  focus(): void;
  /** its page is listening: deliver what was held */
  ready(): void;
  close(): void;
}

export type OpenRootTerminalWindow = (handlers: {
  onKey(input: KeyInput): void;
  onClosed(): void;
}) => RootTerminalWindow;

interface AdminSessionState {
  /** the panel that asked for it (it may Stop it) */
  owner: number;
  /** the root window's webContents, once open (it may resize and Stop) */
  view: number | undefined;
  resize(cols: number, rows: number): void;
  ready(): void;
  stop(): void;
}

const senderId = (e: unknown): number | undefined =>
  (e as { sender?: { id?: number } } | undefined)?.sender?.id;

export function registerDiskSpaceIpcHandlers(
  deps: {
    client?: DiskSpaceClient;
    gate?: () => PrivilegedGate | undefined;
    toolPaths?: () => Pick<DiskToolPaths, "python" | "ptyHost">;
    /** opens the dedicated root terminal window; without it no administrator session starts */
    rootWindow?: OpenRootTerminalWindow;
  } = {},
): () => void {
  const client = deps.client ?? createDiskSpaceClient();
  const toolPaths = deps.toolPaths ?? diskSpaceToolPaths;
  /** the one interactive root session */
  let admin: AdminSessionState | null = null;

  ipcMain.handle(IPC.diskMounts, async (): Promise<DiskMountsView> => {
    try {
      const r = await client.mounts();
      return r.ok
        ? { ok: true, mounts: r.mounts ?? [] }
        : { ok: false, error: r.error ?? "failed" };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskMap, async (_e, arg: unknown): Promise<DiskMapView> => {
    const a = (arg ?? {}) as { path?: unknown; maxNodes?: unknown };
    const p = cleanPath(a.path);
    if (!p.ok) return { ok: false, error: p.error };
    try {
      const r = await client.map(p.value, {
        maxNodes: intIn(a.maxNodes, 1, 50_000, DEFAULT_MAX_NODES),
      });
      if (!r.ok || !r.tree) return { ok: false, error: r.error ?? "the scan failed" };
      return {
        ok: true,
        tree: r.tree as DiskNodeView,
        ...(r.summary ? { summary: r.summary } : {}),
        ...(r.truncated ? { truncated: true } : {}),
      };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskLevels, async (_e, arg: unknown): Promise<DiskLevelsView> => {
    const a = (arg ?? {}) as { path?: unknown; depth?: unknown; top?: unknown };
    const p = cleanPath(a.path);
    if (!p.ok) return { ok: false, error: p.error };
    try {
      const r = await client.levels(p.value, {
        depth: intIn(a.depth, 1, 12, 4),
        top: intIn(a.top, 1, 200, 12),
      });
      return r.ok
        ? { ok: true, levels: r.levels ?? [] }
        : { ok: false, error: r.error ?? "failed" };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskFiles, async (_e, arg: unknown): Promise<DiskFilesView> => {
    const a = (arg ?? {}) as { path?: unknown; top?: unknown };
    const p = cleanPath(a.path);
    if (!p.ok) return { ok: false, error: p.error };
    try {
      const r = await client.largestFiles(p.value, { top: intIn(a.top, 1, 1000, 50) });
      return r.ok ? { ok: true, files: r.files ?? [] } : { ok: false, error: r.error ?? "failed" };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskDeletePlan, async (_e, arg: unknown): Promise<DiskDeletePlanView> => {
    const a = (arg ?? {}) as { paths?: unknown; mode?: unknown };
    const ps = cleanPaths(a.paths);
    if (!ps.ok) return { ok: false, error: ps.error };
    const mode = cleanMode(a.mode);
    if (!mode.ok) return { ok: false, error: mode.error };
    try {
      const r = await client.deletePlan(ps.value, { mode: mode.value });
      if (!r.ok) return { ok: false, error: r.error ?? "failed" };
      return {
        ok: true,
        mode: mode.value,
        items: r.items ?? [],
        worstRisk: r.worstRisk ?? null,
        total: r.total ?? 0,
        requiresPhrase: r.requiresPhrase === true,
      };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskDelete, async (_e, arg: unknown): Promise<DiskDeleteRunView> => {
    const a = (arg ?? {}) as {
      paths?: unknown;
      mode?: unknown;
      confirm?: unknown;
      ackHighRisk?: unknown;
    };
    if (a.confirm !== true) return { ok: false, error: "a delete needs confirm: true" };
    const ps = cleanPaths(a.paths);
    if (!ps.ok) return { ok: false, error: ps.error };
    const mode = cleanMode(a.mode);
    if (!mode.ok) return { ok: false, error: mode.error };
    try {
      const r = await client.deleteConfirm(ps.value, {
        mode: mode.value,
        ackHighRisk: a.ackHighRisk === true,
      });
      return r.ok
        ? { ok: (r.results ?? []).every((x) => x.ok), results: r.results ?? [] }
        : { ok: false, error: r.error ?? "failed" };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskRescanAsRoot, async (_e, arg: unknown): Promise<DiskMapView> => {
    const a = (arg ?? {}) as { path?: unknown };
    const p = cleanPath(a.path);
    if (!p.ok) return { ok: false, error: p.error };
    const gate = deps.gate?.();
    if (!gate) return { ok: false, error: "the privileged gate is not available" };
    try {
      const r = await client.privilegedRescan(p.value);
      if (!r.ok || !r.argv)
        return { ok: false, error: r.error ?? "could not build the root command" };
      const res = await gate.requestAndRun(
        {
          argv: r.argv,
          cwd: r.cwd ?? "/",
          why: r.why ?? `measure ${p.value} as root`,
          surface: "studio",
          requester: "Studio: Rescan as root",
        },
        // the whole map comes back on stdout — keep all of it, not the gate's 1 MiB default
        { captureBytes: ROOT_MAP_CAPTURE_BYTES },
      );
      if (res.decision !== "approved") {
        return {
          ok: false,
          decision: res.decision,
          error: res.reason ?? `not run (${res.decision})`,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          decision: res.decision,
          error: res.reason ?? `the root scan failed (exit ${res.exitCode})`,
        };
      }
      if (res.outputTruncated) {
        return {
          ok: false,
          decision: res.decision,
          error: "the root map was too large to keep — rescan a deeper folder",
        };
      }
      const parsed = JSON.parse(res.stdout ?? "") as {
        tree?: DiskNodeView;
        summary?: DiskMapView["summary"];
      };
      if (!parsed.tree) return { ok: false, error: "the root scan returned no tree" };
      return {
        ok: true,
        asRoot: true,
        decision: res.decision,
        tree: parsed.tree,
        ...(parsed.summary ? { summary: parsed.summary } : {}),
      };
    } catch (e) {
      return { ok: false, error: errOf(e) };
    }
  });

  ipcMain.handle(IPC.diskOpenAdmin, async (e, arg: unknown): Promise<DiskAdminResultView> => {
    const sender = (e as { sender?: IpcSender } | undefined)?.sender;
    if (!sender) return { ok: false, error: "no window asked for it" };
    if (!deps.rootWindow) return { ok: false, error: "the root terminal window is not available" };
    if (admin) return { ok: false, error: "an administrator session is already open" };
    const a = (arg ?? {}) as { path?: unknown };
    let path: string | undefined;
    if (a.path !== undefined) {
      const p = cleanPath(a.path);
      if (!p.ok) return { ok: false, error: p.error };
      path = p.value;
    }
    const gate = deps.gate?.();
    if (!gate) return { ok: false, error: "the privileged gate is not available" };
    const openWindow = deps.rootWindow;
    const ac = new AbortController();
    let handle: { write(d: string): void; resize(c: number, r: number): void } | null = null;
    let win: RootTerminalWindow | null = null;
    let stoppedByHuman = false;
    /** the program has drawn: until then keys are dropped, never buffered for root to read */
    let live = false;
    let cursor = { appCursor: false, tail: "" };
    const stop = (): void => {
      stoppedByHuman = true;
      ac.abort();
    };
    const session: AdminSessionState = {
      owner: sender.id,
      view: undefined,
      resize: (c, r) => handle?.resize(c, r),
      ready: () => win?.ready(),
      stop,
    };
    admin = session;
    // a key from the root window's physical keyboard (before-input-event), never from IPC
    const onKey = (input: KeyInput): void => {
      const bytes = keyToTerminalBytes(input, { appCursor: cursor.appCursor });
      if (bytes === null) return;
      if (bytes === CTRL_D) {
        stop();
        return;
      }
      if (live) handle?.write(bytes);
    };
    // the panel's window going away by any route ends the root program too
    const end = (): void => ac.abort();
    const onNavigate = (details?: { isMainFrame?: boolean; isSameDocument?: boolean }): void => {
      if (details?.isMainFrame === false || details?.isSameDocument) return;
      ac.abort();
    };
    sender.once?.("destroyed", end);
    sender.on?.("did-start-navigation", onNavigate as never);
    sender.on?.("render-process-gone", end);
    try {
      const r = await client.privilegedExplorer(path);
      if (!r.ok || !r.argv) {
        return { ok: false, error: r.error ?? "could not build the root command" };
      }
      const paths = toolPaths();
      const res = await gate.requestAndRun(
        {
          argv: r.argv,
          cwd: r.cwd ?? "/",
          why: r.why ?? "explore the whole disk as root",
          surface: "studio",
          requester: "Studio: Disk space as administrator",
        },
        {
          signal: ac.signal,
          timeoutMs: ADMIN_SESSION_TIMEOUT_MS,
          captureBytes: ADMIN_CAPTURE_BYTES,
          onOutput: (chunk) => {
            cursor = cursorKeysMode(cursor, chunk);
            if (!live) {
              live = true;
              win?.status("");
              win?.focus();
            }
            win?.data(chunk);
          },
          terminal: {
            python: absoluteExecutable(paths.python),
            ptyHost: paths.ptyHost,
            cols: ROOT_WINDOW_COLS,
            rows: ROOT_WINDOW_ROWS,
            onStart: (h) => {
              handle = h;
              // opened only now — after the approval — and not focused until the program
              // draws, so it never covers the system password dialog
              win = openWindow({ onKey, onClosed: stop });
              session.view = win.webContentsId;
              win.status("Enter your password in the system dialog…");
            },
          },
        },
      );
      if (res.decision !== "approved") {
        return {
          ok: false,
          decision: res.decision,
          error: res.reason ?? `not run (${res.decision})`,
        };
      }
      const clean = res.exitCode === 0 || stoppedByHuman;
      return {
        ok: clean,
        decision: res.decision,
        ...(res.exitCode !== undefined ? { exitCode: res.exitCode } : {}),
        ...(!clean ? { error: res.reason ?? `disk-space ended (exit ${res.exitCode})` } : {}),
      };
    } catch (err) {
      return { ok: false, error: errOf(err) };
    } finally {
      (win as RootTerminalWindow | null)?.close();
      sender.removeListener?.("did-start-navigation", onNavigate as never);
      sender.removeListener?.("render-process-gone", end);
      if (admin === session) admin = null;
    }
  });

  // the root window's xterm fits itself and reports its size; only that window may
  ipcMain.on(IPC.diskAdminResize, (e, arg: unknown) => {
    if (!admin || admin.view === undefined || senderId(e) !== admin.view) return;
    const a = (arg ?? {}) as { cols?: unknown; rows?: unknown };
    admin.resize(
      intIn(a.cols, 20, 1000, ROOT_WINDOW_COLS),
      intIn(a.rows, 5, 500, ROOT_WINDOW_ROWS),
    );
  });

  // the root window's page has subscribed: release what main held for it
  ipcMain.on(IPC.diskAdminReady, (e) => {
    if (admin && admin.view !== undefined && senderId(e) === admin.view) admin.ready();
  });

  // Stop: the panel that opened it, or the root window itself
  ipcMain.on(IPC.diskAdminStop, (e) => {
    const id = senderId(e);
    if (admin && id !== undefined && (id === admin.owner || id === admin.view)) admin.stop();
  });

  return () => {
    admin?.stop();
    for (const ch of [IPC.diskAdminResize, IPC.diskAdminStop, IPC.diskAdminReady]) {
      ipcMain.removeAllListeners(ch);
    }
    for (const ch of [
      IPC.diskMounts,
      IPC.diskMap,
      IPC.diskLevels,
      IPC.diskFiles,
      IPC.diskDeletePlan,
      IPC.diskDelete,
      IPC.diskRescanAsRoot,
      IPC.diskOpenAdmin,
    ]) {
      ipcMain.removeHandler(ch);
    }
  };
}
