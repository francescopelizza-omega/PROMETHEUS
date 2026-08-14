/**
 * grants-store.test.ts — persisted "don't ask again".
 *
 * Two properties are load-bearing and neither is about round-tripping:
 *
 *  1. A `once` or `session` grant must NEVER reach the disk. Persisting one would silently
 *     promote a one-turn answer into a permanent one — the user said "this time" and would be
 *     held to "always".
 *  2. The file is plain JSON in the user's config dir. It can be hand-edited, and it is exactly
 *     what a hostile process would write to. Loading it through `add()` means an edited file
 *     cannot express a grant the UI would have refused.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agent, cliProfiles } from "@prometheus/core";

import { grantsPath, loadGrantsInto, readGrants, saveGrants } from "./grants-store.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "prom-grants-"));
}

/** Write a raw grants file (the hand-edited / hostile case). */
function writeRaw(home: string, body: unknown): void {
  mkdirSync(cliProfiles.configDir(home), { recursive: true });
  writeFileSync(grantsPath(home), typeof body === "string" ? body : JSON.stringify(body));
}

/* ── what is written ────────────────────────────────────────────────────────*/

test("only project and user grants are written — once/session must not survive", () => {
  const home = tempHome();
  const store = new agent.ScopedPermissionStore();
  store.add({ subject: "engine:scan", decision: "allow", scope: "user" });
  store.add({ subject: "engine:install", decision: "allow", scope: "project", root: "/w" });
  store.add({ subject: "bash:git status", decision: "allow", scope: "session" });
  store.add({ subject: "bash:ls", decision: "allow", scope: "once" });

  assert.equal(saveGrants(store, home), true);
  const back = readGrants(home);
  assert.deepEqual(
    back.map((g) => `${g.subject}/${g.scope}`),
    ["engine:scan/user", "engine:install/project"],
  );
});

test("a project grant keeps the root it is bound to", () => {
  // Without the root a project grant would apply in every other project — the exact scope
  // creep the field exists to prevent.
  const home = tempHome();
  const store = new agent.ScopedPermissionStore();
  store.add({ subject: "engine:scan", decision: "allow", scope: "project", root: "/work/repo" });
  saveGrants(store, home);
  assert.equal(readGrants(home)[0]?.root, "/work/repo");
});

test("a deny is persisted as faithfully as an allow", () => {
  const home = tempHome();
  const store = new agent.ScopedPermissionStore();
  store.add({ subject: "engine:harden", decision: "deny", scope: "user" });
  saveGrants(store, home);
  assert.equal(readGrants(home)[0]?.decision, "deny");
});

/* ── what is read back ──────────────────────────────────────────────────────*/

test("a round trip restores the grant into a fresh store", () => {
  const home = tempHome();
  const a = new agent.ScopedPermissionStore();
  a.add({ subject: "engine:scan", decision: "allow", scope: "user" });
  saveGrants(a, home);

  const b = new agent.ScopedPermissionStore();
  assert.deepEqual(loadGrantsInto(b, home), { loaded: 1, refused: 0 });
  const rules = b.merge([], "/anywhere");
  assert.deepEqual(rules, [{ match: "engine:scan", decision: "allow" }]);
});

test("an over-broad grant on disk is REFUSED, not loaded", () => {
  // This is the whole reason rehydration goes through add(): a hand-edited file must not be
  // able to express what the UI would have rejected.
  const home = tempHome();
  writeRaw(home, {
    grants: [
      { subject: "*", decision: "allow", scope: "user" },
      { subject: "engine:*", decision: "allow", scope: "user" },
      { subject: "bash:rm -rf / --force", decision: "allow", scope: "user" },
      { subject: "engine:scan", decision: "allow", scope: "user" },
    ],
  });
  const store = new agent.ScopedPermissionStore();
  const res = loadGrantsInto(store, home);
  assert.equal(res.loaded, 1, "something broad slipped through");
  assert.equal(res.refused, 3);
  assert.deepEqual(store.merge([], "/w"), [{ match: "engine:scan", decision: "allow" }]);
});

test("a file claiming a once/session scope is ignored, not upgraded", () => {
  const home = tempHome();
  writeRaw(home, {
    grants: [
      { subject: "engine:scan", decision: "allow", scope: "once" },
      { subject: "engine:audit", decision: "allow", scope: "session" },
    ],
  });
  assert.deepEqual(readGrants(home), []);
});

test("unknown keys are stripped rather than carried into the engine", () => {
  const home = tempHome();
  writeRaw(home, {
    grants: [{ subject: "engine:scan", decision: "allow", scope: "user", sudo: true, force: 1 }],
  });
  assert.deepEqual(readGrants(home), [
    { subject: "engine:scan", decision: "allow", scope: "user" },
  ]);
});

test("a bare array is accepted as well as the wrapped object", () => {
  const home = tempHome();
  writeRaw(home, [{ subject: "engine:scan", decision: "allow", scope: "user" }]);
  assert.equal(readGrants(home).length, 1);
});

test("a missing, empty or corrupt file reads as no grants", () => {
  assert.deepEqual(readGrants(tempHome()), []);
  for (const body of ["", "{", "null", "42", '"text"', '{"grants":"no"}']) {
    const home = tempHome();
    writeRaw(home, body);
    assert.deepEqual(readGrants(home), [], `threw or invented on ${body}`);
  }
});

test("malformed rows are dropped one by one, not the whole file", () => {
  const home = tempHome();
  writeRaw(home, {
    grants: [
      { subject: "", decision: "allow", scope: "user" },
      { subject: "engine:scan", decision: "maybe", scope: "user" },
      { subject: "engine:audit", decision: "allow", scope: "user" },
      null,
      "nope",
    ],
  });
  assert.deepEqual(
    readGrants(home).map((g) => g.subject),
    ["engine:audit"],
  );
});

/* ── failure posture ────────────────────────────────────────────────────────*/

test("an unwritable home reports false rather than taking the turn with it", () => {
  const store = new agent.ScopedPermissionStore();
  store.add({ subject: "engine:scan", decision: "allow", scope: "user" });
  // A path under a FILE cannot become a directory — mkdir fails, and so must the save.
  const file = join(tempHome(), "a-file");
  writeFileSync(file, "x");
  assert.equal(saveGrants(store, join(file, "nested")), false);
});

test("saving an empty store writes an empty list, not a broken file", () => {
  const home = tempHome();
  assert.equal(saveGrants(new agent.ScopedPermissionStore(), home), true);
  assert.deepEqual(readGrants(home), []);
});
