/**
 * input-box.test.ts — composer layout: borders, width, soft-wrap, explicit newline,
 * cursor mapping, placeholder, and vertical scroll.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { clickToOffset, layoutComposer, reverseSearchLine } from "./input-box.js";
import { stringWidth } from "./width.js";

test("empty composer shows the placeholder + a 3-line box", () => {
  const l = layoutComposer("", 0, 30, { placeholder: "type a message…" });
  assert.equal(l.lines.length, 3);
  assert.ok(l.lines[0]?.startsWith("╭"));
  assert.ok(l.lines[2]?.startsWith("╰"));
  assert.match(l.lines[1] ?? "", /type a message/);
  // cursor sits at the start of the text area (col 4, body row 1)
  assert.equal(l.cursorRow, 1);
  assert.equal(l.cursorCol, 4);
});

test("box spans the full terminal width (resizes)", () => {
  for (const w of [20, 40, 80]) {
    const l = layoutComposer("hi", 2, w);
    assert.equal([...(l.lines[0] ?? "")].length, w, `top border == width ${w}`);
    assert.equal([...(l.lines[1] ?? "")].length, w, `body == width ${w}`);
  }
});

test("wide CJK content keeps the right border aligned (display width)", () => {
  const w = 40;
  const l = layoutComposer("中文中文中文", 6, w);
  for (const line of l.lines) {
    assert.equal(stringWidth(line), w, `line is ${w} display cols: ${line}`);
  }
  // caret after 6 wide chars sits at gutter(4) + 6×2 = 16 display cols
  assert.equal(l.cursorCol, 4 + 12);
});

test("cursor column tracks the caret index", () => {
  const l = layoutComposer("hello", 3, 40);
  assert.equal(l.cursorCol, 4 + 3); // text starts at col 4
  assert.equal(l.cursorRow, 1);
});

test("soft-wrap pushes long text + cursor onto the next visual row", () => {
  // textW = width-6 = 4; "abcdef" wraps after 4 chars.
  const l = layoutComposer("abcdef", 6, 10); // cursor at end (index 6)
  // body rows: "abcd" then "ef" → 2 body rows + 2 borders = 4 lines
  assert.equal(l.lines.length, 4);
  assert.equal(l.cursorRow, 2); // second body row
  assert.equal(l.cursorCol, 4 + 2); // after "ef"
});

test("explicit newline (Shift-Enter) splits rows", () => {
  const l = layoutComposer("a\nb", 3, 40);
  assert.equal(l.lines.length, 4); // 2 body rows + 2 borders
  assert.equal(l.cursorRow, 2);
  assert.equal(l.cursorCol, 4 + 1); // after "b"
});

test("maxRows scrolls so the caret row stays visible", () => {
  // 6 wrapped rows of width 4, but maxRows=2 → only 2 body rows shown
  const text = "abcdefghijklmnopqrstuvwx"; // 24 chars / 4 = 6 rows
  const l = layoutComposer(text, text.length, 10, { maxRows: 2 });
  assert.equal(l.lines.length, 4); // 2 body + 2 borders
  // caret is on the last row, still visible
  assert.equal(l.cursorRow, 2);
});

test("painters are applied without shifting cursor columns", () => {
  const plain = layoutComposer("hi", 1, 30);
  const colored = layoutComposer("hi", 1, 30, {
    paint: { border: (s) => `\x1b[35m${s}\x1b[0m`, text: (s) => `\x1b[37m${s}\x1b[0m` },
  });
  assert.equal(colored.cursorCol, plain.cursorCol);
  assert.equal(colored.cursorRow, plain.cursorRow);
  assert.match(colored.lines[0] ?? "", /\x1b\[35m/); // border colored
});

test("reverseSearchLine: prompt format, highlight span, failing state (CLI-019)", () => {
  const hist = ["scan repo", "install foo"];
  // plain (caps=none identity painters) keeps the recognizable backtick format
  const line = reverseSearchLine({ query: "install", matchIndex: 1, failing: false }, hist);
  assert.equal(line, "(reverse-i-search)`install': install foo");
  // the matched span is passed to the highlight painter
  const hi = reverseSearchLine({ query: "foo", matchIndex: 1, failing: false }, hist, {
    match: (s) => `[${s}]`,
  });
  assert.equal(hi, "(reverse-i-search)`foo': install [foo]");
  // failing state + no candidate
  const failed = reverseSearchLine({ query: "zzz", matchIndex: -1, failing: true }, hist);
  assert.equal(failed, "(failed reverse-i-search)`zzz': ");
});

// ── CLI-069: click-to-offset ─────────────────────────────────────────────────────
test("clickToOffset: ASCII click lands on the clicked char (CLI-069)", () => {
  // "hello world" on one row, width 40. Click col 6 (0-based) → offset 6 ('w').
  assert.equal(clickToOffset("hello world", 40, 0, 6), 6);
  assert.equal(clickToOffset("hello world", 40, 0, 0), 0);
  assert.equal(clickToOffset("hello world", 40, 0, 99), 11); // past end → end of text
});

test("clickToOffset: a click mid-CJK-glyph lands on its LEFT edge (CLI-069)", () => {
  // "a你好" → a@col0, 你@col1-2, 好@col3-4. Click col2 (2nd cell of 你) → offset 1 (before 你).
  assert.equal(clickToOffset("a你好", 40, 0, 0), 0); // 'a'
  assert.equal(clickToOffset("a你好", 40, 0, 1), 1); // start of 你
  assert.equal(clickToOffset("a你好", 40, 0, 2), 1); // mid-你 → left edge (offset 1)
  assert.equal(clickToOffset("a你好", 40, 0, 3), 2); // start of 好
});

test("clickToOffset: a click on a wrapped 2nd row maps into that row (CLI-069)", () => {
  // width 5 → "hello" fills row 0, "world" on row 1. Click row 1 col 2 → offset 7 ('r').
  assert.equal(clickToOffset("helloworld", 5, 1, 2), 7);
  assert.equal(clickToOffset("helloworld", 5, 9, 0), 10); // below text → buffer end
});

/* ── the inlaid bottom-border badge (per-model effort state) ─────────────────── */

test("a badge is inlaid in the BOTTOM border, right-aligned, preserving box width", () => {
  const l = layoutComposer("hi", 2, 40, { badge: "effort: high" });
  const bottom = l.lines[2] ?? "";
  // width must be unchanged — the redraw math depends on lines.length AND column count.
  assert.equal([...bottom].length, 40);
  assert.ok(bottom.startsWith("╰"));
  assert.ok(bottom.endsWith("╯"));
  assert.match(bottom, /effort: high/);
  // right-aligned: exactly two trailing dashes before the corner.
  assert.match(bottom, /effort: high ──╯$/);
  // the TOP border stays a clean rule.
  assert.equal(l.lines[0], `╭${"─".repeat(38)}╮`);
});

test("the badge does not disturb cursor math", () => {
  const plain = layoutComposer("hello", 5, 40);
  const badged = layoutComposer("hello", 5, 40, { badge: "effort: not available" });
  assert.equal(badged.cursorRow, plain.cursorRow);
  assert.equal(badged.cursorCol, plain.cursorCol);
  assert.equal(badged.height, plain.height);
});

test("a badge too wide for the box is dropped whole, never truncated", () => {
  // a half-rendered "effort: not availa" reads as a rendering bug, not as information.
  const l = layoutComposer("hi", 2, 20, { badge: "effort: not available" });
  const bottom = l.lines[2] ?? "";
  assert.equal([...bottom].length, 20);
  assert.equal(bottom, `╰${"─".repeat(18)}╯`);
  assert.equal(bottom.includes("effort"), false);
});

test("no badge renders the classic plain rule", () => {
  const l = layoutComposer("hi", 2, 30);
  assert.equal(l.lines[2], `╰${"─".repeat(28)}╯`);
});

test("the badge is painted independently of the border", () => {
  const l = layoutComposer("hi", 2, 40, {
    badge: "effort: high",
    paint: { border: (s) => `<b>${s}</b>`, badge: (s) => `<E>${s}</E>` },
  });
  const bottom = l.lines[2] ?? "";
  assert.match(bottom, /<E> effort: high <\/E>/);
  assert.match(bottom, /^<b>╰<\/b>/);
});

/* ── the two-row trait panel ────────────────────────────────────────────────*/

test("panel: a `├──┤` rule, the two rows, then a PLAIN bottom border", () => {
  // The bottom border carries no inlaid badge when a panel is present: they are two
  // renderings of the same facts, and showing both would say everything twice.
  const l = layoutComposer("hi", 2, 50, {
    panel: ["completion   vision", "tools        effort: high"],
    badge: "effort: high",
  });
  const [, , rule, r1, r2, bottom] = l.lines;
  assert.ok(rule?.startsWith("\u251c"), "the panel opens with a tee-joined rule");
  assert.ok(rule?.endsWith("\u2524"));
  assert.match(r1 ?? "", /completion/);
  assert.match(r2 ?? "", /effort: high/);
  assert.ok(bottom?.startsWith("\u2570"));
  assert.doesNotMatch(bottom ?? "", /effort/, "the badge must not also be inlaid");
});

test("panel: every rendered line is exactly the box width", () => {
  // The redraw math assumes lines.length === physical rows, which only holds if no line
  // wraps. A panel row one column too wide would silently double the box's height.
  for (const width of [30, 50, 80, 120]) {
    const l = layoutComposer("hi", 2, width, {
      panel: ["completion   vision   audio", "tools   thinking   effort: max"],
    });
    for (const line of l.lines) {
      assert.equal(stringWidth(line), width, `width ${width}: a line was not ${width} columns`);
    }
  }
});

test("panel: adds exactly 3 lines and does NOT move the caret", () => {
  const plain = layoutComposer("hello", 5, 50, {});
  const panelled = layoutComposer("hello", 5, 50, {
    panel: ["completion   vision", "tools        effort: high"],
  });
  assert.equal(panelled.height, plain.height + 3);
  // the panel lives BELOW the text area, so the caret is unaffected — the click-to-position
  // geometry in frame.ts depends on this.
  assert.equal(panelled.cursorRow, plain.cursorRow);
  assert.equal(panelled.cursorCol, plain.cursorCol);
});

test("panel: rows are painted with the badge painter, not the border one", () => {
  const l = layoutComposer("hi", 2, 50, {
    panel: ["tools   thinking", "vision  effort: high"],
    paint: { badge: (s) => `<E>${s}</E>`, border: (s) => `<B>${s}</B>` },
  });
  assert.match(l.lines[3] ?? "", /<E>tools/);
  assert.match(l.lines[4] ?? "", /effort: high\s*<\/E>/);
});

test("panel: an over-wide row is clipped rather than allowed to wrap the box", () => {
  // `status.ts` returns null instead of a clipped grid, so this should be unreachable in
  // practice — but a row that DID arrive too wide must break the strip, never the redraw.
  const l = layoutComposer("hi", 2, 30, { panel: ["x".repeat(200), "y".repeat(200)] });
  for (const line of l.lines) assert.equal(stringWidth(line), 30);
});
