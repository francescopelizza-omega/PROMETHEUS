/**
 * tui/input-box.ts — the bordered, resizable composer layout.
 *
 * Pure layout: given the input text, the cursor index, and the terminal width, it
 * produces the rounded box (top rule · prompt + wrapped text · bottom rule) PLUS the
 * exact (row,col) the real terminal cursor must move to. Width is recomputed every
 * render so the box resizes with the window (SIGWINCH). Soft-wrap + explicit "\n"
 * (Shift-Enter) are both honored; the cursor mapping is char-accurate across wraps.
 *
 * Color is INJECTED (border/prompt/placeholder/text painters) so cursor columns are
 * computed in VISIBLE coordinates and never drift when ANSI is added. PURE + tested.
 */

import { charWidth, clipToWidth, padToWidth } from "./width.js";

const TL = "╭";
const TR = "╮";
const BL = "╰";
const BR = "╯";
const H = "─";
const V = "│";

/** Optional painters (default identity → plain strings for tests). */
export interface ComposerPaint {
  border?: (s: string) => string;
  prompt?: (s: string) => string;
  placeholder?: (s: string) => string;
  text?: (s: string) => string;
}

export interface ComposerOpts {
  /** the first-line marker (default "›"). */
  prompt?: string;
  /** dim hint shown when the text is empty. */
  placeholder?: string;
  /** painters for color (default identity). */
  paint?: ComposerPaint;
  /** clamp the box to at most this many visual text rows (scrolls the tail). */
  maxRows?: number;
}

export interface ComposerLayout {
  /** the full box, top border → body rows → bottom border. */
  lines: string[];
  /** cursor target, 0-indexed from the FIRST line of the box. */
  cursorRow: number;
  cursorCol: number;
  /** total line count (== lines.length) — the app needs it for the redraw math. */
  height: number;
}

const id = (s: string): string => s;

/** A visual row of the text area: the substring + the global index where it starts. */
interface VisualRow {
  text: string;
  start: number;
}

/**
 * Walk the text into visual rows of width `w`, honoring explicit "\n". Also returns a
 * cursor map: for every global index 0..len, the (row,col) the caret sits at. The
 * caret at a soft-wrap boundary sits at the START of the next row (editor convention).
 */
function wrap(text: string, w: number): { rows: VisualRow[]; caret: Array<[number, number]> } {
  const rows: VisualRow[] = [];
  const caret: Array<[number, number]> = [];
  // index by CODE POINT (not UTF-16 unit) so an emoji is one caret step + one cell.
  const cps = [...text];
  let row = 0;
  let col = 0;
  let cur = "";
  let start = 0;
  const flush = (): void => {
    rows.push({ text: cur, start });
    cur = "";
  };
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i] as string;
    if (ch === "\n") {
      caret[i] = [row, col];
      flush();
      row += 1;
      col = 0;
      start = i + 1;
      continue;
    }
    // wide chars (CJK/emoji) take 2 cells; wrap BEFORE placing one that would overflow.
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (col + cw > w && col > 0) {
      flush();
      row += 1;
      col = 0;
      start = i;
    }
    caret[i] = [row, col];
    cur += ch;
    col += cw;
  }
  caret[cps.length] = [row, col];
  flush();
  return { rows, caret };
}

/**
 * Map a click inside the composer text area back to a caret offset (CLI-069). `bodyRow` is the
 * 0-based visual row within the wrapped text; `textCol` is the 0-based DISPLAY column within the
 * text (both already translated from the terminal report by the app). Returns the code-point
 * offset: the largest offset on `bodyRow` whose column ≤ `textCol` — so a click mid-way through a
 * 2-cell CJK/emoji glyph lands the caret on its LEFT edge (consistently). Past a line's end → the
 * row's end; below the text → the buffer end.
 */
export function clickToOffset(text: string, w: number, bodyRow: number, textCol: number): number {
  const { caret } = wrap(text, Math.max(1, w));
  let best = -1;
  let bestCol = -1;
  let lastOnRow = -1;
  for (let o = 0; o < caret.length; o++) {
    const [r, col] = caret[o] ?? [0, 0];
    if (r !== bodyRow) continue;
    lastOnRow = o;
    if (col <= textCol && col > bestCol) {
      best = o;
      bestCol = col;
    }
  }
  if (best >= 0) return best;
  if (lastOnRow >= 0) return lastOnRow; // click past the line's end → end of that row
  return Math.max(0, caret.length - 1); // below the text → buffer end
}

/**
 * Lay out the composer for the given text + cursor + terminal width.
 *
 * The box always spans `width` columns (responsive). Inner text width = width-6
 * (2 borders, 2 pad, 2 gutter). When the wrapped text exceeds `maxRows`, the view
 * scrolls so the cursor's row stays visible (the tail is shown).
 */
export function layoutComposer(
  text: string,
  cursor: number,
  width: number,
  opts: ComposerOpts = {},
): ComposerLayout {
  const prompt = opts.prompt ?? "›";
  const paint = opts.paint ?? {};
  const pb = paint.border ?? id;
  const pp = paint.prompt ?? id;
  const ph = paint.placeholder ?? id;
  const pt = paint.text ?? id;

  // clamp width so the math never goes negative on a tiny terminal.
  const outer = Math.max(width, 8);
  const textW = Math.max(1, outer - 6);
  const cur = Math.max(0, Math.min(cursor, [...text].length));

  const { rows, caret } = wrap(text, textW);
  const [caretRow, caretCol] = caret[cur] ?? [0, 0];

  // vertical scroll: keep the caret row visible within maxRows.
  const maxRows = Math.max(1, opts.maxRows ?? rows.length);
  let top = 0;
  if (rows.length > maxRows) {
    top = Math.min(Math.max(0, caretRow - (maxRows - 1)), rows.length - maxRows);
  }
  const view = rows.slice(top, top + maxRows);

  const bar = H.repeat(outer - 2);
  const lines: string[] = [pb(`${TL}${bar}${TR}`)];

  const empty = text.length === 0;
  view.forEach((vr, idx) => {
    const isFirst = top + idx === 0;
    const gutter = isFirst ? `${prompt} ` : "  ";
    const body =
      empty && isFirst
        ? ph(padToWidth(clipToWidth(opts.placeholder ?? "", textW), textW))
        : pt(padToWidth(vr.text, textW));
    const g = isFirst ? pp(gutter) : gutter;
    lines.push(`${pb(V)} ${g}${body} ${pb(V)}`);
  });
  lines.push(pb(`${BL}${bar}${BR}`));

  // cursor: row 0 is the top border; body rows follow. col 0 is the left border.
  // layout: V(1) + space(1) + gutter(2) + text → text starts at column 4.
  const visRow = caretRow - top;
  const cursorRow = 1 + Math.max(0, Math.min(visRow, view.length - 1));
  const cursorCol = 4 + caretCol;
  return { lines, cursorRow, cursorCol, height: lines.length };
}

/**
 * The reverse-i-search prompt line (CLI-019): `` (reverse-i-search)`query': match ``,
 * or `(failed reverse-i-search)` when no match. The matched span is highlighted via the
 * injected `match` painter (identity → plain, so it stays readable under caps="none").
 */
export function reverseSearchLine(
  search: { query: string; matchIndex: number; failing: boolean },
  history: readonly string[],
  paint: { label?: (s: string) => string; match?: (s: string) => string } = {},
): string {
  const label = paint.label ?? id;
  const hi = paint.match ?? id;
  const candidate = search.matchIndex >= 0 ? (history[search.matchIndex] ?? "") : "";
  const tag = search.failing ? "(failed reverse-i-search)" : "(reverse-i-search)";
  let shown = candidate;
  if (search.query) {
    const i = candidate.toLowerCase().indexOf(search.query.toLowerCase());
    if (i >= 0) {
      shown =
        candidate.slice(0, i) +
        hi(candidate.slice(i, i + search.query.length)) +
        candidate.slice(i + search.query.length);
    }
  }
  return `${label(tag)}\`${search.query}': ${shown}`;
}
