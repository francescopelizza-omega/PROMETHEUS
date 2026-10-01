// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/inline-diff.ts — PURE line diff for the Cmd-K/Cmd-I inline-edit before/after view (APP-092).
 *
 * The inline-edit overlay streams a proposed REPLACEMENT for the selection; this computes a
 * line-level diff (LCS) between the original selection and the proposal so the overlay can
 * render removed/added/context lines with token colors before Accept/Reject. No react/monaco —
 * node:test-able.
 */

export type DiffLineType = "ctx" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * A line-level diff (before → after) via a longest-common-subsequence backtrace. Deletions
 * (only in `before`) come out as `del`, additions (only in `after`) as `add`, unchanged lines
 * as `ctx`. Order preserves the after-file reading order with deletions shown at their point.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS length table (n+1 × m+1).
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i]! });
    i += 1;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j]! });
    j += 1;
  }
  return out;
}

/** Counts of added/removed lines for the diff summary ("+3 −1"). */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added += 1;
    else if (l.type === "del") removed += 1;
  }
  return { added, removed };
}
