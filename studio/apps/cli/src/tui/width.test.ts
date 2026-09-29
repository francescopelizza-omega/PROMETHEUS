/**
 * width.test.ts — wcwidth: wide CJK/emoji = 2, combining/ZWJ = 0, ANSI-stripped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TEXT_PRESENTATION,
  charWidth,
  clipToWidth,
  graphemeCount,
  graphemeOffset,
  graphemeSlice,
  padToWidth,
  splitGraphemes,
  stringWidth,
  wrapLine,
} from "./width.js";

test("charWidth: ASCII=1, CJK/emoji=2, combining/ZW=0", () => {
  assert.equal(charWidth("a".codePointAt(0) ?? 0), 1);
  assert.equal(charWidth("中".codePointAt(0) ?? 0), 2);
  assert.equal(charWidth("😀".codePointAt(0) ?? 0), 2);
  assert.equal(charWidth(0x0301), 0); // combining acute
  assert.equal(charWidth(0x200d), 0); // ZWJ
  assert.equal(charWidth(0xfe0f), 0); // variation selector
});

/**
 * The wide ranges jumped from U+FFE6 to U+1F000, so the BMP emoji — which are two cells in every
 * emulator on every platform — were measured as one. They are not in the chrome's own source;
 * they arrive in model replies, which are word-wrapped to `cols-1` and written straight into
 * scrollback, so a reply line holding a `✅` that packs to exactly the budget is one column over,
 * wraps, and makes the printed block a row taller than anything counted.
 */
test("charWidth: BMP emoji with default emoji presentation are 2 cells", () => {
  for (const ch of ["✅", "❌", "⭐", "⭕", "❗", "✨", "⌚", "⏰", "⏳", "➕", "⚡", "♈", "⬛"]) {
    assert.equal(stringWidth(ch), 2, `${ch} must measure 2 columns`);
  }
  // …while the TEXT-default neighbours stay 1: their width is a font property, and the chrome
  // pins them with VS15 (`TEXT_PRESENTATION`) rather than guessing in the table.
  for (const ch of ["⚙", "⚠", "ℹ", "✓", "✗", "→", "·", "│", "╭"]) {
    assert.equal(stringWidth(ch), 1, `${ch} must measure 1 column`);
  }
});

test("TEXT_PRESENTATION pins a text-default emoji to one cell and costs no columns", () => {
  assert.equal(stringWidth(TEXT_PRESENTATION), 0);
  assert.equal(stringWidth(`⚙${TEXT_PRESENTATION} medium`), 8); // same as the bare gear
  assert.equal(stringWidth("⚙ medium"), 8);
});

test("stringWidth sums cells + strips ANSI", () => {
  assert.equal(stringWidth("ab"), 2);
  assert.equal(stringWidth("中文"), 4);
  assert.equal(stringWidth("a😀b"), 4);
  assert.equal(stringWidth("\x1b[31mred\x1b[0m"), 3); // ANSI ignored
});

test("padToWidth pads to display columns", () => {
  assert.equal(padToWidth("中", 4), "中  "); // 2 + 2 spaces = 4 cols
  assert.equal(padToWidth("ab", 2), "ab"); // already wide enough
});

test("clipToWidth truncates by columns with an ellipsis", () => {
  const clipped = clipToWidth("中文字", 4); // 6 cols → must fit ≤ 4
  assert.ok(stringWidth(clipped) <= 4);
  assert.ok(clipped.endsWith("…"));
  assert.equal(clipToWidth("hello", 10), "hello"); // already fits → unchanged
});

test("wrapLine: soft-wraps at spaces, trims the wrap-point space (CLI-003)", () => {
  // "the quick brown fox" @ width 9 → "the quick" / "brown fox"
  assert.deepEqual(wrapLine("the quick brown fox", 9), ["the quick", "brown fox"]);
  // fits → single line, unchanged
  assert.deepEqual(wrapLine("short", 20), ["short"]);
  // no wrap when width <= 0 (unknown-width pass-through)
  assert.deepEqual(wrapLine("a b c d e", 0), ["a b c d e"]);
  // every wrapped line is within the width
  for (const l of wrapLine("alpha beta gamma delta epsilon", 12)) {
    assert.ok(stringWidth(l) <= 12);
    assert.ok(!l.startsWith(" "), "no stray leading space after a wrap");
  }
});

test("wrapLine: hard-breaks an unbreakable run at the width, on codepoint edges", () => {
  const parts = wrapLine("abcdefghij", 4); // no spaces → hard break every 4
  assert.deepEqual(parts, ["abcd", "efgh", "ij"]);
  // wide chars count 2 cells: 3 CJK @ width 4 → 2 per line
  const cjk = wrapLine("中文字", 4);
  for (const l of cjk) assert.ok(stringWidth(l) <= 4);
  // a surrogate-pair emoji never splits mid-glyph
  for (const l of wrapLine("😀😀😀", 3)) assert.ok(stringWidth(l) <= 3);
});

// ── CLI-065: grapheme clusters ───────────────────────────────────────────────────
test("splitGraphemes: ASCII / CJK / ZWJ emoji / combining marks each cluster correctly (CLI-065)", () => {
  assert.deepEqual(splitGraphemes("abc"), ["a", "b", "c"]);
  assert.deepEqual(splitGraphemes("你好"), ["你", "好"]);
  assert.deepEqual(splitGraphemes("👨‍👩‍👧"), ["👨‍👩‍👧"]); // 7 code points → 1 grapheme
  assert.deepEqual(splitGraphemes("é"), ["é"]); // e + combining acute → 1 grapheme
  assert.equal(graphemeCount("a你👨‍👩‍👧"), 3);
});

test("graphemeOffset + graphemeSlice map grapheme indices to code units (CLI-065)", () => {
  const s = "a你好"; // a(1) 你(1) 好(1) — but 你/好 are single UTF-16 units each; use an astral char
  assert.equal(graphemeOffset("ab", 1), 1);
  const family = "👨‍👩‍👧"; // 11 UTF-16 units
  assert.equal(graphemeOffset(`x${family}y`, 1), 1); // offset before the family = 1 (after "x")
  assert.equal(graphemeOffset(`x${family}y`, 2), 1 + family.length); // after the whole family
  assert.equal(graphemeSlice(`x${family}y`, 0, 2), `x${family}`);
  assert.equal(graphemeSlice("你好世界", 1, 3), "好世");
  void s;
});

test("clipToWidth is ANSI-aware — SGR bytes are not columns, and are never cut in half", () => {
  /**
   * It iterated raw code points, so an SGR run spent four visible columns (`[`, `3`, `1`, `m` —
   * ESC itself is zero). A styled string was over-truncated by four columns per colour change,
   * disagreeing with the `stringWidth` every caller had already measured with. Worse, a cut
   * landing INSIDE the sequence emitted a bare `\x1b[` — half an escape, which the terminal
   * completes by eating the next character, so clipping a coloured line corrupted the line
   * after it.
   */
  const RED = "\x1b[31m";
  const RESET = "\x1b[0m";
  const styled = `${RED}hello world${RESET} tail`;
  assert.equal(stringWidth(styled), 16);

  for (const w of [4, 8, 12, 15]) {
    const out = clipToWidth(styled, w);
    assert.ok(stringWidth(out) <= w, `clip(${w}) produced ${stringWidth(out)} visible columns`);
  }
  // the styling survives, and no partial escape is emitted
  const cut = clipToWidth(`${RED}abcdefgh`, 2);
  assert.ok(cut.startsWith(RED), "a whole SGR run is kept");
  assert.ok(!/\x1b(?!\[[0-9;]*m)/.test(cut), "a bare/severed ESC must never reach the terminal");
  // plain text is unchanged
  assert.equal(clipToWidth("abcdefghij", 5), "abcd…");
  assert.equal(clipToWidth("short", 20), "short");
});
