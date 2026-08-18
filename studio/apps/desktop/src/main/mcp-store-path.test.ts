/**
 * mcp-store-path.test.ts — one connector file, not two.
 *
 * The CLI wrote `$PROMETHEUS_HOME/config/mcp-servers.json`; the desktop wrote
 * `<userData>/mcp-servers.json`. Same format, same product, two files — so a connector added
 * with `prometheus mcp add` was invisible in Studio's Extensions panel and vice versa, with
 * both sides reporting success and listing a different set.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { legacyMcpStorePath, migrateMcpStore, sharedMcpStorePath } from "./mcp-store-path.js";

/** Point `prometheusHome()` at a temp dir for the duration of `fn`. */
function withHome<T>(fn: (home: string, userData: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "prom-home-"));
  const userData = mkdtempSync(join(tmpdir(), "prom-ud-"));
  const prev = process.env.PROMETHEUS_HOME;
  process.env.PROMETHEUS_HOME = home;
  try {
    return fn(home, userData);
  } finally {
    // `delete`, not `= undefined`: node coerces an assigned undefined to the STRING
    // "undefined", so the suggested fix would leave PROMETHEUS_HOME set to a bogus path.
    // biome-ignore lint/performance/noDelete: restoring ABSENCE, which assignment cannot do
    if (prev === undefined) delete process.env.PROMETHEUS_HOME;
    else process.env.PROMETHEUS_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

test("the shared path is the CLI's, under PROMETHEUS_HOME — not Electron's userData", () => {
  withHome((home) => {
    assert.equal(sharedMcpStorePath(), join(home, "config", "mcp-servers.json"));
  });
});

test("desktop-only connectors are ADOPTED into the shared file", () => {
  withHome((_home, userData) => {
    writeJson(legacyMcpStorePath(userData), {
      fs: { id: "fs", label: "files" },
      git: { id: "git", label: "git" },
    });
    assert.equal(migrateMcpStore(userData), 2);
    const shared = JSON.parse(readFileSync(sharedMcpStorePath(), "utf8"));
    assert.deepEqual(Object.keys(shared).sort(), ["fs", "git"]);
  });
});

test("an id present in BOTH keeps the SHARED entry — a stale desktop copy never wins", () => {
  withHome((_home, userData) => {
    writeJson(sharedMcpStorePath(), { fs: { id: "fs", label: "the current one" } });
    writeJson(legacyMcpStorePath(userData), {
      fs: { id: "fs", label: "a stale copy" },
      git: { id: "git", label: "git" },
    });
    assert.equal(migrateMcpStore(userData), 1, "only the genuinely new entry is adopted");
    const shared = JSON.parse(readFileSync(sharedMcpStorePath(), "utf8"));
    assert.equal(shared.fs.label, "the current one");
    assert.equal(shared.git.label, "git");
  });
});

test("migration is idempotent — a second boot adopts nothing", () => {
  withHome((_home, userData) => {
    writeJson(legacyMcpStorePath(userData), { fs: { id: "fs" } });
    assert.equal(migrateMcpStore(userData), 1);
    assert.equal(migrateMcpStore(userData), 0);
    assert.equal(migrateMcpStore(userData), 0);
  });
});

test("the OLD file is left on disk — it is the only copy of the pre-migration state", () => {
  withHome((_home, userData) => {
    writeJson(legacyMcpStorePath(userData), { fs: { id: "fs" } });
    migrateMcpStore(userData);
    assert.equal(existsSync(legacyMcpStorePath(userData)), true);
  });
});

test("no old file, an empty one, or a corrupt one: nothing happens and nothing throws", () => {
  withHome((_home, userData) => {
    assert.equal(migrateMcpStore(userData), 0, "absent");
    writeJson(legacyMcpStorePath(userData), {});
    assert.equal(migrateMcpStore(userData), 0, "empty");
    writeFileSync(legacyMcpStorePath(userData), "{ not json", "utf8");
    assert.equal(migrateMcpStore(userData), 0, "corrupt");
    writeFileSync(legacyMcpStorePath(userData), "[1,2,3]", "utf8");
    assert.equal(migrateMcpStore(userData), 0, "an array is not a store");
  });
});
