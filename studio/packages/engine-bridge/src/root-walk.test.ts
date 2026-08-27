/**
 * root-walk.test.ts — finding the PROMETHEUS root from wherever this module ended up.
 *
 * The resolvers used to walk a FIXED number of levels up from `import.meta.url`, a distance that
 * is correct for exactly one layout: `…/studio/packages/engine-bridge/{src,dist}`. But this
 * module is BUNDLED. In the Electron build it is inlined into
 * `studio/apps/desktop/out/main/index.js`, where the fixed walk landed on `…/studio` — which
 * holds no `prometheus.py` — so every engine-backed surface in the desktop app (Agents, Catalog,
 * Skills, Vault, Spectacular, Doctor, every nemesis gate) and every sidecar-backed one (tests,
 * repo map, linters, structural search, coverage, profiler, modelhub, metadata) resolved to
 * paths that do not exist.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { ENGINE_MARKER, findRootFrom } from "./config.js";
import { resolveSidecarDir } from "./sidecar-runner.js";

/** A miniature PROMETHEUS checkout with the real directory shapes. */
function fixture(): { root: string; bundle: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "prom-root-"));
  writeFileSync(join(root, ENGINE_MARKER), "# engine\n");
  writeFileSync(join(root, "nemesis"), "#!/bin/sh\n");
  const bundle = join(root, "studio", "apps", "desktop", "out", "main");
  const source = join(root, "studio", "packages", "engine-bridge", "src");
  mkdirSync(bundle, { recursive: true });
  mkdirSync(source, { recursive: true });
  mkdirSync(join(root, "studio", "python", "sidecar"), { recursive: true });
  return { root, bundle, source };
}

test("the root is found from the ELECTRON BUNDLE's location, not just the source tree", () => {
  const { root, bundle, source } = fixture();

  // the layout the old fixed walk was written for still works…
  assert.equal(findRootFrom(source), root);

  // …and so does the one it silently failed on. This is the regression.
  assert.equal(findRootFrom(bundle), root);

  // self-validating: prove the OLD fixed-distance walk really would have missed it, so this
  // test cannot pass for the wrong reason if `fixture()` is ever reshaped.
  const oldGuess = resolve(bundle, "..", "..", "..", "..");
  assert.notEqual(oldGuess, root, "fixture no longer reproduces the bundle depth");
  assert.equal(
    existsSync(join(oldGuess, ENGINE_MARKER)),
    false,
    "the old walk would have found the engine — fixture is wrong",
  );
});

test("a directory under no checkout at all resolves to nothing rather than a wrong guess", () => {
  const orphan = mkdtempSync(join(tmpdir(), "prom-orphan-"));
  assert.equal(findRootFrom(orphan), undefined);
});

test("the walk stops at the filesystem root instead of looping", () => {
  // `/` has no prometheus.py; the walk must terminate and say so.
  assert.equal(findRootFrom("/"), undefined);
});

test("the sidecar directory resolves to one that EXISTS in this checkout", () => {
  /**
   * The old walk produced `studio/apps/python/sidecar` from the Electron bundle — a path that has
   * never existed — and returned it anyway, so the failure surfaced as "sidecar not found" in
   * eight different tool windows rather than as a path bug.
   */
  const dir = resolveSidecarDir();
  assert.equal(existsSync(dir), true, `sidecar dir does not exist: ${dir}`);
  assert.match(dir, /studio[/\\]python[/\\]sidecar$/);

  // an explicit override still wins outright
  assert.equal(resolveSidecarDir("/custom/sidecar"), "/custom/sidecar");
});
