/**
 * session/mcp-session.ts — connect the configured MCP servers for a CHAT session, and expose
 * their tools to the agent.
 *
 * Everything downstream of this file was already built and had no producer: `mcpToolDefs`
 * turns a server's `tools/list` into `ToolDef`s, `parseMcpToolName` routes an
 * `mcp__<server>__<tool>` call in the runner, and `SessionCtx.callMcpTool` is threaded through
 * to it. But the only `McpHostManager` in the CLI lived inside `prometheus mcp test`, which
 * connects and immediately disconnects. So a user could add a connector, see it listed, and
 * the agent would still never see a single one of its tools. This closes that.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT:
 *
 *  1. **Connecting spawns processes.** Only servers the user has `enabled` are started, each
 *     under a timeout, each fail-soft: a broken connector costs its own tools and nothing else.
 *     With no connectors configured — the overwhelmingly common case — this does no work at all.
 *  2. **The confirm has already happened.** `McpHostManager.callTool` runs the §4.3 policy gate
 *     itself and refuses when it is not auto-approvable. By the time a call reaches here the
 *     agent's own broker has ALREADY asked the human about this exact tool with these exact
 *     arguments, using the SAME annotations (they are carried verbatim into the `ToolDef`).
 *     Answering that second gate with `false` would make every non-read-only MCP tool
 *     permanently unusable; answering it with `true` is not a bypass, it is not asking the
 *     same question twice.
 *  3. **A tool result is text.** MCP content is a typed array; the model needs a string. An
 *     `isError` result comes back as `ok:false` so the model can re-plan rather than treating
 *     an error payload as an answer.
 */
import { agent, mcpHost, type mcpServer } from "@prometheus/core";
import { createMcpTransportFactory } from "@prometheus/core/mcp-node";
import { type EngineConfig, type VerdictTier, gate as engineGate } from "@prometheus/engine-bridge";

import { prometheusHome } from "../home.js";
import { CliMcpConfigStore, mcpStorePath } from "../mcp-store.js";
import { createCliSecretsStore } from "../secrets-backend.js";

type ToolDef = mcpServer.ToolDef;

/** The keychain service `--auth-secret <ref>` bearer tokens live under (never in the config). */
const MCP_AUTH_SERVICE = "prometheus-mcp-auth";

/** How long one server gets to hand back its tool list before the session moves on without it. */
export const CONNECT_TIMEOUT_MS = 15_000;

/** What a tool call gives back to the runner — the `SessionCtx.callMcpTool` contract. */
export interface McpCallOutcome {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** A live MCP session: the tools it can offer, and the dispatcher for them. */
export interface McpSession {
  /** The connected servers' tools, namespaced. Empty when nothing connected. */
  tools(): ToolDef[];
  /** Dispatch one `mcp__<server>__<tool>` call. Never throws — the runner reads the outcome. */
  callTool(serverId: string, tool: string, args: Record<string, unknown>): Promise<McpCallOutcome>;
  /** One line for the session banner, or "" when there is nothing to say. */
  banner(): string;
  /** Shut every transport down. Safe to call twice. */
  close(): Promise<void>;
}

/** The real nemesis gate (mirrors `mcp-cmd.ts` — fail-closed to `error`). */
function createCliMcpGate(config: EngineConfig = {}): mcpHost.NemesisGate {
  return async (target: string): Promise<mcpHost.HostGateVerdict> => {
    try {
      const v = await engineGate(target, {}, config);
      return { verdict: v.verdict, riskScore: v.risk_score, target, findings: v.findings.length };
    } catch {
      return { verdict: "error" as VerdictTier, target, findings: 0 };
    }
  };
}

/** Build the manager a chat session drives. Separate from `mcp-cmd`'s so neither owns the other. */
export function createSessionMcpManager(home: string = prometheusHome()): mcpHost.McpHostManager {
  const secrets = createCliSecretsStore();
  return new mcpHost.McpHostManager({
    store: new CliMcpConfigStore(mcpStorePath(home)),
    gate: createCliMcpGate(),
    transport: createMcpTransportFactory({
      resolveAuth: (ref: string) => secrets.get(MCP_AUTH_SERVICE, ref),
    }),
  });
}

/** Reject after `ms`, so one wedged stdio server cannot hold the whole session start. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * The MCP result conversion now lives in CORE, so the desktop's main process converts a call
 * result exactly the way this session does. Re-exported under the original names because the
 * judgements — isError is a failure, an empty success is an empty success, truncation is
 * marked — are what a second copy would get subtly different.
 */
export {
  MAX_MCP_RESULT_CHARS as MAX_RESULT_CHARS,
  renderMcpContent,
} from "@prometheus/core/agent-protocol";

/**
 * The slice of `McpHostManager` a chat session actually drives.
 *
 * Named as an interface rather than taking the class, because the class carries private fields
 * and so cannot be stood in for structurally — which would mean the only way to test this file
 * is to spawn real servers, i.e. not to test it.
 */
export interface McpManagerLike {
  list(): mcpHost.McpServerConfig[];
  get(id: string): mcpHost.McpServerConfig | undefined;
  connect(id: string): Promise<mcpHost.McpServerConfig>;
  disconnect(id: string): Promise<void>;
  callTool(
    id: string,
    name: string,
    args?: Record<string, unknown>,
    opts?: { confirm?: (toolName: string) => boolean | Promise<boolean> },
  ): Promise<{ content: unknown; isError?: boolean }>;
}

export interface OpenMcpOptions {
  home?: string;
  /** injected in tests; defaults to the real keychain/transport-backed manager. */
  manager?: McpManagerLike;
  /** progress sink — one line per server that failed, so a broken connector is visible. */
  write?: (line: string) => void;
  /** override the per-server connect budget (tests use a short one). */
  connectTimeoutMs?: number;
}

/**
 * Connect every enabled server and return the session's MCP surface.
 *
 * Fail-soft everywhere: this must never be the reason a chat session refuses to start.
 */
export async function openMcpSession(opts: OpenMcpOptions = {}): Promise<McpSession> {
  const manager = opts.manager ?? createSessionMcpManager(opts.home);
  const connected: string[] = [];
  const failed: string[] = [];
  let configs: mcpHost.McpServerConfig[] = [];

  try {
    configs = manager.list();
  } catch {
    configs = [];
  }

  // A server the user disabled stays off. A blocked one is not retried — the nemesis verdict
  // is the answer, and re-asking it every session would train the user to ignore it.
  const budget = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const startable = configs.filter((c) => c.enabled && c.health !== "blocked");
  await Promise.all(
    startable.map(async (cfg) => {
      try {
        await withTimeout(manager.connect(cfg.id), budget, `connect ${cfg.id}`);
        connected.push(cfg.id);
      } catch (err) {
        failed.push(cfg.id);
        const detail = err instanceof Error ? err.message : String(err);
        opts.write?.(`mcp: ${cfg.id} did not connect — ${detail}`);
      }
    }),
  );

  const liveConfigs = (): mcpHost.McpServerConfig[] =>
    connected.map((id) => manager.get(id)).filter((c): c is mcpHost.McpServerConfig => Boolean(c));

  let closed = false;

  return {
    tools: () => agent.protocol.allMcpToolDefs(liveConfigs()),
    async callTool(serverId, tool, args) {
      try {
        const res = await manager.callTool(serverId, tool, args, {
          // The human already answered, upstream, about this exact call. See the header.
          confirm: async () => true,
        });
        return agent.protocol.mcpOutcome(serverId, tool, res);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, summary: `${tool} on ${serverId} failed: ${detail}` };
      }
    },
    banner() {
      if (connected.length === 0 && failed.length === 0) return "";
      const toolCount = agent.protocol.allMcpToolDefs(liveConfigs()).length;
      const ok = connected.length > 0 ? `${connected.join(", ")} (${toolCount} tools)` : "";
      const bad = failed.length > 0 ? `${ok ? " · " : ""}failed: ${failed.join(", ")}` : "";
      return `mcp: ${ok}${bad}`;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(
        connected.map(async (id) => {
          try {
            await manager.disconnect(id);
          } catch {
            /* a transport that is already gone is not an error worth surfacing at exit */
          }
        }),
      );
    },
  };
}

/**
 * Merge MCP tools into a tuning's host-local `extra`.
 *
 * Applied at the PROJECTOR, per turn, rather than baked into `seedTuning`: servers connect
 * asynchronously and can be added mid-session, and `repl.reduce` spreads `...tuning.tools`
 * everywhere, so a value written once at startup would go stale invisibly.
 */
export function withMcpTools<T extends { tools: { extra?: readonly ToolDef[] } }>(
  tuning: T,
  mcpTools: readonly ToolDef[],
): T {
  if (mcpTools.length === 0) return tuning;
  const existing = tuning.tools.extra ?? [];
  // A built-in wins a name collision: the namespaced `mcp__` prefix makes one impossible today,
  // but this is the invariant that keeps it impossible if the prefix ever changes.
  const taken = new Set(existing.map((t) => t.name));
  return {
    ...tuning,
    tools: { ...tuning.tools, extra: [...existing, ...mcpTools.filter((t) => !taken.has(t.name))] },
  };
}
