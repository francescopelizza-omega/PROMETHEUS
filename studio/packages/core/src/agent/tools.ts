/**
 * agent/tools.ts — the agent's exposed tool set (file 11 §3.2).
 *
 * The REPL agent uses the SAME 14-tool catalog the MCP server declares
 * (mcp/server/tools.ts) — never a parallel definition. `exposedTools` resolves
 * which of them an agent may see from its tuning's allow/deny lists; `isForceArg`
 * detects an attempt to pass --force/force:true (the agent is FORBIDDEN from it,
 * §4 — only a human may type the confirmation). PURE.
 */
import { PROMETHEUS_TOOLS, type ToolDef } from "../mcp/server/index.js";
import { PROPOSE_EDIT_TOOL } from "./edit.js";
import { WEB_FETCH_TOOL } from "./web.js";

export type ToolName = string;

/** The agent's full tool surface: the MCP prometheus.py catalog PLUS the CLI-local
 * tools the runtime dispatches (not the engine): `propose_edit` (CLI-010) and
 * `web_fetch` via the safeFetch L6 proxy (CLI-011). */
const AGENT_TOOLS: readonly ToolDef[] = [...PROMETHEUS_TOOLS, PROPOSE_EDIT_TOOL, WEB_FETCH_TOOL];

export interface AgentToolPolicy {
  enabled: boolean;
  /** if non-empty, ONLY these tools are exposed; else all (minus deny). */
  allow: ToolName[];
  deny: ToolName[];
}

/** Resolve the tools an agent may call from its policy (allow ∖ deny, gated by enabled). */
export function exposedTools(policy: AgentToolPolicy): ToolDef[] {
  if (!policy.enabled) return [];
  const deny = new Set(policy.deny);
  const base =
    policy.allow.length > 0
      ? AGENT_TOOLS.filter((t) => policy.allow.includes(t.name))
      : AGENT_TOOLS;
  return base.filter((t) => !deny.has(t.name));
}

/** The names of the tools an agent may call (for quick membership checks). */
export function exposedToolNames(policy: AgentToolPolicy): Set<ToolName> {
  return new Set(exposedTools(policy).map((t) => t.name));
}

/** A force-flag token, INCLUDING its `=value` form (e.g. `--force`, `--force=1`). */
function isForceToken(a: unknown): boolean {
  if (typeof a !== "string") return false;
  return (
    a === "--force" ||
    a === "--force-unsafe" ||
    a.startsWith("--force=") ||
    a.startsWith("--force-unsafe=")
  );
}

/** Detect a forbidden --force / force:true in tool args (the §4 hard block). */
export function isForceArg(args: Record<string, unknown>): boolean {
  if (args.force === true) return true;
  if (typeof args.force === "string" && args.force.toLowerCase() === "true") return true;
  // a raw argv array carrying the flag (incl. the `--force=value` form)
  const argv = args.argv;
  if (Array.isArray(argv) && argv.some(isForceToken)) return true;
  return false;
}

/** Strip any force flag from tool args defensively (belt-and-braces with isForceArg). */
export function stripForce(args: Record<string, unknown>): Record<string, unknown> {
  const { force: _force, ...rest } = args;
  if (Array.isArray(rest.argv)) {
    rest.argv = (rest.argv as unknown[]).filter((a) => !isForceToken(a));
  }
  return rest;
}
