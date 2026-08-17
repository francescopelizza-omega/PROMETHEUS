/**
 * memory-store.test.ts — the durable-memory host half: project-key derivation, discovery
 * (repo-root walk), and the `memory_write`/`memory_read` dispatch, on real temp directories.
 *
 * The "precedence chain" a project-scoped store like this needs is really a DISCOVERY
 * question: given a `cwd` somewhere inside a repo, does every call land in the SAME memory
 * directory regardless of which subdirectory the session happens to be in? That is what the
 * repo-root walk + stable project-key tests below pin down; `rules/loader.ts`'s literal
 * precedence-chain concept doesn't apply here (there is exactly one memory dir per project).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadMemoryIndexBlock,
  memoryDir,
  memoryProjectRoot,
  projectKey,
  readMemoryEntry,
  runMemoryTool,
  writeMemoryEntry,
} from "./memory-store.js";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "prom-mem-"));
  mkdirSync(join(dir, ".git")); // mark it as a repo root
  return dir;
}

const goodArgs = {
  name: "deploy order",
  description: "staging must migrate before the API deploys",
  category: "infra",
  why: "the pipeline silently reorders these otherwise and it has caused an outage before",
  body: "run migrate, then deploy — never the reverse.",
};

/* ── project-key / repo-root discovery ───────────────────────────────────────*/

test("memoryProjectRoot walks UP from a subdirectory to the nearest .git", () => {
  const root = repo();
  const sub = join(root, "packages", "core", "src");
  mkdirSync(sub, { recursive: true });
  assert.equal(memoryProjectRoot(sub), root);
  assert.equal(memoryProjectRoot(root), root);
});

test("memoryProjectRoot falls back to cwd itself when no .git is found", () => {
  const dir = mkdtempSync(join(tmpdir(), "prom-mem-norepo-"));
  assert.equal(memoryProjectRoot(dir), dir);
});

test("projectKey is a stable 16-hex-char digest, same input ⇒ same key", () => {
  const root = repo();
  const k1 = projectKey(root);
  const k2 = projectKey(root);
  assert.equal(k1, k2);
  assert.match(k1, /^[0-9a-f]{16}$/);
  assert.notEqual(k1, projectKey(repo())); // a different repo ⇒ a different key
});

test("memoryDir is the SAME directory for a cwd in ANY subdirectory of the repo", () => {
  const root = repo();
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const sub = join(root, "apps", "cli", "src");
  mkdirSync(sub, { recursive: true });
  assert.equal(memoryDir(home, root), memoryDir(home, sub));
});

/* ── memory_write validation + create-or-update semantics ───────────────────*/

test("memory_write refuses an invalid call and writes nothing to disk", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const root = repo();
  const out = writeMemoryEntry(home, root, { ...goodArgs, why: "" });
  assert.equal(out.ok, false);
  assert.match(out.summary, /"why" is required/);
  assert.equal(
    existsSync(memoryDir(home, root)),
    false,
    "an invalid write must not create the dir",
  );
});

test("memory_write creates <slug>.md + regenerates index.md, and reports why it was kept", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const root = repo();
  const out = writeMemoryEntry(home, root, goodArgs);
  assert.equal(out.ok, true);
  assert.match(out.summary, /deploy order/);
  assert.match(out.summary, /outage before/); // the `why` is echoed back, not silently dropped
  const dir = memoryDir(home, root);
  assert.equal(existsSync(join(dir, "deploy-order.md")), true);
  const index = readFileSync(join(dir, "index.md"), "utf8");
  assert.match(index, /staging must migrate before the API deploys/);
});

test("writing again under the SAME name overwrites the topic — no dated duplicate", () => {
  // The whole "organized by topic, not a log" discipline: this is what enforces it.
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const root = repo();
  writeMemoryEntry(home, root, goodArgs);
  writeMemoryEntry(home, root, { ...goodArgs, body: "UPDATED: migrate, wait 5m, then deploy." });
  const dir = memoryDir(home, root);
  const body = readFileSync(join(dir, "deploy-order.md"), "utf8");
  assert.match(body, /UPDATED: migrate, wait 5m/);
  assert.doesNotMatch(body, /never the reverse\./); // the old body is GONE, not appended
  const index = readFileSync(join(dir, "index.md"), "utf8");
  // only one entry in the index, even though memory_write ran twice
  assert.equal(index.match(/\(deploy-order\)/g)?.length, 1);
});

/* ── memory_read ──────────────────────────────────────────────────────────────*/

test("memory_read with no topic, before anything is written, refuses honestly", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const root = repo();
  const out = readMemoryEntry(home, root, "");
  assert.equal(out.ok, true); // the tool still answers — an empty index is a valid answer
  assert.equal(out.data?.count, 0);
  assert.match(out.summary, /no durable facts recorded yet/);
});

test("memory_read with no topic, after a write, lists it (and only a summary)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const root = repo();
  writeMemoryEntry(home, root, goodArgs);
  const out = readMemoryEntry(home, root, "");
  assert.equal(out.data?.count, 1);
  assert.match(out.summary, /staging must migrate before the API deploys/);
  assert.doesNotMatch(out.summary, /run migrate, then deploy/); // the BODY is not in the index
});

test("memory_read with a topic returns the FULL body of that one entry", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const root = repo();
  writeMemoryEntry(home, root, goodArgs);
  const byName = readMemoryEntry(home, root, "deploy order");
  const bySlug = readMemoryEntry(home, root, "deploy-order");
  for (const out of [byName, bySlug]) {
    assert.equal(out.ok, true);
    assert.match(out.summary, /run migrate, then deploy — never the reverse\./);
  }
});

test("memory_read with an unknown topic refuses and points back at the index", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const root = repo();
  writeMemoryEntry(home, root, goodArgs);
  const out = readMemoryEntry(home, root, "nonexistent topic");
  assert.equal(out.ok, false);
  assert.match(out.summary, /no topic matching/);
});

/* ── the auto-load path (session-start injection) ────────────────────────────*/

test("loadMemoryIndexBlock is null when the project has never had an entry written", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const root = repo();
  assert.equal(loadMemoryIndexBlock(home, root), null);
});

test("loadMemoryIndexBlock returns the index text once something has been written", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const root = repo();
  writeMemoryEntry(home, root, goodArgs);
  const block = loadMemoryIndexBlock(home, root);
  assert.match(block ?? "", /staging must migrate before the API deploys/);
});

/* ── runMemoryTool: the name-based dispatcher ────────────────────────────────*/

test("runMemoryTool dispatches memory_write/memory_read by name, null for anything else", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-mem-home-"));
  const root = repo();
  assert.equal(runMemoryTool("read_file", {}, { cwd: root, home }), null);
  const w = runMemoryTool("memory_write", goodArgs, { cwd: root, home });
  assert.equal(w?.ok, true);
  const r = runMemoryTool("memory_read", { topic: "deploy order" }, { cwd: root, home });
  assert.match(r?.summary ?? "", /run migrate, then deploy/);
});
