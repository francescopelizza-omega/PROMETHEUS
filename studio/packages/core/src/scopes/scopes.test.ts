/**
 * scopes.test.ts — named glob Scopes + Favorites + Bookmarks (file 13 §2.6).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUILTIN_SCOPES,
  type Bookmark,
  type Favorite,
  SCOPE_PRODUCTION,
  SCOPE_TESTS,
  bookmarkByMnemonic,
  filterByScope,
  isFavorite,
  matchScope,
  removeBookmark,
  setBookmark,
  toggleFavorite,
} from "./index.js";

// ---- scopes ---------------------------------------------------------------- //

test("ships builtin scopes: Project Files, Production, Tests", () => {
  assert.equal(BUILTIN_SCOPES.length, 3);
});

test("Production scope excludes tests; Tests scope is their complement", () => {
  assert.equal(matchScope(SCOPE_PRODUCTION, "src/app.ts"), true);
  assert.equal(matchScope(SCOPE_PRODUCTION, "src/app.test.ts"), false);
  assert.equal(matchScope(SCOPE_PRODUCTION, "tests/test_app.py"), false);
  assert.equal(matchScope(SCOPE_TESTS, "src/app.test.ts"), true);
  assert.equal(matchScope(SCOPE_TESTS, "src/app.ts"), false);
});

test("filterByScope keeps only in-scope paths", () => {
  const paths = ["src/a.ts", "src/a.test.ts", "src/b.ts", "tests/t.py"];
  assert.deepEqual(filterByScope(paths, SCOPE_PRODUCTION), ["src/a.ts", "src/b.ts"]);
});

// ---- favorites ------------------------------------------------------------- //

test("toggleFavorite adds then removes; isFavorite reflects it", () => {
  let favs: Favorite[] = [];
  favs = toggleFavorite(favs, "src/main.ts");
  assert.equal(isFavorite(favs, "src/main.ts"), true);
  favs = toggleFavorite(favs, "src/main.ts");
  assert.equal(isFavorite(favs, "src/main.ts"), false);
});

// ---- bookmarks ------------------------------------------------------------- //

test("setBookmark adds/replaces by (path,line); mnemonic lookup + remove work", () => {
  let bms: Bookmark[] = [];
  bms = setBookmark(bms, { path: "a.ts", line: 10, mnemonic: "1" });
  bms = setBookmark(bms, { path: "a.ts", line: 10, mnemonic: "2" }); // replace same loc
  assert.equal(bms.length, 1);
  assert.equal(bookmarkByMnemonic(bms, "2")?.line, 10);
  bms = removeBookmark(bms, "a.ts", 10);
  assert.equal(bms.length, 0);
});
