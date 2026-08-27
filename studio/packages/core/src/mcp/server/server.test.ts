/**
 * server.test.ts — the embedded MCP server tool catalog + runner + isError policy.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS, getTool, toolNames } from "./index.js";
import { computeIsError } from "./isError.js";
import { type EngineRunner, runMcpTool, validateArgs } from "./runner.js";
import { PROMETHEUS_TOOLS } from "./tools.js";

test("catalog is 14 ported + 4 studio = 18 tools, unique names", () => {
  assert.equal(PROMETHEUS_TOOLS.length, 14);
  assert.equal(TOOLS.length, 18);
  assert.equal(new Set(toolNames()).size, 18);
  for (const t of ["prometheus_scan", "prometheus_install", "prometheus_models"]) {
    assert.ok(getTool(t), `${t} present`);
  }
});

test("annotations: read-only vs destructive (the §4.3 source of truth)", () => {
  assert.equal(getTool("prometheus_list")?.annotations.readOnlyHint, true);
  assert.equal(getTool("prometheus_install")?.annotations.destructiveHint, true);
  assert.equal(getTool("prometheus_uninstall")?.annotations.destructiveHint, true);
  // localai + mcp_discover are pure reads; models/apps/worldsim are worst-case destructive.
  assert.equal(getTool("prometheus_localai")?.annotations.readOnlyHint, true);
  assert.equal(getTool("prometheus_models")?.annotations.destructiveHint, true);
});

test("toArgv: read-only tools never carry global flags", () => {
  assert.deepEqual(getTool("prometheus_scan")?.toArgv({}), ["scan"]);
  assert.deepEqual(getTool("prometheus_info")?.toArgv({ name: "superpowers" }), [
    "info",
    "superpowers",
  ]);
  assert.deepEqual(getTool("prometheus_skills_list")?.toArgv({}), ["skills", "list"]);
});

test("toArgv: install puts global flags before the subcommand (§1.1 contract)", () => {
  const install = getTool("prometheus_install")!;
  assert.deepEqual(install.toArgv({ name: "x", dryRun: true }), ["--dry-run", "install", "x"]);
  assert.deepEqual(install.toArgv({ name: "x", dryRun: false, yes: true }), [
    "--yes",
    "install",
    "x",
  ]);
  assert.deepEqual(install.toArgv({ name: "x", dryRun: false, yes: true, only: "hooks" }), [
    "--yes",
    "install",
    "x",
    "--only",
    "hooks",
  ]);
  assert.deepEqual(install.toArgv({ name: "x", dryRun: false, force: true }), [
    "--force",
    "install",
    "x",
  ]);
});

test("toArgv: studio action tools map action+tool+flags", () => {
  assert.deepEqual(getTool("prometheus_models")?.toArgv({ action: "list" }), ["models", "list"]);
  assert.deepEqual(
    getTool("prometheus_models")?.toArgv({
      action: "install",
      tool: "FlashAttention",
      dryRun: true,
    }),
    ["--dry-run", "models", "install", "FlashAttention"],
  );
  assert.deepEqual(getTool("prometheus_localai")?.toArgv({ action: "show", tool: "ollama" }), [
    "localai",
    "show",
    "ollama",
  ]);
  assert.deepEqual(getTool("prometheus_localai")?.toArgv({}), ["localai", "audit"]);
});

test("validateArgs: defaults + required + enum + type checks", () => {
  const install = getTool("prometheus_install")!;
  // default dryRun:true applied when absent
  const r1 = validateArgs(install.schema, { name: "x" });
  assert.equal(r1.ok, true);
  assert.equal(r1.value.dryRun, true);
  // missing required name → error
  const r2 = validateArgs(install.schema, {});
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes("name")));
  // enum violation
  const models = getTool("prometheus_models")!;
  const r3 = validateArgs(models.schema, { action: "frobnicate" });
  assert.equal(r3.ok, false);
  // wrong type
  const r4 = validateArgs(install.schema, { name: 42 });
  assert.equal(r4.ok, false);
  // unknown keys ignored (lenient)
  const r5 = validateArgs(install.schema, { name: "x", bogus: 1 });
  assert.equal(r5.ok, true);
  assert.equal("bogus" in r5.value, false);
});

test("runMcpTool: validates then dispatches the built argv to the injected runner", async () => {
  const calls: string[][] = [];
  const fakeRun: EngineRunner = async (argv) => {
    calls.push(argv);
    return { ok: true, command: argv.join(" "), data: {}, exitCode: 0, stderr: "" } as never;
  };
  await runMcpTool(
    getTool("prometheus_install")!,
    { name: "superpowers", dryRun: true },
    { run: fakeRun },
  );
  assert.deepEqual(calls[0], ["--dry-run", "install", "superpowers"]);

  // invalid args reject before the runner is touched.
  calls.length = 0;
  await assert.rejects(() => runMcpTool(getTool("prometheus_info")!, {}, { run: fakeRun }));
  assert.equal(calls.length, 0);
});

test("computeIsError: audit high/critical = error; medium/low/clean = informational", () => {
  assert.equal(computeIsError("prometheus_audit", { worst_verdict: "high" }), true);
  assert.equal(computeIsError("prometheus_audit", { worst_verdict: "critical" }), true);
  assert.equal(computeIsError("prometheus_audit", { worst_verdict: "medium" }), false);
  assert.equal(computeIsError("prometheus_audit", { worst_verdict: "low" }), false);
  assert.equal(computeIsError("prometheus_audit", { worst_verdict: "clean" }), false);
  // engine error envelope + failed state-change
  assert.equal(computeIsError("prometheus_list", { error: "boom" }), true);
  assert.equal(computeIsError("prometheus_install", { ok: false }), true);
  assert.equal(computeIsError("prometheus_install", { ok: true }), false);
  assert.equal(computeIsError("prometheus_scan", {}), false);
});

test("every exposed tool maps to a subcommand the engine actually has", () => {
  /**
   * `prometheus_mcp_discover` mapped to `["mcp", "discover"]` and prometheus.py has no `mcp`
   * subcommand at all — `invalid choice: 'mcp'`. This catalog is what the standalone
   * `prometheus-studio-mcp` binary registers in `tools/list`, so an external MCP client saw a
   * tool promising to list configured MCP servers and got an argparse error on every call. It
   * was removed rather than repointed: the discovery it advertised lives in TypeScript, which
   * the engine bridge cannot reach.
   *
   * The verbs below are prometheus.py's own `<command>` choices. A tool whose first argv element
   * is not one of them cannot work, and a test asserting its broken argv — which is what existed
   * — only pins the breakage in place.
   */
  const ENGINE_VERBS = new Set([
    "vault",
    "wizard",
    "scan",
    "superscan",
    "matrix",
    "where",
    "purge",
    "schedule",
    "inventory",
    "list",
    "doctor",
    "bundle",
    "install",
    "uninstall",
    "status",
    "enable",
    "disable",
    "skills",
    "quarantine",
    "secure",
    "auto",
    "info",
    "audit",
    "scaffold-skill",
    "sync",
    "models",
    "apps",
    "worldsim",
    "localai",
    "chat",
    "describe",
    "tutorial",
    "methods",
    "harden",
    "pentest",
  ]);
  for (const tool of TOOLS) {
    const verb = tool.toArgv({})[0];
    assert.ok(
      verb && ENGINE_VERBS.has(verb),
      `"${tool.name}" runs \`prometheus ${verb}\`, which is not an engine subcommand`,
    );
  }
});
