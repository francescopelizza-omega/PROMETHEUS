// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * mcp/host/policy.ts — the §4.3 capability & confirm policy (THE load-bearing rule).
 *
 * Every tool's auto-approve decision keys off the MCP annotations declared in the
 * tool catalog (mcp/server/tools.ts) — the SAME annotations the external SDK server
 * uses. This module is the single source of that policy, shared by the MCP host
 * (callTool) and the agent ToolBroker (§4). It is PURE.
 *
 * The hard contract (enforced, not advisory):
 *   - destructiveHint  → ALWAYS confirm; NEVER auto-approved, even with a grant.
 *   - readOnlyHint     → auto-approvable IF (and only if) the grant opts in.
 *   - idempotentHint   → confirm once per session (not silently auto).
 *   - openWorldHint    → confirm + surface network/host scope.
 *   - unknown/none     → confirm (fail safe).
 * A grant's `autoApprove` flag is honored ONLY for readOnlyHint tools.
 */
import type { ToolAnnotations } from "../server/tools.js";

/** The descriptive confirm category for a tool (drives the UI affordance). */
export type ConfirmPolicy = "auto" | "confirm-once" | "always-confirm" | "confirm-scope";

/** Classify a tool's confirm policy from its annotations (descriptive). */
export function confirmPolicy(ann: ToolAnnotations | undefined): ConfirmPolicy {
  const a = ann ?? {};
  if (a.destructiveHint) return "always-confirm";
  if (a.openWorldHint) return "confirm-scope";
  if (a.idempotentHint) return "confirm-once";
  if (a.readOnlyHint) return "auto";
  return "always-confirm";
}

/**
 * The ENFORCED auto-approve gate. Returns true ONLY when a tool may run without a
 * human click: it must be read-only, NOT destructive, and the grant must opt in.
 */
export function autoApprovable(ann: ToolAnnotations | undefined, granted: boolean): boolean {
  const a = ann ?? {};
  if (a.destructiveHint) return false; // never, even with a grant
  if (!a.readOnlyHint) return false; // idempotent/openWorld/unknown require confirm
  return granted === true;
}
