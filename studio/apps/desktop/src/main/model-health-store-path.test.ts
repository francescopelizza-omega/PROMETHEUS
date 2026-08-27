/**
 * model-health-store-path.test.ts — one endpoint-health file, not two.
 *
 * Mirrors mcp-store-path.test.ts: the CLI wrote `$PROMETHEUS_HOME/state/model-health.json`;
 * the desktop wrote `<userData>/model-health.json`. Same shape, two files — a breaker the CLI
 * tripped was invisible to the desktop's Settings ▸ Model Health page, and vice versa.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  legacyModelHealthStorePath,
  migrateModelHealthStore,
  sharedModelHealthStorePath,
} from "./model-health-store-path.js";

/** Point `prometheusHome()` at a temp dir for the duration of `fn`. */
function withHome<T>(fn: (home: string, userData: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "prom-home-"));
  const userData = mkdtempSync(join(tmpdir(), "prom-ud-"));
  const prev = process.env.PROMETHEUS_HOME;
  process.env.PROMETHEUS_HOME = home;
  try {
    return fn(home, userData);
  } finally {
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
    assert.equal(sharedModelHealthStorePath(), join(home, "state", "model-health.json"));
  });
});

test("desktop-only endpoint records are ADOPTED into the shared file", () => {
  withHome((_home, userData) => {
    writeJson(legacyModelHealthStorePath(userData), {
      "ep-1": { endpointId: "ep-1", model: "m" },
      "ep-2": { endpointId: "ep-2", model: "m2" },
    });
    assert.equal(migrateModelHealthStore(userData), 2);
    const shared = JSON.parse(readFileSync(sharedModelHealthStorePath(), "utf8"));
    assert.deepEqual(Object.keys(shared).sort(), ["ep-1", "ep-2"]);
  });
});

test("an id present in BOTH keeps the SHARED entry — a stale desktop copy never wins", () => {
  withHome((_home, userData) => {
    writeJson(sharedModelHealthStorePath(), {
      "ep-1": { endpointId: "ep-1", model: "the current one" },
    });
    writeJson(legacyModelHealthStorePath(userData), {
      "ep-1": { endpointId: "ep-1", model: "a stale copy" },
      "ep-2": { endpointId: "ep-2", model: "m2" },
    });
    assert.equal(migrateModelHealthStore(userData), 1, "only the genuinely new entry is adopted");
    const shared = JSON.parse(readFileSync(sharedModelHealthStorePath(), "utf8"));
    assert.equal(shared["ep-1"].model, "the current one");
    assert.equal(shared["ep-2"].model, "m2");
  });
});

test("migration is idempotent — a second boot adopts nothing", () => {
  withHome((_home, userData) => {
    writeJson(legacyModelHealthStorePath(userData), { "ep-1": { endpointId: "ep-1" } });
    assert.equal(migrateModelHealthStore(userData), 1);
    assert.equal(migrateModelHealthStore(userData), 0);
    assert.equal(migrateModelHealthStore(userData), 0);
  });
});
