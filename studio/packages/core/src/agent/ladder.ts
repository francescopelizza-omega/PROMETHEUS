// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/ladder.ts — the DETERMINISTIC fallback ladder that locates a hunk's pre-image
 * when the model's `old` text does not match the file byte-for-byte (WRAPPER Phase A).
 *
 * A model very often reproduces a region with drifted whitespace/indentation. The exact
 * applier (edit.ts) then fails `no-match` and the whole edit dies. This ladder recovers
 * those cases WITHOUT ever guessing: each rung has an explicit predicate, and every rung
 * is unique-or-ambiguous — if a rung's predicate matches more than one site it returns
 * `ambiguous` and STOPS (a laxer rung only gets more ambiguous). If nothing matches
 * uniquely it fails CLOSED (`no-match`) and the caller emits a structured retry hint.
 * There is deliberately NO edit-distance / fuzzy-similarity tail (Aider disabled its own
 * as too error-prone) — that is the line between "recover a whitespace drift" and
 * "confidently corrupt a file".
 *
 * LOAD-BEARING: resolveHunk operates ONLY on the normalized `work` string edit.ts builds
 * (LF, BOM-stripped) and returns CHAR OFFSETS into it plus the exact replacement string.
 * edit.ts does the single slice+splice and re-applies CRLF/BOM/trailing-newline, so
 * byte-preservation of every untouched region is guaranteed by construction.
 */

/** Which rung located the match (audit + retry-hint context). */
export type Rung = "exact" | "trailing-ws" | "indent" | "blank-skip" | "anchor";

/** The ordered ladder (exact first, laxer last). Every rung is unique-or-ambiguous. */
export const RUNGS: readonly Rung[] = Object.freeze([
  "exact",
  "trailing-ws",
  "indent",
  "blank-skip",
  "anchor",
]);

export type ResolveResult =
  | { ok: true; start: number; end: number; replacement: string; rung: Rung }
  | { ok: false; code: "no-match" | "ambiguous"; rung?: Rung };

export interface ResolveOptions {
  /** enable the fallback rungs beyond `exact`. When false, only the exact rung runs. */
  fallback?: boolean;
}

/* ── line helpers (offset-preserving, so we can build exact spans) ───────────── */

interface LineSpan {
  /** char offset of the line start in `work`. */
  start: number;
  /** char offset just past the line's content (before its \n, if any). */
  contentEnd: number;
  /** char offset just past the line INCLUDING its \n (=== contentEnd at EOF w/o newline). */
  end: number;
  /** the line content (no trailing \n). */
  text: string;
}

/**
 * Split `s` into offset-tagged lines. A trailing "\n" yields a final empty line, mirroring
 * `s.split("\n")` so line counts line up with the model's `old`/`new` splits.
 */
function lineSpans(s: string): LineSpan[] {
  const out: LineSpan[] = [];
  let i = 0;
  const n = s.length;
  for (;;) {
    const j = s.indexOf("\n", i);
    if (j === -1) {
      out.push({ start: i, contentEnd: n, end: n, text: s.slice(i, n) });
      return out;
    }
    out.push({ start: i, contentEnd: j, end: j + 1, text: s.slice(i, j) });
    i = j + 1;
  }
}

const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) as RegExpExecArray)[0];
const rstrip = (s: string): string => s.replace(/[ \t]+$/, "");
const hstrip = (s: string): string => s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
const isBlank = (s: string): boolean => /^[ \t]*$/.test(s);

/** Model `old`/`new` split into content lines + whether the block ended with a newline. */
interface Block {
  lines: string[];
  endsNl: boolean;
}
function toBlock(s: string): Block {
  const parts = s.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") {
    return { lines: parts.slice(0, -1), endsNl: true };
  }
  return { lines: parts, endsNl: false };
}

/** The [start,end) char span in `work` covering file lines [i .. i+m-1], with/without the final \n. */
function windowSpan(
  file: LineSpan[],
  i: number,
  m: number,
  endsNl: boolean,
): { start: number; end: number } {
  const first = file[i] as LineSpan;
  const last = file[i + m - 1] as LineSpan;
  return { start: first.start, end: endsNl ? last.end : last.contentEnd };
}

/** Collect every window start where `pred(i)` holds. Returns [] / [one] / [many]. */
function windows(file: LineSpan[], m: number, pred: (i: number) => boolean): number[] {
  const hits: number[] = [];
  if (m <= 0 || m > file.length) return hits;
  for (let i = 0; i + m <= file.length; i++) if (pred(i)) hits.push(i);
  return hits;
}

/** Re-indent every NON-BLANK line of `newText` by prepending `add` (empty add ⇒ identity). */
function reindent(newText: string, add: string): string {
  if (add === "") return newText;
  return newText
    .split("\n")
    .map((l) => (isBlank(l) ? l : add + l))
    .join("\n");
}

/* ── the rungs ───────────────────────────────────────────────────────────────── */

/** Exact substring match (identical to edit.ts's historical behavior). */
function rungExact(work: string, oldN: string, newN: string): ResolveResult {
  const idx = work.indexOf(oldN);
  if (idx === -1) return { ok: false, code: "no-match", rung: "exact" };
  if (work.indexOf(oldN, idx + 1) !== -1) return { ok: false, code: "ambiguous", rung: "exact" };
  return { ok: true, start: idx, end: idx + oldN.length, replacement: newN, rung: "exact" };
}

/** Per-line trailing-whitespace-insensitive match; the replacement is inserted verbatim. */
function rungTrailingWs(file: LineSpan[], old: Block, newN: string): ResolveResult {
  const m = old.lines.length;
  const want = old.lines.map(rstrip);
  const hits = windows(file, m, (i) =>
    want.every((w, k) => rstrip((file[i + k] as LineSpan).text) === w),
  );
  if (hits.length === 0) return { ok: false, code: "no-match", rung: "trailing-ws" };
  if (hits.length > 1) return { ok: false, code: "ambiguous", rung: "trailing-ws" };
  const { start, end } = windowSpan(file, hits[0] as number, m, old.endsNl);
  return { ok: true, start, end, replacement: newN, rung: "trailing-ws" };
}

/**
 * Leading-indentation-insensitive match. The model's block is under- (or equally-) indented
 * relative to the file; we recover a SINGLE constant added prefix `add` such that every
 * non-blank file line === add + oldLine (also trailing-ws-insensitive). The replacement is
 * re-indented by `add`. Declines (no-match) on inconsistent/tab-vs-space deltas — never guesses.
 */
function rungIndent(file: LineSpan[], old: Block, newN: string): ResolveResult {
  const m = old.lines.length;
  const oldTrim = old.lines.map(hstrip);
  const oldLead = old.lines.map(leadingWs);
  const matchAt = (i: number): string | null => {
    let add: string | null = null;
    for (let k = 0; k < m; k++) {
      const fl = file[i + k] as LineSpan;
      if (hstrip(fl.text) !== oldTrim[k]) return null;
      if (isBlank(fl.text)) continue; // blank lines carry no indent signal
      const fLead = leadingWs(fl.text);
      const oLead = oldLead[k] as string;
      // file must be OLD indented by a constant additive prefix: fLead === add + oLead.
      if (!fLead.endsWith(oLead)) return null; // e.g. tab-vs-space mismatch ⇒ decline
      const thisAdd = fLead.slice(0, fLead.length - oLead.length);
      if (add === null) add = thisAdd;
      else if (add !== thisAdd) return null; // inconsistent delta ⇒ decline
    }
    return add ?? "";
  };
  const adds: string[] = [];
  const hits = windows(file, m, (i) => {
    const a = matchAt(i);
    if (a === null) return false;
    adds.push(a);
    return true;
  });
  if (hits.length === 0) return { ok: false, code: "no-match", rung: "indent" };
  if (hits.length > 1) return { ok: false, code: "ambiguous", rung: "indent" };
  const { start, end } = windowSpan(file, hits[0] as number, m, old.endsNl);
  return { ok: true, start, end, replacement: reindent(newN, adds[0] as string), rung: "indent" };
}

/**
 * Blank-line-skip: strip fully-blank leading/trailing lines from `old` (and the SAME count of
 * blank lines from `new`, only while they are actually blank) then retry trailing-ws + indent.
 * Recovers a spurious leading/trailing blank line without disturbing the file's real blank lines.
 */
function rungBlankSkip(file: LineSpan[], old: Block, newN: string): ResolveResult {
  let lo = 0;
  let hi = old.lines.length;
  while (lo < hi && isBlank(old.lines[lo] as string)) lo++;
  while (hi > lo && isBlank(old.lines[hi - 1] as string)) hi--;
  if (hi - lo === 0) return { ok: false, code: "no-match", rung: "blank-skip" };
  if (lo === 0 && hi === old.lines.length)
    return { ok: false, code: "no-match", rung: "blank-skip" };

  // After trimming outer blank lines the inner block is a run of full lines; treat it as
  // newline-terminated so the window span includes each matched line's own line ending.
  const trimmedOld: Block = { lines: old.lines.slice(lo, hi), endsNl: true };

  const newBlock = toBlock(newN);
  let nlo = 0;
  let nhi = newBlock.lines.length;
  for (let k = 0; k < lo && nlo < nhi && isBlank(newBlock.lines[nlo] as string); k++) nlo++;
  for (
    let k = old.lines.length;
    k > hi && nhi > nlo && isBlank(newBlock.lines[nhi - 1] as string);
    k--
  )
    nhi--;
  const trimmedNew = newBlock.lines.slice(nlo, nhi).join("\n") + (trimmedOld.endsNl ? "\n" : "");

  const ws = rungTrailingWs(file, trimmedOld, trimmedNew);
  if (ws.ok || ws.code === "ambiguous") return ws.ok ? { ...ws, rung: "blank-skip" } : ws;
  const ind = rungIndent(file, trimmedOld, trimmedNew);
  return ind.ok
    ? { ...ind, rung: "blank-skip" }
    : { ok: false, code: "no-match", rung: "blank-skip" };
}

/**
 * Anchor/context locate: when leading/trailing lines drifted but an interior line is stable.
 * Pick the RAREST non-blank line of `old` as the pivot; for each file occurrence of that pivot
 * (trimmed), align the window and require the WHOLE window to match (trimmed). Unique-or-ambiguous.
 */
function rungAnchor(file: LineSpan[], old: Block, newN: string): ResolveResult {
  const m = old.lines.length;
  const oldTrim = old.lines.map(hstrip);
  // frequency of each trimmed non-blank old line across the file
  const fileTrim = file.map((l) => hstrip(l.text));
  const freq = new Map<string, number>();
  for (const t of fileTrim) freq.set(t, (freq.get(t) ?? 0) + 1);
  let pivot = -1;
  let pivotFreq = Number.POSITIVE_INFINITY;
  for (let k = 0; k < m; k++) {
    const t = oldTrim[k] as string;
    if (t === "") continue;
    const f = freq.get(t) ?? 0;
    if (f >= 1 && f < pivotFreq) {
      pivotFreq = f;
      pivot = k;
    }
  }
  if (pivot === -1) return { ok: false, code: "no-match", rung: "anchor" };
  const full = (i: number): boolean =>
    i >= 0 && i + m <= file.length && oldTrim.every((t, k) => (fileTrim[i + k] as string) === t);
  const hits: number[] = [];
  for (let p = 0; p < file.length; p++) {
    if ((fileTrim[p] as string) !== (oldTrim[pivot] as string)) continue;
    const i = p - pivot;
    if (full(i)) hits.push(i);
  }
  const uniq = [...new Set(hits)];
  if (uniq.length === 0) return { ok: false, code: "no-match", rung: "anchor" };
  if (uniq.length > 1) return { ok: false, code: "ambiguous", rung: "anchor" };
  const { start, end } = windowSpan(file, uniq[0] as number, m, old.endsNl);
  return { ok: true, start, end, replacement: newN, rung: "anchor" };
}

/* ── the ladder ──────────────────────────────────────────────────────────────── */

/**
 * Locate a single hunk in `work`, returning a char span + replacement, or a typed refusal.
 * The exact rung always runs first and is identical to edit.ts's historical behavior; the
 * fallback rungs run only when `opts.fallback` is set. On an ambiguous hit at ANY rung the
 * ladder stops (never escalates to a laxer rung — that can only be more ambiguous).
 */
export function resolveHunk(
  work: string,
  oldN: string,
  newN: string,
  opts: ResolveOptions = {},
): ResolveResult {
  const exact = rungExact(work, oldN, newN);
  if (exact.ok || exact.code === "ambiguous" || !opts.fallback) return exact;

  const file = lineSpans(work);
  const old = toBlock(oldN);
  if (old.lines.length === 0) return { ok: false, code: "no-match" };

  for (const rung of [rungTrailingWs, rungIndent, rungBlankSkip, rungAnchor]) {
    const r = rung(file, old, newN);
    if (r.ok) return r;
    if (r.code === "ambiguous") return r; // stop — laxer rungs only get more ambiguous
  }
  return { ok: false, code: "no-match" };
}
