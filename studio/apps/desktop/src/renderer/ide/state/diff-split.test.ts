/**
 * diff-split.test.ts — node:test for the unified-diff → two-sides splitter (#10).
 *
 * Pins context-on-both, removed-on-original, added-on-modified, header skipping, and the
 * "no newline" marker. Pure — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { splitUnifiedDiff } from "./diff-split.js";

test("context goes to both sides; -/+ split", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "index 111..222 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    " const c = 4;",
  ].join("\n");
  const { original, modified } = splitUnifiedDiff(diff);
  assert.equal(original, "const a = 1;\nconst b = 2;\nconst c = 4;");
  assert.equal(modified, "const a = 1;\nconst b = 3;\nconst c = 4;");
});

test("pure additions appear only on the modified side", () => {
  const diff = ["@@ -0,0 +1,2 @@", "+line one", "+line two"].join("\n");
  const { original, modified } = splitUnifiedDiff(diff);
  assert.equal(original, "");
  assert.equal(modified, "line one\nline two");
});

test("pure deletions appear only on the original side", () => {
  const diff = ["@@ -1,2 +0,0 @@", "-gone one", "-gone two"].join("\n");
  const { original, modified } = splitUnifiedDiff(diff);
  assert.equal(original, "gone one\ngone two");
  assert.equal(modified, "");
});

test("file preamble before the first @@ is ignored", () => {
  const diff = [
    "diff --git a/x b/x",
    "index 1..2",
    "--- a/x",
    "+++ b/x",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");
  const { original, modified } = splitUnifiedDiff(diff);
  assert.equal(original, "a");
  assert.equal(modified, "b");
});

test("the no-newline marker is dropped, multi-hunk concatenates", () => {
  const diff = [
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "\\ No newline at end of file",
    "@@ -10 +10 @@",
    " ctx",
  ].join("\n");
  const { original, modified } = splitUnifiedDiff(diff);
  assert.equal(original, "a\nctx");
  assert.equal(modified, "b\nctx");
});

test("empty diff → empty sides", () => {
  assert.deepEqual(splitUnifiedDiff(""), { original: "", modified: "" });
});
