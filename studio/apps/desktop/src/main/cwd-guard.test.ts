/**
 * cwd-guard.test.ts — Prometheus Studio can never open a workspace inside its OWN source repo.
 *
 * Exercises the REAL discovery mechanism end-to-end (not a fake fs) — this test file itself
 * runs from inside the real prometheus-studio checkout, so `ownRepoRoot()` genuinely finds it.
 * The pure matching logic already has its own fake-fs unit tests in core's own
 * own-repo-guard.test.ts; this file is the integration proof that this app's real wiring works.
 */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { guardOwnRepo, ownRepoRoot } from "./cwd-guard.js";

test("ownRepoRoot(): resolves to the real prometheus-studio checkout when running from inside it", () => {
  assert.ok(ownRepoRoot(), "expected to find the real repo root while running inside it");
});

test("guardOwnRepo(): a folder inside this real repo IS redirected to the real home directory", () => {
  const root = ownRepoRoot();
  assert.ok(root);
  const target = join(root as string, "apps", "desktop");
  const result = guardOwnRepo(target);
  assert.equal(result.redirected, true);
  assert.equal(result.cwd, homedir());
  assert.equal(result.requestedCwd, target);
});

test("guardOwnRepo(): an unrelated folder is never redirected", () => {
  const result = guardOwnRepo("/tmp/some-other-project");
  assert.equal(result.redirected, false);
  assert.equal(result.cwd, "/tmp/some-other-project");
});
