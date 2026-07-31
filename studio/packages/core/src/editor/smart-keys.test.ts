/**
 * smart-keys.test.ts — node:test for the PURE smart-key + clipboard-ring math
 * (complete-statement ⇧⌘⏎, smart-enter, ⌘⇧V ring — MDS parity file 01).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLIP_RING_CAP,
  clipCycle,
  clipPush,
  completeStatement,
  smartEnterEdit,
} from "./smart-keys.js";

/* ── completeStatement ──────────────────────────────────────────────────────── */

test("completeStatement: `if (x` (ts) → a closed block with the caret inside", () => {
  const r = completeStatement("if (x", 1, "typescript");
  assert.equal(r.edit.text, "if (x) {\n\t\n}");
  assert.deepEqual(r.edit.range, { startLine: 1, startCol: 1, endLine: 1, endCol: 6 });
  assert.deepEqual(r.caret, { line: 2, col: 2 });
});

test("completeStatement: `if x` (py) → colon header + deeper caret", () => {
  const r = completeStatement("if x", 1, "python");
  assert.equal(r.edit.text, "if x:\n\t");
  assert.deepEqual(r.caret, { line: 2, col: 2 });
});

test("completeStatement closes unbalanced brackets innermost-first", () => {
  const r = completeStatement("foo(bar[1", 3, "typescript");
  assert.equal(r.edit.text, "foo(bar[1]);\n");
  assert.equal(r.edit.range.startLine, 3);
});

test("completeStatement closes an open quote before terminating", () => {
  const ts = completeStatement('const s = "ab', 1, "typescript");
  assert.equal(ts.edit.text, 'const s = "ab";\n');
  const py = completeStatement("s = 'ab", 1, "python");
  assert.equal(py.edit.text, "s = 'ab'\n");
});

test("completeStatement: python header with call parens gets both `)` and `:`", () => {
  const r = completeStatement("for i in range(3", 1, "python");
  assert.equal(r.edit.text, "for i in range(3):\n\t");
});

test("completeStatement: a trailing open brace completes to a block", () => {
  const r = completeStatement("while (ok) {", 1, "javascript");
  assert.equal(r.edit.text, "while (ok) {\n\t\n}");
  assert.deepEqual(r.caret, { line: 2, col: 2 });
});

test("completeStatement preserves the existing indentation", () => {
  const r = completeStatement("  if y", 5, "python");
  assert.equal(r.edit.text, "  if y:\n  \t");
  assert.deepEqual(r.caret, { line: 6, col: 4 });
});

test("completeStatement: `match`/`case` soft keywords — headers get `:`, assignments don't", () => {
  // real structural-pattern headers complete with a colon…
  assert.equal(completeStatement("match x", 1, "python").edit.text, "match x:\n\t");
  assert.equal(completeStatement("case 1", 1, "python").edit.text, "case 1:\n\t");
  // …but the far-more-common assignments / calls must NOT get a bogus colon.
  assert.equal(
    completeStatement("match = re.match(x", 1, "python").edit.text,
    "match = re.match(x)\n",
  );
  assert.equal(completeStatement("case = 5", 1, "python").edit.text, "case = 5\n");
  // a bare call named match/case is not a header either (no space before the paren).
  assert.equal(completeStatement("match(pat", 1, "python").edit.text, "match(pat)\n");
});

test("completeStatement: def with a default arg still gets its colon (no assign false-neg)", () => {
  assert.equal(completeStatement("def f(x=1", 1, "python").edit.text, "def f(x=1):\n\t");
});

test("completeStatement on an already-complete line degrades to a plain new line", () => {
  const r = completeStatement("const a = 1;", 1, "typescript");
  assert.equal(r.edit.text, "const a = 1;\n");
  assert.deepEqual(r.caret, { line: 2, col: 1 });
});

test("completeStatement ignores brackets inside string literals", () => {
  const r = completeStatement('const s = "(unclosed";', 1, "typescript");
  assert.equal(r.edit.text, 'const s = "(unclosed";\n'); // no phantom `)` appended
});

/* ── smartEnterEdit ─────────────────────────────────────────────────────────── */

test("smartEnterEdit keeps indentation on a plain line", () => {
  const r = smartEnterEdit({ line: "  return x", lineNumber: 4, col: 11, lang: "typescript" });
  assert.equal(r.edit.text, "\n  ");
  assert.deepEqual(r.edit.range, { startLine: 4, startCol: 11, endLine: 4, endCol: 11 });
  assert.deepEqual(r.caret, { line: 5, col: 3 });
});

test("smartEnterEdit deepens after a block opener (c-like `{`, python `:`)", () => {
  const ts = smartEnterEdit({ line: "if (x) {", lineNumber: 1, col: 9, lang: "typescript" });
  assert.equal(ts.edit.text, "\n\t");
  const py = smartEnterEdit({ line: "if x:", lineNumber: 1, col: 6, lang: "python" });
  assert.equal(py.edit.text, "\n\t");
  assert.deepEqual(py.caret, { line: 2, col: 2 });
});

test("smartEnterEdit splits a `{}` pair around the caret", () => {
  const r = smartEnterEdit({ line: "foo() {}", lineNumber: 2, col: 8, lang: "typescript" });
  assert.equal(r.edit.text, "\n\t\n");
  assert.deepEqual(r.caret, { line: 3, col: 2 });
});

/* ── clipboard-stack reducer ────────────────────────────────────────────────── */

test("clipPush dedupes (re-copy floats to top), ignores whitespace, caps the ring", () => {
  let ring = clipPush([], "a");
  ring = clipPush(ring, "b");
  ring = clipPush(ring, "a"); // duplicate floats
  assert.deepEqual(ring, ["a", "b"]);
  assert.deepEqual(clipPush(ring, "   "), ["a", "b"]); // whitespace ignored
  const big = Array.from({ length: CLIP_RING_CAP }, (_, i) => `e${i}`);
  const capped = clipPush(big, "new");
  assert.equal(capped.length, CLIP_RING_CAP);
  assert.equal(capped[0], "new");
  assert.equal(capped.includes(`e${CLIP_RING_CAP - 1}`), false); // oldest evicted
});

test("clipCycle rotates head→back and wraps; tiny rings are unchanged", () => {
  assert.deepEqual(clipCycle(["a", "b", "c"]), ["b", "c", "a"]);
  assert.deepEqual(clipCycle(clipCycle(clipCycle(["a", "b", "c"]))), ["a", "b", "c"]);
  assert.deepEqual(clipCycle(["solo"]), ["solo"]);
  assert.deepEqual(clipCycle([]), []);
});
