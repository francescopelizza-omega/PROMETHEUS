#!/usr/bin/env node
/**
 * fake-mcp-server.mjs — a tiny MCP stdio server for CLI-036 `mcp test` tests. Speaks
 * newline-delimited JSON-RPC 2.0: replies to `initialize` and `tools/list`, ignores the
 * `notifications/initialized` notification. Emits a human banner to stderr (a real server
 * does) to prove the client tolerates non-protocol stderr.
 */
process.stderr.write("fake-mcp-server: starting up (this is stderr noise)\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
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
        serverInfo: { name: "fake-mcp-server", version: "1.0.0" },
      });
    } else if (msg.method === "tools/list") {
      reply(msg.id, {
        tools: [
          { name: "echo", description: "echo the input", inputSchema: { type: "object" } },
          { name: "ping", description: "ping/pong", inputSchema: { type: "object" } },
        ],
      });
    }
    // notifications (no id) are ignored.
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
