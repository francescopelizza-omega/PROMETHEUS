// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * mcp/host/mcp-audit.ts — the on-disk record of MCP trust decisions.
 *
 * A SEPARATE file from `exec-audit.jsonl`/`hooks-audit.jsonl` (same JSONL, newest-last
 * discipline as both), so a security review of "what did this server's tools do to get
 * blocked" doesn't have to filter someone else's audit stream to find it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function mcpAuditPath(home: string): string {
  return join(home, "config", "mcp-audit.jsonl");
}

/** Append one line. Never throws — an audit that can break a connection attempt would get
 *  removed the first time a full disk stopped someone working, and then there would be no
 *  audit at all. */
export function appendMcpAudit(home: string, entry: Record<string, unknown>): void {
  try {
    const file = mcpAuditPath(home);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    /* best effort */
  }
}
