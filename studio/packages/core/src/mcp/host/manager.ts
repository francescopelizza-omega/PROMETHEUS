/**
 * mcp/host/manager.ts — the McpHostManager lifecycle (file 09 §2.2).
 *
 *   addServer(cfg) ─▶ nemesis gate ─▶ persist (disabled; blocked if high/critical)
 *   connect(id)    ─▶ (refuse if blocked) spawn transport ─▶ initialize ─▶ tools/list
 *                     ─▶ cache caps ─▶ health="ready"
 *   callTool(id,n) ─▶ §4.3 policy gate (autoApprove + annotation) ─▶ dispatch
 *   disconnect/removeServer ─▶ mirror engine enable/disable/uninstall semantics
 *
 * The manager is PURE over three injected deps: a ConfigStore (persistence — the
 * desktop provides the disk-backed one), a NemesisGate (the engine runner), and a
 * TransportFactory (the SDK client). Tests use the in-memory store + a fake gate +
 * FakeTransport. Core never spawns or scans — it orchestrates the injected seams.
 */
import { type NemesisGate, gateServer, verdictBlocks } from "./gate.js";
import { autoApprovable } from "./policy.js";
import type { McpClientTransport, McpToolCallResult, TransportFactory } from "./transports.js";
import type { McpServerConfig, McpServerHealth } from "./types.js";

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
    };
    this.deps.store.upsert(stored);
    return stored;
  }

  /** Connect a server: refuse if blocked; spawn transport, list tools, cache caps. */
  async connect(id: string): Promise<McpServerConfig> {
    const cfg = this.requireServer(id);
    if (cfg.health === "blocked") {
      throw new Error(`MCP server "${id}" is blocked by nemesis; it cannot be connected`);
    }
    this.setHealth(id, "starting");
    try {
      const transport = this.deps.transport(cfg);
      await transport.connect();
      const tools = await transport.listTools();
      this.live.set(id, transport);
      const updated: McpServerConfig = {
        ...this.requireServer(id),
        capabilities: { tools, resources: false, prompts: false },
        health: "ready",
        enabled: true,
      };
      this.deps.store.upsert(updated);
      return updated;
    } catch (e) {
      this.setHealth(id, "error");
      throw e instanceof Error ? e : new Error(String(e));
    }
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
