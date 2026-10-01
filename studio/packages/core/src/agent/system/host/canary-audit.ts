// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/host/canary-audit.ts — the on-disk record of tripped canary tokens.
 *
 * A SEPARATE file from `exec-audit.jsonl`/`hooks-audit.jsonl`/`mcp-audit.jsonl` (same JSONL,
 * newest-last discipline as all three): a canary trip means something got the model to act
 * against an explicit instruction, which is a different severity of event from "a command was
 * scanned" or "a hook ran" and deserves its own stream rather than being buried in one of those.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function canaryAuditPath(home: string): string {
  return join(home, "config", "canary-audit.jsonl");
}

/** Append one line. Never throws — matches `appendExecAudit`/`appendMcpAudit`'s contract: an
 *  audit that can break a turn would get removed the first time it did, and then there would be
 *  no audit at all. */
export function appendCanaryAudit(home: string, entry: Record<string, unknown>): void {
  try {
    const file = canaryAuditPath(home);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    /* best effort */
  }
}
