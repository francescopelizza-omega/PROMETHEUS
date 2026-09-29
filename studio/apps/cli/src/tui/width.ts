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
  /**
   * The BMP emoji that are WIDE WITHOUT a variation selector (`Emoji_Presentation=Yes`).
   *
   * The ranges above jump from U+FFE6 straight to U+1F000, so every code point between U+2000
   * and U+2FFF was measured as one column — including this set, which every emulator on every
   * platform advances TWO cells for. No font or `TERM_PROGRAM` check belongs here: unlike the
   * text-default emoji (`⚙`, `⚠`, `ℹ`, whose width depends on whether the terminal font carries
   * a text glyph), these have emoji presentation by default and are unconditionally two cells.
   *
   * They do not appear in the chrome's own source — they arrive in model replies, which are
   * word-wrapped with `wrapLine(line, cols-1)` and written into scrollback verbatim. A reply
   * line holding a `✅` or a `❌` that packs to exactly the measured budget is really one column
   * over, so it wraps, the printed block is a row taller than the renderer counted, and the
   * chrome below it drifts — the same failure as a mismeasured composer row, reached through
   * ordinary agent output instead.
   */
  if (
    cp === 0x231a ||
    cp === 0x231b ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55
  ) {
    return 2;
  }
  return 1;
}

/**
 * U+FE0E VARIATION SELECTOR-15 — "render the PREVIOUS code point as text, one cell".
 *
 * For the other half of the emoji problem: code points with `Emoji=Yes` but
 * `Emoji_Presentation=No` (`⚙` U+2699, `⚠` U+26A0, `ℹ` U+2139, …). Their width is a property of
 * the TERMINAL FONT, not of Unicode — measured on this machine, Menlo carries a text glyph for
 * `⚙` and paints it in one cell, while Monaco does not and CoreText falls back to Apple Color
 * Emoji, which takes two. A width table cannot be right for both, so fixed-width chrome must
 * not gamble: appending VS15 asks for the one-cell text glyph explicitly, which is what
 * `charWidth` already assumes. VS15 itself measures 0, so no caller's column budget moves.
 *
 * Use it on any such glyph that lands in a line built to an exact column budget. It is a no-op
 * on a terminal that was already picking the text glyph.
 */
export const TEXT_PRESENTATION = "︎";

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
  /**
   * ANSI-aware, exactly like `stringWidth` and `wrapLine` already are.
   *
   * Iterating raw code points counted the bytes of an SGR run as visible columns: `\x1b[31m`
   * spends four of them (`[`, `3`, `1`, `m` — ESC itself is zero), so a styled string was
   * over-truncated by four columns per colour change, and every caller that had already
   * measured with `stringWidth` disagreed with the result. Worse, a cut landing INSIDE the
   * sequence emitted a bare `\x1b[` — a half escape the terminal then eats the next character
   * to complete, so clipping a colored line could corrupt the line after it.
   *
   * `toCells` splits the string into whole SGR runs (width 0) and single code points, so a
   * sequence is either copied entire or not at all.
   */
  let out = "";
  let w = 0;
  for (const cell of toCells(s)) {
    if (cell.w === 0) {
      out += cell.s; // an SGR run: keep it whole, it costs no columns
      continue;
    }
    if (w + cell.w > width - 1) break;
    out += cell.s;
    w += cell.w;
  }
  // Re-close explicitly. The cut can land BEFORE the source's own reset, and a clipped
  // coloured string that never resets leaves its tint running into everything drawn after it
  // — one truncated row repaints the rest of the screen in its colour. Zero-width, so no
  // caller's column budget changes.
  return `${out}…${out.includes("\x1b[") ? "\x1b[0m" : ""}`;
}
