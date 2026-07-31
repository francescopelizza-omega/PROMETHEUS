/**
 * host.test.ts — MCP host policy + gate + manager lifecycle + importers.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { gateTarget, resolveCommandPath, verdictBlocks } from "./gate.js";
import { builtinPrometheusConfig, parseCodexToml, parseMcpServersJson } from "./importers.js";
import { InMemoryConfigStore, McpHostManager } from "./manager.js";
import { autoApprovable, confirmPolicy } from "./policy.js";
import {
  FakeTransport,
  type TransportFactory,
  isPrivateHost,
  validateRemoteTransport,
} from "./transports.js";
import type { HostGateVerdict, McpServerConfig, McpToolDescriptor } from "./types.js";

const RO_TOOL: McpToolDescriptor = {
  name: "read_file",
  inputSchema: {},
  annotations: { readOnlyHint: true },
};
const WRITE_TOOL: McpToolDescriptor = {
  name: "write_file",
  inputSchema: {},
  annotations: { destructiveHint: true },
};

function cfg(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "fs",
    label: "Filesystem",
    transport: { kind: "stdio", command: "mcp-fs", args: ["--root", "/w"] },
    enabled: false,
    scope: "global",
    autoApprove: [],
    source: "manual",
    health: "unknown",
    ...over,
  };
}

test("§4.3 policy: only read-only + granted is auto; destructive never auto", () => {
  assert.equal(confirmPolicy({ readOnlyHint: true }), "auto");
  assert.equal(confirmPolicy({ destructiveHint: true }), "always-confirm");
  assert.equal(confirmPolicy({ idempotentHint: true }), "confirm-once");
  assert.equal(confirmPolicy({ openWorldHint: true }), "confirm-scope");
  assert.equal(confirmPolicy(undefined), "always-confirm");

  assert.equal(autoApprovable({ readOnlyHint: true }, true), true);
  assert.equal(autoApprovable({ readOnlyHint: true }, false), false);
  assert.equal(autoApprovable({ destructiveHint: true }, true), false); // never, even granted
  assert.equal(autoApprovable({ idempotentHint: true }, true), false); // not read-only
});

test("gate routing: resolve command/url; marketplace repo wins over command", () => {
  assert.equal(resolveCommandPath({ kind: "stdio", command: "x", args: [] }), "x");
  assert.equal(resolveCommandPath({ kind: "http", url: "https://h" }), "https://h");
  assert.equal(gateTarget(cfg()), "mcp-fs");
  assert.equal(gateTarget(cfg({ source: "marketplace", repo: "owner/repo" })), "owner/repo");
  assert.equal(verdictBlocks({ verdict: "block", target: "x" }), true);
  assert.equal(verdictBlocks({ verdict: "error", target: "x" }), true);
  assert.equal(verdictBlocks({ verdict: "warn", target: "x" }), false);
  assert.equal(verdictBlocks(undefined), false);
});

test("manager: a block verdict ⇒ health=blocked, not enabled, connect refused", async () => {
  const store = new InMemoryConfigStore();
  const blockGate = async (target: string): Promise<HostGateVerdict> => ({
    verdict: "block",
    target,
  });
  const factory: TransportFactory = () => new FakeTransport();
  const mgr = new McpHostManager({ store, gate: blockGate, transport: factory });

  const added = await mgr.addServer(cfg({ enabled: true }));
  assert.equal(added.health, "blocked");
  assert.equal(added.enabled, false);
  await assert.rejects(() => mgr.connect("fs"), /blocked by nemesis/);
});

test("manager: allow verdict → connect → ready + cached tools; callTool gated", async () => {
  const store = new InMemoryConfigStore();
  const allowGate = async (target: string): Promise<HostGateVerdict> => ({
    verdict: "allow",
    target,
  });
  const transport = new FakeTransport({ tools: [RO_TOOL, WRITE_TOOL] });
  const factory: TransportFactory = () => transport;
  const mgr = new McpHostManager({ store, gate: allowGate, transport: factory });

  await mgr.addServer(cfg({ autoApprove: ["read_file"] }));
  const ready = await mgr.connect("fs");
  assert.equal(ready.health, "ready");
  assert.equal(ready.capabilities?.tools.length, 2);
  assert.equal(mgr.isConnected("fs"), true);

  // read-only + pre-approved → dispatched without confirm.
  await mgr.callTool("fs", "read_file", { path: "/w/a" });
  assert.deepEqual(transport.calls.at(-1), { name: "read_file", args: { path: "/w/a" } });

  // destructive → requires confirm; without it, blocked.
  await assert.rejects(() => mgr.callTool("fs", "write_file", {}), /requires confirmation/);
  // with confirm true → dispatched.
  await mgr.callTool("fs", "write_file", { path: "/w/b" }, { confirm: () => true });
  assert.deepEqual(transport.calls.at(-1), { name: "write_file", args: { path: "/w/b" } });

  await mgr.removeServer("fs");
  assert.equal(transport.closed, true);
  assert.equal(mgr.get("fs"), undefined);
});

test("importers: §2.4 builtin prometheus config (read-only tools auto-approved only)", () => {
  const b = builtinPrometheusConfig({
    node: "/usr/bin/node",
    serverJs: "/s/server.js",
    prometheusPy: "/p.py",
  });
  assert.equal(b.id, "prometheus");
  assert.equal(b.source, "builtin");
  assert.equal(b.enabled, true);
  assert.equal(b.autoApprove.length, 8);
  assert.equal(b.autoApprove.includes("prometheus_install"), false);
  assert.equal(b.autoApprove.includes("prometheus_scan"), true);
  assert.equal(b.transport.kind === "stdio" && b.transport.env?.PROMETHEUS_PY, "/p.py");
});

test("importers: parse json mcpServers + graceful on malformed; codex toml best-effort", () => {
  const json = JSON.stringify({
    mcpServers: {
      github: { command: "gh-mcp", args: ["serve"], env: { TOKEN: "x" } },
      remote: { url: "https://mcp.example" },
      bad: { nothing: true },
    },
  });
  const rows = parseMcpServersJson(json);
  assert.equal(rows.length, 2); // "bad" skipped
  assert.equal(
    rows.every((r) => r.enabled === false && r.source === "imported"),
    true,
  );
  assert.deepEqual(parseMcpServersJson("not json"), []);
  assert.deepEqual(parseMcpServersJson("{bad"), []);

  const toml = '[mcp_servers.fs]\ncommand = "mcp-fs"\nargs = ["--root", "/w"]\n';
  const codex = parseCodexToml(toml);
  assert.equal(codex.length, 1);
  assert.equal(codex[0]?.transport.kind === "stdio" && codex[0].transport.command, "mcp-fs");
});

/* ── APP-095: remote (streamable-HTTP) transport validation (SSRF gate) ──────*/

test("validateRemoteTransport: https public ok; http only on localhost", () => {
  assert.equal(
    validateRemoteTransport({ kind: "http", url: "https://mcp.example.com/rpc" }).ok,
    true,
  );
  assert.equal(
    validateRemoteTransport({ kind: "http", url: "http://localhost:8080/rpc" }).ok,
    true,
  );
  assert.equal(validateRemoteTransport({ kind: "http", url: "http://127.0.0.1:9000" }).ok, true);
  // plain http to a non-localhost host is rejected (fail-closed).
  assert.equal(validateRemoteTransport({ kind: "http", url: "http://mcp.example.com" }).ok, false);
});

test("validateRemoteTransport: private/link-local ranges blocked even on https (SSRF)", () => {
  for (const url of [
    "https://169.254.169.254/latest/meta-data", // cloud metadata
    "https://10.0.0.5/rpc",
    "https://192.168.1.10/rpc",
    "https://172.16.4.4/rpc",
  ]) {
    assert.equal(validateRemoteTransport({ kind: "http", url }).ok, false, url);
  }
  assert.equal(isPrivateHost("169.254.169.254"), true);
  assert.equal(isPrivateHost("10.1.2.3"), true);
  assert.equal(isPrivateHost("172.20.0.1"), true);
  assert.equal(isPrivateHost("8.8.8.8"), false);
});

test("validateRemoteTransport: IPv4-mapped IPv6 (the form new URL() emits) can't bypass the SSRF gate", () => {
  // WHATWG `new URL()` serializes a mapped tail as HEX (`::ffff:a9fe:a9fe`), which the old
  // dotted-decimal-only regex missed → metadata/RFC1918 reachable over https. Both forms + the
  // bracketed URL must now be blocked.
  assert.equal(isPrivateHost("::ffff:a9fe:a9fe"), true); // 169.254.169.254 (hex)
  assert.equal(isPrivateHost("::ffff:a00:5"), true); // 10.0.0.5 (hex)
  assert.equal(isPrivateHost("::ffff:169.254.169.254"), true); // dotted form still blocked
  assert.equal(isPrivateHost("::"), true); // unspecified
  assert.equal(
    validateRemoteTransport({ kind: "http", url: "https://[::ffff:169.254.169.254]/" }).ok,
    false,
  );
  assert.equal(validateRemoteTransport({ kind: "http", url: "https://[::ffff:a00:5]/" }).ok, false);
  // a legitimate global-unicast IPv6 is still allowed (not over-blocked).
  assert.equal(isPrivateHost("2606:4700:4700::1111"), false);
});

test("validateRemoteTransport: malformed url + non-http kind + header allowlist", () => {
  assert.equal(validateRemoteTransport({ kind: "http", url: "not a url" }).ok, false);
  assert.equal(validateRemoteTransport({ kind: "http" }).ok, false); // no url
  assert.equal(validateRemoteTransport({ kind: "stdio" }).ok, false); // not a remote transport
  // an allowed custom/auth header passes.
  assert.equal(
    validateRemoteTransport({
      kind: "http",
      url: "https://x.com",
      headers: { Authorization: "Bearer x", "X-Api-Key": "y" },
    }).ok,
    true,
  );
  // a smuggled framing/routing header is rejected.
  assert.equal(
    validateRemoteTransport({ kind: "http", url: "https://x.com", headers: { Host: "evil" } }).ok,
    false,
  );
  assert.equal(
    validateRemoteTransport({ kind: "http", url: "https://x.com", headers: { "Bad Name": "y" } })
      .ok,
    false,
  );
});
