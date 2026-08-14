/**
 * agent/tools.ts — the agent's exposed tool set (file 11 §3.2).
 *
 * The REPL agent uses the SAME 14-tool catalog the MCP server declares
 * (mcp/server/tools.ts) — never a parallel definition. `exposedTools` resolves
 * which of them an agent may see from its tuning's allow/deny lists; `isForceArg`
 * detects an attempt to pass --force/force:true (the agent is FORBIDDEN from it,
 * §4 — only a human may type the confirmation). PURE.
 */
// NOT the mcp/server BARREL: it re-exports runner.ts, which value-imports
// @prometheus/engine-bridge → node:child_process, dragging Node into every module that
// touches agent/*. mcp/server/tools.ts has ZERO imports and is where PROMETHEUS_TOOLS
// actually lives, so this points at the definition instead of the barrel (C5).
import { PROMETHEUS_TOOLS, type ToolDef } from "../mcp/server/tools.js";

// Re-exported because `AgentToolPolicy.extra` is typed in ToolDef: a host declaring its own
// tools should not have to reach into `mcp/server/tools.js` for the type of the thing this
// module asked it for.
export type { FieldSpec, ToolAnnotations, ToolDef, ToolSchema } from "../mcp/server/tools.js";
import { PROPOSE_EDIT_TOOL, WRITE_FILE_TOOL } from "./edit.js";
import { WEB_FETCH_TOOL } from "./web.js";

export type ToolName = string;

/** The agent's full tool surface: the MCP prometheus.py catalog PLUS the CLI-local
 * tools the runtime dispatches (not the engine): `propose_edit` (CLI-010, edit existing),
 * `write_file` (create/overwrite a file), and `web_fetch` via the safeFetch L6 proxy
 * (CLI-011). */
const AGENT_TOOLS: readonly ToolDef[] = [
  ...PROMETHEUS_TOOLS,
  PROPOSE_EDIT_TOOL,
  WRITE_FILE_TOOL,
  WEB_FETCH_TOOL,
];

/** The names of the tools prometheus.py executes — the product's own verbs. */
export const ENGINE_VERBS: readonly string[] = PROMETHEUS_TOOLS.map((t) => t.name);

const ENGINE_VERB_NAMES: ReadonlySet<string> = new Set(ENGINE_VERBS);

/**
 * Whether this tool is executed by prometheus.py rather than by the host.
 *
 * The discriminator that already exists is `toArgv`: an engine verb maps its args to argv,
 * while every host-local tool's `toArgv` THROWS. Calling it to find out would mean invoking a
 * function for its exception, so the same fact is stated here as a set — and it is stated in
 * core, once, because both hosts need it to route a call and a second copy is how the desktop
 * came to answer `run_command` differently from the CLI.
 *
 * PURE: the definitions are data, so a sandboxed renderer can ask this and then send the call
 * to whichever process owns the engine.
 */
export function isEngineVerb(name: string): boolean {
  return ENGINE_VERB_NAMES.has(name);
}

export interface AgentToolPolicy {
  enabled: boolean;
  /** if non-empty, ONLY these tools are exposed; else all (minus deny). */
  allow: ToolName[];
  deny: ToolName[];
  /**
   * HOST-LOCAL tools this surface dispatches itself, merged into the catalog above.
   *
   * `propose_edit` / `write_file` / `web_fetch` are already host-local in exactly this
   * sense — the runtime executes them, not prometheus.py — they are just hard-coded
   * because the CLI was the only host. The desktop editor has its own set (read_file,
   * list_dir, grep, run_command) that has no meaning in a terminal, and without this
   * seam the GUI could not run THIS loop and so kept a fork of it, missing the broker,
   * the --force ban and the gate abort (HANDOFF_2 §9c).
   *
   * `allow`/`deny` apply to these identically — a host tool is not privileged, it is
   * just declared somewhere else.
   */
  extra?: readonly ToolDef[];
}

/** Resolve the tools an agent may call from its policy (allow ∖ deny, gated by enabled). */
export function exposedTools(policy: AgentToolPolicy): ToolDef[] {
  if (!policy.enabled) return [];
  const deny = new Set(policy.deny);
  // A host tool with the same name as a catalog tool WINS — the host is the one that will
  // actually execute it, so its schema is the truthful one to show the model.
  const hostNames = new Set((policy.extra ?? []).map((t) => t.name));
  const all: ToolDef[] = [
    ...AGENT_TOOLS.filter((t) => !hostNames.has(t.name)),
    ...(policy.extra ?? []),
  ];
  const base = policy.allow.length > 0 ? all.filter((t) => policy.allow.includes(t.name)) : all;
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
