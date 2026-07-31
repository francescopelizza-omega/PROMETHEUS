/**
 * bookmarks.test.ts — the PURE bookmark model (APP-061): toggle idempotence, mnemonic
 * steal, line-shift + clamp, and serialize round-trip / fail-soft.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BookmarkState,
  EMPTY_BOOKMARKS,
  allSorted,
  bookmarkGlyphClass,
  bookmarkedUris,
  byMnemonic,
  clearMnemonic,
  deserialize,
  forUri,
  gutterInputsFor,
  isBookmarked,
  removeBookmark,
  serialize,
  setMnemonic,
  shiftLines,
  storageKeyFor,
  toggleBookmark,
  useBookmarksStore,
  wireBookmarkGutter,
} from "./bookmarks.js";

const A = "file:///a.ts";
const B = "file:///b.ts";

test("toggle: adds then removes the same line (idempotent pair)", () => {
  let s = EMPTY_BOOKMARKS;
  s = toggleBookmark(s, A, 10);
  assert.equal(isBookmarked(s, A, 10), true);
  assert.equal(s.list.length, 1);
  s = toggleBookmark(s, A, 10); // toggle off
  assert.equal(isBookmarked(s, A, 10), false);
  assert.equal(s.list.length, 0);
  // remove is a no-op when absent (same ref).
  assert.equal(removeBookmark(s, A, 99), s);
});

test("setMnemonic: creates a bookmark + STEALS the digit from any prior holder (single update)", () => {
  let s = EMPTY_BOOKMARKS;
  s = setMnemonic(s, A, 5, 1); // digit 1 → A:5 (creates the bookmark)
  assert.equal(byMnemonic(s, 1)?.line, 5);
  s = setMnemonic(s, B, 20, 1); // digit 1 → B:20 — must steal from A:5
  const holders = s.list.filter((b) => b.mnemonic === 1);
  assert.equal(holders.length, 1, "exactly one holder of digit 1");
  assert.equal(holders[0]?.uri, B);
  // A:5 still exists but no longer holds the digit.
  assert.equal(isBookmarked(s, A, 5), true);
  assert.equal(s.list.find((b) => b.uri === A && b.line === 5)?.mnemonic, undefined);
  // out-of-range digit is a no-op.
  assert.equal(setMnemonic(s, A, 5, 42), s);
  // clearMnemonic drops it.
  s = clearMnemonic(s, 1);
  assert.equal(byMnemonic(s, 1), undefined);
});

test("shiftLines: bookmarks below an edit move; a deleted line clamps (never vanishes)", () => {
  let s: BookmarkState = { list: [] };
  s = toggleBookmark(s, A, 5);
  s = toggleBookmark(s, A, 10);
  s = toggleBookmark(s, A, 20);
  s = toggleBookmark(s, B, 10); // another file — untouched by an A edit
  // insert 3 lines at line 8 → bookmarks below 8 shift +3.
  s = shiftLines(s, A, 8, 3);
  assert.equal(
    forUri(s, A)
      .map((b) => b.line)
      .join(","),
    "5,13,23",
  );
  assert.equal(forUri(s, B)[0]?.line, 10); // other file unchanged
  // delete lines starting at 12 (delta -5) → the bookmark at 13 clamps to 12; 23 → 18.
  s = shiftLines(s, A, 12, -5);
  assert.deepEqual(
    forUri(s, A).map((b) => b.line),
    [5, 12, 18],
  );
});

test("shiftLines: a collision after clamping keeps the mnemonic-holder", () => {
  let s: BookmarkState = { list: [] };
  s = toggleBookmark(s, A, 6); // plain
  s = setMnemonic(s, A, 9, 3); // mnemonic holder at line 9
  // delete a big range at line 5 (delta -10): both clamp to line 5 → merge, keep the holder.
  s = shiftLines(s, A, 5, -10);
  const at = forUri(s, A);
  assert.equal(at.length, 1);
  assert.equal(at[0]?.line, 5);
  assert.equal(at[0]?.mnemonic, 3, "the mnemonic survives the merge");
});

test("serialize round-trips; deserialize is fail-soft + drops malformed rows", () => {
  let s = EMPTY_BOOKMARKS;
  s = setMnemonic(toggleBookmark(s, A, 3, "note"), A, 7, 2);
  const round = deserialize(serialize(s));
  assert.deepEqual(allSorted(round), allSorted(s));
  // corrupt / non-array / bad rows → empty or filtered.
  assert.deepEqual(deserialize("{not json"), EMPTY_BOOKMARKS);
  assert.deepEqual(deserialize(JSON.stringify({ not: "array" })), EMPTY_BOOKMARKS);
  assert.deepEqual(deserialize(null), EMPTY_BOOKMARKS);
  const mixed = deserialize(
    JSON.stringify([
      { uri: A, line: 4, mnemonic: 2 },
      { uri: A }, // no line → dropped
      { line: 5 }, // no uri → dropped
      { uri: A, line: 0 }, // line < 1 → dropped
      { uri: A, line: 6, mnemonic: 99 }, // bad digit → kept but mnemonic stripped
    ]),
  );
  assert.equal(mixed.list.length, 2);
  assert.equal(mixed.list[0]?.mnemonic, 2);
  assert.equal(mixed.list[1]?.mnemonic, undefined);
});

test("deserialize enforces one-holder-per-mnemonic (a corrupt duplicate digit is stripped)", () => {
  const dup = deserialize(
    JSON.stringify([
      { uri: A, line: 1, mnemonic: 5 },
      { uri: A, line: 2, mnemonic: 5 }, // duplicate digit 5 → kept, but mnemonic stripped
    ]),
  );
  assert.equal(dup.list.length, 2);
  assert.equal(dup.list[0]?.mnemonic, 5);
  assert.equal(dup.list[1]?.mnemonic, undefined);
});

test("storageKeyFor isolates per workspace root", () => {
  assert.notEqual(storageKeyFor("/proj/a"), storageKeyFor("/proj/b"));
  assert.match(storageKeyFor("/proj/a"), /bookmarks/);
});

test("wireBookmarkGutter: syncs store → registry, clears a file that loses its last mark", () => {
  const calls: { uri: string; n: number }[] = [];
  const registry = {
    register: () => {},
    replaceForProvider: (_p: string, uri: string, decs: unknown[]) =>
      calls.push({ uri, n: decs.length }),
  };
  const store = useBookmarksStore.getState();
  store.setRoot("/proj/wire"); // node:test has no window → loads EMPTY, persists no-op
  const unsub = wireBookmarkGutter(registry, useBookmarksStore);
  store.toggle(A, 3);
  store.toggle(A, 8);
  // the last sync for A carries 2 decorations.
  assert.equal(calls.filter((c) => c.uri === A).at(-1)?.n, 2);
  store.remove(A, 3);
  store.remove(A, 8); // A now empty → cleared with []
  assert.equal(calls.filter((c) => c.uri === A).at(-1)?.n, 0);
  unsub();
});

test("gutter projection: per-digit glyph class + inputs sorted by line", () => {
  assert.equal(bookmarkGlyphClass(undefined), "bookmark-glyph");
  assert.equal(bookmarkGlyphClass(3), "bookmark-glyph-3");
  let s = EMPTY_BOOKMARKS;
  s = toggleBookmark(s, A, 12);
  s = setMnemonic(s, A, 4, 7);
  s = toggleBookmark(s, B, 1);
  const inputs = gutterInputsFor(s, A);
  assert.deepEqual(
    inputs.map((i) => i.line),
    [4, 12],
  ); // sorted
  assert.equal(inputs[0]?.glyphClassName, "bookmark-glyph-7");
  assert.match(inputs[0]?.hoverMessage ?? "", /Bookmark 7/);
  assert.equal(inputs[1]?.glyphClassName, "bookmark-glyph");
  assert.deepEqual(bookmarkedUris(s).sort(), [A, B].sort());
});
