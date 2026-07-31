/**
 * structure-filter.test.ts — the pure File Structure / Method Hierarchy filtering (APP-097):
 * subsequence match, parent-chain retention, empty-query full tree, and the memberMatch name
 * heuristic. node:test, no Electron/DOM.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { NormalizedSymbol } from "./lsp-convert.ts";
import {
  filterSymbols,
  memberMatch,
  subsequenceMatch,
  symbolAtPosition,
} from "./structure-filter.ts";

const R = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
function sym(name: string, children: NormalizedSymbol[] = []): NormalizedSymbol {
  return { name, detail: "", kind: 5, range: R, selectionRange: R, children };
}
/** A symbol spanning an explicit multi-line range (for symbolAtPosition tests). */
function ranged(
  name: string,
  r: NormalizedSymbol["range"],
  children: NormalizedSymbol[] = [],
): NormalizedSymbol {
  return { name, detail: "", kind: 5, range: r, selectionRange: r, children };
}

// class Foo { bar() {} baz() {} }  ·  class Qux { run() {} }
const TREE: NormalizedSymbol[] = [sym("Foo", [sym("bar"), sym("baz")]), sym("Qux", [sym("run")])];

test("subsequenceMatch: order-preserving, case-insensitive, empty = all", () => {
  assert.equal(subsequenceMatch("fooBar", "fb"), true);
  assert.equal(subsequenceMatch("fooBar", "FOOBAR"), true);
  assert.equal(subsequenceMatch("fooBar", "rb"), false); // out of order
  assert.equal(subsequenceMatch("anything", ""), true);
});

test("filterSymbols: empty query returns the whole tree with correct depth", () => {
  const rows = filterSymbols(TREE, "");
  assert.deepEqual(
    rows.map((r) => [r.symbol.name, r.depth]),
    [
      ["Foo", 0],
      ["bar", 1],
      ["baz", 1],
      ["Qux", 0],
      ["run", 1],
    ],
  );
});

test("filterSymbols: a nested match retains its ancestor chain, prunes the rest", () => {
  const rows = filterSymbols(TREE, "baz");
  assert.deepEqual(
    rows.map((r) => [r.symbol.name, r.depth]),
    [
      ["Foo", 0], // ancestor retained
      ["baz", 1], // the match
    ],
  );
  // "bar" (sibling) and the whole "Qux" branch are pruned.
});

test("filterSymbols: a matching parent with no matching child returns alone", () => {
  const rows = filterSymbols(TREE, "qux");
  assert.deepEqual(
    rows.map((r) => r.symbol.name),
    ["Qux"],
  );
});

test("filterSymbols: subsequence spanning parent name surfaces the parent subtree root", () => {
  // "fo" matches Foo (parent); Foo returns alone (its children don't match "fo").
  const rows = filterSymbols(TREE, "fo");
  assert.deepEqual(
    rows.map((r) => r.symbol.name),
    ["Foo"],
  );
});

test("memberMatch: finds a member by exact name anywhere in the tree, else null", () => {
  assert.equal(memberMatch("run", TREE)?.name, "run");
  assert.equal(memberMatch("bar", TREE)?.name, "bar"); // nested under Foo
  assert.equal(memberMatch("missing", TREE), null);
  // case-sensitive: method names are.
  assert.equal(memberMatch("RUN", TREE), null);
});

test("symbolAtPosition: returns the deepest symbol whose range contains the caret", () => {
  // class Foo (lines 0-9) { bar() (lines 2-4)  baz() (lines 6-8) }
  const tree = [
    ranged("Foo", { start: { line: 0, character: 0 }, end: { line: 9, character: 1 } }, [
      ranged("bar", { start: { line: 2, character: 2 }, end: { line: 4, character: 3 } }),
      ranged("baz", { start: { line: 6, character: 2 }, end: { line: 8, character: 3 } }),
    ]),
  ];
  assert.equal(symbolAtPosition(tree, 3, 5)?.name, "bar"); // inside bar → deepest wins over Foo
  assert.equal(symbolAtPosition(tree, 7, 0)?.name, "baz");
  assert.equal(symbolAtPosition(tree, 1, 0)?.name, "Foo"); // in Foo but not a method
  assert.equal(symbolAtPosition(tree, 20, 0), null); // outside everything
});
