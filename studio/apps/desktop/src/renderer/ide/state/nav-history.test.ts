/**
 * nav-history.test.ts — node:test for the PURE navigation-stack reducer.
 *
 * Pins: coalescing of nearby same-file moves, push on a real jump, forward-history
 * truncation on a new navigation, the front-cap, and back/forward pointer bounds.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MIN_GAP,
  NAV_CAP,
  type NavLoc,
  initialNav,
  navBack,
  navForward,
  pruneNav,
  recordNav,
} from "./nav-history.js";

const at = (uri: string, line: number, column = 1): NavLoc => ({ uri, line, column });

test("first record seeds the stack", () => {
  const s = recordNav(initialNav(), at("a", 10));
  assert.deepEqual(s, { entries: [at("a", 10)], index: 0 });
});

test("a nearby same-file move coalesces (updates in place, no push)", () => {
  let s = recordNav(initialNav(), at("a", 10));
  s = recordNav(s, at("a", 10 + (MIN_GAP - 1), 5));
  assert.equal(s.entries.length, 1);
  assert.deepEqual(s.entries[0], at("a", 10 + (MIN_GAP - 1), 5));
});

test("a far same-file jump pushes a new entry", () => {
  let s = recordNav(initialNav(), at("a", 10));
  s = recordNav(s, at("a", 10 + MIN_GAP + 5));
  assert.equal(s.entries.length, 2);
  assert.equal(s.index, 1);
});

test("a different file always pushes", () => {
  let s = recordNav(initialNav(), at("a", 10));
  s = recordNav(s, at("b", 10));
  assert.equal(s.entries.length, 2);
});

test("back then a new nav truncates forward history", () => {
  let s = recordNav(initialNav(), at("a", 1));
  s = recordNav(s, at("b", 1));
  s = recordNav(s, at("c", 1)); // entries [a,b,c] index 2
  const b = navBack(s);
  assert.ok(b);
  s = b.state; // index 1 (b)
  assert.deepEqual(b.loc, at("b", 1));
  s = recordNav(s, at("d", 1)); // truncates c, pushes d → [a,b,d]
  assert.deepEqual(
    s.entries.map((e) => e.uri),
    ["a", "b", "d"],
  );
  assert.equal(s.index, 2);
});

test("back/forward walk the pointer and clamp at the ends", () => {
  let s = recordNav(initialNav(), at("a", 1));
  s = recordNav(s, at("b", 1));
  assert.equal(navForward(s), null); // already at the end
  const b = navBack(s);
  assert.ok(b);
  assert.deepEqual(b.loc, at("a", 1));
  assert.equal(navBack(b.state), null); // at the start
  const f = navForward(b.state);
  assert.ok(f);
  assert.deepEqual(f.loc, at("b", 1));
});

test("stack caps at NAV_CAP, dropping the oldest and keeping the pointer valid", () => {
  let s = initialNav();
  for (let i = 0; i < NAV_CAP + 10; i++) s = recordNav(s, at(`f${i}`, 1));
  assert.equal(s.entries.length, NAV_CAP);
  assert.equal(s.index, NAV_CAP - 1);
  assert.equal(s.entries[s.index]?.uri, `f${NAV_CAP + 9}`);
  assert.equal(s.entries[0]?.uri, "f10"); // oldest 10 dropped
});

// ── APP-022: dead-entry skip, prune, dedupe + column round-trip ──────────────

test("navBack skips a DEAD entry and lands on the next live one", () => {
  let s = recordNav(initialNav(), at("a", 1));
  s = recordNav(s, at("b", 1));
  s = recordNav(s, at("c", 1)); // [a,b,c] index 2
  // "b" was deleted → back from c skips b, lands on a.
  const alive = (uri: string) => uri !== "b";
  const r = navBack(s, alive);
  assert.ok(r);
  assert.deepEqual(r.loc, at("a", 1));
  assert.equal(r.state.index, 0);
});

test("navForward skips a DEAD entry going forward", () => {
  let s = recordNav(initialNav(), at("a", 1));
  s = recordNav(s, at("b", 1));
  s = recordNav(s, at("c", 1));
  const back = navBack(s); // index 1 (b)... actually back to index 1
  assert.ok(back);
  // sit at index 0 (a): back twice
  const back2 = navBack(back.state);
  assert.ok(back2);
  const s0 = back2.state; // index 0
  const alive = (uri: string) => uri !== "b";
  const f = navForward(s0, alive); // from a, forward skips b → c
  assert.ok(f);
  assert.deepEqual(f.loc, at("c", 1));
  assert.equal(f.state.index, 2);
});

test("navBack returns null when every earlier entry is dead", () => {
  let s = recordNav(initialNav(), at("a", 1));
  s = recordNav(s, at("b", 1)); // [a,b] index 1
  assert.equal(
    navBack(s, () => false),
    null,
  );
});

test("navBack default predicate (omitted) is unchanged — first step back", () => {
  let s = recordNav(initialNav(), at("a", 1));
  s = recordNav(s, at("b", 1));
  const r = navBack(s);
  assert.ok(r);
  assert.deepEqual(r.loc, at("a", 1));
});

test("pruneNav drops dead entries and re-anchors the pointer", () => {
  let s = recordNav(initialNav(), at("a", 1));
  s = recordNav(s, at("b", 1));
  s = recordNav(s, at("c", 1)); // index 2 (c)
  const pruned = pruneNav(s, (uri) => uri !== "b");
  assert.deepEqual(
    pruned.entries.map((e) => e.uri),
    ["a", "c"],
  );
  assert.equal(pruned.entries[pruned.index]?.uri, "c"); // still points at c
});

test("pruneNav re-anchors to the first survivor when the current entry is dead", () => {
  let s = recordNav(initialNav(), at("a", 1));
  s = recordNav(s, at("b", 1)); // index 1 (b)
  const pruned = pruneNav(s, (uri) => uri !== "b");
  assert.deepEqual(
    pruned.entries.map((e) => e.uri),
    ["a"],
  );
  assert.equal(pruned.index, 0);
});

test("pruneNav returns the SAME ref when nothing is dead (no churn)", () => {
  let s = recordNav(initialNav(), at("a", 1));
  s = recordNav(s, at("b", 1));
  assert.equal(
    pruneNav(s, () => true),
    s,
  );
});

test("dedupe: two visits < MIN_GAP lines apart in the same file collapse to one entry", () => {
  let s = recordNav(initialNav(), at("f", 10, 1));
  s = recordNav(s, at("f", 10 + (MIN_GAP - 1), 4));
  s = recordNav(s, at("f", 11, 2));
  assert.equal(s.entries.length, 1); // all coalesced into one spot
});

test("forward history truncates on a fresh record but NOT on a back/forward traversal", () => {
  let s = recordNav(initialNav(), at("a", 1));
  s = recordNav(s, at("b", 1));
  s = recordNav(s, at("c", 1)); // [a,b,c]
  const b1 = navBack(s); // traversal → [a,b,c] preserved, index 1
  assert.ok(b1);
  assert.equal(b1.state.entries.length, 3); // NOT truncated by traversal
  const f = navForward(b1.state);
  assert.ok(f);
  assert.equal(f.state.entries.length, 3);
  // now a FRESH record from index 1 truncates the forward tail (c).
  const after = recordNav(b1.state, at("d", 1));
  assert.deepEqual(
    after.entries.map((e) => e.uri),
    ["a", "b", "d"],
  );
});

test("column is 1-based and survives the record→back round-trip (no off-by-one)", () => {
  let s = recordNav(initialNav(), at("a", 5, 12)); // line 5, column 12 (1-based)
  s = recordNav(s, at("b", 1, 1));
  const r = navBack(s);
  assert.ok(r);
  assert.equal(r.loc.line, 5);
  assert.equal(r.loc.column, 12); // exact, no shift
});
