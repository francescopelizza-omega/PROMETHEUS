/**
 * catalog-validate.test.ts — node:test for the Catalog IPC zod seam (file 06 §4/§8).
 *
 * catalog-ipc.ts is RELAY-ONLY and imports electron (so it is not unit-tested at
 * the seam, exactly like model-ipc.ts / env-ipc.ts). The testable invariant is the
 * validation seam: every `catalog:*` channel arg flows through these zod validators
 * BEFORE routing (a renderer is the least-trusted surface, C5; install drives the
 * engine's REAL nemesis gate). This file pins:
 *
 *   1. valid args parse to the coerced typed value (defaults applied),
 *   2. invalid args reject with a SERIALIZABLE {kind:"invalid-args",message,…},
 *   3. an UNKNOWN action/component/host is REJECTED (fail-closed — never dispatched),
 *   4. shell-metacharacter / control-char names are REJECTED at the seam (inert argv),
 *   5. THE FORCE GATE (§8): `force:true` WITHOUT `confirmForce:true` collapses to
 *      `force:false` — JS never silently force-overrides a nemesis BLOCK (C5).
 *
 * catalog-validate.ts imports the REAL `zod`; the decoupled runner maps it to the
 * same faithful double model-validate.test.ts uses (via zod-resolver.mjs registered
 * BEFORE the dynamic import). Production resolves the real zod via electron-vite.
 *
 * Run: node --import ../../../apps/cli/dev-register.mjs --test catalog-validate.test.ts
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// Map `zod` to the local double BEFORE importing catalog-validate.ts.
register(new URL("./__test-doubles__/zod-resolver.mjs", import.meta.url));

const {
  validateCatalogName,
  validateCatalogAudit,
  validateCatalogStatus,
  validateCatalogInventory,
  validateCatalogRaw,
  validateCatalogInstall,
  validateCatalogUninstall,
  validateCatalogToggle,
  validateCatalogBundle,
  validateCatalogSync,
  validateCatalogScaffold,
  validateCatalogAppLifecycle,
} = await import("./catalog-validate.js");

/** The shared discriminated outcome the validators return. */
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

/* ── name reads (info/where/audit/status) ────────────────────────────────────*/

test("validateCatalogName accepts a plain registry name", () => {
  assert.deepEqual(validateCatalogName({ name: "claude-mem" }), {
    ok: true,
    value: { name: "claude-mem" },
  });
});

test("validateCatalogName accepts the surgical plugin:comp1,comp2 form", () => {
  const r = validateCatalogName({ name: "devtools:security-review,pr-bot" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.name, "devtools:security-review,pr-bot");
});

test("validateCatalogName REJECTS shell-metacharacter / control-char names (inert argv, C5)", () => {
  assertInvalidArgs(validateCatalogName({ name: "evil; rm -rf /" }) as GuardResult<unknown>);
  assertInvalidArgs(validateCatalogName({ name: "x$(whoami)" }) as GuardResult<unknown>);
  assertInvalidArgs(validateCatalogName({ name: "a`b`" }) as GuardResult<unknown>);
  assertInvalidArgs(validateCatalogName({ name: "" }) as GuardResult<unknown>);
});

test("validateCatalogStatus accepts the literal all", () => {
  assert.deepEqual(validateCatalogStatus({ name: "all" }), { ok: true, value: { name: "all" } });
});

/* ── audit (strict / gate-fresh defaults) ────────────────────────────────────*/

test("validateCatalogAudit defaults strict + gateFresh false; honours true", () => {
  assert.deepEqual(validateCatalogAudit({ name: "graphify" }), {
    ok: true,
    value: { name: "graphify", strict: false, gateFresh: false },
  });
  const r = validateCatalogAudit({ name: "graphify", strict: true, gateFresh: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { name: "graphify", strict: true, gateFresh: true });
});

/* ── inventory (optional host filter) ────────────────────────────────────────*/

test("validateCatalogInventory accepts no host + a valid host; rejects a bad host", () => {
  assert.deepEqual(validateCatalogInventory({}), { ok: true, value: {} });
  assert.deepEqual(validateCatalogInventory({ host: "cursor" }), {
    ok: true,
    value: { host: "cursor" },
  });
  assertInvalidArgs(validateCatalogInventory({ host: "a;b" }) as GuardResult<unknown>);
});

/* ── raw read (surface + localai action) ─────────────────────────────────────*/

test("validateCatalogRaw accepts a known surface + rejects an unknown one (fail-closed)", () => {
  const r = validateCatalogRaw({ surface: "apps", action: "list" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.surface, "apps");
  assertInvalidArgs(validateCatalogRaw({ surface: "torrents" }) as GuardResult<unknown>);
});

test("F4: a malformed/leading-dash action is REJECTED (argv option-injection defense)", () => {
  assertInvalidArgs(validateCatalogRaw({ surface: "apps", action: "-rf" }) as GuardResult<unknown>);
  assertInvalidArgs(
    validateCatalogRaw({ surface: "apps", action: "a b; rm" }) as GuardResult<unknown>,
  );
  assert.equal(validateCatalogRaw({ surface: "apps", action: "run" }).ok, true);
});

test("validateCatalogRaw accepts a localai sub-action + rejects an unknown one", () => {
  const r = validateCatalogRaw({ surface: "localai", localaiAction: "audit" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.localaiAction, "audit");
  assertInvalidArgs(
    validateCatalogRaw({ surface: "localai", localaiAction: "drain" }) as GuardResult<unknown>,
  );
});

/* ── install (defaults + surgical surface + THE FORCE GATE) ───────────────────*/

test("validateCatalogInstall defaults dryRun:true and force:false", () => {
  const r = validateCatalogInstall({ name: "codegraph" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.name, "codegraph");
    assert.equal(r.value.dryRun, true);
    assert.equal(r.value.yes, false);
    assert.equal(r.value.arm, false);
    assert.equal(r.value.strict, false);
    assert.equal(r.value.force, false);
  }
});

test("validateCatalogInstall carries the surgical host/only/skip/arm surface", () => {
  const r = validateCatalogInstall({
    name: "devtools",
    host: ["claude", "cursor"],
    only: "security-review,pr-bot",
    arm: true,
    dryRun: false,
    yes: true,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value.host, ["claude", "cursor"]);
    assert.equal(r.value.only, "security-review,pr-bot");
    assert.equal(r.value.arm, true);
    assert.equal(r.value.dryRun, false);
    assert.equal(r.value.yes, true);
  }
});

test("THE FORCE GATE: install force:true WITHOUT confirmForce collapses to force:false (C5/§8)", () => {
  const r = validateCatalogInstall({ name: "sketchy", force: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.force, false, "force is DROPPED without the typed-confirm");
});

test("THE FORCE GATE: install force:true WITH confirmForce:true honours force (C5/§8)", () => {
  const r = validateCatalogInstall({ name: "sketchy", force: true, confirmForce: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.force, true, "force is honoured only with the paired confirm");
});

test("THE FORCE GATE: confirmForce:true alone (force:false) stays force:false", () => {
  const r = validateCatalogInstall({ name: "x", confirmForce: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.force, false);
});

test("validateCatalogInstall REJECTS a bad host in the array (fail-closed)", () => {
  assertInvalidArgs(
    validateCatalogInstall({ name: "x", host: ["claude", "a;b"] }) as GuardResult<unknown>,
  );
});

test("validateCatalogInstall REJECTS shell-meta in only/skip components", () => {
  assertInvalidArgs(validateCatalogInstall({ name: "x", only: "a;b" }) as GuardResult<unknown>);
});

/* ── uninstall (dry-run-first) ───────────────────────────────────────────────*/

test("validateCatalogUninstall defaults dryRun:true", () => {
  const r = validateCatalogUninstall({ name: "claude-mem" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.dryRun, true);
    assert.equal(r.value.yes, false);
  }
});

/* ── enable / disable (component enum) ───────────────────────────────────────*/

test("validateCatalogToggle accepts hooks|mcp; rejects an unknown component", () => {
  const r = validateCatalogToggle({ name: "x", component: "hooks" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.component, "hooks");
  assertInvalidArgs(
    validateCatalogToggle({ name: "x", component: "daemon" }) as GuardResult<unknown>,
  );
});

/* ── bundle (force gate too) ─────────────────────────────────────────────────*/

test("THE FORCE GATE: bundle force:true WITHOUT confirmForce collapses to force:false", () => {
  const r = validateCatalogBundle({ force: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.force, false);
});

/* ── sync ────────────────────────────────────────────────────────────────────*/

test("validateCatalogSync needs skill + to; rejects a bad agent", () => {
  assert.deepEqual(validateCatalogSync({ skill: "cavecrew", to: "cursor" }), {
    ok: true,
    value: { skill: "cavecrew", to: "cursor" },
  });
  assertInvalidArgs(validateCatalogSync({ skill: "cavecrew", to: "a b" }) as GuardResult<unknown>);
});

/* ── scaffold-skill (autoFire default true) ──────────────────────────────────*/

test("validateCatalogScaffold defaults autoFire true; carries trigger/body/tools", () => {
  const r = validateCatalogScaffold({
    name: "my-skill",
    trigger: "Use when reviewing PRs",
    tools: "Read Edit",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.autoFire, true);
    assert.equal(r.value.trigger, "Use when reviewing PRs");
    assert.equal(r.value.tools, "Read Edit");
  }
});

test("validateCatalogScaffold honours autoFire:false (manual /name)", () => {
  const r = validateCatalogScaffold({ name: "my-skill", autoFire: false });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.autoFire, false);
});

/* ── app lifecycle (4th/8th/3rd fn verb set) ─────────────────────────────────*/

test("validateCatalogAppLifecycle accepts a known action; rejects an unknown one", () => {
  const r = validateCatalogAppLifecycle({ surface: "apps", action: "rollback", tool: "n8n" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.surface, "apps");
    assert.equal(r.value.action, "rollback");
    assert.equal(r.value.tool, "n8n");
  }
  assertInvalidArgs(
    validateCatalogAppLifecycle({ surface: "apps", action: "nuke" }) as GuardResult<unknown>,
  );
});

test("validateCatalogAppLifecycle rejects an unknown surface (fail-closed)", () => {
  assertInvalidArgs(
    validateCatalogAppLifecycle({ surface: "localai", action: "install" }) as GuardResult<unknown>,
  );
});
