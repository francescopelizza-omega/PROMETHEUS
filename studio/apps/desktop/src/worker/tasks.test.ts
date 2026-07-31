/**
 * worker/tasks.test.ts — node:test coverage for the PURE worker task logic.
 *
 * Built-in node:test + node:assert only (no vitest). These run NOW via
 *   node --import ../../apps/cli/dev-register.mjs --test src/worker/tasks.test.ts
 * They import ONLY worker/tasks.ts (pure Node) — no electron, no child process.
 *
 * Covers TASK 1 (log aggregation) + TASK 2 (file search) + the runTask dispatch.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type TaskRequest,
  aggregateLogLines,
  indexFiles,
  isCancelMessage,
  isTaskProgress,
  isTaskRequest,
  matchesGlob,
  runTask,
  searchFiles,
} from "./tasks.js";

/* ── TASK 1: log aggregation ──────────────────────────────────────────────── */

test("aggregateLogLines drops blank lines and counts phases", () => {
  const agg = aggregateLogLines(
    [
      "",
      "Scanning target for secrets",
      "  ",
      "Installing plugin foo",
      "warning: deprecated flag",
      "",
    ].join("\n"),
  );
  assert.equal(agg.total, 3);
  assert.equal(agg.counts.scan, 1);
  assert.equal(agg.counts.install, 1);
  assert.equal(agg.counts.warn, 1);
  assert.equal(agg.warnings, 1);
  // indices are over NON-blank lines only.
  assert.deepEqual(
    agg.events.map((e) => e.index),
    [0, 1, 2],
  );
});

test("aggregateLogLines classifies a nemesis verdict line + picks the worst verdict", () => {
  const agg = aggregateLogLines([
    "nemesis verdict: allow",
    "gate result: warn",
    "nemesis verdict: BLOCK on owner/repo",
  ]);
  const verdictEvents = agg.events.filter((e) => e.verdict);
  assert.ok(verdictEvents.length >= 1);
  // worst across all lines is block.
  assert.equal(agg.worstVerdict, "block");
});

test("aggregateLogLines parses a JSON-lines progress object into fields", () => {
  const agg = aggregateLogLines(['{"phase":"install","message":"copying files","pct":42}']);
  assert.equal(agg.total, 1);
  const ev = agg.events[0];
  assert.ok(ev);
  assert.equal(ev.phase, "install");
  assert.equal(ev.message, "copying files");
  assert.equal(ev.fields?.pct, 42);
});

test("aggregateLogLines defaults unrecognised lines to info", () => {
  const agg = aggregateLogLines(["just some chatter"]);
  assert.equal(agg.events[0]?.phase, "info");
  assert.equal(agg.worstVerdict, undefined);
});

test("aggregateLogLines counts an error line", () => {
  const agg = aggregateLogLines(["error: boom"]);
  assert.equal(agg.errors, 1);
  assert.equal(agg.events[0]?.phase, "error");
});

/* ── TASK 2: file search / index ──────────────────────────────────────────── */

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "prom-search-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "node_modules", "dep"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\nconst NEEDLE = true;\n");
  writeFileSync(join(root, "src", "b.js"), "console.log('b');\n");
  // README intentionally has the word ONLY in lowercase ("needle") so the
  // case-sensitive grep distinguishes it from src/a.ts's uppercase NEEDLE.
  writeFileSync(join(root, "README.md"), "# title\nlowercase needle here\n");
  writeFileSync(join(root, "node_modules", "dep", "ignored.ts"), "NEEDLE in ignored\n");
  return root;
}

test("searchFiles filters by extension and ignores node_modules", () => {
  const root = makeTree();
  try {
    const res = searchFiles({ root, extensions: ["ts"] });
    const rels = res.matches.map((m) => m.rel);
    assert.deepEqual(rels, ["src/a.ts"]); // node_modules/dep/ignored.ts excluded
    assert.equal(res.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchFiles grep finds content matches with a 1-based line number", () => {
  const root = makeTree();
  try {
    // case-sensitive so only src/a.ts's uppercase NEEDLE matches (README is lc).
    const res = searchFiles({ root, grep: "NEEDLE", caseSensitive: true });
    const hit = res.matches.find((m) => m.rel === "src/a.ts");
    assert.ok(hit, "a.ts should match the grep");
    assert.equal(hit?.matchLine, 2);
    // README only has lowercase "needle" → not a case-sensitive match.
    assert.ok(!res.matches.some((m) => m.rel === "README.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchFiles caseSensitive grep respects case", () => {
  const root = makeTree();
  try {
    const insensitive = searchFiles({ root, grep: "needle" });
    assert.ok(insensitive.matches.some((m) => m.rel === "src/a.ts"));
    const sensitive = searchFiles({ root, grep: "needle", caseSensitive: true });
    // lowercase "needle" only appears in README, not src/a.ts (NEEDLE).
    assert.ok(!sensitive.matches.some((m) => m.rel === "src/a.ts"));
    assert.ok(sensitive.matches.some((m) => m.rel === "README.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchFiles honours maxResults and sets truncated", () => {
  const root = makeTree();
  try {
    const res = searchFiles({ root, maxResults: 1 });
    assert.equal(res.matches.length, 1);
    assert.equal(res.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchFiles on a missing root returns an empty, non-thrown result", () => {
  const res = searchFiles({ root: "/no/such/dir/exists/prom" });
  assert.deepEqual(res.matches, []);
  assert.equal(res.scanned, 0);
});

/* ── APP-024: glob matching + include/exclude scope ───────────────────────── */

test("matchesGlob: * stays within one segment, ** crosses, ? is one char", () => {
  assert.equal(matchesGlob("src/*.ts", "src/a.ts"), true);
  assert.equal(matchesGlob("src/*.ts", "src/sub/a.ts"), false); // * must NOT match '/'
  assert.equal(matchesGlob("src/**/*.ts", "src/sub/deep/a.ts"), true);
  assert.equal(matchesGlob("src/**/*.ts", "src/a.ts"), true); // ** matches zero segments
  assert.equal(matchesGlob("a?.ts", "ab.ts"), true);
  assert.equal(matchesGlob("a?b.ts", "a/b.ts"), false); // '?' never matches '/'
  assert.equal(matchesGlob("src/**", "src/sub/deep/a.ts"), true);
});

test("matchesGlob: {a,b} alternation and any-depth basename patterns", () => {
  assert.equal(matchesGlob("*.{ts,tsx}", "a.tsx"), true);
  assert.equal(matchesGlob("*.{ts,tsx}", "a.js"), false);
  // a no-slash pattern matches at any depth (basename semantics).
  assert.equal(matchesGlob("*.md", "docs/deep/x.md"), true);
  assert.equal(matchesGlob("*.{a,b}", "dir/f.b"), true);
  // regex metachars in the pattern stay literal.
  assert.equal(matchesGlob("a.ts", "axts"), false);
});

test("searchFiles include keeps only matching files; exclude skips before reading", () => {
  const root = makeTree();
  try {
    const inc = searchFiles({ root, include: ["src/**"] });
    assert.deepEqual(
      inc.matches.map((m) => m.rel),
      ["src/a.ts", "src/b.js"],
    );
    const exc = searchFiles({ root, exclude: ["src/**", "*.md"] });
    assert.deepEqual(
      exc.matches.map((m) => m.rel),
      [],
    );
    // exclude also prunes a grep (the excluded file is never opened → no match).
    const grep = searchFiles({ root, grep: "NEEDLE", caseSensitive: true, exclude: ["src/**"] });
    assert.ok(!grep.matches.some((m) => m.rel === "src/a.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ── dispatch + guard ─────────────────────────────────────────────────────── */

test("runTask dispatches log.aggregate", () => {
  const res = runTask({
    id: "x1",
    kind: "log.aggregate",
    payload: { lines: ["installing foo"] },
  });
  assert.equal(res.ok, true);
  assert.equal(res.id, "x1");
  if (res.ok && res.kind === "log.aggregate") {
    assert.equal(res.result.total, 1);
  }
});

test("runTask dispatches file.search", () => {
  const root = makeTree();
  try {
    const res = runTask({
      id: "x2",
      kind: "file.search",
      payload: { root, extensions: ["md"] },
    });
    assert.equal(res.ok, true);
    if (res.ok && res.kind === "file.search") {
      assert.deepEqual(
        res.result.matches.map((m) => m.rel),
        ["README.md"],
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isTaskRequest rejects malformed messages", () => {
  assert.equal(isTaskRequest(null), false);
  assert.equal(isTaskRequest({ kind: "log.aggregate" }), false); // no id
  assert.equal(isTaskRequest({ id: "a", kind: "file.search", payload: {} }), false); // no root
  assert.equal(isTaskRequest({ id: "a", kind: "bogus", payload: {} }), false);
  const good: TaskRequest = { id: "a", kind: "log.aggregate", payload: { lines: [] } };
  assert.equal(isTaskRequest(good), true);
  // APP-066: file.index is a valid task; cancel/progress messages are distinct shapes.
  assert.equal(isTaskRequest({ id: "a", kind: "file.index", payload: { root: "/r" } }), true);
  assert.equal(isCancelMessage({ cancel: "a" }), true);
  assert.equal(isCancelMessage({ id: "a" }), false);
  assert.equal(isTaskProgress({ id: "a", kind: "file.search", progress: { scanned: 5 } }), true);
  assert.equal(isTaskProgress({ id: "a", kind: "file.search", ok: true }), false);
});

test("indexFiles returns a flat sorted file list (worker index walk, APP-066)", () => {
  const root = mkdtempSync(join(tmpdir(), "prom-index-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "z.ts"), "export const z = 1;\n");
    writeFileSync(join(root, "node_modules", "dep.js"), "module.exports = {}");
    const res = indexFiles({ root });
    const rel = res.files.map((p) => p.slice(root.length + 1));
    assert.ok(rel.includes("z.ts") && rel.includes(join("src", "a.ts")));
    assert.equal(
      rel.some((f) => f.includes("node_modules")),
      false,
      "index prunes node_modules like search",
    );
    // dispatch via runTask → the offloaded protocol returns a file.index response.
    const viaTask = runTask({ id: "i1", kind: "file.index", payload: { root } });
    assert.equal(viaTask.ok, true);
    assert.equal(viaTask.kind, "file.index");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searchFiles fires the onProgress hook with the final scanned count (APP-066)", () => {
  const root = mkdtempSync(join(tmpdir(), "prom-prog-"));
  try {
    writeFileSync(join(root, "a.ts"), "x");
    writeFileSync(join(root, "b.ts"), "y");
    const ticks: number[] = [];
    const res = searchFiles({ root }, { onProgress: (n) => ticks.push(n) });
    assert.ok(ticks.length >= 1, "progress emitted");
    assert.equal(ticks[ticks.length - 1], res.scanned); // final tick == total scanned
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
