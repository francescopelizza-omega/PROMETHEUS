/**
 * agents/runtime.ts — the agent registry + tool dispatcher routing + spawn supervisor.
 *
 * `buildDispatcher` routes a ToolCall by its ref kind (mcp/engine/ext) to the
 * INJECTED handler (the desktop main wires McpHostManager / engine-bridge / the ext
 * host). `AgentRuntime` holds the agent registry and enforces the §4.2 multi-agent
 * rule: a spawned subagent must have NO ancestor cycle and a sandbox ⊆ its parent's
 * (never broader). PURE — no engine/MCP runtime here.
 */
import type { ToolCall, ToolDispatcher } from "./orchestrator.js";
import { parseToolRef, sandboxWithin } from "./sandbox.js";
import type { AgentDef } from "./types.js";

export interface DispatchHandlers {
  mcp?(serverId: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  engine?(cmd: string, args: Record<string, unknown>): Promise<unknown>;
  ext?(extId: string, cmd: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Build a ToolDispatcher that routes by ref kind; a missing handler throws (the
 *  broker should have blocked it — this is the defense-in-depth backstop). */
export function buildDispatcher(handlers: DispatchHandlers): ToolDispatcher {
  return async (call: ToolCall) => {
    const parsed = parseToolRef(call.ref);
    if (!parsed) throw new Error(`malformed tool ref "${call.ref}"`);
    if (parsed.kind === "mcp") {
      if (!handlers.mcp) throw new Error(`no MCP dispatcher for "${call.ref}"`);
      return handlers.mcp(parsed.serverId ?? "", parsed.tool, call.args);
    }
    if (parsed.kind === "engine") {
      if (!handlers.engine) throw new Error(`no engine dispatcher for "${call.ref}"`);
      return handlers.engine(parsed.tool, call.args);
    }
    if (!handlers.ext) throw new Error(`no extension dispatcher for "${call.ref}"`);
    return handlers.ext(parsed.extId ?? "", parsed.tool, call.args);
  };
}

export interface SpawnCheck {
  ok: boolean;
  reason?: string;
}

export class AgentRuntime {
  private readonly agents = new Map<string, AgentDef>();

  register(def: AgentDef): void {
    this.agents.set(def.id, def);
  }

  get(id: string): AgentDef | undefined {
    return this.agents.get(id);
  }

  list(): AgentDef[] {
    return [...this.agents.values()];
  }

  /**
   * Validate a §4.2 subagent spawn: the child must exist, must not already be in the
   * run genealogy (no cycle), and its sandbox must be no broader than the parent's.
   */
  canSpawn(parentId: string, childId: string, ancestry: readonly string[]): SpawnCheck {
    const parent = this.agents.get(parentId);
    const child = this.agents.get(childId);
    if (!parent) return { ok: false, reason: `unknown parent agent "${parentId}"` };
    if (!child) return { ok: false, reason: `unknown child agent "${childId}"` };
    if (ancestry.includes(childId) || childId === parentId) {
      return { ok: false, reason: `cycle: "${childId}" is already in the run genealogy` };
    }
    if (!sandboxWithin(child.sandbox, parent.sandbox)) {
      return {
        ok: false,
        reason: `child "${childId}" sandbox is broader than parent "${parentId}"`,
      };
    }
    return { ok: true };
  }
}
