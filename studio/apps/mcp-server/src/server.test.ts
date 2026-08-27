/**
 * server.test.ts — the real-transport MCP server's exposed catalog + dispatch gating.
 *
 * These tests import `./server.js` directly (never spawning the real stdio transport — see
 * the entry-point guard at the bottom of server.ts) to assert:
 *   1. the catalog is read-only ONLY, by name and by re-derived authorization category,
 *   2. a tool this server deliberately excludes (prometheus_install, a destructive/mutating
 *      tool) is REFUSED at dispatch time — not silently run — and the engine runner is never
 *      invoked for it,
 *   3. an exposed read-only tool still dispatches correctly through the shared runMcpTool path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { agent, mcpServer } from "@prometheus/core";
import { EXPOSED_TOOLS, dispatchTool, isExposedToolName } from "./server.js";

test("catalog: every exposed tool is annotated readOnlyHint AND classifies as read", () => {
  assert.ok(EXPOSED_TOOLS.length > 0, "catalog must not be empty");
  for (const t of EXPOSED_TOOLS) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} must be readOnlyHint`);
    assert.equal(
      agent.classifyAuth(t.name, t.annotations),
      "read",
      `${t.name} must classify as read`,
    );
  }
});

test("catalog: expects the known read-only prometheus.py + studio tools", () => {
  const names = new Set(EXPOSED_TOOLS.map((t) => t.name));
  for (const expected of [
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
    "prometheus_localai",
  ]) {
    assert.ok(names.has(expected), `expected ${expected} in the exposed catalog`);
  }
});

test("catalog: NEVER exposes a mutating/destructive tool", () => {
  const names = new Set(EXPOSED_TOOLS.map((t) => t.name));
  for (const excluded of [
    "prometheus_install",
    "prometheus_uninstall",
    "prometheus_enable",
    "prometheus_disable",
    "prometheus_models",
    "prometheus_apps",
    "prometheus_worldsim",
    // host-local tools the interactive agent loop exposes but this transport never does
    "write_file",
    "propose_edit",
    "web_fetch",
  ]) {
    assert.equal(names.has(excluded), false, `${excluded} must NOT be exposed`);
  }
  // sanity: the full core catalog DOES contain the destructive ones we just asserted absent —
  // proves this is a deliberate filter, not an accidentally-small catalog.
  assert.ok(mcpServer.getTool("prometheus_install"), "sanity: full catalog has prometheus_install");
});

test("isExposedToolName: mirrors EXPOSED_TOOLS membership exactly", () => {
  assert.equal(isExposedToolName("prometheus_scan"), true);
  assert.equal(isExposedToolName("prometheus_install"), false);
  assert.equal(isExposedToolName("not_a_real_tool"), false);
});

test("dispatchTool: a destructive tool is REFUSED — gated, not silently allowed", async () => {
  let engineCalled = false;
  const fakeRun: mcpServer.EngineRunner = async (argv) => {
    engineCalled = true;
    return { ok: true, command: argv.join(" "), data: {}, exitCode: 0, stderr: "" } as never;
  };

  const result = await dispatchTool(
    "prometheus_install",
    { name: "some-plugin", yes: true, force: true },
    { run: fakeRun },
  );

  assert.equal(result.isError, true);
  assert.equal(engineCalled, false, "the engine runner must NEVER be invoked for an excluded tool");
  const payload = result.structuredContent as { ok: boolean; error: string };
  assert.equal(payload.ok, false);
  assert.match(payload.error, /not exposed/);
});

test("dispatchTool: an unknown tool name is refused the same way (fail-closed)", async () => {
  const result = await dispatchTool("definitely_not_a_tool", {});
  assert.equal(result.isError, true);
});

test("dispatchTool: an exposed read-only tool dispatches through runMcpTool normally", async () => {
  const calls: string[][] = [];
  const fakeRun: mcpServer.EngineRunner = async (argv) => {
    calls.push(argv);
    return { command: argv.join(" "), ok: true, agents: ["claude-code"] } as never;
  };

  const result = await dispatchTool("prometheus_scan", {}, { run: fakeRun });

  assert.deepEqual(calls[0], ["scan"]);
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, {
    command: "scan",
    ok: true,
    agents: ["claude-code"],
  });
});

test("dispatchTool: prometheus_audit still surfaces a high/critical verdict as an error (same policy)", async () => {
  const fakeRun: mcpServer.EngineRunner = async (argv) =>
    ({ command: argv.join(" "), ok: true, worst_verdict: "critical", findings: [] }) as never;

  const result = await dispatchTool("prometheus_audit", { name: "some-plugin" }, { run: fakeRun });
  assert.equal(result.isError, true);
});
