/**
 * main/ide/history-store.ts — the MAIN-side Local History manager (APP-063, file 13 §2.6).
 *
 * Wraps the PURE core `localHistory` model with the IO it deliberately leaves to the caller:
 * a per-WORKSPACE capped ring of file snapshots, persisted to `<userData>/local-history/
 * <hash>.json` (debounced write-behind, atomic temp+rename so a crash can't corrupt it) and
 * reloaded on workspace bind (corrupt → fresh history, fail-soft, NEVER blocks a save).
 *
 * Capture happens in the `ide:fsWrite` handler BEFORE the write — the PRE-write on-disk
 * content is snapshotted (so revert-by-one-step lands on the previous state, not the buffer
 * being written). node:fs + core only — no electron — so it's node:test-covered with a tmp
 * userData dir + injected clock.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { localHistory } from "@prometheus/core";

type LocalHistory = localHistory.LocalHistory;

/** One timeline entry as the renderer receives it (ts + label + delta from the prior rev). */
export interface HistoryEntryView {
  ts: number;
  label?: string;
  added: number;
  removed: number;
}

export interface LocalHistoryManagerOptions {
  /** the dir history JSON files live in, e.g. `<userData>/local-history`. */
  dir: string;
  /** injectable clock (ms epoch) for deterministic tests. */
  now?: () => number;
  /** write-behind debounce (ms). Default 1500. */
  debounceMs?: number;
}

/** A stable filename for a workspace root (content-addressed, collision-safe). */
export function workspaceHash(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export class LocalHistoryManager {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly histories = new Map<string, LocalHistory>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeRoot: string | null = null;

  constructor(opts: LocalHistoryManagerOptions) {
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
    this.debounceMs = opts.debounceMs ?? 1500;
  }

  private fileFor(root: string): string {
    return join(this.dir, `${workspaceHash(root)}.json`);
  }

  /** Bind (+ lazily load) a workspace root as the active capture target. */
  async bind(root: string): Promise<void> {
    this.activeRoot = root;
    if (this.histories.has(root)) return;
    let history = localHistory.createLocalHistory();
    try {
      history = localHistory.deserializeHistory(await readFile(this.fileFor(root), "utf8"));
    } catch {
      /* missing/corrupt → fresh history (fail-soft) */
    }
    this.histories.set(root, history);
  }

  /** Snapshot `content` for `path` into the active workspace's history (+ schedule persist).
   *  A no-op when nothing is bound or the capture policy (globs/size) rejects it. */
  capture(path: string, content: string, label = "save"): void {
    const root = this.activeRoot;
    if (!root) return;
    const cur = this.histories.get(root) ?? localHistory.createLocalHistory();
    const next = localHistory.recordSnapshot(cur, {
      path,
      content,
      ts: this.now(),
      label,
    });
    if (next === cur) return; // policy rejected → nothing to persist
    this.histories.set(root, next);
    this.schedulePersist(root);
  }

  /** The timeline for a file (newest → oldest) with each rev's line delta from the prior. */
  list(root: string, path: string): HistoryEntryView[] {
    const history = this.histories.get(root);
    if (!history) return [];
    const snaps = localHistory.snapshotsFor(history, path); // newest → oldest
    return snaps.map((s, i) => {
      const older = snaps[i + 1]?.content ?? "";
      const d = localHistory.lineDelta(older, s.content);
      return {
        ts: s.ts,
        ...(s.label ? { label: s.label } : {}),
        added: d.added,
        removed: d.removed,
      };
    });
  }

  /** The content of a specific revision (uri+ts), or undefined. */
  read(root: string, path: string, ts: number): string | undefined {
    const history = this.histories.get(root);
    return history ? localHistory.revertContent(history, path, ts) : undefined;
  }

  /** Persist NOW (flush) — used on dispose so no revision is lost on quit. */
  async flush(): Promise<void> {
    const roots = [...this.timers.keys()];
    for (const root of roots) {
      const t = this.timers.get(root);
      if (t) clearTimeout(t);
      this.timers.delete(root);
      await this.persist(root);
    }
  }

  private schedulePersist(root: string): void {
    const prev = this.timers.get(root);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(root);
      void this.persist(root);
    }, this.debounceMs);
    if (typeof t.unref === "function") t.unref();
    this.timers.set(root, t);
  }

  private async persist(root: string): Promise<void> {
    const history = this.histories.get(root);
    if (!history) return;
    const file = this.fileFor(root);
    try {
      await mkdir(dirname(file), { recursive: true });
      const tmp = join(dirname(file), `.${workspaceHash(root)}.${this.now()}.tmp`);
      await writeFile(tmp, localHistory.serializeHistory(history), "utf8");
      await rename(tmp, file); // atomic within the dir
    } catch {
      /* a persist failure must never block a save — the history stays in-memory */
    }
  }
}
