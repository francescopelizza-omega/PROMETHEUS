/**
 * cwd-guard.test.ts — Prometheus can never operate with a cwd inside its OWN source repo.
 *
 * Exercises the REAL discovery mechanism end-to-end (not a fake fs) — this test file itself
 * runs from inside the real prometheus-studio checkout, so `ownRepoRoot()` genuinely finds it,
 * exactly as it would for a real user running the CLI from a clone of this repo. The pure
 * matching logic itself (findOwnWorkspaceRoot/isInsideRepo/guardCwd) already has its own
 * fake-fs unit tests in core's own-repo-guard.test.ts; this file is the integration proof that
 * this app's real wiring finds the real repo.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  guardOwnRepo,
  ownRepoRoot,
  resetCwdNoticeCache,
  resetOwnRepoRootCache,
  resolveCwd,
} from "./cwd-guard.js";

test("ownRepoRoot(): resolves to the real prometheus-studio checkout when running from inside it", () => {
  const root = ownRepoRoot();
  assert.ok(root, "expected to find the real repo root while running inside it");
});

test("guardOwnRepo(): a path inside this real repo IS redirected to the real home directory", () => {
  const root = ownRepoRoot();
  assert.ok(root);
  const target = join(root as string, "apps", "cli", "src");
  const result = guardOwnRepo(target);
  assert.equal(result.redirected, true);
  assert.equal(result.cwd, homedir());
  assert.equal(result.requestedCwd, target);
});

test("guardOwnRepo(): the repo root itself is redirected too, not just a nested subdirectory", () => {
  const root = ownRepoRoot();
  assert.ok(root);
  assert.equal(guardOwnRepo(root as string).redirected, true);
});

test("guardOwnRepo(): an unrelated path is never redirected", () => {
  const result = guardOwnRepo("/tmp/some-other-project");
  assert.equal(result.redirected, false);
  assert.equal(result.cwd, "/tmp/some-other-project");
});

test("resolveCwd(): defaults to process.cwd() when no explicit request is given, going through the SAME guard", () => {
  // The test runner invokes from the repo root, so process.cwd() is genuinely inside it — this
  // proves the fallback path is guarded exactly like an explicit request, not a separate one
  // that forgot to be.
  const notes: string[] = [];
  const cwd = resolveCwd(undefined, (l) => notes.push(l));
  assert.equal(cwd, homedir());
  assert.ok(
    notes.some((n) => n.includes("redirected")),
    `expected a redirect notice, got: ${JSON.stringify(notes)}`,
  );
});

test("resolveCwd(): an explicit request outside the repo passes through untouched, no notice printed", () => {
  const notes: string[] = [];
  const cwd = resolveCwd("/tmp/some-other-project", (l) => notes.push(l));
  assert.equal(cwd, "/tmp/some-other-project");
  assert.deepEqual(notes, []);
});

test("resolveCwd(): still redirects correctly with no `write` callback at all", () => {
  const root = ownRepoRoot();
  assert.ok(root);
  const cwd = resolveCwd(root as string); // no write() passed — must not throw, must still redirect
  assert.equal(cwd, homedir());
});

test("the redirect notice is printed ONCE per process, not once per resolveCwd call", () => {
  /**
   * A single `prometheus` run resolves the cwd twice whenever the modern TUI cannot start: the
   * TUI bridge resolves it (session-bridge.ts:430), throws afterwards, and the readline host
   * resolves it again (host.ts:593). The user saw the same "refuses to operate inside its own
   * repository" warning twice, in consecutive lines — reported verbatim from a real session.
   *
   * The REDIRECT is not deduplicated: both callers must still get the safe path back.
   */
  resetCwdNoticeCache();
  resetOwnRepoRootCache("/repo");
  const lines: string[] = [];
  const w = (l: string): void => void lines.push(l);

  const first = resolveCwd("/repo/apps/cli", w);
  const second = resolveCwd("/repo/apps/cli", w);
  assert.equal(lines.length, 1, `warned ${lines.length} times:\n${lines.join("\n")}`);
  assert.match(lines[0] ?? "", /refuses to operate inside its own repository/);
  assert.equal(second, first, "the second caller must still be redirected");
  assert.notEqual(second, "/repo/apps/cli");

  // a DIFFERENT redirect is its own notice — this dedupes repeats, it does not silence news
  resolveCwd("/repo/packages/core", w);
  assert.equal(lines.length, 2);

  // …and a fresh process starts over
  resetCwdNoticeCache();
  resolveCwd("/repo/apps/cli", w);
  assert.equal(lines.length, 3);

  resetOwnRepoRootCache();
  resetCwdNoticeCache();
});
