/**
 * agents/toolBroker.ts — the §4.3 capability chokepoint (PURE, the load-bearing rule).
 *
 * Every tool call in an agent run passes through `brokerDecision` BEFORE dispatch.
 * It keys off the MCP annotations (the same ones in mcp/server/tools.ts), the agent's
 * per-tool grant, and the per-run call count. The hard contract (mcp/host/policy.ts):
 *   - a ref NOT in the agent's allowlist → block
 *   - over maxCallsPerRun → block
 *   - read-only + grant.autoApprove → auto
 *   - everything else (destructive/idempotent/openWorld/unknown) → confirm
 * destructiveHint is NEVER auto, even with autoApprove (enforced in policy.autoApprovable).
 */
import { autoApprovable, confirmPolicy } from "../mcp/host/policy.js";
import type { ToolAnnotations } from "../mcp/server/index.js";
import type { AgentToolGrant } from "./types.js";

export interface BrokerInput {
  ref: string;
  annotations?: ToolAnnotations;
  /** the matching grant for this ref (undefined ⇒ not in the agent's allowlist). */
  grant?: AgentToolGrant;
  /** prior calls of THIS ref in the current run. */
  callsSoFar?: number;
}

export interface BrokerDecision {
  action: "auto" | "confirm" | "block";
  reason: string;
}

/** The single decision function the orchestrator routes every tool call through. */
export function brokerDecision(input: BrokerInput): BrokerDecision {
  const { ref, annotations, grant, callsSoFar = 0 } = input;
  if (!grant) {
    return { action: "block", reason: `tool "${ref}" is not in the agent's allowlist` };
  }
  if (grant.maxCallsPerRun != null && callsSoFar >= grant.maxCallsPerRun) {
    return {
      action: "block",
      reason: `tool "${ref}" exceeded maxCallsPerRun (${grant.maxCallsPerRun})`,
    };
  }
  if (autoApprovable(annotations, grant.autoApprove === true)) {
    return { action: "auto", reason: "read-only tool, pre-approved" };
  }
  return { action: "confirm", reason: `requires confirmation (${confirmPolicy(annotations)})` };
}

/** Find the grant for a ref in an agent's allowlist. */
export function grantFor(grants: AgentToolGrant[], ref: string): AgentToolGrant | undefined {
  return grants.find((g) => g.ref === ref);
}
