import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_FRECENCY_STORE,
  MAX_FRECENCY_ENTRIES,
  frecencyForDirectory,
  frecencyScore,
  parseFrecencyStore,
  rankEntries,
  recordPathUse,
  scoreFragment,
  topFrecencyPaths,
} from "./index.js";

test("scoreFragment: exact match scores highest of its own candidate", () => {
  const m = scoreFragment("foo", "foo");
  assert.ok(m);
  assert.deepEqual(m!.positions, [0, 1, 2]);
});

test("scoreFragment: fragmented (non-contiguous) subsequence still matches", () => {
  // "cli" should match "src/cli/index.ts" — a fragment, not a rigid prefix.
  const m = scoreFragment("cli", "src/cli/index.ts");
  assert.ok(m, "expected a fragmented subsequence match");
});

test("scoreFragment: not a subsequence returns null", () => {
  assert.equal(scoreFragment("xyz", "abc"), null);
});

test("scoreFragment: a query longer than the candidate never matches", () => {
  assert.equal(scoreFragment("abcdef", "abc"), null);
});

test("scoreFragment: blank query matches everything with a neutral score", () => {
  const m = scoreFragment("", "anything");
  assert.deepEqual(m, { score: 0, positions: [] });
});

test("scoreFragment: positions stay valid indices into the ORIGINAL candidate even when a character's lowercase form is a different length", () => {
  // Turkish İ (U+0130) lowercases to TWO code units ("i" + a combining dot, U+0307) — a
  // whole-string .toLowerCase() would desync every index after it from the real candidate.
  const candidate = "İstanbul.ts";
  const m = scoreFragment("tan", candidate);
  assert.ok(m, "expected a match");
  const matched = m!.positions.map((i) => candidate[i]).join("");
  assert.equal(matched.toLowerCase(), "tan");
});

test("scoreFragment: case-insensitive matching still works around a length-changing lowercase char", () => {
  // the "stanbul" tail should still match "stanbul" even though "İ" itself is skipped.
  const m = scoreFragment("stanbul", "İstanbul.ts");
  assert.ok(m, "expected the ascii tail to still match");
});

test("scoreFragment: a word-boundary-aligned match outscores a scattered one", () => {
  // "run" as a whole segment ("runner") should beat "run" scattered inside "aruinner".
  const aligned = scoreFragment("run", "runner.py");
  const scattered = scoreFragment("run", "a-r-u-n-file");
  assert.ok(aligned && scattered);
  assert.ok(aligned!.score > scattered!.score);
});

test("rankEntries: blank query with no frecency data is directory-then-alpha", () => {
  const ranked = rankEntries("", [
    { name: "zebra.ts", isDir: false },
    { name: "apps", isDir: true },
    { name: "alpha.ts", isDir: false },
  ]);
  assert.deepEqual(
    ranked.map((r) => r.name),
    ["apps", "alpha.ts", "zebra.ts"],
  );
});

test("rankEntries: non-matching entries are dropped, matching ones are fragment-ranked", () => {
  const ranked = rankEntries("cmp", [
    { name: "components", isDir: true },
    { name: "package.json", isDir: false },
    { name: "compose.yml", isDir: false },
  ]);
  const names = ranked.map((r) => r.name);
  assert.ok(names.includes("components"));
  assert.ok(names.includes("compose.yml"));
  assert.ok(!names.includes("package.json"));
});

test("rankEntries: a blank-query frecency favorite is boosted to the top", () => {
  const frecency = new Map([["old-favorite.ts", 100]]);
  const ranked = rankEntries(
    "",
    [
      { name: "aaa.ts", isDir: false },
      { name: "old-favorite.ts", isDir: false },
    ],
    frecency,
  );
  assert.equal(ranked[0]!.name, "old-favorite.ts");
});

test("rankEntries: frecency nudges a tie but does not bury a much stronger fuzzy match", () => {
  const frecency = new Map([["zzz-unrelated.ts", 1000]]); // huge frecency, weak/no fuzzy match
  const ranked = rankEntries(
    "widget",
    [
      { name: "widget.ts", isDir: false }, // strong match, no frecency
      { name: "zzz-unrelated.ts", isDir: false }, // not a subsequence of "widget" at all
    ],
    frecency,
  );
  // zzz-unrelated.ts doesn't even contain "widget" as a subsequence, so it must be dropped
  // entirely regardless of frecency — frecency only re-ranks entries that already matched.
  assert.deepEqual(
    ranked.map((r) => r.name),
    ["widget.ts"],
  );
});

test("recordPathUse: a fresh path is added with count 1", () => {
  const store = recordPathUse(EMPTY_FRECENCY_STORE, "/proj/a.ts", 1_000);
  assert.deepEqual(store.entries, [{ path: "/proj/a.ts", count: 1, lastUsedMs: 1_000 }]);
});

test("recordPathUse: reusing the same path increments count and bumps lastUsedMs", () => {
  let store = recordPathUse(EMPTY_FRECENCY_STORE, "/proj/a.ts", 1_000);
  store = recordPathUse(store, "/proj/a.ts", 2_000);
  assert.deepEqual(store.entries, [{ path: "/proj/a.ts", count: 2, lastUsedMs: 2_000 }]);
});

test("recordPathUse: is immutable (never mutates the store it was given)", () => {
  const store = EMPTY_FRECENCY_STORE;
  const before = JSON.stringify(store);
  recordPathUse(store, "/proj/a.ts", 1_000);
  assert.equal(JSON.stringify(store), before);
});

test("recordPathUse: evicts the single lowest-frecency entry past the cap, not the oldest", () => {
  let store: ReturnType<typeof recordPathUse> = EMPTY_FRECENCY_STORE;
  const now = 1_000_000;
  // Fill to the cap with entries that all have count 1 at a distinct, increasing lastUsedMs
  // (entry 0 is the OLDEST / least recently used, and therefore lowest-scoring at `now`).
  for (let i = 0; i < MAX_FRECENCY_ENTRIES; i++) {
    store = recordPathUse(store, `/proj/f${i}.ts`, now - (MAX_FRECENCY_ENTRIES - i) * 1000);
  }
  assert.equal(store.entries.length, MAX_FRECENCY_ENTRIES);
  // One more path pushes it over the cap — the oldest/lowest-scoring entry (f0) must be evicted,
  // not an arbitrary one (e.g. not simply the first element / insertion order).
  store = recordPathUse(store, "/proj/new.ts", now);
  assert.equal(store.entries.length, MAX_FRECENCY_ENTRIES);
  assert.ok(
    !store.entries.some((e) => e.path === "/proj/f0.ts"),
    "the stalest entry should be evicted",
  );
  assert.ok(store.entries.some((e) => e.path === "/proj/new.ts"));
});

test("frecencyScore: decays with age and grows with count", () => {
  const now = 10 * 86_400_000; // day 10
  const fresh: Parameters<typeof frecencyScore>[0] = { path: "/a", count: 1, lastUsedMs: now };
  const stale: Parameters<typeof frecencyScore>[0] = { path: "/a", count: 1, lastUsedMs: 0 };
  assert.ok(frecencyScore(fresh, now) > frecencyScore(stale, now));

  const frequent: Parameters<typeof frecencyScore>[0] = { path: "/a", count: 10, lastUsedMs: now };
  assert.ok(frecencyScore(frequent, now) > frecencyScore(fresh, now));
});

test("topFrecencyPaths: most-frecent first, respects a limit", () => {
  const now = 1_000_000;
  const store = {
    entries: [
      { path: "/a", count: 1, lastUsedMs: now },
      { path: "/b", count: 50, lastUsedMs: now },
      { path: "/c", count: 5, lastUsedMs: now },
    ],
  };
  const top = topFrecencyPaths(store, now, 2);
  assert.deepEqual(
    top.map((e) => e.path),
    ["/b", "/c"],
  );
});

test("parseFrecencyStore: corrupt/missing input yields an empty store, never throws", () => {
  assert.deepEqual(parseFrecencyStore(undefined), { entries: [] });
  assert.deepEqual(parseFrecencyStore(null), { entries: [] });
  assert.deepEqual(parseFrecencyStore("garbage"), { entries: [] });
  assert.deepEqual(parseFrecencyStore({}), { entries: [] });
  assert.deepEqual(parseFrecencyStore({ entries: "nope" }), { entries: [] });
});

test("parseFrecencyStore: drops malformed rows element-wise, keeps well-formed ones", () => {
  const parsed = parseFrecencyStore({
    entries: [
      { path: "/ok", count: 3, lastUsedMs: 123 },
      { path: "/bad-count", count: "nope", lastUsedMs: 123 },
      { missing: "fields" },
      { path: "/ok2", count: 1, lastUsedMs: 456 },
    ],
  });
  assert.deepEqual(parsed.entries, [
    { path: "/ok", count: 3, lastUsedMs: 123 },
    { path: "/ok2", count: 1, lastUsedMs: 456 },
  ]);
});

test("parseFrecencyStore: drops a non-finite or negative count/lastUsedMs (e.g. from a corrupted JSON number literal)", () => {
  const parsed = parseFrecencyStore({
    entries: [
      { path: "/ok", count: 3, lastUsedMs: 123 },
      // an overflowed numeric literal (e.g. 1e400) parses via JSON.parse to Infinity too.
      { path: "/infinite-count", count: Number.POSITIVE_INFINITY, lastUsedMs: 123 },
      { path: "/nan-lastUsed", count: 1, lastUsedMs: Number.NaN },
      { path: "/negative-count", count: -1, lastUsedMs: 123 },
    ],
  });
  assert.deepEqual(parsed.entries, [{ path: "/ok", count: 3, lastUsedMs: 123 }]);
});

test("frecencyForDirectory: only entries whose parent is exactly dirPath contribute", () => {
  const now = 1_000_000;
  const store = {
    entries: [
      { path: "/proj/src/a.ts", count: 5, lastUsedMs: now },
      { path: "/proj/src/nested/b.ts", count: 99, lastUsedMs: now }, // different (deeper) parent
      { path: "/proj/other/c.ts", count: 99, lastUsedMs: now }, // different parent entirely
    ],
  };
  const map = frecencyForDirectory(store, "/proj/src", now);
  assert.deepEqual([...map.keys()], ["a.ts"]);
});

test("frecencyForDirectory: a trailing slash on dirPath is tolerated", () => {
  const now = 1_000_000;
  const store = { entries: [{ path: "/proj/src/a.ts", count: 1, lastUsedMs: now }] };
  const map = frecencyForDirectory(store, "/proj/src/", now);
  assert.equal(map.get("a.ts"), frecencyScore(store.entries[0]!, now));
});

test("frecencyForDirectory: backslash-separated (Windows) paths are also recognized", () => {
  const now = 1_000_000;
  const store = {
    entries: [
      { path: "C:\\proj\\src\\a.ts", count: 5, lastUsedMs: now },
      { path: "C:\\proj\\other\\b.ts", count: 99, lastUsedMs: now },
    ],
  };
  const map = frecencyForDirectory(store, "C:\\proj\\src", now);
  assert.deepEqual([...map.keys()], ["a.ts"]);
});

test("frecencyForDirectory: a corrupted entry with a non-finite score never poisons SIBLING entries in the same map", () => {
  const now = 1_000_000;
  // parseFrecencyStore would normally reject this, but frecencyForDirectory must be
  // defensive on its own too — a directly-constructed store should never let one bad
  // entry's NaN/Infinity score leak into another entry's reported score.
  const store = {
    entries: [
      { path: "/proj/src/good.ts", count: 5, lastUsedMs: now },
      { path: "/proj/src/corrupt.ts", count: Number.POSITIVE_INFINITY, lastUsedMs: 0 },
    ],
  };
  const map = frecencyForDirectory(store, "/proj/src", now);
  assert.ok(Number.isFinite(map.get("good.ts")), "an unrelated entry's score must stay finite");
});
