/**
 * usages.test.ts — node:test for the PURE Find-Usages fan-in math (APP-023).
 *
 * Pins the 0→1-based conversion at the boundary, canonical-uri equivalence (LSP file:// vs
 * grep fs path vs percent-encoded), cross-source dedupe (an LSP + a grep hit at the same
 * location collapse to one, LSP tag wins), grouping, and the pure scope-prefix filter.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Usage,
  canonicalUri,
  countUsages,
  dirOf,
  filterScope,
  groupByFile,
  mergeUsages,
  usagesFromLocations,
} from "./usages.js";

const grep = (uri: string, line: number, column: number, excerpt?: string): Usage => ({
  uri,
  line,
  column,
  source: "grep",
  ...(excerpt !== undefined ? { excerpt } : {}),
});

test("canonicalUri: file:// uri, bare path, and percent-encoded all collapse to one form", () => {
  assert.equal(canonicalUri("file:///a/b.ts"), "file:///a/b.ts");
  assert.equal(canonicalUri("/a/b.ts"), "file:///a/b.ts");
  assert.equal(canonicalUri("file:///a/b%20c.ts"), "file:///a/b c.ts");
  // the three forms of the SAME file are equal
  assert.equal(canonicalUri("file:///a/b.ts"), canonicalUri("/a/b.ts"));
});

test("usagesFromLocations converts 0-based LSP positions to 1-based (once, at the boundary)", () => {
  const out = usagesFromLocations([
    { uri: "file:///a.ts", range: { start: { line: 4, character: 2 } } },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { uri: "file:///a.ts", line: 5, column: 3, source: "lsp" });
});

test("mergeUsages dedupes an LSP + a grep hit at the SAME location (LSP tag wins)", () => {
  // LSP 0-based (4:2) → 1-based (5:3); grep already 1-based (5:3) at the same file.
  const lsp = usagesFromLocations([
    { uri: "file:///a.ts", range: { start: { line: 4, character: 2 } } },
  ]);
  const grepHits = [grep("/a.ts", 5, 3)]; // bare path → canonicalizes to file:///a.ts
  const merged = mergeUsages(lsp, grepHits);
  assert.equal(merged.length, 1); // collapsed to ONE
  assert.equal(merged[0]?.source, "lsp"); // LSP (passed first) wins the tie
});

test("mergeUsages keeps distinct locations and grafts a missing excerpt from a duplicate", () => {
  const lsp = usagesFromLocations([
    { uri: "file:///a.ts", range: { start: { line: 0, character: 0 } } }, // → 1:1, no excerpt
  ]);
  const grepHits = [grep("/a.ts", 1, 1, "const x = 1"), grep("/b.ts", 2, 4)];
  const merged = mergeUsages(lsp, grepHits);
  assert.equal(merged.length, 2); // a.ts:1:1 (deduped) + b.ts:2:4
  const a = merged.find((u) => u.line === 1);
  assert.equal(a?.source, "lsp");
  assert.equal(a?.excerpt, "const x = 1"); // excerpt grafted from the grep duplicate
});

test("groupByFile groups + sorts files by path and rows by (line, column)", () => {
  const usages = [
    grep("/b.ts", 3, 1),
    grep("/a.ts", 10, 2),
    grep("/a.ts", 2, 5),
    grep("/a.ts", 2, 1),
  ];
  const groups = groupByFile(usages);
  assert.deepEqual(
    groups.map((g) => g.uri),
    ["file:///a.ts", "file:///b.ts"],
  );
  assert.deepEqual(
    groups[0]?.rows.map((r) => `${r.line}:${r.column}`),
    ["2:1", "2:5", "10:2"],
  );
});

test("filterScope: all / file / directory prefix (pure, no re-query)", () => {
  const usages = [
    grep("/proj/src/a.ts", 1, 1),
    grep("/proj/src/sub/b.ts", 2, 1),
    grep("/proj/other/c.ts", 3, 1),
  ];
  assert.equal(filterScope(usages, "all", "file:///proj/src/a.ts").length, 3);
  assert.equal(filterScope(usages, "file", "file:///proj/src/a.ts").length, 1);
  // directory-of-origin = /proj/src/ → a.ts + sub/b.ts, NOT other/c.ts
  const dir = filterScope(usages, "directory", "file:///proj/src/a.ts");
  assert.equal(dir.length, 2);
  assert.equal(
    dir.every((u) => canonicalUri(u.uri).startsWith("file:///proj/src/")),
    true,
  );
});

test("dirOf returns the directory prefix (trailing slash)", () => {
  assert.equal(dirOf("file:///proj/src/a.ts"), "file:///proj/src/");
  assert.equal(dirOf("/proj/src/a.ts"), "file:///proj/src/");
});

test("countUsages tallies rows + distinct files", () => {
  const c = countUsages([grep("/a.ts", 1, 1), grep("/a.ts", 2, 1), grep("/b.ts", 1, 1)]);
  assert.deepEqual(c, { usages: 3, files: 2 });
});
