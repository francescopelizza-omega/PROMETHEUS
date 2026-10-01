#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * mock-server.mjs — a minimal MCP stdio server used ONLY by transport.test.ts.
 *
 * Speaks the same newline-delimited JSON-RPC 2.0 wire protocol the real transport
 * drives: initialize → notifications/initialized → tools/list → tools/call. Kept as a
 * plain .mjs (not a *.test.ts) so the test runner spawns it but never collects it.
 */
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard line-splitting loop
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      reply(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "1" },
      });
    } else if (msg.method === "notifications/initialized") {
      // notification — no reply
    } else if (msg.method === "tools/list") {
      reply(msg.id, {
        tools: [
          {
            name: "echo",
            description: "echoes its arguments",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
        ],
      });
    } else if (msg.method === "tools/call") {
      const args = msg.params?.arguments ?? {};
      reply(msg.id, {
        content: [{ type: "text", text: JSON.stringify(args) }],
        isError: false,
      });
    } else if (typeof msg.id !== "undefined") {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })}\n`,
      );
    }
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
