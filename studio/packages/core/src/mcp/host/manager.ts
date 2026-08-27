/**
 * mcp/host/manager.ts — the McpHostManager lifecycle (file 09 §2.2).
 *
 *   addServer(cfg) ─▶ nemesis gate ─▶ persist (disabled; blocked if high/critical)
 *   connect(id)    ─▶ (refuse if blocked) spawn transport ─▶ initialize ─▶ tools/list
 *                     ─▶ compare against the PINNED hash (block on drift) ─▶ cache caps
 *                     ─▶ health="ready"
 *   callTool(id,n) ─▶ §4.3 policy gate (autoApprove + annotation) ─▶ dispatch
 *   disconnect/removeServer ─▶ mirror engine enable/disable/uninstall semantics
 *
 * The manager is PURE over its injected deps: a ConfigStore (persistence — the
 * desktop provides the disk-backed one), a NemesisGate (the engine runner), a
 * TransportFactory (the SDK client), and an optional drift observer. Tests use the
 * in-memory store + a fake gate + FakeTransport. Core never spawns or scans (beyond the
 * pure, in-process pattern check in `tool-pinning.ts`) — it orchestrates the injected seams.
 */
import { type NemesisGate, gateServer, verdictBlocks } from "./gate.js";
import { autoApprovable } from "./policy.js";
import { hashToolDescriptors, scanToolDescriptors } from "./tool-pinning.js";
import type { McpClientTransport, McpToolCallResult, TransportFactory } from "./transports.js";
import type { McpServerConfig, McpServerHealth, McpToolDescriptor } from "./types.js";

/** Persistence seam for server configs (disk-backed in desktop; in-memory in tests). */
export interface ConfigStore {
  list(): McpServerConfig[];
  get(id: string): McpServerConfig | undefined;
  upsert(cfg: McpServerConfig): void;
  remove(id: string): void;
}

/** A trivial in-memory ConfigStore (tests + a default). */
export class InMemoryConfigStore implements ConfigStore {
  private readonly map = new Map<string, McpServerConfig>();
  list(): McpServerConfig[] {
    return [...this.map.values()];
  }
  get(id: string): McpServerConfig | undefined {
    return this.map.get(id);
  }
  upsert(cfg: McpServerConfig): void {
    this.map.set(cfg.id, cfg);
  }
  remove(id: string): void {
    this.map.delete(id);
  }
}

export interface McpHostDeps {
  store: ConfigStore;
  gate: NemesisGate;
  transport: TransportFactory;
  /**
   * Called when `connect()` finds a server's tool descriptors changed since they were pinned —
   * the "rug pull" signal. Optional: omitting it still blocks the server on drift, it just
   * means nothing beyond the persisted `health`/`gate` state records why. A real host wires
   * this to `appendMcpAudit` (`mcp-audit.ts`).
   */
  onToolDrift?: (info: { id: string; flaggedSignals: string[] }) => void;
}

export interface CallToolOptions {
  /** asked when a tool is not auto-approvable; returning false blocks the call. */
  confirm?: (toolName: string) => boolean | Promise<boolean>;
}

export class McpHostManager {
  private readonly live = new Map<string, McpClientTransport>();
  private readonly deps: McpHostDeps;

  constructor(deps: McpHostDeps) {
    this.deps = deps;
  }

  list(): McpServerConfig[] {
    return this.deps.store.list();
  }

  get(id: string): McpServerConfig | undefined {
    return this.deps.store.get(id);
  }

  isConnected(id: string): boolean {
    return this.live.has(id);
  }

  /** Add + gate a server. A block/error verdict ⇒ health="blocked" (NOT started). */
  async addServer(cfg: McpServerConfig): Promise<McpServerConfig> {
    const verdict = await gateServer(cfg, this.deps.gate);
    const blocked = verdictBlocks(verdict);
    const stored: McpServerConfig = {
      ...cfg,
      gate: verdict,
      enabled: blocked ? false : cfg.enabled,
      health: blocked ? "blocked" : "unknown",
      // Every (re-)add is a fresh trust decision: the next successful connect establishes a
      // NEW pin from whatever the server currently claims, rather than comparing against a
      // pin from before this re-approval.
      toolsPinnedHash: undefined,
      blockedReason: blocked ? "gate" : undefined,
    };
    this.deps.store.upsert(stored);
    return stored;
  }

  /**
   * Connect a server: refuse if blocked; spawn transport, list tools, cache caps.
   *
   * A server's tool descriptors are only ever gated (by content, via `tool-pinning.ts`) HERE —
   * `addServer`'s nemesis gate scans the launch command, not what the server claims its tools
   * do. The first successful connect after an add PINS the descriptor set's hash; every later
   * connect compares the fresh `tools/list` against that pin and blocks on any mismatch, same
   * as a bad launch command blocks at add time. This is deliberately NOT "only block if the
   * new descriptors also scan dirty" — a server that changed itself after approval doesn't get
   * to vouch for its own new definition.
   */
  async connect(id: string): Promise<McpServerConfig> {
    const cfg = this.requireServer(id);
    if (cfg.health === "blocked") {
      throw new Error(
        cfg.blockedReason === "tool-drift"
          ? `MCP server "${id}" is blocked: its tool definitions changed after they were approved (possible "rug pull") — re-add the server to review and re-approve`
          : `MCP server "${id}" is blocked by nemesis; it cannot be connected`,
      );
    }
    this.setHealth(id, "starting");
    let tools: McpToolDescriptor[];
    /**
     * Held OUTSIDE the try so the failure path can tear it down.
     *
     * `connect()` spawns the child (stdio) or opens the session (http); `listTools()` is the
     * next call. A throw anywhere between them left the transport unreferenced — `this.live` is
     * only populated on success — with nothing left holding a handle to close it. The concrete
     * shape is a server that starts but does not speak MCP: a wrong binary, a missing argument,
     * an `npx -y @modelcontextprotocol/server-…` cold download that outruns the handshake
     * timeout. The connect fails, the health flips to "error", and the process stays alive for
     * the rest of the session. Retrying the connect leaks another one.
     *
     * The tool-drift path below already tears down for exactly this reason; this is the same
     * best-effort close, on the path that needed it more.
     */
    let transport: McpClientTransport | undefined;
    try {
      transport = this.deps.transport(cfg);
      await transport.connect();
      tools = await transport.listTools();
      this.live.set(id, transport);
    } catch (e) {
      this.setHealth(id, "error");
      // A close() that itself rejects must not replace the real failure the caller needs to see.
      try {
        await transport?.close();
      } catch {
        /* best effort — the connect error below is the one that matters */
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
    const hash = hashToolDescriptors(tools);
    const pinned = cfg.toolsPinnedHash;
    if (pinned !== undefined && pinned !== hash) {
      const scan = scanToolDescriptors(tools);
      this.deps.onToolDrift?.({ id, flaggedSignals: scan.signals });
      const live = this.live.get(id);
      this.live.delete(id);
      // Best-effort teardown: a transport whose close() rejects must not skip persisting the
      // block below — the drift is already confirmed, and a close failure is a second, separate
      // problem that must never suppress the first one's result.
      try {
        await live?.close();
      } catch {
        /* best effort */
      }
      this.deps.store.upsert({
        ...this.requireServer(id),
        health: "blocked",
        enabled: false,
        blockedReason: "tool-drift",
      });
      throw new Error(
        `MCP server "${id}"'s tool definitions changed since they were approved (possible "rug pull") — re-add the server to review and re-approve`,
      );
    }
    const updated: McpServerConfig = {
      ...this.requireServer(id),
      capabilities: { tools, resources: false, prompts: false },
      health: "ready",
      enabled: true,
      toolsPinnedHash: hash,
    };
    this.deps.store.upsert(updated);
    return updated;
  }

  /**
   * Call a tool on a connected server. The §4.3 policy gate runs FIRST: a tool is
   * dispatched without confirmation ONLY if it is auto-approvable (read-only +
   * pre-approved). Otherwise the injected confirm() must return true.
   */
  async callTool(
    id: string,
    name: string,
    args: Record<string, unknown> = {},
    opts: CallToolOptions = {},
  ): Promise<McpToolCallResult> {
    const cfg = this.requireServer(id);
    const transport = this.live.get(id);
    if (!transport) throw new Error(`MCP server "${id}" is not connected`);
    /**
     * The server DIED since we last spoke to it — reap it here rather than calling into a
     * corpse.
     *
     * Checked at call time rather than by polling, because that is the moment the answer
     * matters and the only moment it is free. Marking it `error` and dropping it from `live`
     * means the next `tools()` stops advertising a server that is gone, so the model stops
     * being handed tools that cannot run. The message names the cause, which a bare transport
     * error never did.
     */
    if (transport.isDead?.() === true) {
      this.live.delete(id);
      this.setHealth(id, "error");
      throw new Error(
        `MCP server "${id}" has exited — its tools are no longer available; reconnect it to use them again`,
      );
    }
    const descriptor = cfg.capabilities?.tools.find((t) => t.name === name);
    const granted = cfg.autoApprove.includes(name);
    if (!autoApprovable(descriptor?.annotations, granted)) {
      const approved = opts.confirm ? await opts.confirm(name) : false;
      if (!approved) throw new Error(`tool "${name}" on "${id}" requires confirmation`);
    }
    return transport.callTool(name, args);
  }

  /** Disconnect: close the transport, mark unknown (config persists, reversible). */
  async disconnect(id: string): Promise<void> {
    const transport = this.live.get(id);
    if (transport) {
      await transport.close();
      this.live.delete(id);
    }
    const cfg = this.deps.store.get(id);
    if (cfg && cfg.health !== "blocked") this.deps.store.upsert({ ...cfg, health: "unknown" });
  }

  /** Remove: disconnect then drop the config (mirrors engine uninstall). */
  async removeServer(id: string): Promise<void> {
    await this.disconnect(id);
    this.deps.store.remove(id);
  }

  private requireServer(id: string): McpServerConfig {
    const cfg = this.deps.store.get(id);
    if (!cfg) throw new Error(`unknown MCP server "${id}"`);
    return cfg;
  }

  private setHealth(id: string, health: McpServerHealth): void {
    const cfg = this.deps.store.get(id);
    if (cfg) this.deps.store.upsert({ ...cfg, health });
  }
}
