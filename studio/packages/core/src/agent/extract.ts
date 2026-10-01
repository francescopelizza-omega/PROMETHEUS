// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/extract.ts — PURE extraction of edit intents from RAW model text (WRAPPER Phase A).
 *
 * The user's core insight: an LLM only emits text; something must pull the "part of code to
 * add or modify" out of that text and turn it into applicable edits. `propose_edit` already
 * carries structured {old,new} hunks, but when a model instead writes edits as PROSE — Aider
 * SEARCH/REPLACE blocks or a ```diff fence — this parser recovers them into EditHunk[] that the
 * deterministic applier (edit.ts + ladder.ts) can then locate and apply.
 *
 * Fail-closed + never half-apply: an unterminated SEARCH block (no divider or no REPLACE close)
 * emits NOTHING. Aider markers are matched by their exact keywords (SEARCH / REPLACE), so a real
 * git conflict marker (`<<<<<<< HEAD` … `>>>>>>> branch`) is never mistaken for an edit.
 */
import type { EditHunk } from "./edit.js";

export interface EditIntent {
  /** the target file path, if one was found near the block (a header / fence-info / bare path line). */
  path?: string;
  kind: "search-replace" | "diff";
  hunks: EditHunk[];
}

const SEARCH = /^<{5,9} SEARCH\s*$/;
const DIVIDER = /^={5,9}\s*$/;
const REPLACE = /^>{5,9} REPLACE\s*$/;
const FENCE = /^\s*(?:`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s*(?:`{3,}|~{3,})\s*$/;
const HUNK_HEADER = /^@@ /;

/** Pull a file path out of a header / fenced-info / bare line, or null. Paths have no spaces. */
export function pathCandidate(line: string): string | null {
  let s = line.trim();
  s = s
    .replace(/^#{1,6}\s+/, "") // markdown heading
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "") // bold
    .replace(/`/g, "") // inline code
    .replace(/:$/, "") // trailing colon
    .trim();
  const kv = /^(?:file|path)\s*[:=]\s*(.+)$/i.exec(s);
  if (kv) s = (kv[1] as string).trim();
  if (!s || /\s/.test(s)) return null; // a path has no whitespace
  if (!/[./]/.test(s)) return null; // must look like a path (a dot or a slash)
  if (!/^[\w./@~+-]+$/.test(s)) return null; // conservative charset
  return s;
}

/** Strip a unified-diff path header (`+++ b/foo.ts\t(date)` → `foo.ts`). */
function diffPath(line: string): string | undefined {
  let s = line.replace(/^[+-]{3}\s+/, "");
  const tab = s.indexOf("\t");
  if (tab !== -1) s = s.slice(0, tab);
  s = s.trim().replace(/^[ab]\//, "");
  return s && s !== "/dev/null" ? s : undefined;
}

/** Parse one SEARCH/REPLACE block starting at `lines[start]` (the SEARCH marker). */
function parseSearchReplace(
  lines: string[],
  start: number,
): { hunk: EditHunk | null; consumed: number } {
  let i = start + 1;
  const oldLines: string[] = [];
  while (i < lines.length && !DIVIDER.test(lines[i] as string)) oldLines.push(lines[i++] as string);
  if (i >= lines.length) return { hunk: null, consumed: lines.length }; // no divider ⇒ incomplete
  i++; // skip the =======
  const newLines: string[] = [];
  while (i < lines.length && !REPLACE.test(lines[i] as string)) newLines.push(lines[i++] as string);
  if (i >= lines.length) return { hunk: null, consumed: lines.length }; // no REPLACE ⇒ incomplete
  i++; // skip the >>>>>>> REPLACE
  const old = oldLines.join("\n");
  if (old === "") return { hunk: null, consumed: i }; // empty pre-image can't be located — skip
  return { hunk: { old, new: newLines.join("\n") }, consumed: i };
}

/** Parse a ```diff fence body starting at `lines[start]` (first line after the fence marker). */
function parseDiffFence(
  lines: string[],
  start: number,
  seedPath: string | undefined,
): { intents: EditIntent[]; consumed: number } {
  let i = start;
  let path = seedPath;
  let inHunk = false;
  let oldBuf: string[] = [];
  let newBuf: string[] = [];
  const byPath = new Map<string, EditHunk[]>();
  const flush = (): void => {
    if (inHunk && oldBuf.length > 0) {
      const key = path ?? "";
      const arr = byPath.get(key) ?? [];
      arr.push({ old: oldBuf.join("\n"), new: newBuf.join("\n") });
      byPath.set(key, arr);
    }
    oldBuf = [];
    newBuf = [];
    inHunk = false;
  };
  while (i < lines.length && !FENCE_CLOSE.test(lines[i] as string)) {
    const l = lines[i] as string;
    if (l.startsWith("+++ ")) {
      flush();
      path = diffPath(l) ?? path;
    } else if (l.startsWith("--- ")) {
      /* old-file header — ignore */
    } else if (HUNK_HEADER.test(l)) {
      flush();
      inHunk = true;
    } else if (inHunk) {
      if (l.startsWith("+")) newBuf.push(l.slice(1));
      else if (l.startsWith("-")) oldBuf.push(l.slice(1));
      else if (l.startsWith(" ")) {
        oldBuf.push(l.slice(1));
        newBuf.push(l.slice(1));
      } else if (l === "") {
        oldBuf.push("");
        newBuf.push("");
      }
      // a "\ No newline at end of file" or stray line is ignored
    }
    i++;
  }
  flush();
  const consumed = i < lines.length ? i + 1 : i; // step past the closing fence
  const intents: EditIntent[] = [];
  for (const [key, hunks] of byPath) {
    if (hunks.length > 0) intents.push({ ...(key ? { path: key } : {}), kind: "diff", hunks });
  }
  return { intents, consumed };
}

/**
 * Extract every edit intent from raw model text. Recognizes Aider SEARCH/REPLACE blocks (the
 * dominant text edit format) and ```diff fences. A path is bound from the nearest preceding
 * header / bare path line / fence info-string. Prose between blocks is ignored; incomplete
 * blocks are dropped (never a half-edit).
 */
export function extractEditIntents(raw: string): EditIntent[] {
  const lines = raw.split("\n");
  const intents: EditIntent[] = [];
  let pendingPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;

    const fence = FENCE.exec(line);
    if (fence) {
      const info = (fence[1] as string).trim();
      if (/^diff\b/.test(info) || info === "diff") {
        const { intents: diffIntents, consumed } = parseDiffFence(lines, i + 1, pendingPath);
        intents.push(...diffIntents);
        i = consumed;
        continue;
      }
      const p = pathCandidate(info);
      if (p) pendingPath = p;
      i++;
      continue;
    }

    if (SEARCH.test(line)) {
      const { hunk, consumed } = parseSearchReplace(lines, i);
      if (hunk) {
        intents.push({
          ...(pendingPath ? { path: pendingPath } : {}),
          kind: "search-replace",
          hunks: [hunk],
        });
      }
      i = consumed;
      continue;
    }

    const p = pathCandidate(line);
    if (p) pendingPath = p;
    i++;
  }
  return intents;
}
