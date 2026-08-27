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
  return { manager, gate: opts.gate ?? allowGate, confirm: async () => false };
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

test("prometheus mcp <typo>: reports unknown-verb, never silently defaults to list", async () => {
  // regression: command[1] is undefined for a TWO_WORD mismatch (parse.ts sets `unmatchedSub`
  // instead), so a typo used to silently fall through to the "list" branch.
  const deps = fakeDeps();
  const res = await runMcpCommand(ctxFor(["mcp", "ad", "fs", "--cmd", "node", "--json"]), deps);
  assert.equal(res.exitCode, 1);
  assert.equal((res.json as { error: string }).error, "unknown-verb");
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

test("--dry-run PREVIEWS an mcp add/remove — it used to do the real thing", async () => {
  /**
   * `dry-run` is a declared global boolean (`parse.ts`), forwarded to the engine for every
   * registry-routed verb and listed in `--help`, so a user who types it on a prom-native verb
   * reasonably expects a preview. `mcp add --dry-run` instead ran the full add: gated the
   * command, wrote `mcp-servers.json`, and the server showed up in `mcp list`.
   * `mcp remove --dry-run` likewise removed it. Both measured end to end through the built
   * binary, against a temp PROMETHEUS_HOME.
   */
  const deps = fakeDeps();

  const preview = await runMcpCommand(
    ctxFor(["mcp", "add", "probe", "--cmd", "echo", "--dry-run"]),
    deps,
  );
  assert.equal(preview.exitCode, 0);
  assert.equal((preview.json as { preview?: boolean }).preview, true);
  assert.match(preview.text ?? "", /preview/i);
  assert.equal(deps.manager.list().length, 0, "the preview PERSISTED the server");

  // the gate still runs in a preview — "would nemesis allow it" is the useful half
  assert.ok((preview.json as { gate?: unknown }).gate, "a preview must still report the verdict");

  // …and a preview of something nemesis BLOCKS says so, still without persisting
  const blocked = await runMcpCommand(
    ctxFor(["mcp", "add", "bad", "--cmd", "echo", "--dry-run"]),
    fakeDeps({ gate: blockGate }),
  );
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.text ?? "", /WOULD BE BLOCKED/);

  /* self-validating: a REAL add still adds, and a real remove still removes. */
  const added = await runMcpCommand(ctxFor(["mcp", "add", "probe", "--cmd", "echo"]), deps);
  assert.equal(added.exitCode, 0, added.text);
  assert.equal(deps.manager.list().length, 1);

  const rmPreview = await runMcpCommand(
    ctxFor(["mcp", "remove", "probe", "--dry-run", "--yes"]),
    deps,
  );
  assert.equal((rmPreview.json as { preview?: boolean }).preview, true);
  assert.equal(deps.manager.list().length, 1, "the preview REMOVED the server");

  const removed = await runMcpCommand(ctxFor(["mcp", "remove", "probe", "--yes"]), deps);
  assert.equal(removed.exitCode, 0);
  assert.equal(deps.manager.list().length, 0);
});

test("mcp add: a nemesis BLOCK reports what actually happened — the row IS persisted", async () => {
  // regression: the message said "not added" while `addServer` had deliberately persisted the
  // server as `enabled:false, health:"blocked"` — a record that is load-bearing (connect()
  // refuses on it). The control held; the REPORT was false, in the direction that matters:
  // `mcp list` showed the server and mcp-servers.json contained it.
  const { deps } = fakeDeps({ gate: blockGate });
  const out = await runMcpCommand(
    ctxFor(["mcp", "add", "evil", "--cmd", "sh", "--args", "-c rm -rf /", "--json"]),
    deps,
  );
  assert.equal(out.exitCode, 2);
  const json = out.json as { ok: boolean; error: string; stored?: boolean; enabled?: boolean };
  assert.equal(json.ok, false);
  assert.equal(json.error, "gate-blocked");
  assert.equal(json.stored, true, "the envelope must admit the row was written");
  assert.equal(json.enabled, false, "and that it is disabled");
  assert.ok(!/not added/.test(out.text ?? ""), "the text must not claim nothing was written");
});
