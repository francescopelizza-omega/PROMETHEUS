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
export interface Checkpoint {
  id: string;
  sessionId: string;
  turnNumber: number;
  createdAt: string;
  label?: string;
  /** path → content for every captured file (the restore source). */
  files: Record<string, string>;
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
  if (Buffer.byteLength(content, "utf8") > max) return false;
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
  /** files that exist now but were absent at checkpoint time → delete to revert exactly. */
  delete: string[];
}

/**
 * Compute the exact restore plan to revert the workspace to a checkpoint (E2): rewrite
 * every captured file, and delete any file that exists now but wasn't in the snapshot
 * (so agent `bash` *creations* are undone too). Pure — the caller performs the IO.
 */
export function restorePlan(checkpoint: Checkpoint, currentPaths: readonly string[]): RestorePlan {
  const snapPaths = new Set(Object.keys(checkpoint.files));
  return {
    write: { ...checkpoint.files },
    delete: currentPaths.filter((p) => !snapPaths.has(p) && shouldSnapshot(p, "")),
  };
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
