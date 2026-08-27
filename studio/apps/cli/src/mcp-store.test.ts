/**
 * mcp-store.test.ts — the CLI's MCP config store must write a DELTA, not a snapshot.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliMcpConfigStore } from "./mcp-store.js";

const server = (id: string) => ({ id, transport: { kind: "stdio" as const, command: id } });
const idsOnDisk = (path: string): string[] =>
  (JSON.parse(readFileSync(path, "utf8")).servers as { id: string }[]).map((s) => s.id).sort();

test("a write does not clobber a server another process added since startup", () => {
  /**
   * `load()` runs once, in the constructor, and `persist()` rewrote the whole file from that
   * in-memory snapshot. A chat session open in one terminal plus `prometheus mcp add beta` in
   * another ended with `beta` silently deleted the moment the session's own `disconnect()`
   * upserted a health field on an unrelated server.
   */
  const dir = mkdtempSync(join(tmpdir(), "prom-mcp-store-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify({ servers: [server("alpha")] }));

  const session = new CliMcpConfigStore(path); // long-lived: snapshot taken NOW
  const other = new CliMcpConfigStore(path); // a second process
  other.upsert(server("beta"));
  assert.deepEqual(idsOnDisk(path), ["alpha", "beta"]);

  // the long-lived session writes an unrelated update on shutdown
  session.upsert({ ...server("alpha"), health: "unknown" } as never);
  assert.deepEqual(idsOnDisk(path), ["alpha", "beta"], "beta was clobbered by a stale snapshot");
});

test("remove deletes only its own entry, keeping concurrent additions", () => {
  const dir = mkdtempSync(join(tmpdir(), "prom-mcp-store-rm-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify({ servers: [server("alpha")] }));
  const session = new CliMcpConfigStore(path);
  new CliMcpConfigStore(path).upsert(server("beta"));
  session.remove("alpha");
  assert.deepEqual(idsOnDisk(path), ["beta"]);
});

test("an UNPARSEABLE config is not replaced by one process's slice of it", () => {
  // Falling back to an empty map would turn a corrupt file into a silent wipe.
  const dir = mkdtempSync(join(tmpdir(), "prom-mcp-store-bad-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify({ servers: [server("alpha")] }));
  const session = new CliMcpConfigStore(path); // reads alpha into memory
  writeFileSync(path, "{ not json"); // something corrupts it
  session.upsert(server("beta"));
  assert.deepEqual(idsOnDisk(path), ["alpha", "beta"], "the in-memory view is the safer base");
});
