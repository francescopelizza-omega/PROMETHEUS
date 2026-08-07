/**
 * editor/changeset.ts — THE ChangeSet apply/reject engine (file 07 §7.4).
 *
 * This is the heart of "AI edits apply safely": a model proposal is NEVER applied
 * directly. It becomes a ChangeSet — a tree of files, each split into independently
 * accept/reject-able HUNKS rendered in DiffReview.tsx. The user picks hunks; we
 * apply ONLY the accepted ones, deterministically, as one undoable batch.
 *
 * This module is the PURE core of that contract (file 07 §3.1/§7.4): a real
 * line-level diff (`computeHunks`), the apply math (`applyChangeSet`), the
 * accept/reject selection helpers, and a multi-file plan summary. It is
 * framework-free — NO monaco/react/electron — so it is fully testable in
 * isolation, which is exactly why it is the most-tested module in the package.
 *
 * GOLDEN RULE alignment (C5): this file decides nothing about SAFETY. It only
 * computes text. Files newly authored by the agent are flagged (`isNew`) so the
 * caller can route them through the engine run-gate (§5.2) — that decision lives
 * in the engine, never here.
 *
 * Node built-ins only (none needed — pure string math).
 */

/* ------------------------------------------------------------------------- *
 * Types (file 07 §7.4)
 * ------------------------------------------------------------------------- */

/** A single accept/reject-able change region within a file. */
export interface Hunk {
  /** stable id, unique within its FileEdit (used for accept/reject selection). */
  id: string;
  /** 0-based line index in the ORIGINAL file where this hunk's removed run starts. */
  originalStart: number;
  /** number of consecutive original lines this hunk removes (0 = pure insertion). */
  originalLines: number;
  /** the replacement lines (empty = pure deletion). */
  newLines: string[];
  /** the original lines this hunk removes, kept for the red side of the diff. */
  oldLines: string[];
}

/** One file's worth of edits — a list of independently selectable hunks. */
export interface FileEdit {
  /** canonical file:///abs/path key. */
  uri: string;
  hunks: Hunk[];
  /** the model is creating this file (no original on disk) — flagged for the run-gate. */
  isNew?: boolean;
  /** the model is deleting this file. */
  isDelete?: boolean;
}

/** A model proposal: a rationale + one FileEdit per touched file. */
export interface ChangeSet {
  id: string;
  /** the model's one-line "why" (rendered in the DiffReview header). */
  rationale: string;
  edits: FileEdit[];
}

/* ------------------------------------------------------------------------- *
 * Hunk computation — a real, deterministic line diff
 * ------------------------------------------------------------------------- */

/** Split text into lines WITHOUT dropping a trailing-newline distinction. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

/** Re-join lines with "\n" (the inverse of splitLines for our line model). */
function joinLines(lines: string[]): string {
  return lines.join("\n");
}

/**
 * Longest-common-subsequence over two line arrays. Returns the LCS table so the
 * caller can backtrack into matched/unmatched runs. Classic O(n*m) DP — fine for
 * the file sizes an AI edit touches (large-file mode skips AI per §3.1).
 */
function lcsTable(a: readonly string[], b: readonly string[]): number[][] {
  const n = a.length;
  const m = b.length;
  // (n+1) x (m+1), zero-initialised.
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

/** An edit operation produced by walking the LCS table. */
interface Op {
  kind: "equal" | "del" | "add";
  /** index into the original (del/equal) — undefined for add. */
  aIndex?: number;
  /** index into the new (add/equal) — undefined for del. */
  bIndex?: number;
}

/** Walk the LCS table into a flat op list (Myers-style equal/del/add sequence). */
function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  const dp = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  const n = a.length;
  const m = b.length;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "equal", aIndex: i, bIndex: j });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "del", aIndex: i });
      i++;
    } else {
      ops.push({ kind: "add", bIndex: j });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", aIndex: i++ });
  while (j < m) ops.push({ kind: "add", bIndex: j++ });
  return ops;
}

/**
 * Compute the HUNKS that transform `before` into `after`. Each maximal run of
 * del/add ops (separated by equal lines) becomes one independently selectable
 * hunk. Hunk ids are stable and content-independent (`h0`, `h1`, …) so a UI
 * checkbox map survives a re-render. Deterministic for identical inputs.
 *
 * - `originalStart`/`originalLines` describe the removed run in the ORIGINAL file
 *   (originalLines === 0 for a pure insertion).
 * - `newLines` is the replacement (empty for a pure deletion).
 */
export function computeHunks(before: string, after: string): Hunk[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const ops = diffOps(a, b);

  // `cursor` tracks the next ORIGINAL line index we'd consume — it is the anchor
  // for a pure insertion (the new lines splice in BEFORE this index).
  const hunks: Hunk[] = [];
  let idx = 0;
  let k = 0;
  let cursor = 0;
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.kind === "equal") {
      cursor = op.aIndex! + 1;
      k++;
      continue;
    }
    // Start of a change run — gather the contiguous del/add ops between equals.
    // A pure insertion is anchored at `cursor` (the next original index).
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const originalStart = op.kind === "del" ? op.aIndex! : cursor;
    while (k < ops.length && ops[k]!.kind !== "equal") {
      const cur = ops[k]!;
      if (cur.kind === "del") {
        oldLines.push(a[cur.aIndex!]!);
        cursor = cur.aIndex! + 1;
      } else {
        newLines.push(b[cur.bIndex!]!);
      }
      k++;
    }
    hunks.push({
      id: `h${idx++}`,
      originalStart,
      originalLines: oldLines.length,
      newLines,
      oldLines,
    });
  }
  return hunks;
}

/* ------------------------------------------------------------------------- *
 * Selection helpers
 * ------------------------------------------------------------------------- */

/** Every hunk id in a FileEdit (the "accept all" selection). */
export function acceptAll(edit: FileEdit): string[] {
  return edit.hunks.map((h) => h.id);
}

/** The empty selection (the "reject all" selection). */
export function rejectAll(_edit: FileEdit): string[] {
  return [];
}

/** Toggle a single hunk id into/out of a selection set (immutable). */
export function acceptHunk(selection: readonly string[], hunkId: string): string[] {
  return selection.includes(hunkId)
    ? selection.filter((id) => id !== hunkId)
    : [...selection, hunkId];
}

/* ------------------------------------------------------------------------- *
 * Apply — the deterministic, accept-subset apply math
 * ------------------------------------------------------------------------- */

/**
 * Apply ONLY the accepted hunks of a single FileEdit to `originalText`, returning
 * the new text. Deterministic and order-independent (hunks are sorted by their
 * original anchor before splicing, then applied bottom-up so earlier indices stay
 * valid). Unaccepted hunks are left untouched — exactly the §7.4 "Apply selected"
 * semantics. A single call is one undoable batch by construction (the caller wraps
 * the returned text in one Monaco executeEdits).
 *
 * - isDelete edits collapse to "" when ALL hunks are accepted, else apply normally.
 * - isNew edits treat originalText as "" (no original on disk).
 */
export function applyChangeSet(
  originalText: string,
  fileEdit: FileEdit,
  acceptedHunkIds: readonly string[],
): string {
  const accepted = new Set(acceptedHunkIds);
  const chosen = fileEdit.hunks.filter((h) => accepted.has(h.id));

  // A deletion with every hunk accepted collapses the whole file.
  if (fileEdit.isDelete && chosen.length === fileEdit.hunks.length && fileEdit.hunks.length > 0) {
    return "";
  }

  const base = fileEdit.isNew ? "" : originalText;
  const lines = splitLines(base);

  // Apply bottom-up so a splice never shifts a not-yet-applied hunk's anchor.
  const ordered = [...chosen].sort((x, y) => y.originalStart - x.originalStart);
  for (const h of ordered) {
    lines.splice(h.originalStart, h.originalLines, ...h.newLines);
  }
  return joinLines(lines);
}

/**
 * Round-trip convenience: apply the FULL set of a FileEdit (accept-all). For an
 * isNew file this yields the proposed file content from scratch.
 */
export function applyFileEditFully(originalText: string, fileEdit: FileEdit): string {
  return applyChangeSet(originalText, fileEdit, acceptAll(fileEdit));
}

/* ------------------------------------------------------------------------- *
 * Multi-file plan summary
 * ------------------------------------------------------------------------- */

/** A per-file line in the ChangeSet plan summary. */
export interface FilePlanSummary {
  uri: string;
  isNew: boolean;
  isDelete: boolean;
  hunks: number;
  /** lines added across all hunks. */
  added: number;
  /** lines removed across all hunks. */
  removed: number;
}

/** The whole-ChangeSet summary the DiffReview header renders (file 07 §7.4). */
export interface ChangeSetSummary {
  id: string;
  rationale: string;
  files: FilePlanSummary[];
  totalAdded: number;
  totalRemoved: number;
  /** uris of files newly authored by the agent — flagged for the next run-gate (§5.2). */
  newFiles: string[];
}

/** Added/removed line counts for one FileEdit. */
function fileEditCounts(edit: FileEdit): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of edit.hunks) {
    added += h.newLines.length;
    removed += h.oldLines.length;
  }
  return { added, removed };
}

/**
 * Build the multi-file plan summary for a ChangeSet (pure). Used both by the GUI
 * DiffReview header and the `prometheus agent` patch preview (file 07 §10 parity). The
 * `newFiles` list is what the caller hands to the run-gate — AI-authored code is
 * untrusted-until-gated, exactly like cloned code (§7.4).
 */
export function summarizeChangeSet(cs: ChangeSet): ChangeSetSummary {
  const files: FilePlanSummary[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  const newFiles: string[] = [];
  for (const edit of cs.edits) {
    const { added, removed } = fileEditCounts(edit);
    totalAdded += added;
    totalRemoved += removed;
    if (edit.isNew) newFiles.push(edit.uri);
    files.push({
      uri: edit.uri,
      isNew: edit.isNew === true,
      isDelete: edit.isDelete === true,
      hunks: edit.hunks.length,
      added,
      removed,
    });
  }
  return { id: cs.id, rationale: cs.rationale, files, totalAdded, totalRemoved, newFiles };
}

/**
 * Build a FileEdit from a before/after pair (the common path: the model returns a
 * full rewritten file and we diff it into selectable hunks). `isNew` is inferred
 * when `before` is empty and `after` is not.
 */
export function fileEditFromTexts(uri: string, before: string, after: string): FileEdit {
  const hunks = computeHunks(before, after);
  const edit: FileEdit = { uri, hunks };
  if (before === "" && after !== "") edit.isNew = true;
  if (before !== "" && after === "") edit.isDelete = true;
  return edit;
}
