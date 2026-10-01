// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/fuzzy.ts — the PURE command-palette / quick-open fuzzy matcher (§8).
 *
 * `CommandPalette.tsx` (Cmd-Shift-P commands, Cmd-P quick-open files) ranks its
 * entries with this matcher. It is a small, deterministic subsequence scorer in the
 * VS-Code/Cursor spirit: every query char must appear IN ORDER in the candidate;
 * contiguous runs, word-boundary hits (after `/ . _ - space`), and a prefix match
 * score higher; case-insensitive with a case-exact bonus. Returns the matched char
 * indices so the UI can bold them.
 *
 * Framework-free — NO react / monaco / electron — so the ranking is testable in
 * isolation (file 07 build-notes: "command-palette fuzzy match"). Node built-ins
 * only.
 */

/** A scored fuzzy match: the score, the matched char indices, and the item. */
export interface FuzzyMatch<T> {
  item: T;
  score: number;
  /** indices into the candidate string that matched (ascending) — for bolding. */
  positions: number[];
}

const WORD_BOUNDARY = new Set(["/", "\\", ".", "_", "-", " ", ":"]);

/** Whether candidate index `i` starts a word (first char or after a separator). */
function isBoundary(candidate: string, i: number): boolean {
  return i === 0 || WORD_BOUNDARY.has(candidate[i - 1] ?? "");
}

/** The per-match reward for aligning query char `qi` at candidate index `i`. */
function matchReward(
  query: string,
  candidate: string,
  qi: number,
  i: number,
  contiguous: boolean,
): number {
  let pts = 1; // base
  if (contiguous) pts += 6; // continues a contiguous run (fzf-style; dominates)
  if (isBoundary(candidate, i)) pts += 4; // start of a word
  if (i === 0 && qi === 0) pts += 8; // prefix of the whole candidate
  if (candidate[i] === query[qi]) pts += 1; // case-exact
  return pts;
}

/**
 * Score one candidate against a query (case-insensitive subsequence) via an OPTIMAL
 * alignment — not a greedy earliest-match. Returns null when the query is NOT a
 * subsequence of the candidate. Higher = better. A small DP (fzf-style) maximises the
 * total reward over every valid alignment so a contiguous, word-aligned run ("runner"
 * inside "…/runner.py") beats a scattered earliest-char match ("…s**r**c…runner"),
 * and a clean prefix beats a separator-spread match. Deterministic; O(n·m) — fine for
 * the short strings a palette/quick-open ranks.
 */
export function fuzzyScore(
  query: string,
  candidate: string,
): { score: number; positions: number[] } | null {
  if (query === "") return { score: 1, positions: [] };
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const n = q.length;
  const m = c.length;
  if (n > m) return null;

  const NEG = Number.NEGATIVE_INFINITY;
  // best[qi][i] = best score aligning q[0..qi] with q[qi] placed exactly at c[i].
  const best: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(NEG));
  // back[qi][i] = the chosen index of q[qi-1] in the optimal alignment (for positions).
  const back: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(-1));

  for (let i = 0; i < m; i++) {
    if (c[i] === q[0]) best[0]![i] = matchReward(query, candidate, 0, i, false);
  }
  for (let qi = 1; qi < n; qi++) {
    for (let i = qi; i < m; i++) {
      if (c[i] !== q[qi]) continue;
      // q[qi] at i must follow q[qi-1] at some prev < i.
      let bestPrev = NEG;
      let bestPrevIdx = -1;
      for (let p = qi - 1; p < i; p++) {
        const prevScore = best[qi - 1]![p]!;
        if (prevScore === NEG) continue;
        const contiguous = p === i - 1;
        const gapPenalty = contiguous ? 0 : Math.min(i - p - 1, 3);
        const cand = prevScore + matchReward(query, candidate, qi, i, contiguous) - gapPenalty;
        if (cand > bestPrev) {
          bestPrev = cand;
          bestPrevIdx = p;
        }
      }
      best[qi]![i] = bestPrev;
      back[qi]![i] = bestPrevIdx;
    }
  }

  // pick the best end index for the last query char.
  let endIdx = -1;
  let endScore = NEG;
  for (let i = n - 1; i < m; i++) {
    const s = best[n - 1]![i]!;
    if (s > endScore) {
      endScore = s;
      endIdx = i;
    }
  }
  if (endIdx === -1 || endScore === NEG) return null;

  // backtrack the chosen positions.
  const positions: number[] = new Array<number>(n);
  let qi = n - 1;
  let i = endIdx;
  while (qi >= 0) {
    positions[qi] = i;
    i = back[qi]![i]!;
    qi--;
  }

  // shorter candidates that fully matched rank slightly higher (tighter match).
  const score = endScore + Math.max(0, 10 - (candidate.length - query.length) * 0.1);
  return { score, positions };
}

/**
 * Rank a list of items by the fuzzy score of `keyOf(item)` against the query, best
 * first. Non-matching items are dropped. A blank query returns the items unchanged
 * (score 1, no positions) so the palette shows everything in its natural order. The
 * sort is STABLE on equal scores (original order preserved) for predictable UI.
 */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  keyOf: (item: T) => string,
): FuzzyMatch<T>[] {
  const trimmed = query.trim();
  if (trimmed === "") {
    return items.map((item) => ({ item, score: 1, positions: [] }));
  }
  const scored: { m: FuzzyMatch<T>; i: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const r = fuzzyScore(trimmed, keyOf(item));
    if (r) scored.push({ m: { item, score: r.score, positions: r.positions }, i });
  }
  scored.sort((a, b) => b.m.score - a.m.score || a.i - b.i);
  return scored.map((s) => s.m);
}

/**
 * Split a candidate into alternating [plain, matched, plain, matched, …] segments
 * given the matched positions, so the UI can render bold runs without index math.
 * Pure; positions must be ascending + in-range (fuzzyScore guarantees this).
 */
export interface HighlightSegment {
  text: string;
  matched: boolean;
}

export function highlightSegments(
  candidate: string,
  positions: readonly number[],
): HighlightSegment[] {
  if (positions.length === 0) return candidate === "" ? [] : [{ text: candidate, matched: false }];
  const set = new Set(positions);
  const segments: HighlightSegment[] = [];
  let cur = "";
  let curMatched = set.has(0);
  for (let i = 0; i < candidate.length; i++) {
    const m = set.has(i);
    if (m === curMatched) {
      cur += candidate[i];
    } else {
      if (cur !== "") segments.push({ text: cur, matched: curMatched });
      cur = candidate[i]!;
      curMatched = m;
    }
  }
  if (cur !== "") segments.push({ text: cur, matched: curMatched });
  return segments;
}
