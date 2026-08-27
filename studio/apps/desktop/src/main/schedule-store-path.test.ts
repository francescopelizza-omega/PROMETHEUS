/**
 * schedule-store-path.test.ts — one scheduled-task file, not two.
 *
 * Mirrors mcp-store-path.test.ts: the CLI's schedule-runner.ts (the ONLY code that ever
 * executes a due task) reads `$PROMETHEUS_HOME/state/schedules.json`; the desktop wrote
 * `<userData>/schedules.json` — a task created entirely through the GUI could never run.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  legacyScheduleStorePath,
  migrateScheduleStore,
  sharedScheduleStorePath,
} from "./schedule-store-path.js";

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
    assert.equal(sharedScheduleStorePath(), join(home, "state", "schedules.json"));
  });
});

test("desktop-only tasks are ADOPTED into the shared file the CLI runner reads", () => {
  withHome((_home, userData) => {
    writeJson(legacyScheduleStorePath(userData), {
      t1: { id: "t1", name: "one" },
      t2: { id: "t2", name: "two" },
    });
    assert.equal(migrateScheduleStore(userData), 2);
    const shared = JSON.parse(readFileSync(sharedScheduleStorePath(), "utf8"));
    assert.deepEqual(Object.keys(shared).sort(), ["t1", "t2"]);
  });
});

test("an id present in BOTH keeps the SHARED entry — a stale desktop copy never wins", () => {
  withHome((_home, userData) => {
    writeJson(sharedScheduleStorePath(), { t1: { id: "t1", name: "the current one" } });
    writeJson(legacyScheduleStorePath(userData), {
      t1: { id: "t1", name: "a stale copy" },
      t2: { id: "t2", name: "two" },
    });
    assert.equal(migrateScheduleStore(userData), 1, "only the genuinely new entry is adopted");
    const shared = JSON.parse(readFileSync(sharedScheduleStorePath(), "utf8"));
    assert.equal(shared.t1.name, "the current one");
    assert.equal(shared.t2.name, "two");
  });
});

test("migration is idempotent — a second boot adopts nothing", () => {
  withHome((_home, userData) => {
    writeJson(legacyScheduleStorePath(userData), { t1: { id: "t1" } });
    assert.equal(migrateScheduleStore(userData), 1);
    assert.equal(migrateScheduleStore(userData), 0);
    assert.equal(migrateScheduleStore(userData), 0);
  });
});
