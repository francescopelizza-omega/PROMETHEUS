/**
 * own-repo-guard.test.ts — Prometheus can never operate with a cwd inside its own source repo.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  type PackageJsonFs,
  findOwnWorkspaceRoot,
  guardCwd,
  isInsideRepo,
} from "./own-repo-guard.js";

/** A fake package.json tree, keyed by directory → name (undefined = no package.json there). */
function fakeFs(names: Record<string, string>): PackageJsonFs {
  return { packageNameAt: (dir) => names[dir] };
}

const REPO_ROOT = "/Users/alice/dev/prometheus-studio";
const HOME = "/Users/alice";

test("findOwnWorkspaceRoot: finds the ancestor whose package.json is the workspace root", () => {
  const fs = fakeFs({ [REPO_ROOT]: "prometheus-studio-workspace" });
  const startDir = join(REPO_ROOT, "apps", "cli", "dist");
  assert.equal(findOwnWorkspaceRoot(startDir, fs), REPO_ROOT);
});

test("findOwnWorkspaceRoot: an installed/packaged Prometheus (no source checkout) finds nothing", () => {
  const fs = fakeFs({}); // no package.json anywhere carries the marker name
  assert.equal(
    findOwnWorkspaceRoot("/usr/local/lib/node_modules/@prometheus/cli/dist", fs),
    undefined,
  );
});

test("findOwnWorkspaceRoot: an UNRELATED project's package.json never false-positives", () => {
  const fs = fakeFs({ "/Users/alice/dev/my-app": "my-app" });
  assert.equal(findOwnWorkspaceRoot("/Users/alice/dev/my-app/src", fs), undefined);
});

test("isInsideRepo: the root itself, and anything nested under it, are inside", () => {
  assert.ok(isInsideRepo(REPO_ROOT, REPO_ROOT));
  assert.ok(isInsideRepo(join(REPO_ROOT, "apps", "cli"), REPO_ROOT));
});

test("isInsideRepo: a SIBLING directory with the repo root as a string prefix is NOT inside", () => {
  // "prometheus-studio-2" starts with "prometheus-studio" as a raw string, but is a different
  // directory — the check must be prefix-plus-separator, never a bare startsWith.
  assert.equal(isInsideRepo(`${REPO_ROOT}-2`, REPO_ROOT), false);
});

test("isInsideRepo: an unrelated path is not inside", () => {
  assert.equal(isInsideRepo("/Users/alice/dev/my-app", REPO_ROOT), false);
});

test("guardCwd: a target inside the own repo is redirected to home", () => {
  const target = join(REPO_ROOT, "apps", "cli");
  const result = guardCwd(target, REPO_ROOT, HOME);
  assert.deepEqual(result, { cwd: HOME, redirected: true, requestedCwd: target });
});

test("guardCwd: a target OUTSIDE the own repo passes through untouched", () => {
  const target = "/Users/alice/dev/my-app";
  const result = guardCwd(target, REPO_ROOT, HOME);
  assert.deepEqual(result, { cwd: target, redirected: false });
});

test("guardCwd: an undefined ownRepoRoot (no source checkout found) is always a pass-through", () => {
  const target = join(REPO_ROOT, "apps", "cli");
  const result = guardCwd(target, undefined, HOME);
  assert.deepEqual(result, { cwd: target, redirected: false });
});
