// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/diff-hunks.ts — PURE unified-diff hunk toolkit for per-hunk / per-line
 * staging (APP-084). Parses a single file's `git diff` text into a file header + hunks,
 * and rebuilds a valid single-file patch containing a chosen subset of hunks / lines,
 * RECOUNTING the `@@` line counts so `git apply --cached -` accepts it.
 *
 * No monaco / react / git — node:test-able; the EditorPane/GitPanel own the transport.
 *
 * Patch discipline (git apply is strict): keep the `diff --git a/x b/x` + `a/`+`b/`
 * header verbatim (git strips one leading path component, -p1); a dropped unselected
 * `+` line vanishes (newCount−1); a dropped unselected `−` line becomes a ` ` context
 * line (kept on both sides); the `\ No newline at end of file` marker travels with the
 * line it follows (dropped when that line is dropped).
 */

/** One hunk of a unified diff. `lines` keep their leading char (' '/'+'/'-'/'\'). */
export interface DiffHunk {
  /** the raw `@@ -a,b +c,d @@ …` header line (kept for display; rebuilt on apply). */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** A parsed single-file diff: the pre-hunk header lines + its hunks. */
export interface ParsedDiff {
  /** `diff --git …`, `index …`, `--- a/x`, `+++ b/x`, rename/mode lines. */
  header: string[];
  hunks: DiffHunk[];
  /** a rename/mode-only diff with no `@@` body — staging it is whole-file, not per-hunk. */
  bodyless: boolean;
}

/** Parse an `@@ -oldStart,oldLines +newStart,newLines @@` header (counts default to 1). */
function parseHunkHeader(
  line: string,
): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/**
 * Parse ONE file's unified diff text. Everything before the first `@@` is the header;
 * each `@@` starts a hunk that runs until the next `@@` or EOF. A rename/mode diff with
 * no `@@` is returned bodyless (the caller stages it whole-file).
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const rawLines = text.split("\n");
  // a trailing empty element from a final "\n" is not a diff line — drop it.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const header: string[] = [];
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const line of rawLines) {
    if (line.startsWith("@@")) {
      const parsed = parseHunkHeader(line);
      if (!parsed) {
        // a malformed @@ — treat as header noise rather than crashing.
        if (!cur) header.push(line);
        continue;
      }
      cur = { header: line, ...parsed, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (cur) {
      cur.lines.push(line);
    } else {
      header.push(line);
    }
  }
  return { header, hunks, bodyless: hunks.length === 0 };
}

/** The stable key for a change (`+`/`-`) line at `hunkIndex`/`lineIndex` (UI selection). */
export function lineKey(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
}

/** Is a body line a stageable change line (`+` or `-`, never a `\` marker)? */
export function isChangeLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

/** The GitPanel hunk-control reducer: add/remove one line key from the selection set. */
export function toggleSelection(
  selection: ReadonlySet<string>,
  key: string,
  on: boolean,
): Set<string> {
  const next = new Set(selection);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

/** Every change-line key of a hunk (for select-all / all-selected checks). */
export function changeLineKeys(hunkIndex: number, hunk: DiffHunk): string[] {
  const keys: string[] = [];
  hunk.lines.forEach((l, i) => {
    if (isChangeLine(l)) keys.push(lineKey(hunkIndex, i));
  });
  return keys;
}

/** One rebuilt hunk (recounted) or null when the selection leaves it a no-op. */
function rebuildHunk(
  hunk: DiffHunk,
  hunkIndex: number,
  selected: ReadonlySet<string> | null,
): {
  header: string;
  body: string[];
} | null {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let changed = false;
  let lastEmitted = false; // did the immediately-preceding line get emitted? (for `\`)
  hunk.lines.forEach((line, i) => {
    const kind = line[0] ?? " ";
    if (kind === "\\") {
      // `\ No newline at end of file` — travels with the line it follows.
      if (lastEmitted) body.push(line);
      return;
    }
    if (kind === "+") {
      const keep = selected === null || selected.has(lineKey(hunkIndex, i));
      if (keep) {
        body.push(line);
        newCount++;
        changed = true;
        lastEmitted = true;
      } else {
        lastEmitted = false; // dropped → a following `\` is dropped too
      }
      return;
    }
    if (kind === "-") {
      const keep = selected === null || selected.has(lineKey(hunkIndex, i));
      if (keep) {
        body.push(line);
        oldCount++;
        changed = true;
      } else {
        // unselected removal → keep the line as CONTEXT (present on both sides).
        body.push(` ${line.slice(1)}`);
        oldCount++;
        newCount++;
      }
      lastEmitted = true;
      return;
    }
    // context (' ') or an empty body line.
    body.push(line);
    oldCount++;
    newCount++;
    lastEmitted = true;
  });
  if (!changed) return null; // nothing to stage from this hunk
  const header = `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`;
  return { header, body };
}

/**
 * Build a valid single-file patch from the file `header` + the chosen `hunks`, keeping
 * only `selected` change lines when provided (undefined = whole hunks). `@@` counts are
 * recomputed from the emitted body. Returns "" when nothing is selectable (no-op).
 *
 * The `hunks` passed are indexed 0..n and `selected` keys are `${index}:${lineIndex}`
 * against THAT array — the caller slices the hunks it wants and keys the selection to
 * the same indices.
 */
export function buildPatch(
  header: readonly string[],
  hunks: readonly DiffHunk[],
  selected?: ReadonlySet<string>,
): string {
  const sel = selected ?? null;
  const rebuilt = hunks
    .map((h, i) => rebuildHunk(h, i, sel))
    .filter((r): r is { header: string; body: string[] } => r !== null);
  if (rebuilt.length === 0) return "";
  const out: string[] = [...header];
  for (const r of rebuilt) {
    out.push(r.header);
    out.push(...r.body);
  }
  // git apply is LF-strict internally; a trailing newline terminates the last line.
  return `${out.join("\n")}\n`;
}
