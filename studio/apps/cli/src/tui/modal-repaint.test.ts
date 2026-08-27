/**
 * modal-repaint.test.ts — the modal repaint must move up from where the cursor IS.
 *
 * `paintModal` erases from the modal's first line down, so it first moves the cursor up to that
 * line. It moved up `modalLines - 1` — i.e. it assumed the cursor was still at the end of the
 * LAST line. It usually is, but when the prompt fits one line and a hint row is present, the
 * same function deliberately moves the cursor back UP to the prompt row so the caret sits in the
 * text. The next keystroke then moved up another `modalLines - 1` from there, overshooting by
 * exactly one row every time and walking the prompt up the screen over the scrollback above it.
 *
 * The hint row is not hypothetical: the folder prompt renders a live candidate row on every
 * keystroke, which is what made this reachable.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Replay the cursor bookkeeping for `keystrokes` repaints; returns net rows drifted upward. */
function drift(opts: { hintRow: boolean; keystrokes: number; moveUpFrom: "lines" | "cursor" }) {
  const lines = opts.hintRow ? 2 : 1; // prompt row (+ hint row)
  let cursorRow = 0;
  let net = 0;
  for (let i = 0; i < opts.keystrokes; i++) {
    const up = opts.moveUpFrom === "lines" ? Math.max(0, lines - 1) : cursorRow;
    net += up - cursorRow; // rows moved beyond the modal's own first line
    cursorRow = lines - 1; // the write lands the cursor on the last line…
    if (lines > 1) cursorRow = 0; // …then the caret is put back on the prompt row
  }
  return net;
}

test("a hint row made the OLD arithmetic walk the modal up one row per keystroke", () => {
  assert.equal(drift({ hintRow: true, keystrokes: 10, moveUpFrom: "lines" }), 10);
  // and why it went unnoticed: with no hint row the two are identical
  assert.equal(drift({ hintRow: false, keystrokes: 10, moveUpFrom: "lines" }), 0);
});

test("moving up from the RECORDED cursor row leaves the modal in place", () => {
  for (const hintRow of [false, true]) {
    assert.equal(
      drift({ hintRow, keystrokes: 50, moveUpFrom: "cursor" }),
      0,
      `hintRow=${hintRow}: the modal must not move`,
    );
  }
});

test("paintModal moves up by the recorded cursor row, not by the line count", () => {
  const src = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function paintModal"), src.indexOf("function mainHandler"));
  assert.ok(
    fn.includes("if (modalCursorRow > 0) safeWrite(`\\r\\x1b[${modalCursorRow}A`)"),
    "the repaint must move up from the recorded cursor row",
  );
  assert.ok(
    !fn.includes("modalLines - 1}A"),
    "moving up by the line count is the defect — the cursor is not always on the last line",
  );
  assert.ok(
    fn.includes("modalCursorRow = 0; // …and the next repaint must start from HERE"),
    "putting the caret back on the prompt row must record that it moved",
  );
});
