/**
 * migrations.test.ts — versioned, idempotent, fail-soft state migration (Reliability pack).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Migration,
  type Versioned,
  latestVersion,
  runMigrations,
  stateVersion,
  validateMigrations,
} from "./index.js";

interface S extends Versioned {
  theme?: string;
  scheme?: string;
  density?: string;
}

const CHAIN: Migration<S>[] = [
  {
    toVersion: 1,
    description: "rename theme → scheme",
    migrate: (s) => ({ ...s, scheme: s.theme, theme: undefined }),
  },
  {
    toVersion: 2,
    description: "default density",
    migrate: (s) => ({ ...s, density: s.density ?? "comfortable" }),
  },
];

test("stateVersion defaults absent → 0", () => {
  assert.equal(stateVersion({}), 0);
  assert.equal(stateVersion({ version: 3 }), 3);
});

test("runMigrations applies the chain in order + stamps the version", () => {
  const r = runMigrations<S>({ theme: "dark" }, 2, CHAIN);
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, [1, 2]);
  assert.equal(r.state.version, 2);
  assert.equal(r.state.scheme, "dark");
  assert.equal(r.state.theme, undefined);
  assert.equal(r.state.density, "comfortable");
});

test("runMigrations is idempotent (re-run from current version applies nothing)", () => {
  const once = runMigrations<S>({ theme: "dark" }, 2, CHAIN);
  const twice = runMigrations<S>(once.state, 2, CHAIN);
  assert.deepEqual(twice.applied, []);
  assert.equal(twice.state.version, 2);
  assert.equal(twice.state.scheme, "dark");
});

test("runMigrations only applies steps within (current, target]", () => {
  const r = runMigrations<S>({ version: 1, scheme: "x" }, 2, CHAIN);
  assert.deepEqual(r.applied, [2], "skips already-applied v1");
});

test("runMigrations is fail-soft: a throwing step stops + returns the LAST GOOD state", () => {
  const chain: Migration<S>[] = [
    { toVersion: 1, migrate: (s) => ({ ...s, scheme: "ok" }) },
    {
      toVersion: 2,
      migrate: () => {
        throw new Error("bad migration");
      },
    },
    { toVersion: 3, migrate: (s) => ({ ...s, density: "compact" }) },
  ];
  const r = runMigrations<S>({}, 3, chain);
  assert.equal(r.ok, false);
  assert.equal(r.failedAt, 2);
  assert.match(r.error ?? "", /bad migration/);
  assert.deepEqual(r.applied, [1]);
  assert.equal(r.state.version, 1, "stopped at the last good version — never corrupted");
  assert.equal(r.state.scheme, "ok");
  assert.equal(r.state.density, undefined, "v3 never ran");
});

test("validateMigrations enforces contiguous 1..N unique ascending; latestVersion", () => {
  assert.equal(validateMigrations(CHAIN).ok, true);
  assert.equal(latestVersion(CHAIN), 2);
  assert.equal(
    validateMigrations([
      { toVersion: 1, migrate: (s) => s },
      { toVersion: 3, migrate: (s) => s },
    ]).ok,
    false,
  );
  assert.equal(
    validateMigrations([
      { toVersion: 1, migrate: (s) => s },
      { toVersion: 1, migrate: (s) => s },
    ]).ok,
    false,
  );
  assert.equal(validateMigrations([{ toVersion: 0, migrate: (s) => s }]).ok, false);
});
