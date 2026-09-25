/**
 * settings-path.test.ts — one global settings layer, adopted from the old one exactly ONCE.
 *
 * The desktop's global layer moved from `<userData>/settings.json` to the CLI's
 * `$PROMETHEUS_HOME/config/settings.json`. The first version of the migration kept the legacy
 * file where it was and re-ran on every launch, so a key the user later reset in Studio (or
 * unset from the CLI) was folded straight back in from the stale copy on the next start.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  legacyGlobalSettingsPath,
  migrateGlobalSettings,
  sharedGlobalSettingsPath,
} from "./settings-path.js";

/** Point `prometheusHome()` at a temp dir for the duration of `fn` — never the real ~/.prometheus. */
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

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("the shared path is the CLI's, under PROMETHEUS_HOME — not Electron's userData", () => {
  withHome((home) => {
    assert.equal(sharedGlobalSettingsPath(), join(home, "config", "settings.json"));
  });
});

test("legacy leaves are adopted per-LEAF, and the CLI's own values are never clobbered", () => {
  withHome((_home, userData) => {
    writeJson(sharedGlobalSettingsPath(), { hooks: ["cli-hook"] });
    writeJson(legacyGlobalSettingsPath(userData), { hooks: ["stale"], gateStrict: true });
    assert.equal(migrateGlobalSettings(userData), 1);
    assert.deepEqual(readJson(sharedGlobalSettingsPath()), {
      hooks: ["cli-hook"],
      gateStrict: true,
    });
  });
});

test("the migration runs ONCE: a key reset after it is not resurrected on the next launch", () => {
  withHome((_home, userData) => {
    const legacy = legacyGlobalSettingsPath(userData);
    writeJson(legacy, { gateStrict: true });
    assert.equal(migrateGlobalSettings(userData), 1);
    assert.equal(existsSync(legacy), false, "the legacy file left the migration's path");
    assert.equal(existsSync(`${legacy}.migrated`), true, "…but was kept, renamed, not deleted");

    // The user resets the key (Studio's Reset deletes it from the layer), then relaunches.
    writeJson(sharedGlobalSettingsPath(), {});
    assert.equal(migrateGlobalSettings(userData), 0);
    assert.deepEqual(readJson(sharedGlobalSettingsPath()), {}, "the reset key stayed reset");
  });
});

test("a legacy file with nothing new to adopt is still retired", () => {
  withHome((_home, userData) => {
    writeJson(sharedGlobalSettingsPath(), { gateStrict: false });
    writeJson(legacyGlobalSettingsPath(userData), { gateStrict: true });
    assert.equal(migrateGlobalSettings(userData), 0);
    assert.equal(existsSync(legacyGlobalSettingsPath(userData)), false);
    assert.deepEqual(readJson(sharedGlobalSettingsPath()), { gateStrict: false });
  });
});
