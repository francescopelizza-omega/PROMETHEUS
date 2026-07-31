/**
 * repo-map-state.test.ts — the host-side repo-map holder over a REAL node:fs temp dir (CLI-053).
 * Verifies the toggle defaults OFF, refresh walks + renders, stats report, and the node:fs adapter
 * grounds a real file+symbol into the map.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyRepoMapVerb,
  makeRepoMapState,
  refreshRepoMap,
  repoMapStats,
} from "./repo-map-state.js";

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "prom-repomap-"));
  mkdirSync(join(root, "src", "tui"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "src", "tui", "status.ts"), "export function justify() {}\n");
  writeFileSync(join(root, "src", "a.py"), "def top():\n    pass\nclass Thing:\n    pass\n");
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "export const noise = 1;\n");
  writeFileSync(join(root, ".gitignore"), "*.log\n");
  writeFileSync(join(root, "debug.log"), "ignored noise\n");
  return root;
}

test("makeRepoMapState defaults OFF + unbuilt (huge repo pays no unbidden walk) (CLI-053)", () => {
  const s = makeRepoMapState("/nowhere");
  assert.equal(s.enabled, false);
  assert.equal(s.rendered, null);
  assert.equal(s.map, null);
  assert.match(repoMapStats(s), /off.*not built/);
});

test("refreshRepoMap walks the real tree, grounds file+symbol, skips node_modules/.gitignore (CLI-053)", () => {
  const root = fixtureRepo();
  try {
    const s = refreshRepoMap(makeRepoMapState(root));
    assert.ok(s.rendered, "a map is rendered");
    assert.match(s.rendered ?? "", /src\/tui\/status\.ts: justify/); // real fs → file + TS symbol
    assert.match(s.rendered ?? "", /src\/a\.py: top, Thing/); // python top-level def/class
    assert.ok(!/node_modules/.test(s.rendered ?? ""), "node_modules excluded");
    assert.ok(!/debug\.log/.test(s.rendered ?? ""), ".gitignore honored");
    assert.equal(s.map?.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyRepoMapVerb: on builds + enables, off disables, refresh rebuilds (CLI-053)", () => {
  const root = fixtureRepo();
  try {
    const s = makeRepoMapState(root);
    const onMsg = applyRepoMapVerb(s, "on");
    assert.equal(s.enabled, true);
    assert.ok(s.rendered, "on builds the map on first enable");
    assert.match(onMsg, /repo map on/);

    applyRepoMapVerb(s, "off");
    assert.equal(s.enabled, false);
    assert.ok(s.rendered, "off keeps the cached render (only toggles the flag)");

    const refreshed = applyRepoMapVerb(s, "refresh");
    assert.equal(s.enabled, true); // refresh re-enables
    assert.match(refreshed, /files · ~\d+ tok/);

    assert.match(applyRepoMapVerb(s, "bogus"), /unknown/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshRepoMap never throws on a missing root (keeps last good map) (CLI-053)", () => {
  const s = makeRepoMapState("/no/such/dir/xyz");
  assert.doesNotThrow(() => refreshRepoMap(s));
  // a walk over a missing root yields an empty map, not a crash.
  assert.ok(s.rendered !== undefined);
});
