/**
 * fuzzy.test.ts — node:test for the PURE command-palette / quick-open fuzzy matcher.
 *
 * Pins the subsequence discipline (every query char in order), the boundary/prefix/
 * contiguity bonuses that drive sensible ranking, and the highlight segmentation the
 * palette bolds. Pure — no react/monaco — runs under node --test directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fuzzyRank, fuzzyScore, highlightSegments } from "./fuzzy.js";

test("non-subsequence ⇒ null", () => {
  assert.equal(fuzzyScore("xyz", "format document"), null);
});

test("empty query matches everything (score 1, no positions)", () => {
  const r = fuzzyScore("", "anything");
  assert.deepEqual(r, { score: 1, positions: [] });
});

test("subsequence match returns ascending positions", () => {
  const r = fuzzyScore("fd", "format document");
  assert.ok(r);
  // f at 0, d at the start of "document" (index 7).
  assert.deepEqual(r?.positions, [0, 7]);
});

test("prefix + boundary beats a scattered match", () => {
  const prefix = fuzzyScore("form", "format document");
  const scattered = fuzzyScore("form", "perform normalization");
  assert.ok(prefix && scattered);
  assert.ok((prefix?.score ?? 0) > (scattered?.score ?? 0));
});

test("contiguous run scores higher than gapped", () => {
  const contig = fuzzyScore("git", "git commit");
  const gapped = fuzzyScore("git", "g_i_t_x");
  assert.ok(contig && gapped);
  assert.ok((contig?.score ?? 0) > (gapped?.score ?? 0));
});

test("fuzzyRank drops non-matches and ranks the prefix/contiguous match first", () => {
  // "git" is a subsequence of both "Git: Commit" (prefix) and "Go to Definition"
  // (G…o-to-Def-i-ni-t-ion), but the prefix+contiguous "Git" must rank first; the
  // non-matches ("Format Document"/"AI: Inline Edit" lack a 't' after 'i') drop.
  const items = ["Format Document", "Git: Commit", "Go to Definition", "AI: Inline Edit"];
  const ranked = fuzzyRank("git", items, (s) => s);
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0]?.item, "Git: Commit");
  assert.ok(ranked.every((r) => r.item !== "Format Document"));
});

test("fuzzyRank is stable on equal scores (original order kept)", () => {
  const items = ["aXb", "aYb"];
  // both match "ab" with identical structure → original order preserved.
  const ranked = fuzzyRank("ab", items, (s) => s);
  assert.deepEqual(
    ranked.map((r) => r.item),
    ["aXb", "aYb"],
  );
});

test("blank query returns all items in natural order", () => {
  const items = ["c", "a", "b"];
  const ranked = fuzzyRank("  ", items, (s) => s);
  assert.deepEqual(
    ranked.map((r) => r.item),
    ["c", "a", "b"],
  );
});

test("highlightSegments splits matched runs for bolding", () => {
  const segs = highlightSegments("git", [0, 1, 2]);
  assert.deepEqual(segs, [{ text: "git", matched: true }]);
});

test("highlightSegments interleaves plain + matched", () => {
  // candidate "abc", positions [0,2] → a(match) b(plain) c(match)
  const segs = highlightSegments("abc", [0, 2]);
  assert.deepEqual(segs, [
    { text: "a", matched: true },
    { text: "b", matched: false },
    { text: "c", matched: true },
  ]);
});

test("highlightSegments with no positions is one plain run", () => {
  assert.deepEqual(highlightSegments("abc", []), [{ text: "abc", matched: false }]);
});

test("quick-open ranks a path by basename-style query", () => {
  const paths = ["src/agents/runner.py", "src/web/server.ts", "tests/test_runner.py"];
  const ranked = fuzzyRank("runner", paths, (p) => p);
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0]?.item, "src/agents/runner.py");
});
