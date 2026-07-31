/**
 * extract.test.ts — pulling edit intents out of raw model prose (SEARCH/REPLACE + ```diff).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractEditIntents, pathCandidate } from "./extract.js";

test("SEARCH/REPLACE block with a bare path line above it", () => {
  const raw = [
    "Here's the fix:",
    "src/app.ts",
    "<<<<<<< SEARCH",
    "const x = 1;",
    "=======",
    "const x = 2;",
    ">>>>>>> REPLACE",
    "done.",
  ].join("\n");
  const out = extractEditIntents(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.path, "src/app.ts");
  assert.equal(out[0]?.kind, "search-replace");
  assert.deepEqual(out[0]?.hunks, [{ old: "const x = 1;", new: "const x = 2;" }]);
});

test("SEARCH/REPLACE inside a fenced block with a header path", () => {
  const raw = [
    "### src/util.py",
    "```python",
    "<<<<<<< SEARCH",
    "def f():",
    "    return 1",
    "=======",
    "def f():",
    "    return 2",
    ">>>>>>> REPLACE",
    "```",
  ].join("\n");
  const out = extractEditIntents(raw);
  assert.equal(out[0]?.path, "src/util.py");
  assert.equal(out[0]?.hunks[0]?.old, "def f():\n    return 1");
  assert.equal(out[0]?.hunks[0]?.new, "def f():\n    return 2");
});

test("git conflict markers are NOT parsed as an edit", () => {
  const raw = ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> feature-branch"].join("\n");
  assert.deepEqual(extractEditIntents(raw), []);
});

test("an unterminated SEARCH block emits nothing (never a half-edit)", () => {
  const noReplace = ["a.ts", "<<<<<<< SEARCH", "old", "=======", "new"].join("\n"); // no >>>>>>> REPLACE
  assert.deepEqual(extractEditIntents(noReplace), []);
  const noDivider = ["a.ts", "<<<<<<< SEARCH", "old", "still old"].join("\n"); // no =======
  assert.deepEqual(extractEditIntents(noDivider), []);
});

test("an empty SEARCH pre-image is skipped (can't be located)", () => {
  const raw = ["a.ts", "<<<<<<< SEARCH", "=======", "new content", ">>>>>>> REPLACE"].join("\n");
  assert.deepEqual(extractEditIntents(raw), []);
});

test("```diff fence → hunks with reconstructed old/new", () => {
  const raw = [
    "```diff",
    "--- a/src/math.ts",
    "+++ b/src/math.ts",
    "@@ -1,3 +1,3 @@",
    " export function add(a, b) {",
    "-  return a - b;",
    "+  return a + b;",
    " }",
    "```",
  ].join("\n");
  const out = extractEditIntents(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.path, "src/math.ts");
  assert.equal(out[0]?.kind, "diff");
  assert.equal(out[0]?.hunks[0]?.old, "export function add(a, b) {\n  return a - b;\n}");
  assert.equal(out[0]?.hunks[0]?.new, "export function add(a, b) {\n  return a + b;\n}");
});

test("multiple SEARCH/REPLACE blocks, each bound to its nearest path", () => {
  const raw = [
    "a.ts",
    "<<<<<<< SEARCH",
    "1",
    "=======",
    "one",
    ">>>>>>> REPLACE",
    "b.ts",
    "<<<<<<< SEARCH",
    "2",
    "=======",
    "two",
    ">>>>>>> REPLACE",
  ].join("\n");
  const out = extractEditIntents(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.path, "a.ts");
  assert.equal(out[1]?.path, "b.ts");
});

test("pathCandidate recognizes headers, backticks, File: forms; rejects prose", () => {
  assert.equal(pathCandidate("### src/app.ts"), "src/app.ts");
  assert.equal(pathCandidate("`lib/x.py`"), "lib/x.py");
  assert.equal(pathCandidate("File: config.toml"), "config.toml");
  assert.equal(pathCandidate("**pkg/mod.go**"), "pkg/mod.go");
  assert.equal(pathCandidate("here is the fix"), null); // has spaces
  assert.equal(pathCandidate("hello"), null); // no dot/slash
});
