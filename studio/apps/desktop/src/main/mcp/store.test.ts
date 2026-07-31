/**
 * store.test.ts — the disk-backed MCP ConfigStore persists + is fail-soft.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { mcpHost } from "@prometheus/core";

import { DiskConfigStore } from "./store.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "mcp-store-")), "servers.json");
}

function server(id: string): mcpHost.McpServerConfig {
  return {
    id,
    label: id,
    enabled: true,
    scope: "global",
    autoApprove: [],
    source: "manual",
    health: "unknown",
    transport: { kind: "stdio", command: "x", args: [] },
  };
}

test("DiskConfigStore persists across instances (add + remove)", () => {
  const path = tmpFile();
  const a = new DiskConfigStore(path);
  a.upsert(server("github"));
  a.upsert(server("filesystem"));

  const b = new DiskConfigStore(path); // fresh instance reloads from disk
  assert.deepEqual(
    b
      .list()
      .map((s) => s.id)
      .sort(),
    ["filesystem", "github"],
  );

  b.remove("github");
  const c = new DiskConfigStore(path);
  assert.deepEqual(
    c.list().map((s) => s.id),
    ["filesystem"],
  );
});

test("DiskConfigStore is fail-soft on a corrupt file", () => {
  const path = tmpFile();
  writeFileSync(path, "{ this is not json");
  const s = new DiskConfigStore(path);
  assert.deepEqual(s.list(), []);
  // still writable afterwards (overwrites the garbage)
  s.upsert(server("ok"));
  assert.equal(new DiskConfigStore(path).get("ok")?.id, "ok");
});
