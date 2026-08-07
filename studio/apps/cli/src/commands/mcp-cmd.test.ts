/**
 * mcp-cmd.test.ts — `prometheus mcp` (CLI-036). Unit tests use an InMemory store + a fake gate +
 * FakeTransport; two tests use the REAL core stdio transport against a fixture MCP server.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mcpHost } from "@prometheus/core";
import {
  createReferenceHarness,
  createStdioTransportFactory,
  prewarmReferenceServer,
} from "@prometheus/core/mcp-node";

import { makeContext } from "../context.js";
import { CliMcpConfigStore, mcpStorePath } from "../mcp-store.js";
import { parseArgs } from "../parse.js";
import { type McpCmdDeps, runMcpCommand } from "./mcp-cmd.js";

const ctxFor = (argv: string[]) => makeContext(parseArgs(argv));
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "__fixtures__", "fake-mcp-server.mjs");

const allowGate: mcpHost.NemesisGate = async (target) => ({
  verdict: "allow",
  target,
  findings: 0,
});
const blockGate: mcpHost.NemesisGate = async (target) => ({
  verdict: "block",
  target,
  findings: 3,
  riskScore: 90,
});

function fakeDeps(
  opts: {
    gate?: mcpHost.NemesisGate;
    tools?: mcpHost.McpToolDescriptor[];
    failConnect?: boolean;
  } = {},
): McpCmdDeps {
  const manager = new mcpHost.McpHostManager({
    store: new mcpHost.InMemoryConfigStore(),
    gate: opts.gate ?? allowGate,
    transport: () =>
      new mcpHost.FakeTransport({
        ...(opts.tools ? { tools: opts.tools } : {}),
        ...(opts.failConnect ? { failConnect: true } : {}),
      }),
  });
  return { manager, confirm: async () => false };
}

/** A deps whose manager uses the REAL stdio transport (for the fixture-server tests). */
function realDeps(): McpCmdDeps {
  const manager = new mcpHost.McpHostManager({
    store: new mcpHost.InMemoryConfigStore(),
    gate: allowGate,
    transport: createStdioTransportFactory(),
  });
  return { manager, confirm: async () => false };
}

test("mcp add: gated + persisted; list shows it (disk store survives a fresh process)", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-mcp-"));
  try {
    const store = new CliMcpConfigStore(mcpStorePath(home));
    store.upsert({
      id: "fake",
      label: "fake",
      transport: { kind: "stdio", command: "node", args: ["x.mjs"] },
      enabled: true,
      scope: "global",
      autoApprove: [],
      source: "manual",
      health: "unknown",
    });
    // a FRESH store instance (simulating a second `prometheus` process) still sees it.
    const fresh = new CliMcpConfigStore(mcpStorePath(home));
    assert.equal(fresh.get("fake")?.transport.kind, "stdio");
    assert.equal(fresh.list().length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("mcp add: option-shaped --cmd is refused (exit 2, nothing stored)", async () => {
  const deps = fakeDeps();
  // the `=` form pins the value so it can't collide with a real global flag.
  const out = await runMcpCommand(ctxFor(["mcp", "add", "evil", "--cmd=-rf"]), deps);
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error: string }).error, "bad-cmd");
  assert.equal(deps.manager.list().length, 0);
});

test("mcp add: a gate-BLOCKED command is refused fail-closed (config unchanged usability)", async () => {
  const deps = fakeDeps({ gate: blockGate });
  const out = await runMcpCommand(
    ctxFor(["mcp", "add", "bad", "--cmd", "node", "--args", "s.mjs"]),
    deps,
  );
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error: string }).error, "gate-blocked");
  // addServer persists it as health:"blocked" (not connectable) — it is never spawnable.
  assert.equal(deps.manager.get("bad")?.health, "blocked");
});

test("mcp add ok → list shows it; --json emits the config array", async () => {
  const deps = fakeDeps();
  const add = await runMcpCommand(
    ctxFor(["mcp", "add", "fs", "--cmd", "node", "--args", "server.mjs --root ."]),
    deps,
  );
  assert.equal(add.exitCode, 0);
  const list = await runMcpCommand(ctxFor(["mcp", "list", "--json"]), deps);
  const env = list.json as {
    ok: boolean;
    servers: { id: string; transport: { args: string[] } }[];
  };
  assert.equal(env.servers.length, 1);
  assert.equal(env.servers[0]?.id, "fs");
  assert.deepEqual(env.servers[0]?.transport.args, ["server.mjs", "--root", "."]); // server flags kept
});

test("mcp remove: unknown → exit 2; --yes deletes; list no longer shows it", async () => {
  const deps = fakeDeps();
  await runMcpCommand(ctxFor(["mcp", "add", "fs", "--cmd", "node"]), deps);
  const miss = await runMcpCommand(ctxFor(["mcp", "remove", "nope"]), deps);
  assert.equal(miss.exitCode, 2);
  const noConfirm = await runMcpCommand(ctxFor(["mcp", "remove", "fs"]), deps);
  assert.equal(noConfirm.exitCode, 2); // confirm required (default deny)
  const yes = await runMcpCommand(ctxFor(["mcp", "remove", "fs", "--yes"]), deps);
  assert.equal(yes.exitCode, 0);
  assert.equal(deps.manager.list().length, 0);
});

test("mcp test: fake transport reports the tool count + names", async () => {
  const deps = fakeDeps({ tools: [{ name: "a" }, { name: "b" }] });
  await runMcpCommand(ctxFor(["mcp", "add", "fs", "--cmd", "node"]), deps);
  const out = await runMcpCommand(ctxFor(["mcp", "test", "fs", "--json"]), deps);
  assert.equal(out.exitCode, 0);
  assert.deepEqual((out.json as { tools: string[] }).tools, ["a", "b"]);
});

test("mcp test: a connect failure → exit 2, honest message (never hangs)", async () => {
  const deps = fakeDeps({ failConnect: true });
  await runMcpCommand(ctxFor(["mcp", "add", "fs", "--cmd", "node"]), deps);
  const out = await runMcpCommand(ctxFor(["mcp", "test", "fs"]), deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /failed/);
});

test("mcp add --url: stores an http transport (ref only, no secret) → list shows it (CLI-037)", async () => {
  const deps = fakeDeps();
  const add = await runMcpCommand(
    ctxFor([
      "mcp",
      "add",
      "remote",
      "--url",
      "https://api.example.com/mcp",
      "--auth-secret",
      "my-token",
      "--timeout-ms",
      "5000",
    ]),
    deps,
  );
  assert.equal(add.exitCode, 0, add.text ?? "");
  const list = await runMcpCommand(ctxFor(["mcp", "list", "--json"]), deps);
  const env = list.json as {
    servers: { id: string; transport: Record<string, unknown> }[];
  };
  assert.equal(env.servers.length, 1);
  const tr = env.servers[0]?.transport as {
    kind: string;
    url: string;
    authSecretRef?: string;
    timeoutMs?: number;
  };
  assert.equal(tr.kind, "http");
  assert.equal(tr.url, "https://api.example.com/mcp");
  assert.equal(tr.authSecretRef, "my-token"); // the REF name, not the token value
  assert.equal(tr.timeoutMs, 5000);
  // the serialized config must never contain a bearer/secret value.
  assert.doesNotMatch(JSON.stringify(env), /Bearer|s3cr3t/);
});

test("mcp add --url: a private/link-local url is refused fail-closed (SSRF, exit 2)", async () => {
  const deps = fakeDeps();
  const out = await runMcpCommand(
    ctxFor(["mcp", "add", "meta", "--url", "https://169.254.169.254/mcp"]),
    deps,
  );
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error: string }).error, "bad-url");
  assert.equal(deps.manager.list().length, 0);
});

test("mcp add --url: option-shaped url + bad timeout are refused (exit 2)", async () => {
  const deps = fakeDeps();
  const badUrl = await runMcpCommand(ctxFor(["mcp", "add", "x", "--url=-oops"]), deps);
  assert.equal(badUrl.exitCode, 2);
  assert.equal((badUrl.json as { error: string }).error, "bad-url");
  const badTimeout = await runMcpCommand(
    ctxFor(["mcp", "add", "y", "--url", "https://ok.example.com/mcp", "--timeout-ms", "0"]),
    deps,
  );
  assert.equal(badTimeout.exitCode, 2);
  assert.equal((badTimeout.json as { error: string }).error, "bad-timeout");
  assert.equal(deps.manager.list().length, 0);
});

test("mcp test: REAL stdio handshake against the fixture server reports its tools", async () => {
  // realDeps uses the allow-gate (a stub) + the REAL core stdio transport, so `add` stores
  // without spawning python and `test` runs the genuine initialize→tools/list handshake.
  const deps = realDeps();
  const add = await runMcpCommand(
    ctxFor(["mcp", "add", "fixture", "--cmd", process.execPath, "--args", FIXTURE]),
    deps,
  );
  assert.equal(add.exitCode, 0, add.text ?? "");
  const out = await runMcpCommand(ctxFor(["mcp", "test", "fixture", "--json"]), deps);
  assert.equal(out.exitCode, 0, out.text ?? "");
  assert.deepEqual((out.json as { tools: string[] }).tools.sort(), ["echo", "ping"]);
});

test(
  "mcp test: REAL reference server handshake reports its tools (opt-in PROM_MCP_E2E=1) (CLI-038)",
  { skip: process.env.PROM_MCP_E2E !== "1" },
  async () => {
    await prewarmReferenceServer();
    const harness = createReferenceHarness();
    const manager = new mcpHost.McpHostManager({
      store: new mcpHost.InMemoryConfigStore(),
      gate: allowGate,
      transport: createStdioTransportFactory(harness.transportDeps),
    });
    const deps: McpCmdDeps = { manager, confirm: async () => false };
    try {
      await manager.addServer(harness.cfg); // id "e2e-everything" (npx stdio), fake allow-gate
      const out = await runMcpCommand(ctxFor(["mcp", "test", harness.cfg.id, "--json"]), deps);
      assert.equal(out.exitCode, 0, out.text ?? "");
      const tools = (out.json as { tools: string[] }).tools;
      assert.ok(tools.includes("echo"), `echo reported (got: ${tools.join(", ")})`);
    } finally {
      await harness.kill();
      assert.equal(harness.isRunning(), false, "no orphaned reference-server process");
    }
  },
);
