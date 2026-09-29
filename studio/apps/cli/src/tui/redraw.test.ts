/**
 * redraw.test.ts — relative cursor math + the stateful Renderer's parked-caret tracking.
 *
 * The load-bearing invariant: the cursor is parked at the CARET (mid-block) after a
 * paint, so the next repaint must move up by exactly the parked caret row — NOT by the
 * block height. The mid-block test below fails the naive (height-based) implementation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Frame } from "./frame.js";
import {
  ENTER_TUI,
  RESTORE_TUI,
  Renderer,
  composePaint,
  cursorRight,
  cursorUp,
  moveToTop,
  reflowSlack,
} from "./redraw.js";

test("cursorUp/Right are no-ops at 0 (ghost-motion guard)", () => {
  assert.equal(cursorUp(0), "");
  assert.equal(cursorUp(3), "\x1b[3A");
  assert.equal(cursorRight(0), "");
  assert.equal(cursorRight(5), "\x1b[5C");
});

test("moveToTop re-asserts autowrap-off, moves up the parked row + clears to end of screen", () => {
  assert.equal(moveToTop(0), "\x1b[?7l\r\x1b[0J"); // cursor already at the block top
  assert.equal(moveToTop(4), "\x1b[?7l\x1b[4A\r\x1b[0J");
});

/**
 * The whole redraw rests on `lines.length === physical rows`, and that holds only while DECAWM
 * is off. ENTER_TUI set it once at startup, so anything that turned it back on mid-session — a
 * child process, a pager, a terminal restoring defaults, or model output streamed verbatim into
 * scrollback that happened to contain the sequence — made one over-wide chrome line wrap, the
 * block a row taller than the renderer believed, and every repaint strand another top border.
 */
test("every Renderer write re-asserts autowrap-off, not just ENTER_TUI", () => {
  const writes: string[] = [];
  const r = new Renderer((s) => writes.push(s));
  r.paint({ lines: ["a", "b"], cursorRow: 1, cursorCol: 0 });
  r.printAbove("out");
  r.transient("working…");
  r.clear();
  assert.equal(writes.length, 4);
  for (const [i, w] of writes.entries()) {
    assert.ok(w.includes("\x1b[?7l"), `write ${i} must re-arm DECAWM off`);
  }
});

test("reflowSlack: only rows that no longer fit cost extra", () => {
  // 134 → 120: a 133-column line becomes 2 physical rows, so each such row gains 1.
  assert.equal(reflowSlack([133], 120), 1);
  assert.equal(reflowSlack([133, 133, 133, 133], 120), 4);
  // widening, or a shrink the old lines still fit in, rewraps nothing.
  assert.equal(reflowSlack([119, 119], 134), 0);
  assert.equal(reflowSlack([119, 119], 120), 0);
  // the caret on the block's own top row has nothing above it to shift.
  assert.equal(reflowSlack([], 40), 0);
  // MIXED widths are the real case: the key hint and a short dropdown row still fit, and must
  // not be charged for a rewrap they did not have — that would erase live transcript above.
  assert.equal(reflowSlack([133, 40, 116], 120), 1);
  // a drastic shrink costs more than one row per line.
  assert.equal(reflowSlack([133, 133], 45), 2 * 2);
});

test("paint(frame, slack) climbs the rewrapped rows before erasing", () => {
  const writes: string[] = [];
  const r = new Renderer((s) => writes.push(s));
  r.paint({ lines: ["top", "in", "stat"], cursorRow: 1, cursorCol: 0 }); // parked at row 1
  writes.length = 0;
  r.paint({ lines: ["top", "in", "stat"], cursorRow: 1, cursorCol: 0 }, 1);
  // 1 parked row + 1 slack row = up 2, so the erase starts at the real top border again.
  assert.ok(writes[0]?.includes("\x1b[2A\r\x1b[0J"));
  // and the default is unchanged — an ordinary repaint must not climb further than the caret.
  writes.length = 0;
  r.paint({ lines: ["top", "in", "stat"], cursorRow: 1, cursorCol: 0 });
  assert.ok(writes[0]?.includes("\x1b[1A\r\x1b[0J"));
});

test("composePaint hides cursor, erases, writes body CRLF-joined, parks + shows caret", () => {
  const frame: Frame = { lines: ["aaa", "bbb"], cursorRow: 0, cursorCol: 2 };
  const out = composePaint(0, frame);
  assert.ok(out.startsWith("\x1b[?25l")); // hide first
  assert.ok(out.includes("aaa\r\nbbb")); // CRLF between lines, no trailing newline
  assert.ok(out.endsWith("\x1b[?25h")); // show at rest
  // caret: 2 rows, target row 0 → up 1 from the bottom, right 2
  assert.ok(out.includes("\x1b[1A\r\x1b[2C"));
});

test("composePaint with no horizontal/vertical move emits no stray CUU/CUF", () => {
  const frame: Frame = { lines: ["x"], cursorRow: 0, cursorCol: 0 };
  const out = composePaint(0, frame);
  assert.doesNotMatch(out, /\x1b\[0[AC]/); // never [0A or [0C
  assert.doesNotMatch(out, /\x1b\[\dA/); // single line → no up-move to place caret
});

test("Renderer erases by the PARKED CARET ROW, not the block height (the real bug)", () => {
  const writes: string[] = [];
  const r = new Renderer((s) => writes.push(s));
  // a 6-line block (e.g. dropdown above the box) whose caret is on row 4 (the input line)
  r.paint({ lines: ["d", "d", "d", "top", "in", "stat"], cursorRow: 4, cursorCol: 2 });
  writes.length = 0;
  r.paint({ lines: ["x"], cursorRow: 0, cursorCol: 0 });
  // MUST move up exactly 4 (the parked caret row), NOT 5 (height-1) — up 5 would erase
  // a real scrollback line above the chrome.
  assert.ok(writes[0]?.includes("\x1b[4A\r\x1b[0J"));
  assert.ok(!writes[0]?.includes("\x1b[5A"));
});

test("printAbove erases from the parked caret row, writes into scrollback, resets", () => {
  const writes: string[] = [];
  const r = new Renderer((s) => writes.push(s));
  r.paint({ lines: ["1", "2", "3"], cursorRow: 2, cursorCol: 0 }); // parked at row 2
  writes.length = 0;
  r.printAbove("hello\nworld");
  assert.ok(writes[0]?.includes("\x1b[2A\r\x1b[0J")); // up 2 to the block top, then erase
  assert.ok(writes[0]?.includes("hello\r\nworld\r\n"));
  // next paint now erases 0 rows (the block was cleared)
  writes.length = 0;
  r.paint({ lines: ["x"], cursorRow: 0, cursorCol: 0 });
  assert.ok(writes[0]?.includes("\r\x1b[0J"));
  assert.ok(!writes[0]?.includes("\x1b[1A"));
});

test("enter/restore strings carry the required mode toggles", () => {
  assert.ok(ENTER_TUI.includes("\x1b[?2004h")); // bracketed paste on
  assert.ok(ENTER_TUI.includes("\x1b[?7l")); // autowrap off
  assert.ok(ENTER_TUI.includes("\x1b[?25l")); // cursor hidden
  assert.ok(RESTORE_TUI.includes("\x1b[?2004l"));
  assert.ok(RESTORE_TUI.includes("\x1b[?7h"));
  assert.ok(RESTORE_TUI.includes("\x1b[?25h"));
  assert.ok(RESTORE_TUI.endsWith("\x1b[0m"));
});
