/**
 * pending-line.test.ts — a half-typed line must never pre-fill the "update everything" y/N.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { discardPendingLine } from "./pending-line.js";

test("a pending 'y' is emptied by writing the buffer — the route that works under TERM=dumb too", () => {
  // the dumb-mode readline ignores ctrl-e/ctrl-u keypresses; the fields themselves are writable
  const rl = { line: "y", cursor: 1 };
  assert.equal(discardPendingLine(rl), "discarded");
  assert.deepEqual(rl, { line: "", cursor: 0 });
});

test("nothing pending → nothing touched", () => {
  const empty = { line: "", cursor: 0 };
  assert.equal(discardPendingLine(empty), "none");
  assert.equal(discardPendingLine({}), "none", "a readline without a line buffer");
});

test("a buffer that refuses the write is reported, so the caller does not ask at all", () => {
  const frozen = Object.freeze({ line: "y", cursor: 1 });
  assert.equal(discardPendingLine(frozen), "stuck");
  assert.equal(frozen.line, "y");
});
