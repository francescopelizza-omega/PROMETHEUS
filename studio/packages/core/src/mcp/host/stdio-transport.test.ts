/**
 * stdio-transport.test.ts — a server may talk back, and that must not corrupt our replies.
 *
 * JSON-RPC is bidirectional. A server can send US a request at any time — `ping` is legal from
 * either side irrespective of declared capabilities — and it numbers its ids from its own
 * counter, which starts at 1 exactly where ours does. The transport used to key purely on
 * `typeof msg.id === "number"`, so a server's `ping` with id 1 was matched against our in-flight
 * `tools/list`, resolved it with `undefined`, and `listTools` turned that into `[]`.
 *
 * The failure mode is what makes it worth a fixture rather than a unit stub: the server connects,
 * reports `ready`, and offers ZERO tools, with nothing anywhere explaining why. It is
 * indistinguishable from a server that genuinely has no tools.
 *
 * These run against a real child process, because the bug lives in the framing between two
 * processes and a fake that speaks only our half of the protocol cannot express it.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { StdioMcpTransport } from "./stdio-transport.js";
import type { McpServerConfig } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PING_SERVER = join(HERE, "ping-server.mjs");

function cfg(): McpServerConfig {
  return {
    id: "ping",
    label: "Ping",
    enabled: true,
    scope: "global",
    autoApprove: [],
    source: "manual",
    health: "unknown",
    transport: { kind: "stdio", command: process.execPath, args: [PING_SERVER] },
  };
}

/** Let the server's unsolicited requests land BEFORE we ask for anything. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

test("a server that pings us does not empty our tool list", async () => {
  const t = new StdioMcpTransport(cfg());
  await t.connect();
  try {
    await settle();
    const tools = await t.listTools();
    assert.equal(tools.length, 1, "the tool list came back empty — a server request ate the reply");
    assert.equal(tools[0]?.name, "echo");
    assert.equal(tools[0]?.annotations?.readOnlyHint, true);
  } finally {
    await t.close();
  }
});

test("a tool call still returns its own result while the server is talking back", async () => {
  const t = new StdioMcpTransport(cfg());
  await t.connect();
  try {
    await settle();
    const res = await t.callTool("echo", { message: "hi" });
    assert.equal(res.isError, false);
    assert.match(JSON.stringify(res.content), /pong-ok/);
  } finally {
    await t.close();
  }
});

test("a server `ping` is ANSWERED, not left hanging", async () => {
  // A compliant server may block on its request until its own timeout. Silence turns a 1ms
  // round trip into a stall, and the user sees an unexplained pause.
  const t = new StdioMcpTransport(cfg());
  await t.connect();
  try {
    await settle();
    const res = await t.callTool("replies", {});
    const text = (res.content as { text?: string }[])?.[0]?.text ?? "[]";
    const replies = JSON.parse(text) as {
      id: number;
      result?: unknown;
      error?: { code: number };
    }[];
    const pings = replies.filter((r) => r.id === 1 || r.id === 2);
    assert.equal(pings.length, 2, `expected both pings answered, got ${JSON.stringify(replies)}`);
    for (const p of pings) assert.deepEqual(p.result, {}, "ping must return an empty result");
  } finally {
    await t.close();
  }
});

test("an unsupported server request gets METHOD_NOT_FOUND, not silence", async () => {
  // We declare `capabilities: {}`. A server asking for sampling is asking for something we
  // truthfully do not have — saying so in one round trip beats stalling it until it times out.
  const t = new StdioMcpTransport(cfg());
  await t.connect();
  try {
    await settle();
    const res = await t.callTool("replies", {});
    const text = (res.content as { text?: string }[])?.[0]?.text ?? "[]";
    const replies = JSON.parse(text) as { id: number; error?: { code: number; message: string } }[];
    const sampling = replies.find((r) => r.id === 3);
    assert.ok(sampling, "the sampling request was never answered");
    assert.equal(sampling?.error?.code, -32601);
    assert.match(sampling?.error?.message ?? "", /sampling\/createMessage/);
  } finally {
    await t.close();
  }
});

test("a NOTIFICATION is never answered — answering one is a protocol error", async () => {
  const t = new StdioMcpTransport(cfg());
  await t.connect();
  try {
    await settle();
    const res = await t.callTool("replies", {});
    const text = (res.content as { text?: string }[])?.[0]?.text ?? "[]";
    const replies = JSON.parse(text) as { id: unknown }[];
    assert.equal(
      replies.some((r) => r.id === undefined || r.id === null),
      false,
      "an id-less notification was answered",
    );
  } finally {
    await t.close();
  }
});
