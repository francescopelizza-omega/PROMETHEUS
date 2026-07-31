/**
 * todo-model.test.ts — the pure TODO model (APP-096): compile fail-soft, needle derivation
 * (incl. the HACK/XXX-miss fix), scope narrowing, marker filter, MAX_ITEMS clamp, ReDoS
 * guards, and the caseSensitive→`i`-flag round-trip. node:test, no Electron/DOM.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CompiledPattern,
  DEFAULT_TODO_PATTERNS,
  MAX_TODO_ITEMS,
  type TodoPattern,
  type TodoScanItem,
  compilePatterns,
  filterItems,
  scanLines,
  searchNeedlesFor,
} from "./todo-model.ts";

function compile(patterns: readonly TodoPattern[]): CompiledPattern[] {
  return compilePatterns(patterns).compiled;
}

test("compilePatterns compiles the four builtins with case-sensitive stems", () => {
  const { compiled, skipped } = compilePatterns(DEFAULT_TODO_PATTERNS);
  assert.equal(skipped.length, 0);
  assert.deepEqual(
    compiled.map((c) => c.name),
    ["TODO", "FIXME", "HACK", "XXX"],
  );
  // default (no caseSensitive) ⇒ NOT the `i` flag (matches historical \bTODO\b).
  assert.ok(!compiled[0].re.flags.includes("i"));
});

test("compilePatterns fails soft: invalid, unsafe, stemless, empty are skipped not thrown", () => {
  const { compiled, skipped } = compilePatterns([
    { name: "ok", regex: "\\bNOCOMMIT\\b" },
    { name: "bad", regex: "(" }, // invalid syntax
    { name: "redos", regex: "(a+)+$" }, // nested unbounded quantifier
    { name: "stemless", regex: "[A-Z]{3,}" }, // no literal stem
    { name: "empty", regex: "   " },
  ]);
  assert.deepEqual(
    compiled.map((c) => c.name),
    ["ok"],
  );
  const reasons = Object.fromEntries(skipped.map((s) => [s.pattern.name, s.reason]));
  assert.equal(reasons.bad, "invalid");
  assert.equal(reasons.redos, "unsafe");
  assert.equal(reasons.stemless, "no-stem");
  assert.equal(reasons.empty, "empty");
});

test("compilePatterns caps count at max, extras marked too-many", () => {
  const many: TodoPattern[] = Array.from({ length: 20 }, (_, i) => ({
    name: `P${i}`,
    regex: `MARK${i}`,
  }));
  const { compiled, skipped } = compilePatterns(many, 16);
  assert.equal(compiled.length, 16);
  assert.equal(skipped.filter((s) => s.reason === "too-many").length, 4);
});

test("caseSensitive:false round-trips to the i flag (survives persist→recompile)", () => {
  const persisted: TodoPattern = { name: "todo", regex: "todo", caseSensitive: false };
  const [c] = compile([persisted]);
  assert.ok(c.re.flags.includes("i"));
  assert.ok(c.re.test("This is a Todo line"));
});

test("brace quantifiers don't leak digit 'stems' (A{0,50} is stemless; WORD{100} stems to WORD)", () => {
  // A{0,50} can match empty → no guaranteed literal → rejected as no-stem (never a "50" needle).
  const { compiled: c1, skipped } = compilePatterns([{ name: "a", regex: "A{0,50}" }]);
  assert.equal(c1.length, 0);
  assert.equal(skipped[0]?.reason, "no-stem");
  // WORD{100} guarantees "WORD" — that's the needle, not "100".
  assert.deepEqual(searchNeedlesFor(compile([{ name: "w", regex: "WORD{100}" }])), ["WORD"]);
});

test("searchNeedlesFor unions every stem — fixes the HACK/XXX prefilter miss", () => {
  const needles = searchNeedlesFor(compile(DEFAULT_TODO_PATTERNS));
  assert.deepEqual(needles.sort(), ["FIXME", "HACK", "TODO", "XXX"]);
});

test("searchNeedlesFor derives the stem from a custom pattern and an alternation", () => {
  assert.deepEqual(searchNeedlesFor(compile([{ name: "nc", regex: "\\bNOCOMMIT\\b" }])), [
    "NOCOMMIT",
  ]);
  // a single alternation pattern still contributes every branch's stem.
  const alt = searchNeedlesFor(compile([{ name: "all", regex: "\\b(TODO|FIXME|HACK)\\b" }]));
  assert.deepEqual(alt.sort(), ["FIXME", "HACK", "TODO"]);
});

test("scanLines matches builtins and strips the [:\\s-]* separator like the old MARKER_RE", () => {
  const compiled = compile(DEFAULT_TODO_PATTERNS);
  const items: TodoScanItem[] = [];
  scanLines(
    "file:///a.ts",
    ["// TODO: fix the thing", "const x = 1;", "  # FIXME - later", "no marker here"],
    compiled,
    items,
  );
  assert.deepEqual(items, [
    { uri: "file:///a.ts", line: 0, marker: "TODO", text: "fix the thing" },
    { uri: "file:///a.ts", line: 2, marker: "FIXME", text: "later" },
  ]);
});

test("scanLines regression: a file containing ONLY HACK/XXX now surfaces", () => {
  const items: TodoScanItem[] = [];
  scanLines(
    "file:///only.ts",
    ["// HACK: workaround", "/* XXX revisit */"],
    compile(DEFAULT_TODO_PATTERNS),
    items,
  );
  assert.deepEqual(
    items.map((i) => i.marker),
    ["HACK", "XXX"],
  );
});

test("scanLines picks the leftmost marker on a line (alternation parity)", () => {
  const items: TodoScanItem[] = [];
  scanLines("file:///a.ts", ["x FIXME then TODO"], compile(DEFAULT_TODO_PATTERNS), items);
  assert.equal(items[0].marker, "FIXME");
});

test("scanLines skips over-long lines (ReDoS defense) and clamps to max", () => {
  const compiled = compile(DEFAULT_TODO_PATTERNS);
  const skip: TodoScanItem[] = [];
  scanLines("file:///big.ts", [`${" ".repeat(3000)}TODO late`], compiled, skip);
  assert.equal(skip.length, 0); // >2000 chars ⇒ not scanned

  const items: TodoScanItem[] = [];
  const lines = Array.from({ length: 1000 }, () => "// TODO x");
  const capped = scanLines("file:///m.ts", lines, compiled, items, MAX_TODO_ITEMS);
  assert.equal(capped, true);
  assert.equal(items.length, MAX_TODO_ITEMS);
});

test("scanLines accumulates across files against one shared max", () => {
  const compiled = compile(DEFAULT_TODO_PATTERNS);
  const items: TodoScanItem[] = [];
  scanLines("file:///a.ts", ["// TODO a"], compiled, items, 3);
  // b.ts has 3 matches but only 2 slots remain (shared max=3) — stops mid-file, returns capped.
  const full = scanLines(
    "file:///b.ts",
    ["// TODO b", "// TODO c", "// TODO d"],
    compiled,
    items,
    3,
  );
  assert.equal(items.length, 3);
  assert.equal(full, true);
  assert.deepEqual(
    items.map((i) => i.text),
    ["a", "b", "c"],
  );
});

test("filterItems narrows by scope: file / dir-prefix / project", () => {
  const items: TodoScanItem[] = [
    { uri: "file:///proj/src/a.ts", line: 0, marker: "TODO", text: "a" },
    { uri: "file:///proj/src/sub/b.ts", line: 0, marker: "TODO", text: "b" },
    { uri: "file:///proj/other/c.ts", line: 0, marker: "TODO", text: "c" },
  ];
  assert.equal(filterItems(items, { scope: { kind: "project" } }).length, 3);
  assert.deepEqual(
    filterItems(items, { scope: { kind: "file", uri: "file:///proj/src/a.ts" } }).map(
      (i) => i.text,
    ),
    ["a"],
  );
  assert.deepEqual(
    filterItems(items, { scope: { kind: "dir", prefix: "file:///proj/src/" } }).map((i) => i.text),
    ["a", "b"],
  );
});

test("filterItems narrows by the per-pattern marker allow-set", () => {
  const items: TodoScanItem[] = [
    { uri: "file:///a", line: 0, marker: "TODO", text: "t" },
    { uri: "file:///a", line: 1, marker: "HACK", text: "h" },
  ];
  assert.deepEqual(
    filterItems(items, { scope: { kind: "project" }, markers: new Set(["HACK"]) }).map(
      (i) => i.marker,
    ),
    ["HACK"],
  );
  // null/absent marker set ⇒ all pass.
  assert.equal(filterItems(items, { scope: { kind: "project" }, markers: null }).length, 2);
});
