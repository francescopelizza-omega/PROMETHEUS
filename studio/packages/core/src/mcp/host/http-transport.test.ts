/**
 * http-transport.test.ts — the streamable-HTTP MCP client transport (CLI-037).
 *
 * A real local `node:http` fixture serves BOTH plain-JSON and SSE-framed JSON-RPC replies so
 * the handshake, tools/list, auth header, session-id round-trip, and DELETE-on-close are all
 * exercised over genuine sockets; an injected hanging `fetch` proves the timeout aborts with a
 * typed `McpTransportError`. Hermetic — no external MCP server, no keychain touched.
 */
import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { type FetchLike, StreamableHttpTransport } from "./http-transport.js";
import { McpTransportError } from "./transports.js";
import type { McpServerConfig } from "./types.js";

function httpCfg(url: string, extra: Record<string, unknown> = {}): McpServerConfig {
  return {
    id: "remote",
    label: "Remote",
    enabled: true,
    scope: "global",
    autoApprove: [],
    source: "manual",
    health: "unknown",
    transport: { kind: "http", url, ...extra },
  };
}

const HTTP_TOOLS = [{ name: "echo", description: "echoes", inputSchema: { type: "object" } }];

interface Captured {
  authHeaders: (string | undefined)[];
  sessionHeaders: (string | undefined)[];
  methods: string[];
}

/** A streamable-HTTP MCP fixture; `sse` upgrades tools/list to an SSE stream split across writes. */
function makeHttpServer(
  sse: boolean,
): Promise<{ server: Server; url: string; captured: Captured }> {
  const captured: Captured = { authHeaders: [], sessionHeaders: [], methods: [] };
  const server = createServer((req, res) => {
    captured.methods.push(req.method ?? "");
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      captured.authHeaders.push(req.headers.authorization);
      captured.sessionHeaders.push(
        typeof req.headers["mcp-session-id"] === "string"
          ? req.headers["mcp-session-id"]
          : undefined,
      );
      const msg = JSON.parse(body || "{}") as { id?: number; method?: string };
      const reply = (result: unknown): void => {
        const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
        if (sse && msg.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${payload.slice(0, 12)}`); // split the event across writes on purpose
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
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, captured });
    });
  });
}

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

test("http transport: JSON handshake → tools/list, and session id is echoed after initialize", async () => {
  const { server, url, captured } = await makeHttpServer(false);
  servers.push(server);
  const t = new StreamableHttpTransport(httpCfg(url));
  await t.connect();
  const tools = await t.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "echo");
  // the initialize response set Mcp-Session-Id: sess-123; every later request must echo it.
  assert.equal(captured.sessionHeaders.at(-1), "sess-123");
  await t.close();
  assert.ok(captured.methods.includes("DELETE"), "close() sends a best-effort DELETE");
});

test("http transport: reads an SSE response buffered across writes (AC1)", async () => {
  const { server, url } = await makeHttpServer(true);
  servers.push(server);
  const t = new StreamableHttpTransport(httpCfg(url));
  await t.connect();
  const tools = await t.listTools();
  assert.equal(tools[0]?.name, "echo");
  await t.close();
});

test("http transport: bearer auth header is sent only when authSecretRef resolves (AC3)", async () => {
  const { server, url, captured } = await makeHttpServer(false);
  servers.push(server);
  const t = new StreamableHttpTransport(httpCfg(url, { authSecretRef: "my-token" }), {
    resolveAuth: async (ref) => (ref === "my-token" ? "s3cr3t" : undefined),
  });
  await t.connect();
  await t.close();
  assert.ok(
    captured.authHeaders.some((h) => h === "Bearer s3cr3t"),
    "resolved token is sent as a bearer header",
  );

  const { server: s2, url: u2, captured: cap2 } = await makeHttpServer(false);
  servers.push(s2);
  const noAuth = new StreamableHttpTransport(httpCfg(u2)); // no ref, no resolver
  await noAuth.connect();
  await noAuth.close();
  assert.ok(
    cap2.authHeaders.every((h) => h === undefined),
    "no Authorization header when there is no authSecretRef",
  );
});

test("http transport: a stalled request aborts at the configured timeout with kind 'timeout' (AC2)", async () => {
  // an injected fetch that never resolves until aborted — proves the wall-clock timeout fires
  // and rejects a TYPED error, with no dangling timer/socket left to keep the loop alive.
  const hangingFetch: FetchLike = ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    })) as unknown as FetchLike;
  const t = new StreamableHttpTransport(httpCfg("https://example.test/mcp", { timeoutMs: 30 }), {
    fetch: hangingFetch,
  });
  await assert.rejects(
    () => t.connect(),
    (e) => e instanceof McpTransportError && e.kind === "timeout",
  );
});

test("http transport: refuses a private-range url before any I/O (SSRF gate)", async () => {
  let called = false;
  const guardFetch: FetchLike = (() => {
    called = true;
    return Promise.reject(new Error("must not be reached"));
  }) as unknown as FetchLike;
  const t = new StreamableHttpTransport(httpCfg("https://169.254.169.254/mcp"), {
    fetch: guardFetch,
  });
  await assert.rejects(
    () => t.connect(),
    (e) => e instanceof McpTransportError && /private|SSRF/i.test((e as Error).message),
  );
  assert.equal(called, false, "no network I/O happens for a blocked URL");
});
