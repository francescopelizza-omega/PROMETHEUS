/**
 * ping-server.mjs — a COMPLIANT MCP server that also sends requests of its own.
 *
 * Nothing here is malicious or exotic. `ping` is legal from either side at any time,
 * irrespective of declared capabilities, and a server numbers its own JSON-RPC ids from its own
 * counter — which starts at 1, exactly where ours does. This fixture exists because that
 * ordinary behaviour was enough to make our tool list come back EMPTY: the client matched the
 * server's `ping` id against its own in-flight `tools/list` and resolved it with `undefined`.
 *
 * It also records what the client sends back, so a test can assert we ANSWER a server request
 * rather than leaving it hanging until the server's own timeout.
 */
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

const TOOLS = [
  {
    name: "echo",
    description: "Echo a message back.",
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
];

/** Everything the client sent us that was NOT one of our expected requests. */
const clientReplies = [];

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ping-server", version: "1.0.0" },
      },
    });
    return;
  }

  if (msg.method === "notifications/initialized") {
    // The collision, deliberately: ids 1 and 2 are the ones the CLIENT is about to use.
    send({ jsonrpc: "2.0", id: 1, method: "ping" });
    send({ jsonrpc: "2.0", id: 2, method: "ping" });
    // A notification (no id) — must be ignored, never answered.
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
    // A request for a capability we never declared — must get a method-not-found, not silence.
    send({ jsonrpc: "2.0", id: 3, method: "sampling/createMessage", params: {} });
    return;
  }

  if (msg.method === "tools/list") {
    // THE COLLISION, precisely: a request of our own carrying the SAME id, sent while the
    // client's `tools/list` is still in flight — and BEFORE its answer. Waiting until the
    // client is idle would not reproduce anything, because there is no pending entry to
    // corrupt then. This ordering is what turned a healthy server into an empty tool list.
    send({ jsonrpc: "2.0", id: msg.id, method: "ping" });
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    return;
  }

  if (msg.method === "tools/call") {
    if (msg.params?.name === "replies") {
      // A back-channel so the test can read what the client answered our requests with.
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(clientReplies) }] },
      });
      return;
    }
    // Same collision on the call path — a tool result must survive it too.
    send({ jsonrpc: "2.0", id: msg.id, method: "ping" });
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong-ok" }] } });
    return;
  }

  // No `method` ⇒ this is the client ANSWERING one of our requests. Record it.
  if (msg.method === undefined && msg.id !== undefined) {
    clientReplies.push({ id: msg.id, result: msg.result, error: msg.error });
    return;
  }

  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } });
  }
});
