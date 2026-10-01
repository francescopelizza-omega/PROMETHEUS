// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/mcp-ipc.ts — the `mcp:*` ipcMain handlers (file 09 §2).
 *
 * Wires the (previously orphaned) core `McpHostManager` to the renderer: it owns the
 * ONE manager instance built from the desktop's real injected seams — a disk-backed
 * ConfigStore (persistence), the nemesis gate (engine-bridge), and the real stdio
 * transport (main/mcp/*). Every handler validates the renderer's arg, delegates to the
 * manager, and maps the core `McpServerConfig` down to the renderer-safe
 * `McpConnectorView` (no nested engine objects cross). The connector's launch command
 * is nemesis-gated inside `addServer` BEFORE it can be connected (C4/C5).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { describeEngineFailure } from "@prometheus/engine-bridge";

import { mcpHost } from "@prometheus/core";
import * as agentProtocol from "@prometheus/core/agent-protocol";
import { createCliSecretsStore, prometheusHome } from "@prometheus/core/agent-system-host";
import { appendMcpAudit } from "@prometheus/core/mcp-node";
import type { EngineConfig } from "@prometheus/engine-bridge";
import { ipcMain } from "electron";

import {
  type AgentSystemToolResult,
  IPC,
  type McpAddRequest,
  type McpAgentCallRequest,
  type McpAgentServer,
  type McpAgentToolsResult,
  type McpConnectorView,
  type McpImportResult,
  type McpListResult,
  type McpOpResult,
} from "../shared/ipc-contract.js";
import { createMcpGate } from "./mcp/gate.js";
import { DiskConfigStore } from "./mcp/store.js";
import { createMcpTransportFactory } from "./mcp/transport.js";

type McpServerConfig = mcpHost.McpServerConfig;

// `errString` was a LOCAL copy here, one of twenty across main/*.ts, and every copy returned
// `e.message` alone — discarding `EngineError.stderrTail`, which is where the engine puts the
// actual reason when it exits before emitting JSON. See `describeEngineFailure`'s doc.
const errString = describeEngineFailure;

/** Extract an `id` string from `{ id }` or a bare string arg. */
function idOf(arg: unknown): string {
  if (typeof arg === "string") return arg;
  const o = (arg ?? {}) as { id?: unknown };
  return typeof o.id === "string" ? o.id : "";
}

/** Expand a leading `~` to the home dir (the importer config paths use it). */
function expandHome(p: string): string {
  return p.startsWith("~") ? homedir() + p.slice(1) : p;
}

/** Project a core config → the renderer-safe view (no engine objects cross). */
function toView(cfg: McpServerConfig, connected: boolean): McpConnectorView {
  const t = cfg.transport;
  return {
    id: cfg.id,
    label: cfg.label,
    transportKind: t.kind,
    ...(t.kind === "stdio" ? { command: t.command } : { url: t.url }),
    enabled: cfg.enabled,
    health: connected ? "ready" : cfg.health,
    source: cfg.source,
    scope: cfg.scope,
    toolCount: cfg.capabilities?.tools.length ?? 0,
    ...(cfg.gate ? { verdict: cfg.gate.verdict } : {}),
  };
}

export interface McpIpcOptions {
  /** where the disk ConfigStore persists (userData/mcp-servers.json). */
  storePath: string;
  /** engine config for the nemesis gate (defaults to {} — same as the IDE run-gate). */
  engineConfig?: EngineConfig;
  /** PROMETHEUS_HOME for the tool-drift audit trail (shared with the CLI's, default prometheusHome()). */
  home?: string;
}

/** Register the `mcp:*` handlers over one manager; returns a disposer. */
export function registerMcpIpcHandlers(opts: McpIpcOptions): () => void {
  const home = opts.home ?? prometheusHome();
  const store = new DiskConfigStore(opts.storePath);
  const manager = new mcpHost.McpHostManager({
    store,
    gate: createMcpGate(opts.engineConfig ?? {}),
    /**
     * Resolve a remote server's bearer token from the SAME keychain the CLI writes it to.
     *
     * `prometheus mcp add --auth-secret` stores the token in the OS keychain and writes only a
     * REF into the config. `StreamableHttpTransport` attaches the header only when both the ref
     * and a resolver are present, and the desktop passed no resolver — so no Authorization
     * header was ever sent, the remote 401'd, health flipped to "error" and no tools appeared,
     * while the identical connector worked from the terminal. Nothing in the UI hinted that auth
     * had been dropped. The CLI's secrets backend was already moved into core precisely so the
     * desktop could read the same keychain; this is the wiring that was missing.
     */
    transport: createMcpTransportFactory({
      resolveAuth: (ref: string) => createCliSecretsStore().get(mcpHost.MCP_AUTH_SERVICE, ref),
    }),
    onToolDrift: (info) => appendMcpAudit(home, { event: "tool-drift", ...info }),
  });

  const view = (cfg: McpServerConfig): McpConnectorView => toView(cfg, manager.isConnected(cfg.id));
  const viewById = (id: string): McpConnectorView | undefined => {
    const cfg = manager.get(id);
    return cfg ? view(cfg) : undefined;
  };
  const listViews = (): McpConnectorView[] => manager.list().map(view);

  ipcMain.handle(IPC.mcpList, async (): Promise<McpListResult> => {
    try {
      return { ok: true, servers: listViews() };
    } catch (e) {
      return { ok: false, servers: [], error: errString(e) };
    }
  });

  ipcMain.handle(IPC.mcpAdd, async (_e, arg: unknown): Promise<McpOpResult> => {
    const req = (arg ?? {}) as McpAddRequest;
    if (!req.id || !req.label || !req.transport) {
      return { ok: false, error: "id, label and transport are required" };
    }
    const t = req.transport;
    /**
     * REFUSE a transport kind that is neither `stdio` nor `http`.
     *
     * The config builder below is a two-way ternary — `kind === "stdio" ? … : {kind:"http", …}` —
     * so ANY other kind fell into the http branch and was persisted AS http. Worse, the SSRF /
     * header validation right underneath is gated on `t.kind === "http"`, which an unknown kind
     * is not, so it never ran. Measured: `{kind:"websocket", url:"ws://example.com/mcp"}` was
     * accepted `ok:true`, written to disk as `{"kind":"http","url":"ws://example.com/mcp"}` with
     * `verdict: allow`, and never validated at all. Mislabelling the kind was a way past the
     * check, not just a cosmetic bug.
     */
    if (t.kind !== "stdio" && t.kind !== "http") {
      return {
        ok: false,
        error: `unsupported transport kind "${String((t as { kind?: unknown }).kind)}" — expected "stdio" or "http"`,
      };
    }
    if (t.kind === "stdio" && !t.command) return { ok: false, error: "stdio needs a command" };
    if (t.kind === "http") {
      // APP-095: fail-closed SSRF/header validation BEFORE the config is persisted or any
      // network I/O — a plain-http non-localhost / private-range / bad-header url is refused.
      const v = mcpHost.validateRemoteTransport(t);
      if (!v.ok) return { ok: false, error: v.error ?? "invalid remote server url" };
    }
    try {
      const cfg: McpServerConfig = {
        id: req.id,
        label: req.label,
        transport:
          t.kind === "stdio"
            ? {
                kind: "stdio",
                command: t.command,
                args: t.args ?? [],
                ...(t.env ? { env: t.env } : {}),
                ...(t.cwd ? { cwd: t.cwd } : {}),
              }
            : { kind: "http", url: t.url, ...(t.headers ? { headers: t.headers } : {}) },
        enabled: false,
        scope: req.scope ?? "global",
        autoApprove: [],
        source: "manual",
        health: "unknown",
      };
      const stored = await manager.addServer(cfg);
      const blocked = stored.health === "blocked";
      return {
        ok: !blocked,
        server: view(stored),
        ...(blocked
          ? { blocked: true, ...(stored.gate ? { verdict: stored.gate.verdict } : {}) }
          : {}),
      };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.mcpConnect, async (_e, arg: unknown): Promise<McpOpResult> => {
    const id = idOf(arg);
    if (!id) return { ok: false, error: "id required" };
    try {
      return { ok: true, server: view(await manager.connect(id)) };
    } catch (e) {
      const server = viewById(id);
      return { ok: false, error: errString(e), ...(server ? { server } : {}) };
    }
  });

  ipcMain.handle(IPC.mcpDisconnect, async (_e, arg: unknown): Promise<McpOpResult> => {
    const id = idOf(arg);
    if (!id) return { ok: false, error: "id required" };
    try {
      await manager.disconnect(id);
      const server = viewById(id);
      return { ok: true, ...(server ? { server } : {}) };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.mcpRemove, async (_e, arg: unknown): Promise<McpOpResult> => {
    const id = idOf(arg);
    if (!id) return { ok: false, error: "id required" };
    try {
      await manager.removeServer(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  ipcMain.handle(IPC.mcpSetEnabled, async (_e, arg: unknown): Promise<McpOpResult> => {
    const o = (arg ?? {}) as { id?: unknown; enabled?: unknown };
    const id = typeof o.id === "string" ? o.id : "";
    const enabled = o.enabled === true;
    if (!id) return { ok: false, error: "id required" };
    const cfg = manager.get(id);
    if (!cfg) return { ok: false, error: `unknown connector "${id}"` };
    try {
      if (enabled) return { ok: true, server: view(await manager.connect(id)) };
      await manager.disconnect(id);
      const cur = manager.get(id);
      if (cur) store.upsert({ ...cur, enabled: false }); // persist the OFF flag
      const server = viewById(id);
      return { ok: true, ...(server ? { server } : {}) };
    } catch (e) {
      const server = viewById(id);
      return { ok: false, error: errString(e), ...(server ? { server } : {}) };
    }
  });

  ipcMain.handle(IPC.mcpImport, async (): Promise<McpImportResult> => {
    const found: McpServerConfig[] = [];
    for (const path of Object.values(mcpHost.MCP_CONFIG_PATHS)) {
      let text: string;
      try {
        text = readFileSync(expandHome(path), "utf8");
      } catch {
        continue; // that agent isn't installed — skip
      }
      const parsed = path.endsWith(".toml")
        ? mcpHost.parseCodexToml(text)
        : mcpHost.parseMcpServersJson(text);
      found.push(...parsed);
    }
    let imported = 0;
    for (const cfg of found) {
      if (manager.get(cfg.id)) continue; // never clobber an existing connector
      try {
        await manager.addServer(cfg); // each is nemesis-gated
        imported += 1;
      } catch {
        /* skip an un-addable entry */
      }
    }
    return { ok: true, imported, servers: listViews() };
  });

  /* ── the agent pane as an MCP CLIENT ──────────────────────────────────────*/
  /**
   * `mcp:agent-tools` — the live tool DESCRIPTORS, which never used to cross.
   *
   * `McpConnectorView` carries a `toolCount` and nothing else, so the renderer knew how many
   * tools a connected server published and not one thing about them. That is precisely why the
   * pane could call none of them: it could not build a single `ToolDef`. A `ToolDef` cannot
   * cross IPC (it holds a function), so the descriptors cross as plain JSON and the renderer
   * builds the defs with core's own `allMcpToolDefs` — the same function the CLI uses, so a
   * server's tools look identical on both surfaces.
   */
  ipcMain.handle(IPC.mcpAgentTools, async (): Promise<McpAgentToolsResult> => {
    try {
      const servers: McpAgentServer[] = manager.list().map((cfg) => ({
        id: cfg.id,
        label: cfg.label,
        enabled: cfg.enabled,
        health: manager.isConnected(cfg.id) ? "ready" : cfg.health,
        ...(cfg.gate ? { verdict: cfg.gate.verdict } : {}),
        tools: (cfg.capabilities?.tools ?? []) as unknown as Record<string, unknown>[],
      }));
      return { ok: true, servers };
    } catch (e) {
      return { ok: false, servers: [], error: errString(e) };
    }
  });

  /**
   * `mcp:agent-call` — run one tool on one connected server.
   *
   * `confirm: async () => true` is deliberate and is the same decision the CLI session makes:
   * the human was ALREADY asked about this exact call, upstream, by the agent loop's broker,
   * using the same annotations this manager would consult. Asking again here would mean two
   * prompts for one call, and the second one — a bare tool name with no context — is the worse
   * of the two. The manager's own auto-approve list still governs the CLI's non-agent paths.
   */
  ipcMain.handle(IPC.mcpAgentCall, async (_e, arg: unknown): Promise<AgentSystemToolResult> => {
    const req = (arg ?? {}) as Partial<McpAgentCallRequest>;
    if (typeof req.serverId !== "string" || typeof req.tool !== "string") {
      return { ok: false, summary: "mcp:agent-call: malformed request" };
    }
    try {
      const res = await manager.callTool(req.serverId, req.tool, req.args ?? {}, {
        confirm: async () => true,
      });
      const out = agentProtocol.mcpOutcome(req.serverId, req.tool, res);
      return {
        ok: out.ok,
        summary: out.summary,
        ...(out.data ? { data: { content: out.data } } : {}),
      };
    } catch (e) {
      // Fail-closed and NAMED: a dead transport must not read like a tool that returned nothing.
      // Routed through mcpOutcome (not hand-built) for the SAME reason the CLI's mcp-session.ts
      // does: a throw here can be a local transport failure OR a server-authored JSON-RPC
      // protocol-level error string — there is no way to tell them apart at this catch site, so
      // both get the same untrusted-data frame + pattern scan as every other call result.
      const out = agentProtocol.mcpOutcome(req.serverId, req.tool, {
        content: errString(e),
        isError: true,
      });
      return { ok: out.ok, summary: out.summary };
    }
  });

  return () => {
    for (const ch of [
      IPC.mcpList,
      IPC.mcpAdd,
      IPC.mcpConnect,
      IPC.mcpDisconnect,
      IPC.mcpRemove,
      IPC.mcpSetEnabled,
      IPC.mcpImport,
      IPC.mcpAgentTools,
      IPC.mcpAgentCall,
    ]) {
      ipcMain.removeHandler(ch);
    }
  };
}
