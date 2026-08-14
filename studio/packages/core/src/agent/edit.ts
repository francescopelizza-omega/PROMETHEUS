/**
 * agent/edit.ts — the `propose_edit` agent tool + its PURE exact-match applier and
 * line-diff helper (file 11 §3.2, CLI-010).
 *
 * The agent's first file-editing path. `propose_edit` is annotated DESTRUCTIVE so the
 * §4.3 broker ALWAYS routes it to human confirm (never auto, not even under
 * tuning.yes; only the TUI `acceptEdits` mode may auto-approve). The applier is pure
 * (Electron/fs-free — the local write happens in the CLI runtime behind a path guard):
 * it ports the desktop `text-edit-apply.ts` semantics into core.
 *
 * Match semantics (load-bearing):
 *   - each hunk's `old` must occur EXACTLY ONCE (a 2nd occurrence ⇒ `ambiguous`, never
 *     first-wins — a model often sends an `old` that matches N sites);
 *   - CRLF + BOM are normalized for the MATCH then RE-APPLIED on the result, so a
 *     Windows-authored file round-trips byte-identically;
 *   - operates on the whole string (no split/join), so a trailing newline is preserved.
 */
import type { ToolDef } from "../mcp/server/index.js";
import { type ResolveOptions, type Rung, resolveHunk } from "./ladder.js";

export interface EditHunk {
  /** exact pre-image text to find (must be unique in the file). */
  old: string;
  /** replacement text. */
  new: string;
}

export type ApplyEditResult =
  | { ok: true; next: string; applied: number; rungs: Rung[] }
  | { ok: false; code: "empty" | "no-match" | "ambiguous"; message: string; hunk: number };

const BOM = "﻿";

/**
 * Build a normalized (LF, no lone-CRLF `\r`) view of `raw` plus `map`, where `map[k]` is the
 * raw index of work char `k` (and `map[work.length]` is `raw.length`). Only the `\r` of a
 * `\r\n` pair is dropped, so untouched line endings — including mixed or lone-CR files — are
 * preserved when we splice back into `raw`. This replaces the old blanket `\n`→`\r\n` reapply,
 * which silently rewrote every line ending of a MIXED-ending file (corrupting untouched lines).
 */
function normalizeWork(raw: string): { work: string; map: number[] } {
  const map: number[] = [];
  let work = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\r" && raw[i + 1] === "\n") continue; // drop the CRLF `\r`; its `\n` maps next
    map.push(i);
    work += raw[i] as string;
  }
  map.push(raw.length);
  return { work, map };
}

/**
 * Say WHY an `old` block did not match, in terms the model can act on.
 *
 * "old text not found" is true and useless. Watching a live model receive it, the next three
 * rounds are guesses: maybe the indentation, maybe the newlines, maybe re-read the file. Every
 * one of those costs a round trip and can end in the model giving up and using a blunter tool.
 *
 * The failure is nearly always one of four things, and all four are cheap to test for. The
 * message NEVER claims to have applied anything and never invents a location — it reports what
 * is checkable and stops.
 */
export function diagnoseHunkMiss(content: string, old: string): string {
  const file = content.replace(/\r\n/g, "\n");
  const want = old.replace(/\r\n/g, "\n");
  const wantLines = want.split("\n").filter((l) => l.trim() !== "");
  if (wantLines.length === 0) return "";

  // 1. A line-number gutter copied out of read_file's output. The single most likely cause,
  //    because read_file is how the model got the text in the first place.
  if (wantLines.every((l) => /^\s*\d+\s\s/.test(l))) {
    return " — every line of `old` starts with a number, so this looks like read_file's line-number gutter; `old` must be the file's own text without it";
  }

  // 2. Present, but the indentation differs — the model retyped the line instead of copying it.
  const squash = (s: string): string =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .join("\n");
  if (squash(file).includes(squash(want))) {
    return " — the same lines ARE in the file but the leading whitespace differs; copy `old` verbatim, indentation included";
  }

  // 3. It starts right and then diverges. Report WHERE, by finding the longest prefix of `old`
  //    that occurs in the file (monotone: if a prefix occurs, every shorter one does, so a
  //    binary search is exact). This is the case that actually bites — a model rebuilding text
  //    from a numbered listing drops the line break between two lines and the resulting `old`
  //    has no matching first line at all, so a line-by-line check finds nothing to say.
  let lo = 0;
  let hi = want.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (file.includes(want.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  const MIN_USEFUL_PREFIX = 12;
  if (lo >= MIN_USEFUL_PREFIX) {
    const at = file.slice(0, file.indexOf(want.slice(0, lo))).split("\n").length;
    const fileNext = file[file.indexOf(want.slice(0, lo)) + lo];
    const wantNext = want[lo];
    // The specific, common case: the file breaks the line here and `old` does not.
    const newlineHint =
      fileNext === "\n" && wantNext !== "\n"
        ? " — the file has a LINE BREAK there and `old` does not (blank lines count as lines)"
        : "";
    return ` — \`old\` matches from line ${at} for its first ${lo} characters and then diverges${newlineHint}; re-read that region and copy it exactly`;
  }

  // 4. Simply not there.
  return " — no part of `old` appears in the file; re-read it, the file may have changed";
}

/**
 * Apply hunks to `content`, returning the new content or a typed error. Never throws.
 * Hunks apply in order against the running RAW string (so overlapping edits are rejected
 * as no-match once the first consumes the shared text). Matching runs on a normalized LF
 * view; the located char span is mapped back and spliced into the raw bytes, so every
 * untouched region — including its original line endings — is byte-preserved.
 *
 * `opts.fallback` enables the deterministic ladder (trailing-ws / indent / blank-skip /
 * anchor) beyond the exact rung; with `opts` omitted the behavior is byte-identical to the
 * historical exact-only applier. Each ok result reports which `rungs` fired (audit).
 */
export function applyProposedEdit(
  content: string,
  hunks: readonly EditHunk[],
  opts: ResolveOptions = {},
): ApplyEditResult {
  if (!Array.isArray(hunks) || hunks.length === 0) {
    return { ok: false, code: "empty", message: "no hunks to apply", hunk: 0 };
  }
  const hasBom = content.charCodeAt(0) === 0xfeff;
  let raw = hasBom ? content.slice(1) : content;
  const fileNl = raw.includes("\r\n") ? "\r\n" : "\n";
  const rungs: Rung[] = [];

  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i] as EditHunk;
    const oldN = (h.old ?? "").replace(/\r\n/g, "\n");
    const newN = (h.new ?? "").replace(/\r\n/g, "\n");
    if (oldN === "") {
      return { ok: false, code: "empty", message: `hunk ${i}: empty old text`, hunk: i };
    }
    const { work, map } = normalizeWork(raw);
    const r = resolveHunk(work, oldN, newN, opts);
    if (!r.ok) {
      const message =
        r.code === "ambiguous"
          ? `hunk ${i}: old text matches more than one location — extend it with surrounding lines until it is unique`
          : `hunk ${i}: old text not found${diagnoseHunkMiss(work, oldN)}`;
      return { ok: false, code: r.code, message, hunk: i };
    }
    const rawStart = map[r.start] as number;
    // one byte past the last CONSUMED raw char (its `\n`); the CRLF `\r` sits inside [start,end).
    const rawEnd = (map[r.end - 1] as number) + 1;
    const span = raw.slice(rawStart, rawEnd);
    const nl = span.includes("\r\n") ? "\r\n" : span.includes("\n") ? "\n" : fileNl;
    const replacement = nl === "\n" ? r.replacement : r.replacement.replace(/\n/g, nl);
    raw = raw.slice(0, rawStart) + replacement + raw.slice(rawEnd);
    rungs.push(r.rung);
  }

  const next = hasBom ? BOM + raw : raw;
  return { ok: true, next, applied: hunks.length, rungs };
}

export interface DiffLine {
  tag: "+" | "-" | " ";
  text: string;
}

/**
 * A minimal line diff for ONE hunk (old block → new block): shared leading/trailing
 * lines render as context, the changed middle as removed (`-`) then added (`+`). Pure
 * — the TUI paints the tags with token-sourced ANSI (no color here).
 */
export function diffHunk(oldText: string, newText: string): DiffLine[] {
  const o = oldText.replace(/\r\n/g, "\n").split("\n");
  const n = newText.replace(/\r\n/g, "\n").split("\n");
  let pre = 0;
  while (pre < o.length && pre < n.length && o[pre] === n[pre]) pre++;
  let suf = 0;
  while (
    suf < o.length - pre &&
    suf < n.length - pre &&
    o[o.length - 1 - suf] === n[n.length - 1 - suf]
  ) {
    suf++;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ tag: " ", text: o[i] as string });
  for (let i = pre; i < o.length - suf; i++) out.push({ tag: "-", text: o[i] as string });
  for (let i = pre; i < n.length - suf; i++) out.push({ tag: "+", text: n[i] as string });
  for (let i = n.length - suf; i < n.length; i++) out.push({ tag: " ", text: n[i] as string });
  return out;
}

/**
 * Parse a `propose_edit` call's `hunks` arg (a real array, or a JSON string) AND report how
 * many entries were malformed and dropped. A silently-dropped hunk applies fewer edits than
 * the model intended while still reporting `ok` — so the CLI runtime treats `dropped > 0`
 * (or a non-array `hunks`) as a failure with a retry hint rather than a partial success.
 */
export function parseHunksResult(raw: unknown): {
  hunks: EditHunk[];
  dropped: number;
  malformed: boolean;
} {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return { hunks: [], dropped: 0, malformed: true };
    }
  }
  if (!Array.isArray(arr)) return { hunks: [], dropped: 0, malformed: true };
  const out: EditHunk[] = [];
  let dropped = 0;
  for (const h of arr) {
    if (h && typeof h === "object" && typeof h.old === "string" && typeof h.new === "string") {
      out.push({ old: h.old, new: h.new });
    } else {
      dropped++;
    }
  }
  return { hunks: out, dropped, malformed: false };
}

/** Parse a `propose_edit` call's `hunks` arg (a real array, or a JSON string). */
export function parseHunks(raw: unknown): EditHunk[] {
  return parseHunksResult(raw).hunks;
}

/** The `propose_edit` ToolDef — applied LOCALLY by the CLI runtime, never via the engine. */
export const PROPOSE_EDIT_TOOL: ToolDef = {
  name: "propose_edit",
  title: "Propose file edit",
  description:
    "Propose an exact-match edit to a local file: {path, hunks:[{old,new}]} where `old` is the " +
    "exact unique pre-image and `new` the replacement. Requires human approval; never auto-applies.",
  schema: {
    path: { type: "string", required: true, description: "file path within the working set" },
    hunks: {
      type: "array",
      required: true,
      description:
        "the edits to apply, each {old, new}: `old` is an exact, unique, verbatim span of " +
        "the current file (include a little surrounding context so it matches ONE place)",
      items: { type: "object", shape: "{old,new}" },
    },
  },
  // DESTRUCTIVE ⇒ the broker always routes to confirm (never auto, even under tuning.yes).
  annotations: { destructiveHint: true },
  toArgv: () => {
    throw new Error("propose_edit is applied locally by the CLI runtime, not via the engine");
  },
};

/**
 * The `write_file` ToolDef — CREATE a new file or OVERWRITE an existing one with exact
 * content. Applied LOCALLY by the CLI runtime (never the engine), path-guarded within the
 * working set, atomic, with a kept pre-image for revert. Unlike `propose_edit` (exact-match
 * hunks into an existing file) this is how the agent brings a NEW file into being — the
 * "write me hello.py" path. DESTRUCTIVE ⇒ always human-confirmed, never auto-approved.
 */
export const WRITE_FILE_TOOL: ToolDef = {
  name: "write_file",
  title: "Write file",
  description:
    "Create a new file or OVERWRITE an existing one with exact content: {path, content}. " +
    "Use this to author a brand-new file (propose_edit only edits existing files). " +
    "Requires human approval; never auto-applies.",
  schema: {
    path: { type: "string", required: true, description: "file path within the working set" },
    content: { type: "string", required: true, description: "the full file content to write" },
  },
  // DESTRUCTIVE ⇒ the broker always routes to confirm (never auto, even under tuning.yes).
  annotations: { destructiveHint: true },
  toArgv: () => {
    throw new Error("write_file is applied locally by the CLI runtime, not via the engine");
  },
};
