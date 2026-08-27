/**
 * gate-kind.test.ts — an MCP target must be judged as what it IS.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { gateServer, gateTargetSpec } from "./gate.js";
import type { McpServerConfig } from "./types.js";

const stdio = (command: string, args: string[] = []): McpServerConfig =>
  ({
    id: "s",
    label: "s",
    transport: { kind: "stdio", command, args },
    enabled: true,
    scope: "global",
    autoApprove: [],
    source: "manual",
    health: "unknown",
  }) as McpServerConfig;

test("a stdio target is the whole COMMAND LINE, judged as a command", () => {
  /**
   * The gate used to receive only a bare string and every runner fed it to nemesis's FILE
   * scanner. A launch command is not a file — measured against the real nemesis 1.12.0:
   * `gate("npx")` → verdict "error", risk 100, and even a resolved absolute binary
   * (`/usr/bin/env`) → "block". Both mean `verdictBlocks()`, so every server was persisted
   * `health:"blocked"` and NO MCP connector could be added, on any host.
   *
   * The args are part of the target because `npx` alone tells the scorer nothing, while
   * `npx -y some-package` is what actually runs.
   */
  assert.deepEqual(
    gateTargetSpec(stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"])),
    {
      target: "npx -y @modelcontextprotocol/server-filesystem /tmp",
      kind: "command",
    },
  );
  assert.deepEqual(gateTargetSpec(stdio("npx")), { target: "npx", kind: "command" });
});

test("an http transport is an ENDPOINT, not scannable source", () => {
  const cfg = {
    ...stdio("x"),
    transport: { kind: "http", url: "https://mcp.example.com/sse" },
  } as unknown as McpServerConfig;
  assert.deepEqual(gateTargetSpec(cfg), {
    target: "https://mcp.example.com/sse",
    kind: "endpoint",
  });
});

test("a marketplace repo is SOURCE, and wins over the transport", () => {
  const cfg = {
    ...stdio("npx", ["-y", "pkg"]),
    source: "marketplace",
    repo: "https://github.com/org/servers",
  } as unknown as McpServerConfig;
  assert.deepEqual(gateTargetSpec(cfg), {
    target: "https://github.com/org/servers",
    kind: "source",
  });
});

test("gateServer hands the runner BOTH the target and its kind", async () => {
  // A runner that ignores `kind` is how the bug happened; pin that it is passed.
  const seen: { target: string; kind?: string }[] = [];
  await gateServer(stdio("npx", ["-y", "pkg"]), async (target, kind) => {
    seen.push({ target, ...(kind ? { kind } : {}) });
    return { verdict: "allow", target, findings: 0 };
  });
  assert.deepEqual(seen, [{ target: "npx -y pkg", kind: "command" }]);
});
