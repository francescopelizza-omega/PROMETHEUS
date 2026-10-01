// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/fs-watch.ts — the file-tree watcher + fs read/write/tree (file 07 §6 / §3.2).
 *
 * The MAIN process owns the filesystem (C5: the renderer never touches Node fs).
 * This module provides:
 *   - a DEBOUNCED recursive watcher (node:fs.watch; chokidar is an OPTIONAL dep,
 *     wired by injecting a different watcher factory) → coalesced change events the
 *     renderer turns into tree refreshes,
 *   - fs READ / WRITE (the `fs:read` / `fs:write` channels), and
 *   - a LAZY tree (`fs:tree`): children are loaded on expand, not eagerly, so a
 *     huge repo never blocks (file 07 §3.2).
 *
 * Decoupled + testable: the watcher is created through an INJECTABLE factory
 * (defaults to node:fs.watch) so the debounce/coalesce logic is driven by a fake
 * emitter in tests; the debounce timer is injectable too. The fs read/write/tree
 * use node:fs/promises directly (stdlib — allowed in the main process).
 *
 * Node built-ins only: node:fs, node:fs/promises, node:path, node:events.
 */

import { EventEmitter } from "node:events";
import { type FSWatcher, watch as nodeWatch } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

/* ------------------------------------------------------------------------- *
 * Tree shape (file 07 §3.2)
 * ------------------------------------------------------------------------- */

/** One node in the lazy file tree. */
export interface TreeNode {
  /** absolute path. */
  path: string;
  name: string;
  kind: "file" | "dir";
  /** dirs only: true until their children have been loaded (lazy expand). */
  hasChildren?: boolean;
}

/** A debounced, coalesced change event (a SET of touched dirs, file 07 §6). */
export interface FsChangeEvent {
  /** the watched root this batch belongs to. */
  root: string;
  /** the distinct paths that changed in the debounce window. */
  paths: string[];
}

/* ------------------------------------------------------------------------- *
 * fs read / write / tree (the `fs:*` data path)
 * ------------------------------------------------------------------------- */

/** A file read result (text + the detected encoding). */
export interface FsReadResult {
  text: string;
  encoding: string;
}

/** files > this size open read-only in "large file mode" (file 07 §3.1). */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;

/** Read a file as UTF-8 text (file 07 §3.2 `fs:read`). Rejects on a missing file. */
export async function fsRead(path: string): Promise<FsReadResult> {
  const buf = await readFile(path);
  return { text: buf.toString("utf-8"), encoding: "utf-8" };
}

/** Is a file large enough to force read-only / no-LSP "large file mode" (§3.1)? */
export async function isLargeFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.size > LARGE_FILE_BYTES;
  } catch {
    return false;
  }
}

/** Write text to a file as UTF-8 (file 07 §3.2 `fs:write`). The MAIN process owns fs. */
export async function fsWrite(path: string, text: string): Promise<void> {
  await writeFile(path, text, "utf-8");
}

/* ── full-repo walk (APP-065): flat file list honoring ignore rules ─────────── */

/** Directory basenames pruned BEFORE descent — the perf gate (never walk node_modules). */
const WALK_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "target",
  "coverage",
  ".turbo",
]);
/** File extensions skipped as binary/uninteresting (cheaper than reading + NUL-sniffing). */
const WALK_BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".so",
  ".dylib",
  ".dll",
  ".node",
  ".wasm",
  ".class",
  ".pyc",
  ".lock",
]);
const WALK_MAX_DEPTH = 32; // symlink-loop backstop even though we skip symlinks

export interface FsWalkOptions {
  /** skip files larger than this (defaults to LARGE_FILE_BYTES = 5 MB). */
  maxBytes?: number;
  /** hard cap on returned files (a runaway backstop for pathological repos). */
  maxFiles?: number;
}

/**
 * Walk `root` recursively → a FLAT list of absolute file paths, pruning WALK_IGNORE_DIRS at
 * the directory level (before descent), NEVER following symlinks (loop-safe), skipping binary
 * extensions + files over `maxBytes`, and capping depth. One walk replaces N renderer
 * fsTree round-trips (APP-065). Missing/unreadable dirs are skipped, never fatal.
 */
export async function fsWalk(root: string, opts: FsWalkOptions = {}): Promise<string[]> {
  const absRoot = isAbsolute(root) ? root : resolve(root);
  const maxBytes = opts.maxBytes ?? LARGE_FILE_BYTES;
  const maxFiles = opts.maxFiles ?? 200_000;
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH || out.length >= maxFiles) return;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, never fatal
    }
    for (const d of dirents) {
      if (out.length >= maxFiles) return;
      if (d.isSymbolicLink()) continue; // never follow symlinks (cycle guard)
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        if (!WALK_IGNORE_DIRS.has(d.name)) await walk(full, depth + 1);
        continue;
      }
      if (!d.isFile()) continue;
      const dot = d.name.lastIndexOf(".");
      if (dot >= 0 && WALK_BINARY_EXTS.has(d.name.slice(dot).toLowerCase())) continue;
      try {
        const s = await stat(full);
        if (s.size > maxBytes) continue;
      } catch {
        continue;
      }
      out.push(full);
    }
  };
  await walk(absRoot, 0);
  return out;
}

/** Create an EMPTY file, failing if it already exists (`wx` flag) — the explorer's
 *  "New File". The caller path-guards both this + the parent (leap #8 CRUD). */
export async function fsCreateFile(path: string): Promise<void> {
  await writeFile(path, "", { encoding: "utf-8", flag: "wx" });
}

/** Create a directory (NON-recursive — fails if it exists) — the explorer's "New Folder". */
export async function fsMkdir(path: string): Promise<void> {
  await mkdir(path, { recursive: false });
}

/** Rename / move a path. The caller path-guards BOTH src + dest. */
export async function fsRename(src: string, dest: string): Promise<void> {
  await rename(src, dest);
}

/** Delete a file or directory (recursive). Errors if the path is missing (force:false). */
export async function fsDelete(path: string): Promise<void> {
  await rm(path, { recursive: true, force: false });
}

/**
 * List the DIRECT children of `dir` (file 07 §3.2 `fs:tree`, LAZY). Returns one
 * level only — directories carry `hasChildren` so the renderer knows to show an
 * expand arrow without loading them. Sorted dirs-first then name. A read error
 * yields [] (a permission-denied subtree is empty, never a crash).
 */
export async function fsTree(dir: string): Promise<TreeNode[]> {
  // ALWAYS emit ABSOLUTE child paths. A relative root (the editor's default ".") made
  // every child path relative → the tab URI became `file://./foo` whose host is "." →
  // fileURLToPath rejected it → the sensitive-path guard threw "non-absolute path" and
  // EVERY file open failed. Resolving here makes opens work regardless of the root.
  const absDir = isAbsolute(dir) ? dir : resolve(dir);
  let entries: { name: string; isDir: boolean }[];
  try {
    const dirents = await readdir(absDir, { withFileTypes: true });
    entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch {
    return [];
  }
  const nodes: TreeNode[] = [];
  for (const e of entries) {
    const full = join(absDir, e.name);
    if (e.isDir) {
      nodes.push({
        path: full,
        name: e.name,
        kind: "dir",
        hasChildren: await dirHasChildren(full),
      });
    } else {
      nodes.push({ path: full, name: e.name, kind: "file" });
    }
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

/** Cheap "does this dir have any child" probe (for the lazy expand arrow). */
async function dirHasChildren(dir: string): Promise<boolean> {
  try {
    const dirents = await readdir(dir);
    return dirents.length > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------- *
 * The debounced watcher
 * ------------------------------------------------------------------------- */

/** The minimal watcher surface the host relies on (node:fs.FSWatcher / chokidar). */
export interface WatchHandle {
  close(): void;
}

/**
 * The watcher factory (injectable). The default wraps node:fs.watch (recursive)
 * and forwards (eventType, filename) into `onEvent`. A chokidar-backed factory can
 * be injected without changing the host (chokidar is an OPTIONAL dep). A test
 * passes a fake factory it drives manually.
 */
export type WatcherFactory = (
  root: string,
  onEvent: (relPath: string) => void,
  onError: (err: Error) => void,
) => WatchHandle;

/** The default node:fs.watch-backed factory (recursive where the platform supports it). */
export const nodeWatcherFactory: WatcherFactory = (root, onEvent, onError) => {
  let watcher: FSWatcher;
  try {
    watcher = nodeWatch(root, { recursive: true }, (_event, filename) => {
      if (filename) onEvent(String(filename));
    });
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return { close: () => {} };
  }
  watcher.on("error", (e: Error) => onError(e));
  return { close: () => watcher.close() };
};

export interface FsWatchTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const REAL_TIMERS: FsWatchTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h.unref === "function") h.unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface FsWatchHostOptions {
  /** the watcher factory (default: node:fs.watch). */
  watcherFactory?: WatcherFactory;
  /** debounce window (ms) — events inside it coalesce to ONE change batch. Default 200. */
  debounceMs?: number;
  timers?: FsWatchTimers;
}

export interface FsWatchEvents {
  /** a DEBOUNCED, coalesced batch of changes for a watched root. */
  change: [FsChangeEvent];
  /** a watcher error (a watched dir was deleted / EMFILE). */
  error: [{ root: string; message: string }];
}

interface Watch {
  root: string;
  handle: WatchHandle;
  pending: Set<string>;
  timer?: unknown;
  /** How many subscribers asked for this root (see `watch`). */
  refs: number;
}

/**
 * The fs-watch host: one debounced recursive watcher per root, coalescing rapid
 * change bursts (an editor save touches several paths) into ONE `change` batch.
 * Construct ONE per MAIN process. Read/write/tree are the static fns above; this
 * class owns only the watcher lifecycle.
 */
export class FsWatchHost extends EventEmitter {
  private readonly factory: WatcherFactory;
  private readonly debounceMs: number;
  private readonly timers: FsWatchTimers;
  private readonly watches = new Map<string, Watch>();

  constructor(opts: FsWatchHostOptions = {}) {
    super();
    this.factory = opts.watcherFactory ?? nodeWatcherFactory;
    this.debounceMs = opts.debounceMs ?? 200;
    this.timers = opts.timers ?? REAL_TIMERS;
  }

  override on<K extends keyof FsWatchEvents>(
    event: K,
    listener: (...args: FsWatchEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof FsWatchEvents>(event: K, ...args: FsWatchEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Start watching `root` recursively (file 07 §6, `fs:watch`). REFERENCE-COUNTED: a second
   * watch of the same root shares the one watcher, and it is closed only when every watch
   * has been matched by an `unwatch`. It used to be a plain no-op, so two views on the same
   * root (Home's explorer and the editor's, both mounted) shared one watcher and the first
   * to unmount closed it under the other: the editor's explorer silently stopped
   * auto-refreshing on the default navigation path. Change bursts inside the debounce
   * window coalesce into a single `change` event carrying the distinct paths.
   */
  watch(root: string): void {
    const existing = this.watches.get(root);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const entry: Watch = { root, handle: { close: () => {} }, pending: new Set(), refs: 1 };
    entry.handle = this.factory(
      root,
      (relPath) => this.onRawEvent(entry, relPath),
      (err) => this.emit("error", { root, message: err.message }),
    );
    this.watches.set(root, entry);
  }

  /** Release one watch of a root; the watcher closes when the last one is released (and
   *  flushes nothing — the renderer re-lists on demand). */
  unwatch(root: string): void {
    const entry = this.watches.get(root);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.close(root, entry);
  }

  private close(root: string, entry: Watch): void {
    if (entry.timer !== undefined) this.timers.clearTimeout(entry.timer);
    try {
      entry.handle.close();
    } catch {
      /* already closed */
    }
    this.watches.delete(root);
  }

  /** A raw watcher event → buffer + (re)arm the debounce timer. */
  private onRawEvent(entry: Watch, relPath: string): void {
    // node:fs.watch gives a path relative to root; normalise to absolute.
    const abs = relPath.startsWith(entry.root) ? relPath : join(entry.root, relPath);
    entry.pending.add(abs);
    if (entry.timer !== undefined) this.timers.clearTimeout(entry.timer);
    entry.timer = this.timers.setTimeout(() => this.flush(entry), this.debounceMs);
  }

  /** Emit the coalesced batch and reset the buffer. */
  private flush(entry: Watch): void {
    entry.timer = undefined;
    if (entry.pending.size === 0) return;
    const paths = [...entry.pending];
    entry.pending.clear();
    this.emit("change", { root: entry.root, paths });
  }

  /** The roots currently being watched. */
  list(): string[] {
    return [...this.watches.keys()];
  }

  /** Stop every watcher, whatever its reference count (app shutdown). */
  dispose(): void {
    for (const [root, entry] of [...this.watches]) this.close(root, entry);
  }
}

/* ------------------------------------------------------------------------- *
 * Small pure helper
 * ------------------------------------------------------------------------- */

/** The display name of a path (the trailing segment). */
export function displayName(path: string): string {
  return basename(path) || path.split(sep).filter(Boolean).pop() || path;
}
