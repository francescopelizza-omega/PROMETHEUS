// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/text-edit-apply.ts — PURE LSP TextEdit / WorkspaceEdit application (leap #3/#2).
 *
 * Applying an LSP rename or a code-action means splicing TextEdits into file text — for
 * the OPEN buffer (Monaco) AND for files only on disk (read→apply→write). This owns the
 * deterministic splice: convert each edit's LSP line/character range to a string offset,
 * apply RIGHT-TO-LEFT so earlier offsets stay valid. No monaco/react/fs — node:test-able;
 * the caller wires it to fsRead/fsWrite or Monaco models. Also normalizes the two
 * WorkspaceEdit forms ({changes} | {documentChanges}).
 */

import { type NormalizedTextEdit, normalizeTextEdits } from "./lsp-convert.js";

/** Precompute the absolute start offset of each line (0-based). */
function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** Convert an LSP {line, character} to a 0-based string offset (clamped to the text). */
function offsetAt(lineStarts: number[], textLen: number, line: number, character: number): number {
  if (line < 0) return 0;
  if (line >= lineStarts.length) return textLen;
  return Math.min((lineStarts[line] ?? 0) + Math.max(0, character), textLen);
}

/**
 * Apply LSP text edits to `text`. Edits are assumed non-overlapping (the LSP guarantee);
 * applied from the END so each splice doesn't shift the offsets of the ones before it.
 * Total + deterministic — an out-of-range range clamps rather than throwing.
 */
export function applyTextEdits(text: string, edits: NormalizedTextEdit[]): string {
  if (edits.length === 0) return text;
  const lineStarts = computeLineStarts(text);
  const spans = edits.map((e) => {
    const a = offsetAt(lineStarts, text.length, e.range.start.line, e.range.start.character);
    const b = offsetAt(lineStarts, text.length, e.range.end.line, e.range.end.character);
    return { lo: Math.min(a, b), hi: Math.max(a, b), newText: e.newText };
  });
  // apply last-first; ties broken by the later end first (stable for zero-width inserts).
  spans.sort((x, y) => y.lo - x.lo || y.hi - x.hi);
  let out = text;
  for (const s of spans) {
    out = out.slice(0, s.lo) + s.newText + out.slice(s.hi);
  }
  return out;
}

/** A WorkspaceEdit collapsed to per-file text edits. */
export interface WorkspaceFileEdit {
  uri: string;
  edits: NormalizedTextEdit[];
}

/* ── Refactor Preview state (APP-027) — PURE view-model over WorkspaceFileEdit[] ──
 * The preview only SELECTS whole files before handing the ORIGINAL edits to
 * applyTextEdits above; it never reorders/merges/dedupes edits (the applier owns
 * the splice semantics — do not fork a second engine). No React/monaco/fs here. */

/** One edit row of the preview (1-based display coordinates + local snippets). */
export interface PreviewEditRow {
  /** 1-based display range (raw from the WorkspaceEdit, NOT clamped). */
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  /** the exact old text of the (clamped) range; undefined when the file text is unknown. */
  oldText?: string;
  newText: string;
  /** old snippet: the edited line span plus one context line each side, clamped to
   *  the file bounds (a stale range past EOF clamps to the last line, never slices
   *  undefined). Empty when the file text is unknown. */
  before: string[];
  /** the same local span with the edit spliced in. */
  after: string[];
}

/** One file node of the preview tree. `fileEdit` is the ORIGINAL entry — feed IT
 *  (not any display ordering) to applyTextEdits. */
export interface PreviewFileNode {
  uri: string;
  /** human path (file:// stripped + %-decoded); non-file uris pass through. */
  path: string;
  editCount: number;
  edits: PreviewEditRow[];
  fileEdit: WorkspaceFileEdit;
}

/** The whole preview: one node per file that actually carries edits. */
export interface RefactorPreviewModel {
  files: PreviewFileNode[];
}

/** Display path for a uri (decode + strip the file:// scheme; fail-soft). */
function displayPath(uri: string): string {
  const stripped = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

/** Strip a trailing \r for DISPLAY lines only (the applier sees raw text). */
function displayLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Build one edit row: clamp the range to the actual lines, extract old text and
 *  the before/after snippets. Total — never throws on a stale/out-of-range edit. */
function buildEditRow(edit: NormalizedTextEdit, lines: string[] | undefined): PreviewEditRow {
  const { start, end } = edit.range;
  const row: PreviewEditRow = {
    startLine: start.line + 1,
    startCol: start.character + 1,
    endLine: end.line + 1,
    endCol: end.character + 1,
    newText: edit.newText,
    before: [],
    after: edit.newText.split("\n"),
  };
  if (!lines || lines.length === 0) return row;
  const last = lines.length - 1;
  // clamp EXACTLY like the applier's offsetAt: a line past EOF resolves to the END
  // of the text (an EOF insert), not to some column on the last line — the preview
  // must show what applyTextEdits will actually do with a stale range.
  const s = Math.min(Math.max(start.line, 0), last);
  const e = Math.min(Math.max(end.line, s), last);
  const sLine = lines[s] ?? "";
  const eLine = lines[e] ?? "";
  const sc =
    start.line > last ? sLine.length : Math.min(Math.max(start.character, 0), sLine.length);
  const ec = end.line > last ? eLine.length : Math.min(Math.max(end.character, 0), eLine.length);
  const old =
    s === e
      ? sLine.slice(sc, Math.max(sc, ec))
      : [sLine.slice(sc), ...lines.slice(s + 1, e), eLine.slice(0, ec)].join("\n");
  const spliced = (sLine.slice(0, sc) + edit.newText + eLine.slice(ec)).split("\n");
  const ctxBefore = s > 0 ? [lines[s - 1] ?? ""] : [];
  const ctxAfter = e < last ? [lines[e + 1] ?? ""] : [];
  row.oldText = old;
  row.before = [...ctxBefore, ...lines.slice(s, e + 1), ...ctxAfter].map(displayLine);
  row.after = [...ctxBefore, ...spliced, ...ctxAfter].map(displayLine);
  return row;
}

/**
 * Build the preview tree for a normalized WorkspaceEdit. `texts` maps uri → the
 * file's CURRENT text (from fsRead) for old/new snippets; a missing entry degrades
 * to newText-only rows (never an error). Zero-edit file entries are dropped —
 * an empty checkbox that toggles nothing is noise. PURE.
 */
export function buildPreview(
  files: WorkspaceFileEdit[],
  texts?: Record<string, string | undefined>,
): RefactorPreviewModel {
  const nodes: PreviewFileNode[] = [];
  for (const f of files) {
    if (f.edits.length === 0) continue;
    const text = texts?.[f.uri];
    const lines = typeof text === "string" ? text.split("\n") : undefined;
    nodes.push({
      uri: f.uri,
      path: displayPath(f.uri),
      editCount: f.edits.length,
      edits: f.edits.map((e) => buildEditRow(e, lines)),
      fileEdit: f,
    });
  }
  return { files: nodes };
}

/** The default include-set: every previewed file checked. */
export function allPreviewUris(preview: RefactorPreviewModel): Set<string> {
  return new Set(preview.files.map((f) => f.uri));
}

/** Toggle one uri in the include-set (returns a NEW set — react-state friendly). */
export function togglePreviewUri(included: ReadonlySet<string>, uri: string): Set<string> {
  const next = new Set(included);
  if (next.has(uri)) next.delete(uri);
  else next.add(uri);
  return next;
}

/**
 * The accepted per-file edits: INCLUDED files' ORIGINAL WorkspaceFileEdit entries,
 * in the original order. Excluded files are dropped WHOLE — the caller must not
 * fsRead/fsWrite them at all (byte-identity is proven by never touching them,
 * not by writing identical bytes back).
 */
export function selectedEdits(
  preview: RefactorPreviewModel,
  included: ReadonlySet<string>,
): WorkspaceFileEdit[] {
  return preview.files.filter((f) => included.has(f.uri)).map((f) => f.fileEdit);
}

/**
 * Normalize an LSP WorkspaceEdit into per-file edits. The two forms — `changes` (a
 * {uri: TextEdit[]} map) and `documentChanges` (TextDocumentEdit[]) — are MUTUALLY EXCLUSIVE
 * per LSP (a client advertising documentChanges receives only that form), so we PREFER
 * documentChanges and fall back to `changes` only when it is absent: applying both would
 * splice every edit twice (corruption) against a non-conforming server that populates both.
 * Resource ops (CreateFile/RenameFile/DeleteFile) inside documentChanges are dropped (rare for
 * a symbol rename, and applying them needs fs verbs the caller may not grant). PURE.
 */
export function normalizeWorkspaceEdit(wsedit: unknown): WorkspaceFileEdit[] {
  if (!wsedit || typeof wsedit !== "object") return [];
  const o = wsedit as { changes?: Record<string, unknown>; documentChanges?: unknown[] };
  const out: WorkspaceFileEdit[] = [];
  if (Array.isArray(o.documentChanges)) {
    for (const dc of o.documentChanges) {
      if (!dc || typeof dc !== "object") continue;
      const d = dc as { textDocument?: { uri?: unknown }; edits?: unknown };
      const uri = d.textDocument?.uri;
      if (typeof uri === "string" && Array.isArray(d.edits)) {
        const norm = normalizeTextEdits(d.edits);
        if (norm.length > 0) out.push({ uri, edits: norm });
      }
    }
  } else if (o.changes && typeof o.changes === "object" && !Array.isArray(o.changes)) {
    for (const [uri, edits] of Object.entries(o.changes)) {
      const norm = normalizeTextEdits(edits);
      if (norm.length > 0) out.push({ uri, edits: norm });
    }
  }
  return out;
}
