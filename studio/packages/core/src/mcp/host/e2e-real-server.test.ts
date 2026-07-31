/**
 * e2e-real-server.test.ts — opt-in REAL MCP server smoke (CLI-038).
 *
 * Spawns the PINNED `@modelcontextprotocol/server-everything` via `npx -y` and drives
 * initialize → tools/list → tools/call `echo` through the GENUINE core stdio transport +
 * McpHostManager (a fake allow-gate is injected — gating itself is not under test here).
 *
 * GUARDED by `PROM_MCP_E2E=1`: the default `pnpm test` and offline CI SKIP the whole suite
 * (reported skipped, never silently absent) and spawn nothing — the harness is only created
 * inside the guarded `before`, so a skipped describe launches no npx. Teardown SIGTERM→SIGKILLs
 * the whole process group and asserts no `server-everything` process is orphaned.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  type ReferenceHarness,
  createReferenceHarness,
  prewarmReferenceServer,
} from "./e2e-harness.js";
import type { NemesisGate } from "./gate.js";
import { InMemoryConfigStore, McpHostManager } from "./manager.js";
import { createStdioTransportFactory } from "./stdio-transport.js";

const SKIP = process.env.PROM_MCP_E2E !== "1";
const allowGate: NemesisGate = async (target) => ({ verdict: "allow", target, findings: 0 });

describe("MCP e2e: real reference server (opt-in via PROM_MCP_E2E=1)", { skip: SKIP }, () => {
  let harness: ReferenceHarness;
  let manager: McpHostManager;

  before(async () => {
    await prewarmReferenceServer(); // warm the npm cache so the measured handshake is steady-state
    harness = createReferenceHarness();
    manager = new McpHostManager({
      store: new InMemoryConfigStore(),
      gate: allowGate,
      transport: createStdioTransportFactory(harness.transportDeps),
    });
    await manager.addServer(harness.cfg);
  });

  after(async () => {
    try {
      await manager?.disconnect(harness.cfg.id);
    } catch {
      /* already down */
    }
    await harness?.kill();
  });

  it(
    "initialize handshake completes and tools/list returns the echo tool",
    { timeout: 120_000 },
    async () => {
      const start = Date.now();
      const updated = await manager.connect(harness.cfg.id);
      // steady-state (cache pre-warmed) handshake must be well under the 15s per-request timeout.
      assert.ok(Date.now() - start < 15_000, "handshake ≪ 15s transport timeout in steady state");
      const names = (updated.capabilities?.tools ?? []).map((t) => t.name);
      assert.ok(names.length >= 1, "at least one tool advertised");
      assert.ok(names.includes("echo"), `echo tool present (got: ${names.join(", ")})`);
    },
  );

  it(
    "tools/call echo round-trips the argument in content[0].text",
    { timeout: 30_000 },
    async () => {
      const res = await manager.callTool(harness.cfg.id, "echo", { message: "prometheus-e2e" });
      assert.equal(res.isError, false);
      const content = res.content as { type?: string; text?: string }[];
      assert.ok(Array.isArray(content) && content.length >= 1, "content is a non-empty array");
      assert.match(String(content[0]?.text ?? ""), /prometheus-e2e/);
    },
  );

  it("teardown leaves no orphaned reference-server process", { timeout: 30_000 }, async () => {
    await manager.disconnect(harness.cfg.id);
    await harness.kill();
    assert.equal(harness.isRunning(), false, "no server-everything process survives (pgrep empty)");
  });
});
