/**
 * code-index.test.ts — node:test for the PURE codebase-index model (plan 39).
 *
 * Pins symbol-index build + fuzzy query, identifier extraction + word→files index, and
 * the dumb-mode status machine (empty → indexing → ready, clamped).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as ci from "./code-index.js";
import {
  type IndexedSymbol,
  type RepoMapPayload,
  advance,
  buildIndex,
  buildWordIndex,
  extractIdentifiers,
  initialStatus,
  mergeRepoMap,
  searchSymbols,
  searchSymbolsRanked,
  startIndexing,
  wordFiles,
} from "./code-index.js";

const sym = (name: string, uri: string, container = ""): IndexedSymbol => ({
  name,
  kind: 12,
  uri,
  line: 0,
  container,
});

test("buildIndex flattens per-file symbols + tracks files", () => {
  const idx = buildIndex([
    { uri: "a.py", symbols: [sym("foo", "a.py"), sym("bar", "a.py")] },
    { uri: "b.py", symbols: [sym("baz", "b.py")] },
  ]);
  assert.equal(idx.symbols.length, 3);
  assert.deepEqual(idx.files, ["a.py", "b.py"]);
});

test("searchSymbols fuzzy-ranks by name/container; empty query returns a prefix", () => {
  const idx = buildIndex([
    { uri: "a.py", symbols: [sym("parseConfig", "a.py", "Loader"), sym("render", "a.py")] },
  ]);
  const hits = searchSymbols(idx, "parse").map((s) => s.name);
  assert.equal(hits[0], "parseConfig");
  assert.equal(searchSymbols(idx, "", 1).length, 1); // empty query → first N
  assert.deepEqual(searchSymbols(idx, "zzzznope"), []); // no subsequence match
});

test("extractIdentifiers: unique, first-seen order, length ≥ 2, no numbers-first", () => {
  assert.deepEqual(extractIdentifiers("def foo(bar): return bar + 1"), [
    "def",
    "foo",
    "bar",
    "return",
  ]);
  assert.deepEqual(extractIdentifiers("a bb ccc a"), ["bb", "ccc"]); // 'a' too short, dedup
});

test("buildWordIndex maps case-insensitive word → sorted unique files", () => {
  const idx = buildWordIndex([
    { uri: "z.py", text: "Server server" },
    { uri: "a.py", text: "server worker" },
  ]);
  assert.deepEqual(wordFiles(idx, "server"), ["a.py", "z.py"]); // sorted, deduped, case-insensitive
  assert.deepEqual(wordFiles(idx, "WORKER"), ["a.py"]);
  assert.deepEqual(wordFiles(idx, "absent"), []);
});

test("status machine: empty → indexing → ready, clamped", () => {
  assert.deepEqual(initialStatus(), { state: "empty", indexed: 0, total: 0 });
  assert.deepEqual(startIndexing(0), { state: "ready", indexed: 0, total: 0 }); // nothing to do
  let s = startIndexing(2);
  assert.deepEqual(s, { state: "indexing", indexed: 0, total: 2 });
  s = advance(s);
  assert.deepEqual(s, { state: "indexing", indexed: 1, total: 2 });
  s = advance(s, 5); // over-advance clamps + flips ready
  assert.deepEqual(s, { state: "ready", indexed: 2, total: 2 });
  assert.deepEqual(advance(s), s); // advancing a ready status is a no-op
});

// ---- repo-map merge + rank-aware search (APP-053) -------------------------- //

const MAP: RepoMapPayload = {
  files: [
    {
      path: "pkg/core.py",
      symbols: [
        { name: "Widget", kind: "class", line: 1, rank: 1.0 },
        { name: "helper", kind: "function", line: 6, rank: 0.9 },
      ],
    },
    {
      path: "pkg/app.py",
      symbols: [{ name: "main", kind: "function", line: 3, rank: 0.1 }],
    },
  ],
};
const toUri = (rel: string): string => `file:///w/${rel}`;

test("mergeRepoMap adds ranked symbols with LSP kinds + 0-based lines", () => {
  const idx = mergeRepoMap({ symbols: [], files: [] }, MAP, toUri);
  const w = idx.symbols.find((s) => s.name === "Widget");
  assert.ok(w);
  assert.equal(w?.kind, 5); // class
  assert.equal(w?.line, 0); // repomap 1-based → index 0-based
  assert.equal(w?.uri, "file:///w/pkg/core.py");
  assert.equal(w?.rank, 1.0);
  assert.equal(idx.symbols.length, 3);
});

test("mergeRepoMap REPLACES only the touched files' symbols (incremental refresh)", () => {
  const base = mergeRepoMap({ symbols: [], files: [] }, MAP, toUri);
  // a refresh of ONLY app.py (main renamed → run) must not drop core.py's symbols.
  const refreshed = mergeRepoMap(
    base,
    {
      files: [
        { path: "pkg/app.py", symbols: [{ name: "run", kind: "function", line: 3, rank: 0.2 }] },
      ],
    },
    toUri,
  );
  const names = refreshed.symbols.map((s) => s.name).sort();
  assert.deepEqual(names, ["Widget", "helper", "run"]); // main gone, run added, core kept
});

test("searchSymbolsRanked: empty query → highest rank first; query tiebreaks by rank", () => {
  const idx = mergeRepoMap({ symbols: [], files: [] }, MAP, toUri);
  const top = searchSymbolsRanked(idx, "", 10);
  assert.equal(top[0]?.name, "Widget"); // rank 1.0 leads
  assert.equal(top[top.length - 1]?.name, "main"); // rank 0.1 last
});

test("APP-065 ignore rules: prune heavy dirs; skip binary extensions", () => {
  const { isIgnoredDir, isIgnoredFile, defaultIgnoreRules } = ci;
  const rules = defaultIgnoreRules();
  assert.equal(isIgnoredDir("node_modules", rules), true);
  assert.equal(isIgnoredDir(".git", rules), true);
  assert.equal(isIgnoredDir("src", rules), false);
  assert.equal(isIgnoredFile("/w/logo.png", rules), true);
  assert.equal(isIgnoredFile("/w/pnpm-lock.yaml", rules), false); // .yaml is text
  assert.equal(isIgnoredFile("/w/a.pyc", rules), true);
  assert.equal(isIgnoredFile("/w/a.ts", rules), false);
});

test("APP-065 incremental symbol index: update replaces + remove drops (immutable)", () => {
  const { buildIndex, updateIndexEntry, removeIndexEntry, searchSymbols } = ci;
  const A = "file:///a.ts";
  const B = "file:///b.ts";
  let idx = buildIndex([
    { uri: A, symbols: [{ name: "alpha", kind: 12, uri: A, line: 0, container: "" }] },
    { uri: B, symbols: [{ name: "beta", kind: 12, uri: B, line: 0, container: "" }] },
  ]);
  // update A's symbols → only A changes; returns a NEW object (re-render safe).
  const next = updateIndexEntry(idx, A, [
    { name: "gamma", kind: 12, uri: A, line: 3, container: "" },
  ]);
  assert.notEqual(next, idx);
  assert.equal(searchSymbols(next, "gamma").length, 1);
  assert.equal(searchSymbols(next, "alpha").length, 0); // replaced
  assert.equal(searchSymbols(next, "beta").length, 1); // B untouched
  idx = next;
  // remove B → its symbol + file gone.
  const removed = removeIndexEntry(idx, B);
  assert.equal(searchSymbols(removed, "beta").length, 0);
  assert.equal(removed.files.includes(B), false);
  assert.equal(removeIndexEntry(removed, "file:///nope.ts"), removed); // no-op same ref
});

test("APP-065 incremental word index: update re-indexes one file; remove prunes it", () => {
  const { buildWordIndex, updateWordEntry, removeWordEntry, wordFiles } = ci;
  const A = "file:///a.ts";
  const B = "file:///b.ts";
  let w = buildWordIndex([
    { uri: A, text: "const buildIndex = 1" },
    { uri: B, text: "const buildIndex = 2" },
  ]);
  assert.deepEqual(wordFiles(w, "buildindex").sort(), [A, B].sort());
  // A no longer mentions buildIndex → dropped from A only (returns a NEW Map).
  const next = updateWordEntry(w, A, "const other = 1");
  assert.notEqual(next, w);
  assert.deepEqual(wordFiles(next, "buildindex"), [B]);
  assert.deepEqual(wordFiles(next, "other"), [A]);
  w = next;
  // remove B → buildIndex has no files left (word pruned).
  const removed = removeWordEntry(w, B);
  assert.deepEqual(wordFiles(removed, "buildindex"), []);
});

test("APP-065 shortlistFiles: content-based agent shortlist ranks by distinct query tokens", () => {
  const { buildWordIndex, shortlistFiles } = ci;
  const A = "file:///a.ts"; // has BOTH tokens
  const B = "file:///b.ts"; // has one
  const C = "file:///c.ts"; // has neither
  const w = buildWordIndex([
    { uri: A, text: "function parseArgs(input) { return input }" },
    { uri: B, text: "const input = 1" },
    { uri: C, text: "const zzz = 2" },
  ]);
  // an UNOPENED file that DEFINES parseArgs surfaces for a content query — not just name matches.
  const ranked = shortlistFiles(w, "parseArgs input", 10);
  assert.equal(ranked[0], A, "two-token file ranks first");
  assert.ok(ranked.includes(B), "one-token file included");
  assert.equal(ranked.includes(C), false, "zero-token file excluded");
  assert.deepEqual(shortlistFiles(w, "   ", 10), []); // no identifiers → empty
});

test("APP-065 store-level composition: upsert/drop keep the SYMBOL + WORD slices consistent", () => {
  // mirrors code-index-store's upsertFile/dropFile (both slices move together, immutably).
  const { buildIndex, buildWordIndex, updateIndexEntry, updateWordEntry, removeIndexEntry } = ci;
  const { removeWordEntry, searchSymbols, wordFiles } = ci;
  const A = "file:///a.ts";
  let index = buildIndex([{ uri: A, symbols: [{ name: "run", kind: 12, uri: A, line: 0 }] }]);
  let words = buildWordIndex([{ uri: A, text: "function run() {}" }]);
  // upsert a NEW file B (symbols + words together).
  const B = "file:///b.ts";
  index = updateIndexEntry(index, B, [{ name: "halt", kind: 12, uri: B, line: 0 }]);
  words = updateWordEntry(words, B, "function halt() {}");
  assert.equal(searchSymbols(index, "halt").length, 1);
  assert.deepEqual(wordFiles(words, "halt"), [B]);
  // drop B from BOTH slices → fully gone.
  index = removeIndexEntry(index, B);
  words = removeWordEntry(words, B);
  assert.equal(searchSymbols(index, "halt").length, 0);
  assert.deepEqual(wordFiles(words, "halt"), []);
  assert.equal(searchSymbols(index, "run").length, 1); // A survives
});
