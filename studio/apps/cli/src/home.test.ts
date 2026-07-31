/**
 * home.test.ts — the ~/.prometheus tree + per-category path store + settings, all
 * against a TEMP home (never touches the real $HOME). Disk info is asserted loosely.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HOME_TREE,
  diskInfo,
  ensureHomeTree,
  firstRunDone,
  loadPaths,
  loadSettings,
  markFirstRunDone,
  prometheusHome,
  resolveCategory,
  saveSettings,
  setCategory,
} from "./home.js";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "prom-home-test-"));
}

test("prometheusHome honors $PROMETHEUS_HOME, else ~/.prometheus", () => {
  const prev = process.env.PROMETHEUS_HOME;
  try {
    process.env.PROMETHEUS_HOME = "/tmp/custom-prom";
    assert.equal(prometheusHome(), "/tmp/custom-prom");
    // a leading ~ in the override is expanded to $HOME (path.resolve does not do this)
    process.env.PROMETHEUS_HOME = "~/customprom";
    assert.equal(prometheusHome(), join(homedir(), "customprom"));
    process.env.PROMETHEUS_HOME = "";
    assert.match(prometheusHome(), /\.prometheus$/); // falls back to ~/.prometheus
  } finally {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: restore env precisely
      delete process.env.PROMETHEUS_HOME;
    } else process.env.PROMETHEUS_HOME = prev;
  }
});

test("ensureHomeTree creates the full subdir tree (idempotent)", () => {
  const home = tmpHome();
  const { created } = ensureHomeTree(home);
  for (const sub of HOME_TREE) assert.ok(existsSync(join(home, sub)), `missing ${sub}`);
  assert.equal(created.length, HOME_TREE.length); // all new on first run
  assert.deepEqual(ensureHomeTree(home).created, []); // second run creates nothing
});

test("resolveCategory: default under home, then an override after setCategory", () => {
  const home = tmpHome();
  ensureHomeTree(home);
  assert.equal(resolveCategory("open_models", home), join(home, "open_models"));
  assert.equal(resolveCategory("videos", home), join(home, "downloads/videos"));

  const custom = join(tmpHome(), "big-disk", "models");
  const abs = setCategory("open_models", custom, home);
  assert.equal(abs, custom);
  assert.equal(resolveCategory("open_models", home), custom); // override wins
  assert.equal(loadPaths(home).open_models, custom); // persisted
  assert.ok(existsSync(custom)); // dir created
});

test("settings: save/load + first-run marker", () => {
  const home = tmpHome();
  assert.equal(firstRunDone(home), false);
  saveSettings({ foo: "bar" }, home);
  assert.equal(loadSettings(home).foo, "bar");
  markFirstRunDone("local", home);
  assert.equal(firstRunDone(home), true);
  assert.equal(loadSettings(home).preferredBackend, "local");
  assert.equal(loadSettings(home).foo, "bar"); // merge preserved the earlier key
});

test("loadPaths / loadSettings are fail-soft on a missing/garbage file (→ {})", () => {
  const home = join(tmpdir(), "prom-does-not-exist-xyz");
  assert.deepEqual(loadPaths(home), {});
  assert.deepEqual(loadSettings(home), {});
});

test("diskInfo returns positive free/total for a real path (or null)", () => {
  const di = diskInfo(tmpdir());
  if (di !== null) {
    assert.ok(di.freeBytes > 0);
    assert.ok(di.totalBytes >= di.freeBytes);
  }
});
