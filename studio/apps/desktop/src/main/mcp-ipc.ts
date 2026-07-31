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

import { mcpHost } from "@prometheus/core";
import type { EngineConfig } from "@prometheus/engine-bridge";
import { ipcMain } from "electron";

import {
  IPC,
  type McpAddRequest,
  type McpConnectorView,
  type McpImportResult,
  type McpListResult,
  type McpOpResult,
} from "../shared/ipc-contract.js";
import { createMcpGate } from "./mcp/gate.js";
import { DiskConfigStore } from "./mcp/store.js";
import { createMcpTransportFactory } from "./mcp/transport.js";

type McpServerConfig = mcpHost.McpServerConfig;

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
}

/** Register the `mcp:*` handlers over one manager; returns a disposer. */
export function registerMcpIpcHandlers(opts: McpIpcOptions): () => void {
  const store = new DiskConfigStore(opts.storePath);
  const manager = new mcpHost.McpHostManager({
    store,
    gate: createMcpGate(opts.engineConfig ?? {}),
    transport: createMcpTransportFactory(),
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

  return () => {
    for (const ch of [
      IPC.mcpList,
      IPC.mcpAdd,
      IPC.mcpConnect,
      IPC.mcpDisconnect,
      IPC.mcpRemove,
      IPC.mcpSetEnabled,
      IPC.mcpImport,
    ]) {
      ipcMain.removeHandler(ch);
    }
  };
}
