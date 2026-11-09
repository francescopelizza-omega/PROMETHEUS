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
  modelStoresHere,
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
  assert.equal(resolveCategory("videos", home), join(home, "downloads/videos"));

  const custom = join(tmpHome(), "big-disk", "videos");
  const abs = setCategory("videos", custom, home);
  assert.equal(abs, custom);
  assert.equal(resolveCategory("videos", home), custom); // override wins
  assert.equal(loadPaths(home).videos, custom); // persisted
  assert.ok(existsSync(custom)); // dir created
});

test("no model folder of Prometheus's own: models live in each runtime's store", () => {
  // `open_models/` (and an unused cache/hf) used to be created here and exported as
  // PROMETHEUS_MODELS_DIR — it only ever collected duplicates of the runtimes' own copies
  assert.ok(!HOME_TREE.includes("open_models"));
  assert.ok(!HOME_TREE.includes("cache/hf"));
  const home = tmpHome();
  const stores = modelStoresHere({}, home);
  const dirs = Object.fromEntries(stores.map((s) => [s.id, s.dir]));
  assert.equal(dirs.ollama, join(home, ".ollama", "models"));
  assert.equal(dirs.lmstudio, join(home, ".lmstudio", "models"));
  assert.equal(dirs.hf, join(home, ".cache", "huggingface", "hub"));
  assert.ok(stores.every((s) => !s.dir.includes(".prometheus")));
  // the user's own choices are honoured, never overridden
  const moved = modelStoresHere({ OLLAMA_MODELS: "/big/ollama", HF_HOME: "/big/hf" }, home);
  assert.equal(moved.find((s) => s.id === "ollama")?.dir, "/big/ollama");
  assert.equal(moved.find((s) => s.id === "hf")?.dir, join("/big/hf", "hub"));
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

test("saveSettings never destroys an unparseable settings.json — it keeps it aside", async () => {
  const {
    mkdtempSync,
    readdirSync,
    readFileSync: rf,
    rmSync,
    writeFileSync: wf,
    mkdirSync: md,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const { saveSettings, loadSettings } = await import("./home.js");
  const home = mkdtempSync(j(tmpdir(), "prom-cli-settings-"));
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    md(j(home, "config"), { recursive: true });
    const broken = '{ "hooks": { "PreToolUse": [] }, }';
    wf(j(home, "config", "settings.json"), broken);
    saveSettings({ timeoutSeconds: 30 }, home);
    const kept = readdirSync(j(home, "config")).find((f) => f.startsWith("settings.json.corrupt-"));
    assert.ok(kept, "the user's unreadable file was kept");
    assert.equal(rf(j(home, "config", kept as string), "utf8"), broken);
    assert.deepEqual(loadSettings(home), { timeoutSeconds: 30 });
  } finally {
    process.stderr.write = errWrite;
    rmSync(home, { recursive: true, force: true });
  }
});
