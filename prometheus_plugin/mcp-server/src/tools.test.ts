/**
 * tools.test.ts — the MCP tool catalog (CLI-035). node:test via tsx (no vitest in this
 * standalone package). Pins the original 14 tools, the parity count, the destructive
 * confirm-gate, option-injection guards, and the deterministic docs generator.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS, renderToolsDoc } from "./tools.js";

/** The original 14 tool names — MUST stay byte-identical (order + names). */
const ORIGINAL_14 = [
  "prometheus_scan",
  "prometheus_superscan",
  "prometheus_list",
  "prometheus_info",
  "prometheus_where",
  "prometheus_status",
  "prometheus_audit",
  "prometheus_matrix",
  "prometheus_skills_list",
  "prometheus_vault_status",
  "prometheus_install",
  "prometheus_uninstall",
  "prometheus_enable",
  "prometheus_disable",
];

/** The CLI-035 additions — the JSON-capable read surface + the one confirm-gated writer. */
const NEW_TOOLS = [
  "prometheus_describe",
  "prometheus_tutorial",
  "prometheus_methods",
  "prometheus_doctor",
  "prometheus_inventory",
  "prometheus_models",
  "prometheus_apps",
  "prometheus_worldsim",
  "prometheus_secure",
  "prometheus_harden",
  "prometheus_sync",
];

const byName = (n: string) => TOOLS.find((t) => t.name === n);

test("original 14 tools are present, in order, unchanged (pinned)", () => {
  assert.deepEqual(TOOLS.slice(0, 14).map((t) => t.name), ORIGINAL_14);
});

test("tools/list parity: count == JSON-capable inventory (deferred verbs excluded)", () => {
  // 14 original + 11 new = 25. vault-mutation / uninstall-extension / purge are DEFERRED
  // (land after S048/S081) — deliberately NOT counted here.
  assert.equal(TOOLS.length, ORIGINAL_14.length + NEW_TOOLS.length);
  assert.equal(TOOLS.length, 25);
  for (const n of NEW_TOOLS) assert.ok(byName(n), `missing new tool ${n}`);
  // no duplicate names.
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length);
});

test("destructive prometheus_sync REQUIRES confirm — no confirm ⇒ never builds argv", () => {
  const sync = byName("prometheus_sync");
  assert.ok(sync);
  assert.equal(sync?.annotations.destructiveHint, true);
  // toArgv fails closed without confirm (defense-in-depth beyond the z.literal(true) schema).
  assert.throws(() => sync?.toArgv({ skill: "x" }), /confirm-required/);
  assert.throws(() => sync?.toArgv({ skill: "x", confirm: false }), /confirm-required/);
  // with confirm:true it builds the guarded argv.
  assert.deepEqual(sync?.toArgv({ skill: "myskill", confirm: true }), ["sync", "--", "myskill"]);
  assert.deepEqual(sync?.toArgv({ skill: "s", to: "all", confirm: true }), [
    "sync",
    "--",
    "s",
    "--to",
    "all",
  ]);
});

test("option-injection: positional targets are `--`-guarded so `-`-leading ids can't be flags", () => {
  assert.deepEqual(byName("prometheus_describe")?.toArgv({ id: "-rf" }), ["describe", "--", "-rf"]);
  assert.deepEqual(byName("prometheus_describe")?.toArgv({}), ["describe"]); // absent id → no guard
  assert.deepEqual(byName("prometheus_secure")?.toArgv({ target: "-x", full: false }), [
    "secure",
    "--",
    "-x",
  ]);
  assert.deepEqual(byName("prometheus_models")?.toArgv({ action: "status", tool: "-evil" }), [
    "models",
    "status",
    "--",
    "-evil",
  ]);
});

test("enum subactions build positionally (the model can't invent argv)", () => {
  assert.deepEqual(byName("prometheus_models")?.toArgv({ action: "config" }), ["models", "config", "--show"]);
  assert.deepEqual(byName("prometheus_apps")?.toArgv({ action: "installed" }), ["apps", "installed"]);
  assert.deepEqual(byName("prometheus_inventory")?.toArgv({ host: ["claude", "gemini"] }), [
    "inventory",
    "--host",
    "claude",
    "--host",
    "gemini",
  ]);
});

test("no NEW tool can express --force (mirror of the loop.ts never-force invariant)", () => {
  for (const n of NEW_TOOLS) {
    const t = byName(n);
    assert.ok(t);
    assert.ok(!("force" in (t?.schema ?? {})), `${n} must not expose a force field`);
  }
});

test("renderToolsDoc is deterministic + lists every tool (CLI-035 docs)", () => {
  const a = renderToolsDoc(TOOLS);
  const b = renderToolsDoc(TOOLS);
  assert.equal(a, b, "same input → byte-identical output (no hand drift)");
  for (const t of TOOLS) assert.ok(a.includes(`\`${t.name}\``), `doc missing ${t.name}`);
  assert.match(a, /destructive:\*\* yes/); // the sync tool is flagged destructive
});
