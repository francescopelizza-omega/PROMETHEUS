/**
 * working-set.test.ts — the /add-dir working set + its fail-closed scope guard (CLI-004).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";

import {
  createWorkingSet,
  expandHome,
  isPathAllowed,
  pathArgsOf,
  resolveDir,
} from "./working-set.js";

const TMP = realpathSync.native(mkdtempSync(join(tmpdir(), "prom-wsu-")));

test("expandHome: only a leading ~ / ~/ expands", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("~/x"), join(homedir(), "x"));
  assert.equal(expandHome("~otheruser/x"), "~otheruser/x"); // untouched
  assert.equal(expandHome("/abs/x"), "/abs/x");
});

test("resolveDir: valid dir ok; missing/non-dir error", () => {
  const dir = join(TMP, "sub");
  mkdirSync(dir);
  const ok = resolveDir(dir, TMP);
  assert.equal(ok.ok, true);
  assert.ok(ok.resolved?.endsWith("sub"));

  assert.equal(resolveDir(join(TMP, "nope"), TMP).ok, false);

  const file = join(TMP, "afile");
  writeFileSync(file, "x");
  const notDir = resolveDir(file, TMP);
  assert.equal(notDir.ok, false);
  assert.match(notDir.error ?? "", /not a directory/);

  // relative arg resolves against cwd
  assert.equal(resolveDir("sub", TMP).ok, true);
});

test("createWorkingSet: dedups by resolved path, keeps order, removes", () => {
  const a = join(TMP, "a");
  const b = join(TMP, "b");
  mkdirSync(a);
  mkdirSync(b);
  const ws = createWorkingSet();
  assert.equal(ws.add(a, TMP).ok, true);
  assert.equal(ws.add(`${a}${sep}`, TMP).ok, true); // trailing sep = same dir → dedup
  assert.equal(ws.add(b, TMP).ok, true);
  assert.equal(ws.list().length, 2, "duplicate collapses");
  assert.equal(ws.remove(a, TMP), true);
  assert.equal(ws.remove(a, TMP), false); // already gone
  assert.equal(ws.list().length, 1);
});

test("isPathAllowed: fail-closed, sep-boundary, symlink-resolved", () => {
  const root = join(TMP, "root");
  const inside = join(root, "deep", "file.txt");
  mkdirSync(join(root, "deep"), { recursive: true });
  writeFileSync(inside, "x");
  // sibling that shares the root's name prefix must NOT match
  const sibling = join(TMP, "root-evil");
  mkdirSync(sibling);

  assert.equal(isPathAllowed(inside, [root]), true);
  assert.equal(isPathAllowed(root, [root]), true); // the root itself
  assert.equal(isPathAllowed(join(sibling, "x"), [root]), false); // sibling prefix trap
  assert.equal(isPathAllowed(inside, []), false); // no roots ⇒ deny
  assert.equal(isPathAllowed("/totally/other", [root]), false);
  // a `..` escape is resolved away before the compare
  assert.equal(isPathAllowed(join(root, "..", "root-evil", "x"), [root]), false);
});

test("pathArgsOf: collects path-flavored keys only", () => {
  assert.deepEqual(pathArgsOf({ path: "/a", name: "pkg" }), ["/a"]);
  assert.deepEqual(pathArgsOf({ file: "/f", dir: "/d" }).sort(), ["/d", "/f"]);
  assert.deepEqual(pathArgsOf({ paths: ["/x", "/y"] }), ["/x", "/y"]);
  assert.deepEqual(pathArgsOf({ name: "pkg", only: "hooks" }), []); // no path args
});
