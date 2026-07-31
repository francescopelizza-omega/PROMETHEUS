/**
 * agents/types.ts — the agent definition model (file 09 §4.1, verbatim).
 *
 * An agent is a manifest + a model binding + a tool allowlist + a system policy +
 * a sandbox. It is deliberately the same primitive as a Prometheus SKILL.md so the
 * two interop (§4.1). PURE types — no model/engine runtime here.
 */

/** Where a model lives (→ file 05 Model Hub). */
export interface ModelRef {
  provider: string;
  modelId: string;
  endpoint?: string;
}

/** A capability grant: a tool ref + how it may run. */
export interface AgentToolGrant {
  /** "<serverId>:<toolName>" (MCP) | "engine:<cmd>" | "ext:<extId>:<cmd>". */
  ref: string;
  /** honored ONLY for readOnlyHint tools (enforced by the ToolBroker, not advisory). */
  autoApprove: boolean;
  /** per-tool, per-run call cap. */
  maxCallsPerRun?: number;
}

/** The agent process sandbox (§4.4). */
export interface AgentSandbox {
  /** glob allowlist for reads (default: the workspace root). */
  fsRead: string[];
  /** glob allowlist for writes (default: [] — no writes without a grant). */
  fsWrite: string[];
  /** "none" blocks all egress; "mcp-only" allows only declared MCP/HTTP; "allow" raw. */
  network: "none" | "mcp-only" | "allow";
  /** shell tools require an explicit grant (default false). */
  shell: boolean;
  /** wall-clock ceiling per run (default 600 — matches the engine bridge). */
  timeoutSec: number;
}

export interface AgentMemory {
  backend: "chroma" | "sqlite-vec" | "none";
  collection?: string;
}

export interface AgentSchedule {
  cron?: string;
  intervalSec?: number;
}

export type AgentSource = "builtin" | "extension" | "user" | "imported-skill";

/** A full agent definition (§4.1). */
export interface AgentDef {
  id: string;
  name: string;
  /** SHARP trigger text — doubles as a SKILL.md `description` if exported. */
  description: string;
  model: ModelRef;
  /** system prompt / persona. */
  system: string;
  tools: AgentToolGrant[];
  memory?: AgentMemory;
  schedule?: AgentSchedule;
  sandbox: AgentSandbox;
  source: AgentSource;
}

/** The §4.1 default sandbox (mcp-only egress, no writes, 600 s). */
export const DEFAULT_SANDBOX: AgentSandbox = {
  fsRead: ["${workspace}/**"],
  fsWrite: [],
  network: "mcp-only",
  shell: false,
  timeoutSec: 600,
};
