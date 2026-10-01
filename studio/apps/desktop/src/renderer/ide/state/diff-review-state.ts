// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/diff-review-state.ts — the PURE DiffReview selection state (§7.4).
 *
 * `DiffReview.tsx` renders the ChangeSet tree from `@prometheus/core/editor/
 * changeset` — files → hunks, each independently accept/reject-able. The ChangeSet
 * MATH (computeHunks / applyChangeSet) lives in core (already tested there); THIS
 * module owns the renderer-side SELECTION STATE on top of it: which hunks are
 * accepted per file, the tri-state of a file node (all / none / partial), the
 * "Apply selected" plan, the AI-authored new-file flagging the run-gate needs, and
 * the pure (uri, before, after) → ReviewFile converter the propose_edit seam uses.
 *
 * It is framework-free and self-contained — it works over the PLAIN ChangeSet shape
 * (mirrored locally so the sandboxed renderer never imports core's runtime, C5) — so
 * the selection logic is testable in isolation (file 07 build-notes: "diff-review
 * selection state"). The actual apply uses core's applyChangeSet in the MAIN process
 * via window.prometheus.ide.fsWrite; this module decides WHAT to apply, never writes.
 *
 * Node built-ins only.
 */

/** A plain hunk (mirrors core editor/changeset Hunk — id is the selectable unit). */
export interface ReviewHunk {
  id: string;
  /** 0-based line index in the ORIGINAL file where this hunk's removed run starts. */
  originalStart: number;
  /** number of original lines removed (0 = pure insertion). Defaults to oldLines.length. */
  originalLines: number;
  /** added lines (green). */
  newLines: string[];
  /** removed lines (red). */
  oldLines: string[];
}

/** A plain per-file edit (mirrors core editor/changeset FileEdit). */
export interface ReviewFile {
  uri: string;
  hunks: ReviewHunk[];
  isNew?: boolean;
  isDelete?: boolean;
}

/** A plain ChangeSet (mirrors core editor/changeset ChangeSet). */
export interface ReviewChangeSet {
  id: string;
  rationale: string;
  edits: ReviewFile[];
}

/** The accepted-hunk-id selection, keyed by file uri. */
export type DiffSelection = Record<string, string[]>;

/** A file node's tri-state in the tree (drives the checkbox glyph). */
export type TriState = "all" | "none" | "partial";

/** Start with EVERY hunk accepted (the §7.4 default: review-then-trim, not opt-in). */
export function initialSelection(cs: ReviewChangeSet): DiffSelection {
  const sel: DiffSelection = {};
  for (const f of cs.edits) sel[f.uri] = f.hunks.map((h) => h.id);
  return sel;
}

/** The empty selection (reject-all). */
export function emptySelection(cs: ReviewChangeSet): DiffSelection {
  const sel: DiffSelection = {};
  for (const f of cs.edits) sel[f.uri] = [];
  return sel;
}

/** The accepted hunk ids for one file (always an array, never undefined). */
export function acceptedOf(selection: DiffSelection, uri: string): string[] {
  return selection[uri] ?? [];
}

/** Toggle a single hunk id within a file's selection (immutable). */
export function toggleHunk(selection: DiffSelection, uri: string, hunkId: string): DiffSelection {
  const cur = acceptedOf(selection, uri);
  const next = cur.includes(hunkId) ? cur.filter((id) => id !== hunkId) : [...cur, hunkId];
  return { ...selection, [uri]: next };
}

/** Accept every hunk of one file. */
export function acceptFile(selection: DiffSelection, file: ReviewFile): DiffSelection {
  return { ...selection, [file.uri]: file.hunks.map((h) => h.id) };
}

/** Reject every hunk of one file. */
export function rejectFile(selection: DiffSelection, file: ReviewFile): DiffSelection {
  return { ...selection, [file.uri]: [] };
}

/** Accept every hunk of every file (the header "Accept all"). */
export function acceptAll(cs: ReviewChangeSet): DiffSelection {
  return initialSelection(cs);
}

/** Reject every hunk (the header "Reject all"). */
export function rejectAll(cs: ReviewChangeSet): DiffSelection {
  return emptySelection(cs);
}

/** The tri-state of one file node given the current selection. */
export function fileTriState(file: ReviewFile, selection: DiffSelection): TriState {
  const accepted = new Set(acceptedOf(selection, file.uri));
  if (file.hunks.length === 0) return "none";
  const n = file.hunks.filter((h) => accepted.has(h.id)).length;
  if (n === 0) return "none";
  if (n === file.hunks.length) return "all";
  return "partial";
}

/** The tri-state of the WHOLE changeset (the header checkbox). */
export function changeSetTriState(cs: ReviewChangeSet, selection: DiffSelection): TriState {
  let total = 0;
  let accepted = 0;
  for (const f of cs.edits) {
    total += f.hunks.length;
    accepted += f.hunks.filter((h) => acceptedOf(selection, f.uri).includes(h.id)).length;
  }
  if (total === 0 || accepted === 0) return "none";
  if (accepted === total) return "all";
  return "partial";
}

/** A per-file entry of the "Apply selected" plan. */
export interface ApplyPlanFile {
  uri: string;
  acceptedHunkIds: string[];
  /** how many of the file's hunks are accepted. */
  acceptedCount: number;
  totalHunks: number;
  isNew: boolean;
  isDelete: boolean;
}

/** The whole apply plan: only files with ≥1 accepted hunk are written. */
export interface ApplyPlan {
  files: ApplyPlanFile[];
  /** uris of AI-authored NEW files that get applied — flagged for the run-gate (§5.2). */
  newFilesToGate: string[];
  /** nothing accepted → Apply is a no-op (the button is disabled). */
  empty: boolean;
}

/**
 * Build the "Apply selected" plan (file 07 §7.4). Only files with at least one
 * accepted hunk are included. AI-authored NEW files that will be written are
 * collected into `newFilesToGate` — AI code is untrusted-until-gated, exactly like
 * cloned code (§7.4); the caller hands these to the engine run-gate. Pure.
 */
export function buildApplyPlan(cs: ReviewChangeSet, selection: DiffSelection): ApplyPlan {
  const files: ApplyPlanFile[] = [];
  const newFilesToGate: string[] = [];
  for (const f of cs.edits) {
    const accepted = acceptedOf(selection, f.uri).filter((id) => f.hunks.some((h) => h.id === id));
    if (accepted.length === 0) continue;
    files.push({
      uri: f.uri,
      acceptedHunkIds: accepted,
      acceptedCount: accepted.length,
      totalHunks: f.hunks.length,
      isNew: f.isNew === true,
      isDelete: f.isDelete === true,
    });
    if (f.isNew) newFilesToGate.push(f.uri);
  }
  return { files, newFilesToGate, empty: files.length === 0 };
}

/* ------------------------------------------------------------------------- *
 * Apply math — the deterministic accept-subset splice (mirrors core §7.4)
 * ------------------------------------------------------------------------- */

/**
 * Apply ONLY the accepted hunks of one ReviewFile to `originalText`, returning the
 * new text. Mirrors core `applyChangeSet`: hunks splice their `newLines` over their
 * `[originalStart, originalStart+originalLines)` run, applied BOTTOM-UP (descending
 * originalStart) so an earlier splice never shifts a later hunk's anchor. Unaccepted
 * hunks are untouched. isNew treats the base as "" ; an all-accepted isDelete
 * collapses to "". Pure + deterministic — the renderer feeds the result to fsWrite as
 * one undoable batch. The hunk POSITIONS come from core (computeHunks), never guessed.
 */
export function applyReviewFile(
  originalText: string,
  file: ReviewFile,
  acceptedHunkIds: readonly string[],
): string {
  const accepted = new Set(acceptedHunkIds);
  const chosen = file.hunks.filter((h) => accepted.has(h.id));
  if (file.isDelete && chosen.length === file.hunks.length && file.hunks.length > 0) {
    return "";
  }
  const base = file.isNew ? "" : originalText;
  const lines = base === "" ? [] : base.split("\n");
  const ordered = [...chosen].sort((a, b) => b.originalStart - a.originalStart);
  for (const h of ordered) {
    lines.splice(h.originalStart, h.originalLines, ...h.newLines);
  }
  return lines.join("\n");
}

/**
 * FAIL-CLOSED drift guard: verify every ACCEPTED hunk's oldLines still match
 * `originalText` before splicing. Hunks are anchored to the disk content they were
 * computed against — if the file changed since (another apply, the user, git), a
 * blind splice would corrupt it silently. Returns a human-readable mismatch reason,
 * or null when the base is still valid. isNew files have no base to verify. Pure.
 */
export function verifyHunksAgainstBase(
  originalText: string,
  file: ReviewFile,
  acceptedHunkIds: readonly string[],
): string | null {
  if (file.isNew) return null;
  const accepted = new Set(acceptedHunkIds);
  const lines = originalText === "" ? [] : originalText.split("\n");
  for (const h of file.hunks) {
    if (!accepted.has(h.id)) continue;
    if (h.originalStart + h.originalLines > lines.length || h.originalStart > lines.length) {
      return `hunk ${h.id} extends past the end of the file — it changed on disk since this was proposed`;
    }
    for (let k = 0; k < h.originalLines; k++) {
      if (lines[h.originalStart + k] !== h.oldLines[k]) {
        return `hunk ${h.id} no longer matches the file (line ${h.originalStart + k + 1} changed on disk since this was proposed)`;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * before/after → ReviewFile converter (the propose_edit result seam, §7.4)
 * ------------------------------------------------------------------------- */

/** One (uri, before, after) proposal — the plain propose_edit result shape. */
export interface ProposedFileTexts {
  uri: string;
  /** the CURRENT on-disk text ("" for a brand-new file). */
  before: string;
  /** the proposed full text ("" for a deletion). */
  after: string;
}

/** Split into the same "\n" line model applyReviewFile splices over ("" → 0 lines).
 *  CRLF files keep their "\r" INSIDE the line content, so untouched lines stay
 *  byte-identical through a split/join round-trip. */
function splitReviewLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/** LCS table over two line arrays (classic O(n·m) DP — AI edits touch small files;
 *  large-file mode skips AI per §3.1). Mirrors core editor/changeset — mirrored
 *  LOCALLY because the sandboxed renderer never imports core's runtime (C5). */
function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  return dp;
}

/**
 * Compute the ReviewHunks that transform `before` into `after`: each maximal run of
 * deleted/added lines between equal lines becomes one independently selectable hunk.
 * Ids are `${idBase}-0`, `${idBase}-1`, … (stable + content-independent so a checkbox
 * map survives a re-render). `before === after` yields ZERO hunks (the "no changes"
 * pane state, never a no-op hunk). Pure + deterministic.
 */
export function computeReviewHunks(before: string, after: string, idBase = "h"): ReviewHunk[] {
  const a = splitReviewLines(before);
  const b = splitReviewLines(after);
  const dp = lcsTable(a, b);
  const hunks: ReviewHunk[] = [];
  let i = 0;
  let j = 0;
  let idx = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // a change run: greedily take dels/adds until the next equal pair (LCS-guided).
    const originalStart = i;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) break;
      if (j >= b.length || (i < a.length && dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
        oldLines.push(a[i]!);
        i++;
      } else {
        newLines.push(b[j]!);
        j++;
      }
    }
    hunks.push({
      id: `${idBase}-${idx++}`,
      originalStart,
      originalLines: oldLines.length,
      oldLines,
      newLines,
    });
  }
  return hunks;
}

/** The file's DOMINANT EOL style (majority vote; tie → LF). A single stray CRLF in
 *  an LF file must not re-style the whole `after` and phantom-change every line. */
function detectEol(text: string): "\n" | "\r\n" {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lfOnly = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lfOnly ? "\r\n" : "\n";
}

/**
 * Convert one propose_edit result (uri, before, after) into a ReviewFile whose hunks
 * splice correctly through applyReviewFile. `isNew`/`isDelete` are inferred from the
 * empty side. EOL SAFETY: `after` is re-styled to `before`'s detected EOL BEFORE
 * hunking — a model that answers LF into a CRLF file must not mark every line changed
 * nor write mixed endings; untouched lines come from the original buffer, so a
 * reject-all apply is byte-identical by construction. Pure.
 */
export function reviewFileFromTexts(
  uri: string,
  before: string,
  after: string,
  idBase = "h",
): ReviewFile {
  let adapted = after;
  if (before !== "" && after !== "") {
    const eol = detectEol(before);
    adapted = after.replace(/\r\n/g, "\n");
    if (eol === "\r\n") adapted = adapted.replace(/\n/g, "\r\n");
  }
  const file: ReviewFile = { uri, hunks: computeReviewHunks(before, adapted, idBase) };
  if (before === "" && after !== "") file.isNew = true;
  if (before !== "" && after === "") file.isDelete = true;
  return file;
}

/**
 * Build a whole ReviewChangeSet from propose_edit results — the pure converter the
 * agent edit path feeds to `proposeChangeSet` (§7.4). Files whose before === after
 * still appear (with zero hunks) so the pane can show "no changes" instead of null.
 * Duplicate uris collapse LAST-WINS (selection is keyed by uri — two edits for one
 * uri would fight over one selection slot and render duplicate tree keys).
 */
export function changeSetFromTexts(
  id: string,
  rationale: string,
  files: readonly ProposedFileTexts[],
): ReviewChangeSet {
  const byUri = new Map<string, ReviewFile>();
  for (const [i, f] of files.entries()) {
    byUri.set(f.uri, reviewFileFromTexts(f.uri, f.before, f.after, `f${i}`));
  }
  return { id, rationale, edits: [...byUri.values()] };
}
