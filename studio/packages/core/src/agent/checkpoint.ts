// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/checkpoint.ts — per-agent-turn workspace checkpoint (file 14 E2).
 *
 * opencode reverts the ENTIRE working-tree delta of a message — including agent `bash`
 * side-effects — via a per-message snapshot. ChangeSet (07 §7.4) only captures
 * AI-authored FileEdits, so exact revert needs a checkpoint layer: a git-stash-like
 * snapshot taken BEFORE each turn; restore is exact + includes bash writes. PURE model
 * + diff/restore-plan; the actual snapshot bytes come from an injected fs/git seam
 * (C8-supervised). `.gitignore`/large-file aware so secrets/binaries never get captured.
 */
import { globMatch } from "../agents/sandbox.js";

/** A captured pre-turn snapshot of the workspace files (E2). */
import { utf8Length } from "./bytes.js";

export interface Checkpoint {
  id: string;
  sessionId: string;
  turnNumber: number;
  createdAt: string;
  label?: string;
  /** path → content for every captured file (the restore source). */
  files: Record<string, string>;
  /**
   * Paths that DID NOT EXIST when this checkpoint was taken.
   *
   * The one fact `files` cannot carry. A file the agent CREATES has no previous content, and
   * the capture hook recorded that as `files[path] = ""` — indistinguishable from a file that
   * existed and was empty. `/revert` therefore wrote an empty file back where the correct
   * answer was to remove it, and the user was left with a tree full of zero-byte files their
   * build now had to explain. Recorded as a separate list rather than by making `files`
   * nullable so an older checkpoint on disk still loads and still means what it meant.
   */
  absent?: string[];
  /**
   * Paths this turn CHANGED but could not capture — a binary or unreadable file overwritten
   * by write_file. Nothing can be written back for them, but they still claim the turn: a
   * turn whose only change was one of these had no checkpoint at all, so /revert silently
   * undid the PREVIOUS turn instead. They also claim the path for first-touch, so a later
   * edit in the same turn cannot pass off an intermediate state as the pre-turn one.
   */
  unrevertable?: string[];
}

/** What to never snapshot (secrets / build dirs / large binaries; E2 / §2.6 #4). */
export interface SnapshotPolicy {
  ignore?: string[];
  maxBytes?: number;
}

const DEFAULT_IGNORE: readonly string[] = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/dist/**",
  "**/out/**",
  "**/__pycache__/**",
];

/** Whether a file is eligible for the checkpoint (E2 ignore + size guard). */
export function shouldSnapshot(
  path: string,
  content: string,
  policy: SnapshotPolicy = {},
): boolean {
  const ignore = [...DEFAULT_IGNORE, ...(policy.ignore ?? [])];
  if (ignore.some((g) => globMatch(g, path))) return false;
  const max = policy.maxBytes ?? 2_000_000; // 2 MB
  if (utf8Length(content) > max) return false;
  return true;
}

/** Build a checkpoint from a map of current file contents, applying the policy. */
export function makeCheckpoint(
  id: string,
  sessionId: string,
  turnNumber: number,
  now: string,
  files: Record<string, string>,
  policy: SnapshotPolicy = {},
  label?: string,
): Checkpoint {
  const captured: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (shouldSnapshot(path, content, policy)) captured[path] = content;
  }
  return {
    id,
    sessionId,
    turnNumber,
    createdAt: now,
    ...(label ? { label } : {}),
    files: captured,
  };
}

/** A restore plan: which files to rewrite, and which to DELETE (created after the snapshot). */
export interface RestorePlan {
  /** path → the content to write back. */
  write: Record<string, string>;
  /**
   * Files to REMOVE to revert exactly.
   *
   * Two sources: paths observed now that were not in the snapshot, and paths the capture hook
   * explicitly recorded as absent. The second is the one that was missing — the hook is the
   * only thing that knows a `write_file` created a file rather than overwriting one, and
   * without it a create reverted to an empty file instead of to nothing.
   */
  delete: string[];
}

/**
 * Compute the exact restore plan to revert the workspace to a checkpoint (E2): rewrite
 * every captured file, and delete any file that exists now but wasn't in the snapshot
 * (so agent `bash` *creations* are undone too). Pure — the caller performs the IO.
 */
export function restorePlan(checkpoint: Checkpoint, currentPaths: readonly string[]): RestorePlan {
  const absent = new Set(checkpoint.absent ?? []);
  const snapPaths = new Set(Object.keys(checkpoint.files));
  // A path recorded as ABSENT is deleted, never written. It is filtered out of `write` too,
  // because a capture that recorded both (an older checkpoint, or a file created and then
  // edited in the same turn) must resolve to "it was not there", which is the earlier truth.
  const write: Record<string, string> = {};
  for (const [p, content] of Object.entries(checkpoint.files)) {
    if (!absent.has(p)) write[p] = content;
  }
  const created = currentPaths.filter((p) => !snapPaths.has(p) && shouldSnapshot(p, ""));
  return {
    write,
    // de-duplicated: a path can be both recorded-absent and observed-now.
    delete: [...new Set([...absent, ...created])],
  };
}

/**
 * How many paths this checkpoint would touch on revert.
 *
 * `Object.keys(cp.files).length` is no longer that number: a path the turn CREATED lives in
 * `absent`, not in `files`. A `/checkpoints` list that counted only `files` reported "1 file"
 * for a turn that wrote one file and created three, which is exactly the case where the user
 * most wants to know how much a revert is about to move.
 */
export function checkpointSize(cp: Checkpoint): number {
  return new Set([...Object.keys(cp.files), ...(cp.absent ?? []), ...(cp.unrevertable ?? [])]).size;
}

/** Paths that changed between a checkpoint and the current files (added/modified/deleted). */
export function changedPaths(
  checkpoint: Checkpoint,
  current: Record<string, string>,
): { added: string[]; modified: string[]; deleted: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, content] of Object.entries(current)) {
    if (!(p in checkpoint.files)) added.push(p);
    else if (checkpoint.files[p] !== content) modified.push(p);
  }
  for (const p of Object.keys(checkpoint.files)) {
    if (!(p in current)) deleted.push(p);
  }
  return { added, modified, deleted };
}

/* ── an in-memory store (persistence injected; C8-supervised on disk) ──────── */

/** A bounded in-memory checkpoint store (the caller persists to `.prometheus/`). */
export class CheckpointStore {
  private readonly map = new Map<string, Checkpoint>();
  private readonly capacity: number;
  constructor(capacity = 100) {
    this.capacity = capacity;
  }

  record(checkpoint: Checkpoint): void {
    this.map.set(checkpoint.id, checkpoint);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  get(id: string): Checkpoint | undefined {
    return this.map.get(id);
  }
  list(sessionId?: string): Checkpoint[] {
    const all = [...this.map.values()];
    return sessionId ? all.filter((c) => c.sessionId === sessionId) : all;
  }
  delete(id: string): boolean {
    return this.map.delete(id);
  }
  get size(): number {
    return this.map.size;
  }
}
