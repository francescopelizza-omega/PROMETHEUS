/**
 * permission-audit.ts — the bypassPermissions audit trail (CLI-033).
 *
 * `bypassPermissions` auto-runs every action the engine allows (the nemesis gate still
 * BLOCKs the dangerous ones), so each auto-approval leaves ONE line in a session audit log
 * — `ISO ts | tool | argv-summary | outcome` — under the prometheus config dir. The append
 * is O_APPEND (EOF-positioned) and the line is < 512 bytes, so concurrent detached runs
 * (CLI-034) never interleave. Fail-soft: a read-only home just means no trail, never a crash.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { agent } from "@prometheus/core";

import { prometheusHome } from "./home.js";

/** The audit log path (under the config dir, next to settings.json). */
export function permissionAuditPath(home: string = prometheusHome()): string {
  return join(home, "config", "permission-audit.log");
}

/** Compact one tool call's args into a one-line argv summary (truncation happens in formatAuditLine). */
export function argvSummaryOf(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    const val = typeof v === "string" ? v : Array.isArray(v) ? v.join(" ") : JSON.stringify(v);
    parts.push(`${k}=${val}`);
  }
  return parts.join(" ");
}

/**
 * Append ONE bypass-mode audit line (best-effort, fail-soft). Only call this on an actual
 * bypassPermissions auto-approval — no other mode writes a line.
 */
export function appendPermissionAudit(
  tool: string,
  args: Record<string, unknown>,
  outcome: string,
  home: string = prometheusHome(),
  now: () => string = () => new Date().toISOString(),
): void {
  try {
    mkdirSync(join(home, "config"), { recursive: true });
    const line = agent.formatAuditLine(now(), tool, argvSummaryOf(args), outcome);
    appendFileSync(permissionAuditPath(home), line, { flag: "a" });
  } catch {
    /* read-only / full disk → no trail, never a crash */
  }
}
