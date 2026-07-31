/**
 * local-history/history.ts — git-independent file-snapshot history (file 13 §2.6).
 *
 * A Studio-owned timeline of file snapshots (every save + significant edit) with diff +
 * revert — it survives where git doesn't (uncommitted work). Pure: snapshots live in a
 * capped `RingBuffer` (bounded disk); persistence is the caller's. A capture policy
 * honors never-capture globs + a max size so secrets / large binaries never enter the
 * history (§2.6 open-question #4). The heavy 2-way/3-way diff is 07's Monaco; here we
 * provide the lightweight line delta the timeline list shows.
 */
import { globMatch } from "../agents/sandbox.js";
import { type RingBuffer, createRingBuffer, push, recent } from "./ringBuffer.js";

/** One captured file snapshot (§2.6). */
export interface FileSnapshot {
  path: string;
  content: string;
  ts: number; // ms epoch (passed in — pure)
  label?: string; // "save" | "before refactor" | …
}

/** The Local History state — a capped ring of snapshots (§2.6). */
export type LocalHistory = RingBuffer<FileSnapshot>;

/** Default cap: 500 snapshots (bounded disk; §2.6 retention). */
export const DEFAULT_HISTORY_CAP = 500;

export function createLocalHistory(cap: number = DEFAULT_HISTORY_CAP): LocalHistory {
  return createRingBuffer<FileSnapshot>(cap);
}

/** The capture policy — what NEVER enters the history (§2.6 #4). */
export interface CapturePolicy {
  /** globs to never capture (secrets, build dirs, large binaries). */
  neverCapture?: string[];
  /** skip files whose content exceeds this many bytes (large binaries). */
  maxBytes?: number;
}

const DEFAULT_NEVER: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/*.lock",
];

/** Decide whether a file may be snapshotted (§2.6 #4 — never-capture globs + size). */
export function shouldCapture(path: string, content: string, policy: CapturePolicy = {}): boolean {
  const never = [...DEFAULT_NEVER, ...(policy.neverCapture ?? [])];
  if (never.some((g) => globMatch(g, path))) return false;
  const max = policy.maxBytes ?? 1_000_000; // 1 MB default
  if (Buffer.byteLength(content, "utf8") > max) return false;
  return true;
}

/** Record a snapshot if the capture policy allows it; else return the history unchanged. */
export function recordSnapshot(
  history: LocalHistory,
  snapshot: FileSnapshot,
  policy: CapturePolicy = {},
): LocalHistory {
  if (!shouldCapture(snapshot.path, snapshot.content, policy)) return history;
  return push(history, snapshot);
}

/** All snapshots for a path, newest → oldest (the §2.6 timeline). */
export function snapshotsFor(history: LocalHistory, path: string): FileSnapshot[] {
  return recent(history).filter((s) => s.path === path);
}

/** The latest snapshot for a path, or undefined. */
export function latestFor(history: LocalHistory, path: string): FileSnapshot | undefined {
  return snapshotsFor(history, path)[0];
}

/** The content to revert a file to (a specific snapshot ts), or undefined. */
export function revertContent(history: LocalHistory, path: string, ts: number): string | undefined {
  return snapshotsFor(history, path).find((s) => s.ts === ts)?.content;
}

/** A lightweight line delta for the timeline (the rich diff is 07's Monaco). */
export interface LineDelta {
  added: number;
  removed: number;
  changed: boolean;
}

/** Count added/removed lines between two contents (LCS-free, set-based estimate). */
export function lineDelta(prev: string, next: string): LineDelta {
  if (prev === next) return { added: 0, removed: 0, changed: false };
  const a = prev.split("\n");
  const b = next.split("\n");
  const aCount = new Map<string, number>();
  for (const line of a) aCount.set(line, (aCount.get(line) ?? 0) + 1);
  const bCount = new Map<string, number>();
  for (const line of b) bCount.set(line, (bCount.get(line) ?? 0) + 1);
  let added = 0;
  let removed = 0;
  for (const [line, n] of bCount) added += Math.max(0, n - (aCount.get(line) ?? 0));
  for (const [line, n] of aCount) removed += Math.max(0, n - (bCount.get(line) ?? 0));
  return { added, removed, changed: true };
}

/* ── serialization (caller persists to .prometheus/history/) ───────────────── */

/** Serialize the history to a JSON string (the caller writes the file). */
export function serializeHistory(history: LocalHistory): string {
  return JSON.stringify({ capacity: history.capacity, items: history.items });
}

/** Parse a serialized history (fail-soft → a fresh empty history on bad input). */
export function deserializeHistory(json: string, cap: number = DEFAULT_HISTORY_CAP): LocalHistory {
  try {
    const parsed = JSON.parse(json) as { capacity?: number; items?: unknown };
    const capacity = typeof parsed.capacity === "number" ? parsed.capacity : cap;
    const items = Array.isArray(parsed.items)
      ? (parsed.items.filter(
          (s): s is FileSnapshot =>
            typeof s === "object" && s !== null && typeof (s as FileSnapshot).path === "string",
        ) as FileSnapshot[])
      : [];
    let buf = createLocalHistory(capacity);
    for (const item of items) buf = push(buf, item);
    return buf;
  } catch {
    return createLocalHistory(cap);
  }
}
