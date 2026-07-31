/**
 * repo-validate.test.ts — node:test for the Repo Manager IPC zod seam (file 06 §3).
 *
 * repo-ipc.ts is RELAY-ONLY and imports electron (so it is not unit-tested at the
 * seam, exactly like model-ipc.ts / catalog-ipc.ts). The testable invariant is the
 * validation seam: every `repo:*` channel arg flows through these zod validators
 * BEFORE routing to the repo.py sidecar (the ONLY arbitrary-URL clone path, which
 * runs the REAL nemesis on the staged tree, C5/C6). This file pins:
 *
 *   1. valid args parse to the coerced typed value (defaults applied),
 *   2. invalid args reject with a SERIALIZABLE {kind:"invalid-args",message,…},
 *   3. a non-git / shell-metacharacter URL is REJECTED at the seam (inert argv),
 *   4. a non-hex pin SHA / bad branch is REJECTED,
 *   5. THE FORCE GATE (§8): `force:true` WITHOUT `confirmForce:true` collapses to
 *      `force:false` — JS never silently force-promotes a nemesis BLOCK (C5).
 *
 * repo-validate.ts imports the REAL `zod`; the decoupled runner maps it to the same
 * faithful double the other validators use (via zod-resolver.mjs registered BEFORE
 * the dynamic import). Production resolves the real zod via electron-vite.
 *
 * Run: node --import ../../../apps/cli/dev-register.mjs --test repo-validate.test.ts
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("./__test-doubles__/zod-resolver.mjs", import.meta.url));

const {
  validateRepoClone,
  validateRepoUpdate,
  validateRepoPin,
  validateRepoBranch,
  validateRepoRescan,
  validateRepoRemove,
} = await import("./repo-validate.js");

type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { kind: string; message: string; detail?: string } };

function assertInvalidArgs(r: GuardResult<unknown>): void {
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "invalid-args");
    assert.equal(typeof r.error.message, "string");
    assert.ok(r.error.message.length > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(r.error)), r.error);
  }
}

/* ── clone (url shapes + defaults + THE FORCE GATE) ──────────────────────────*/

test("validateRepoClone accepts an https git url + defaults force:false", () => {
  const r = validateRepoClone({ url: "https://github.com/acme/lib.git" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.url, "https://github.com/acme/lib.git");
    assert.equal(r.value.force, false);
  }
});

test("validateRepoClone accepts an ssh + scp-form git url", () => {
  assert.equal(validateRepoClone({ url: "ssh://git@github.com/acme/lib.git" }).ok, true);
  assert.equal(validateRepoClone({ url: "git@github.com:acme/lib.git" }).ok, true);
});

test("validateRepoClone REJECTS a non-git url + shell-meta + file:// + ext::", () => {
  assertInvalidArgs(validateRepoClone({ url: "not a url" }) as GuardResult<unknown>);
  assertInvalidArgs(
    validateRepoClone({ url: "https://x.com/r; rm -rf /" }) as GuardResult<unknown>,
  );
  assertInvalidArgs(validateRepoClone({ url: "file:///etc/passwd" }) as GuardResult<unknown>);
  assertInvalidArgs(validateRepoClone({ url: "ext::sh -c 'id'" }) as GuardResult<unknown>);
  assertInvalidArgs(validateRepoClone({ url: "" }) as GuardResult<unknown>);
});

test("validateRepoClone carries branch + pin + staged + linked", () => {
  const r = validateRepoClone({
    url: "https://github.com/acme/lib",
    branch: "feat/x",
    pin: "a1b2c3d",
    staged: "/tmp/stage",
    linkedCatalogItemId: "acme-skill",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.branch, "feat/x");
    assert.equal(r.value.pin, "a1b2c3d");
    assert.equal(r.value.staged, "/tmp/stage");
    assert.equal(r.value.linkedCatalogItemId, "acme-skill");
  }
});

test("validateRepoClone REJECTS a non-hex pin sha", () => {
  assertInvalidArgs(
    validateRepoClone({ url: "https://github.com/a/b", pin: "zzzz" }) as GuardResult<unknown>,
  );
});

test("F4: a leading-dash branch is REJECTED (argv option-injection defense)", () => {
  assertInvalidArgs(
    validateRepoClone({ url: "https://github.com/a/b", branch: "-x" }) as GuardResult<unknown>,
  );
  assertInvalidArgs(
    validateRepoBranch({ id: "acme", branch: "--upload-pack=x" }) as GuardResult<unknown>,
  );
  // a normal branch still passes
  assert.equal(validateRepoBranch({ id: "acme", branch: "main" }).ok, true);
});

test("THE FORCE GATE: clone force:true WITHOUT confirmForce collapses to force:false (C5/§8)", () => {
  const r = validateRepoClone({ url: "https://github.com/sketchy/repo", force: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.force, false, "force is DROPPED without the typed-confirm");
});

test("THE FORCE GATE: clone force:true WITH confirmForce:true honours force (C5/§8)", () => {
  const r = validateRepoClone({
    url: "https://github.com/sketchy/repo",
    force: true,
    confirmForce: true,
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.force, true, "force is honoured only with the paired confirm");
});

/* ── update / pin / branch (id + force gate) ─────────────────────────────────*/

test("validateRepoUpdate accepts a slug id + drops force without confirm", () => {
  const r = validateRepoUpdate({ id: "acme__lib", force: true });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.id, "acme__lib");
    assert.equal(r.value.force, false);
  }
});

test("validateRepoUpdate REJECTS a bad id (shell-meta)", () => {
  assertInvalidArgs(validateRepoUpdate({ id: "a/b" }) as GuardResult<unknown>);
  assertInvalidArgs(validateRepoUpdate({ id: "a;b" }) as GuardResult<unknown>);
});

test("validateRepoPin needs a hex sha; honours force only with confirm", () => {
  const ok = validateRepoPin({ id: "acme__lib", sha: "d4e5f6a", force: true, confirmForce: true });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.sha, "d4e5f6a");
    assert.equal(ok.value.force, true);
  }
  assertInvalidArgs(validateRepoPin({ id: "acme__lib", sha: "nothex" }) as GuardResult<unknown>);
});

test("validateRepoBranch needs a branch; rejects a whitespace branch", () => {
  const r = validateRepoBranch({ id: "acme__lib", branch: "main" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.branch, "main");
  assertInvalidArgs(validateRepoBranch({ id: "acme__lib", branch: "a b" }) as GuardResult<unknown>);
});

/* ── rescan / remove ─────────────────────────────────────────────────────────*/

test("validateRepoRescan defaults gateFresh false; honours true", () => {
  assert.deepEqual(validateRepoRescan({ id: "acme__lib" }), {
    ok: true,
    value: { id: "acme__lib", gateFresh: false },
  });
  const r = validateRepoRescan({ id: "acme__lib", gateFresh: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.gateFresh, true);
});

test("validateRepoRemove needs a valid id", () => {
  assert.deepEqual(validateRepoRemove({ id: "acme__lib" }), {
    ok: true,
    value: { id: "acme__lib" },
  });
  assertInvalidArgs(validateRepoRemove({}) as GuardResult<unknown>);
});
