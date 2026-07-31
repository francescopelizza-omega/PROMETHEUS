/**
 * transport.test.ts — the real stdio MCP transport against a mock server subprocess.
 *
 * Proves the JSON-RPC-over-stdio wire protocol end to end: connect (initialize
 * handshake) → tools/list → tools/call round-trip, plus a spawn failure rejecting
 * connect. Hermetic — spawns `node mock-server.mjs`, no external MCP server needed.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { mcpHost } from "@prometheus/core";

import { createStdioTransportFactory } from "./transport.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, "mock-server.mjs");

function cfg(over: Partial<mcpHost.McpServerConfig> = {}): mcpHost.McpServerConfig {
  return {
    id: "mock",
    label: "Mock",
    enabled: true,
    scope: "global",
    autoApprove: [],
    source: "manual",
    health: "unknown",
    transport: { kind: "stdio", command: process.execPath, args: [MOCK] },
    ...over,
  };
}

test("stdio transport: connect → listTools → callTool round-trip", async () => {
  const t = createStdioTransportFactory()(cfg());
  await t.connect();
  try {
    const tools = await t.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "echo");
    assert.equal(tools[0]?.annotations?.readOnlyHint, true);
    const res = await t.callTool("echo", { hi: "there" });
    assert.equal(res.isError, false);
  } finally {
    await t.close();
  }
});

test("stdio transport: a bad command rejects connect", async () => {
  const t = createStdioTransportFactory()(
    cfg({ transport: { kind: "stdio", command: "definitely-not-a-real-binary-xyz", args: [] } }),
  );
  await assert.rejects(() => t.connect());
});

test("stdio transport: http transport is rejected (stdio-only today)", async () => {
  const t = createStdioTransportFactory()(
    cfg({ transport: { kind: "http", url: "http://localhost:9" } }),
  );
  await assert.rejects(() => t.connect(), /not supported/);
});

/* ── APP-095: streamable-HTTP transport against a real local server ──────────*/

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after } from "node:test";
import { createMcpTransportFactory } from "./transport.js";

function httpCfg(url: string): mcpHost.McpServerConfig {
  return cfg({ id: "remote", label: "Remote", transport: { kind: "http", url } });
}

const HTTP_TOOLS = [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }];

function makeHttpServer(sse: boolean): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const msg = JSON.parse(body || "{}") as { id?: number; method?: string };
      const reply = (result: unknown): void => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
        if (sse && msg.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          // split the SSE event across writes to exercise cross-read buffering.
          res.write(`data: ${payload.slice(0, 12)}`);
          res.write(`${payload.slice(12)}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" }).end(payload);
        }
      };
      if (msg.method === "initialize") {
        res.setHeader("Mcp-Session-Id", "sess-123");
        reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t" } });
      } else if (msg.method === "notifications/initialized") {
        res.writeHead(202).end();
      } else if (msg.method === "tools/list") {
        reply({ tools: HTTP_TOOLS });
      } else {
        reply({});
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

const httpServers: Server[] = [];
after(() => {
  for (const s of httpServers) s.close();
});

test("http transport: connects to a real local server (JSON mode) + lists tools (AC1)", async () => {
  const { server, url } = await makeHttpServer(false);
  httpServers.push(server);
  const t = createMcpTransportFactory()(httpCfg(url));
  await t.connect();
  const tools = await t.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "echo");
  await t.close();
});

test("http transport: reads an SSE response buffered across writes", async () => {
  const { server, url } = await makeHttpServer(true);
  httpServers.push(server);
  const t = createMcpTransportFactory()(httpCfg(url));
  await t.connect();
  const tools = await t.listTools();
  assert.equal(tools[0]?.name, "echo");
  await t.close();
});

test("http transport: refuses a private-range url before any I/O (SSRF gate, AC2)", async () => {
  const t = createMcpTransportFactory()(httpCfg("https://169.254.169.254/mcp"));
  await assert.rejects(() => t.connect(), /private|SSRF|invalid/i);
});
