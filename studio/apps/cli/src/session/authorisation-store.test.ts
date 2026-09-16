/**
 * authorisation-store.test.ts — where the saved level lives, and what happens to an install
 * that has not been migrated yet.
 *
 * The store moved with the rest of the config from `~/.config/prometheus-studio` into the one
 * Prometheus home, `~/.prometheus/config`. A startup migration copies the old tree across, but
 * it can fail (a read-only home, a container, a locked-down profile) and it has not run at all
 * on the first launch of an upgraded install. The reader therefore falls back to the legacy path
 * on its own — without that, "we moved your settings" and "your setting did not survive" are the
 * same event from the user's side.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSavedAuthLevel, saveAuthLevel } from "./authorisation-store.js";

const NEW = [".prometheus", "config", "authorisation.json"];
const OLD = [".config", "prometheus-studio", "authorisation.json"];

function seed(home: string, where: string[], body: string): string {
  const file = join(home, ...where);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
  return file;
}

test("the store reads and writes under the ONE Prometheus home", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-authstore-"));
  try {
    assert.equal(readSavedAuthLevel(home), null, "a fresh home has no saved level");
    saveAuthLevel(6, home);
    assert.equal(readSavedAuthLevel(home), 6);
    assert.equal(existsSync(join(home, ...NEW)), true, "written to ~/.prometheus/config");
    assert.equal(
      existsSync(join(home, ...OLD)),
      false,
      "nothing may be written to the old root any more",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an UNMIGRATED install still gets its saved level back from the legacy root", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-authstore-legacy-"));
  try {
    seed(home, OLD, '{"level":7}');
    assert.equal(
      readSavedAuthLevel(home),
      7,
      "the fallback is what stops the root move from reading as a lost setting",
    );

    // and the NEW location wins whenever it exists — a stale legacy copy must never resurrect
    // a level the user has since changed.
    seed(home, NEW, '{"level":3}');
    assert.equal(readSavedAuthLevel(home), 3);

    // writing goes to the new root only; the legacy file is left untouched for an older build
    saveAuthLevel(5, home);
    assert.equal(readSavedAuthLevel(home), 5);
    assert.equal(readFileSync(join(home, ...OLD), "utf8"), '{"level":7}');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a corrupt or out-of-range store reads as unset rather than throwing", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-authstore-bad-"));
  try {
    seed(home, NEW, "{ not json");
    assert.equal(readSavedAuthLevel(home), null);
    seed(home, NEW, '{"level":99}');
    assert.equal(readSavedAuthLevel(home), null);
    seed(home, NEW, '{"level":-1}');
    assert.equal(readSavedAuthLevel(home), null);
    // …and a corrupt NEW file still lets a good legacy one through
    seed(home, OLD, '{"level":4}');
    assert.equal(readSavedAuthLevel(home), 4);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("saveAuthLevel clamps to the ladder and never throws on an unwritable home", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-authstore-clamp-"));
  try {
    saveAuthLevel(99, home);
    assert.equal(readSavedAuthLevel(home), 7);
    saveAuthLevel(-4, home);
    assert.equal(readSavedAuthLevel(home), 0);
    // a home that cannot exist must be a no-op, not a crash mid-session
    saveAuthLevel(3, join(home, "definitely", "not", "\0", "writable"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
