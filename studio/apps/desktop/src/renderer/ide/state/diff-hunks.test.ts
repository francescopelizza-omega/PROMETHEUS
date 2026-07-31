/**
 * diff-hunks.test.ts — the PURE unified-diff hunk parser + patch builder (APP-084).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type DiffHunk,
  buildPatch,
  changeLineKeys,
  isChangeLine,
  lineKey,
  parseUnifiedDiff,
  toggleSelection,
} from "./diff-hunks.js";

const TWO_HUNK = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,4 @@
 line1
-old2
+new2
+new2b
 line3
@@ -10,2 +11,2 @@
 keep
-drop10
+add11
`;

test("parseUnifiedDiff: header + two hunks with parsed @@ counts", () => {
  const d = parseUnifiedDiff(TWO_HUNK);
  assert.equal(d.bodyless, false);
  assert.equal(d.header.length, 4);
  assert.equal(d.header[0], "diff --git a/f.txt b/f.txt");
  assert.equal(d.hunks.length, 2);
  const h0 = d.hunks[0]!;
  assert.deepEqual([h0.oldStart, h0.oldLines, h0.newStart, h0.newLines], [1, 3, 1, 4]);
  assert.deepEqual(h0.lines, [" line1", "-old2", "+new2", "+new2b", " line3"]);
  const h1 = d.hunks[1]!;
  assert.deepEqual([h1.oldStart, h1.oldLines, h1.newStart, h1.newLines], [10, 2, 11, 2]);
});

test("parseUnifiedDiff: @@ with omitted counts default to 1", () => {
  const d = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -5 +5,2 @@\n context\n+added\n");
  const h = d.hunks[0]!;
  assert.deepEqual([h.oldStart, h.oldLines, h.newStart, h.newLines], [5, 1, 5, 2]);
});

test("parseUnifiedDiff: a 100%-similar rename is bodyless (whole-file staging)", () => {
  const d = parseUnifiedDiff(
    "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n",
  );
  assert.equal(d.bodyless, true);
  assert.equal(d.hunks.length, 0);
  assert.equal(d.header.length, 4);
});

test("buildPatch: a whole single hunk round-trips (recount matches the source)", () => {
  const d = parseUnifiedDiff(TWO_HUNK);
  const patch = buildPatch(d.header, [d.hunks[0]!]);
  assert.match(patch, /^diff --git a\/f\.txt b\/f\.txt/);
  assert.match(patch, /@@ -1,3 \+1,4 @@/);
  assert.match(patch, /\+new2\n\+new2b/);
  assert.ok(!patch.includes("add11")); // only hunk 0 is in the patch
  assert.ok(patch.endsWith("\n"));
});

test("buildPatch: line subset — dropped '+' vanishes, dropped '−' becomes context, @@ recounts", () => {
  const d = parseUnifiedDiff(TWO_HUNK);
  // select ONLY the '+new2' line (hunk index 0, line index 2)
  const patch = buildPatch(d.header, [d.hunks[0]!], new Set([lineKey(0, 2)]));
  const lines = patch.split("\n");
  const at = lines.find((l) => l.startsWith("@@"))!;
  // old side: line1 + (old2 as context) + line3 = 3; new side: those 3 + new2 = 4
  assert.equal(at, "@@ -1,3 +1,4 @@");
  assert.ok(patch.includes("+new2\n"));
  assert.ok(!patch.includes("+new2b")); // unselected add dropped
  assert.ok(patch.includes(" old2")); // unselected removal kept as context
  assert.ok(!patch.includes("-old2")); // ...and NOT as a removal
});

test("buildPatch: a selection that leaves a hunk unchanged yields an empty patch", () => {
  const d = parseUnifiedDiff(TWO_HUNK);
  // select no change lines → every '+' dropped, every '−' → context → no-op → ""
  assert.equal(buildPatch(d.header, [d.hunks[0]!], new Set()), "");
});

test("no-newline-at-EOF marker travels with its line and drops when the line drops", () => {
  const src =
    "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
  const d = parseUnifiedDiff(src);
  // whole hunk keeps both markers
  const whole = buildPatch(d.header, [d.hunks[0]!]);
  assert.equal((whole.match(/No newline at end of file/g) ?? []).length, 2);
  // keep only the '−' (line index 0): the '+new' (index 2) and ITS marker drop
  const onlyDel = buildPatch(d.header, [d.hunks[0]!], new Set([lineKey(0, 0)]));
  assert.ok(onlyDel.includes("-old"));
  assert.ok(!onlyDel.includes("+new"));
  assert.equal((onlyDel.match(/No newline at end of file/g) ?? []).length, 1);
});

test("changeLineKeys / isChangeLine / lineKey helpers", () => {
  const hunk: DiffHunk = {
    header: "@@ -1,2 +1,2 @@",
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [" ctx", "-del", "+add"],
  };
  assert.equal(isChangeLine(" ctx"), false);
  assert.equal(isChangeLine("-del"), true);
  assert.deepEqual(changeLineKeys(3, hunk), [lineKey(3, 1), lineKey(3, 2)]);
});

test("toggleSelection: immutable add/remove of a line key", () => {
  const a = toggleSelection(new Set(), "0:2", true);
  assert.deepEqual([...a], ["0:2"]);
  const b = toggleSelection(a, "0:3", true);
  assert.deepEqual([...b].sort(), ["0:2", "0:3"]);
  const c = toggleSelection(b, "0:2", false);
  assert.deepEqual([...c], ["0:3"]);
  assert.deepEqual([...a], ["0:2"]); // original untouched
});
