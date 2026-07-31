/**
 * tui/width.ts — terminal DISPLAY width (a compact wcwidth).
 *
 * A terminal cell is not a code point: CJK ideographs + most emoji occupy TWO columns,
 * combining marks / ZWJ / variation selectors occupy ZERO. Counting code points (or
 * UTF-16 units) miscounts both, which drifts the composer's right border + the caret.
 * This is the single source of "how many columns does this take", used by the box
 * layout, the status bar, and the dropdown so every line lands exactly at cols-1.
 */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Columns one Unicode code point occupies (0 / 1 / 2). */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  // C0/C1 controls render as nothing here (they shouldn't reach a visible cell).
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // zero-width: combining marks, ZWJ, variation selectors, zero-width spaces.
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x200b && cp <= 0x200f) || // ZW space/joiners + bidi marks
    cp === 0xfeff ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff)
  ) {
    return 0;
  }
  // wide (2-column) ranges: CJK, Hangul, kana, fullwidth forms, most emoji.
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // hiragana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms + small forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji + symbols
    (cp >= 0x1f000 && cp <= 0x1f2ff) || // mahjong/domino/cards/enclosed
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  ) {
    return 2;
  }
  return 1;
}

/** Display width of a string (ANSI-stripped, wide/zero-width aware). */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/* ── grapheme clusters (CLI-065) ─────────────────────────────────────────────── */

// Intl.Segmenter (Node ≥13 with full-icu, zero deps) — a ZWJ family emoji 👨‍👩‍👧 (7 code points)
// collapses to ONE grapheme; boundaries are locale-independent so the default locale is safe.
const GRAPHEME_SEG = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Split a string into grapheme clusters (CJK = 1 each, a ZWJ emoji cluster = 1, ASCII = 1 each). */
export function splitGraphemes(s: string): string[] {
  return [...GRAPHEME_SEG.segment(s)].map((seg) => seg.segment);
}

/** Number of grapheme clusters. */
export function graphemeCount(s: string): number {
  return splitGraphemes(s).length;
}

/** The UTF-16 string offset of grapheme index `n` (clamped to [0, count]) — for caret↔slice math. */
export function graphemeOffset(s: string, n: number): number {
  const g = splitGraphemes(s);
  let off = 0;
  for (let i = 0; i < Math.min(Math.max(0, n), g.length); i++) off += (g[i] ?? "").length;
  return off;
}

/** Substring by GRAPHEME indices (mixing code-unit + grapheme indices is the classic desync bug). */
export function graphemeSlice(s: string, start: number, end?: number): string {
  return splitGraphemes(s).slice(start, end).join("");
}

/** Right-pad a string to `width` display columns (no-op when already ≥ width). */
export function padToWidth(s: string, width: number): string {
  const gap = width - stringWidth(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/** Split a line into ANSI-SGR runs (zero-width) and single code points (their cell width). */
function toCells(line: string): { s: string; w: number }[] {
  const out: { s: string; w: number }[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
      if (m) {
        out.push({ s: m[0], w: 0 });
        i += m[0].length;
        continue;
      }
    }
    const cp = line.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    out.push({ s: ch, w: charWidth(cp) });
    i += ch.length; // advance by UTF-16 units so surrogate pairs stay intact
  }
  return out;
}

/**
 * Word-wrap ONE logical line to `width` display columns (ANSI + wide-char aware).
 * Soft-wraps at the last space before the boundary (trimming that space); an
 * unbreakable run longer than `width` hard-breaks exactly at the boundary, on a
 * code-point (never mid-surrogate / mid-ANSI) edge. `width <= 0` ⇒ no wrap.
 */
export function wrapLine(line: string, width: number): string[] {
  if (width <= 0 || stringWidth(line) <= width) return [line];
  const cells = toCells(line);
  const out: string[] = [];
  let cur = "";
  let curW = 0;
  let spaceAt = -1; // UTF-16 index in `cur` of the last space (soft-wrap point)
  for (const c of cells) {
    const isSpace = c.s === " ";
    if (curW + c.w > width && curW > 0) {
      if (isSpace) {
        // the space itself is the overflow → end the line here, consume the space
        out.push(cur);
        cur = "";
        curW = 0;
        spaceAt = -1;
        continue;
      }
      if (spaceAt >= 0) {
        out.push(cur.slice(0, spaceAt)); // drop the wrap-point space
        cur = cur.slice(spaceAt + 1);
        curW = stringWidth(cur);
        spaceAt = -1;
      } else {
        out.push(cur); // hard break — no space to wrap at
        cur = "";
        curW = 0;
      }
    }
    cur += c.s;
    curW += c.w;
    if (isSpace) spaceAt = cur.length - 1;
  }
  if (cur.length > 0 || out.length === 0) out.push(cur);
  return out;
}

/** Truncate a string to at most `width` display columns, adding "…" when it cuts. */
export function clipToWidth(s: string, width: number): string {
  if (stringWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}
