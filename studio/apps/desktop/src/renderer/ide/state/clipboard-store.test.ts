/**
 * clipboard-store.test.ts — node:test for the PURE clipboard-ring math (`pushClip`).
 *
 * Pins most-recent-first ordering, de-duplication (re-copy floats to top), the cap, and
 * the whitespace-only guard. Pure — no react/zustand — runs under node --test directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CLIP_CAP, pushClip } from "./clipboard-store.js";

test("push prepends most-recent-first", () => {
  assert.deepEqual(pushClip(["a"], "b"), ["b", "a"]);
  assert.deepEqual(pushClip([], "x"), ["x"]);
});

test("re-copy of an existing entry floats it to the top (no duplicate)", () => {
  assert.deepEqual(pushClip(["b", "a", "c"], "a"), ["a", "b", "c"]);
  assert.deepEqual(pushClip(["a"], "a"), ["a"]);
});

test("whitespace-only text is ignored (ring unchanged, fresh copy)", () => {
  const ring = ["a", "b"];
  const out = pushClip(ring, "   \n\t");
  assert.deepEqual(out, ["a", "b"]);
  assert.notEqual(out, ring); // returns a copy, never the same reference
});

test("caps at the limit, dropping the oldest", () => {
  const many = Array.from({ length: CLIP_CAP }, (_, i) => `e${i}`);
  const out = pushClip(many, "new");
  assert.equal(out.length, CLIP_CAP);
  assert.equal(out[0], "new");
  assert.equal(out.includes(`e${CLIP_CAP - 1}`), false); // oldest fell off
});

test("respects a custom cap", () => {
  assert.deepEqual(pushClip(["a", "b", "c"], "d", 2), ["d", "a"]);
});

test("multi-line text is preserved verbatim", () => {
  const code = "def f():\n    return 1";
  assert.deepEqual(pushClip([], code), [code]);
});
