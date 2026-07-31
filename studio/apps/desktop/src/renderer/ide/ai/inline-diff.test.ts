/**
 * inline-diff.test.ts — PURE line diff for the inline-edit before/after view (APP-092).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type DiffLine, diffStats, lineDiff } from "./inline-diff.js";

test("lineDiff: unchanged lines are context, a replaced line is del+add", () => {
  const d = lineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(
    d.map((l) => `${l.type}:${l.text}`),
    ["ctx:a", "del:b", "add:B", "ctx:c"],
  );
});

test("lineDiff: pure insertion + pure deletion", () => {
  assert.deepEqual(lineDiff("a\nc", "a\nb\nc"), [
    { type: "ctx", text: "a" },
    { type: "add", text: "b" },
    { type: "ctx", text: "c" },
  ] satisfies DiffLine[]);
  assert.deepEqual(lineDiff("a\nb\nc", "a\nc"), [
    { type: "ctx", text: "a" },
    { type: "del", text: "b" },
    { type: "ctx", text: "c" },
  ] satisfies DiffLine[]);
});

test("lineDiff: identical input is all context", () => {
  const d = lineDiff("x\ny", "x\ny");
  assert.ok(d.every((l) => l.type === "ctx"));
});

test("diffStats counts added/removed", () => {
  const d = lineDiff("a\nb\nc", "a\nB\nC\nd");
  const s = diffStats(d);
  assert.equal(s.added, 3); // B, C, d
  assert.equal(s.removed, 2); // b, c
});
