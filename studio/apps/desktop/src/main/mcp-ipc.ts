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

import { DEFAULT_AUTH_LEVEL } from "@prometheus/core/agent-authorization";
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
import {
  type NativeApprover,
  approvalPrompt,
  askApproval,
  electronNativeApprover,
  mainNeedsApprovalFor,
  sharedApprovals,
} from "./agent-approvals.js";
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
  /** main's native "Allow the agent to …?" prompt (tests inject one) */
  nativeApprover?: NativeApprover;
  /**
   * The level main ENFORCES, from the renderer's claim — the same clamp chain agent:systemTool
   * uses (saved file ∧ posture ∧ elevation), injected by index.ts so this module does not import
   * ide-ipc. Absent ⇒ never above the ladder's default.
   */
  clampLevel?: (level: number) => number;
  /** main's native "start these programs?" consent for stdio connectors (tests inject one) */
  confirmStdio?: (programs: StdioProgram[]) => Promise<boolean>;
}

/** One program a stdio connector would start. */
export interface StdioProgram {
  id: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** What a stdio-connector consent shows: the exact argv, where, and env NAMES (never values). */
export function stdioProgramsText(programs: readonly StdioProgram[]): string {
  return programs
    .slice(0, 12)
    .map((p) => {
      const argv = [p.command, ...(p.args ?? [])].join(" ");
      const env = Object.keys(p.env ?? {});
      return [
        `${p.id}: ${argv.length > 400 ? `${argv.slice(0, 400)}…` : argv}`,
        ...(p.cwd ? [`  in ${p.cwd}`] : []),
        ...(env.length ? [`  env: ${env.join(", ")}`] : []),
      ].join("\n");
    })
    .join("\n\n");
}

const STDIO_WARNING =
  "It runs as you, outside any sandbox, whenever the connector is enabled. Only allow programs " +
  "you recognise.";

async function nativeConfirmStdio(programs: StdioProgram[]): Promise<boolean> {
  try {
    const electron = (await import("electron")) as unknown as {
      dialog?: { showMessageBox: (o: unknown) => Promise<{ response: number }> };
    };
    if (!electron.dialog) return false;
    const r = await electron.dialog.showMessageBox({
      type: "warning",
      buttons: ["Cancel", "Allow"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message:
        programs.length === 1
          ? "Allow this MCP connector to start a program on your computer?"
          : `Allow these ${programs.length} MCP connectors to start programs on your computer?`,
      detail: `${stdioProgramsText(programs)}\n\n${STDIO_WARNING}`,
    });
    return r.response === 1;
  } catch {
    return false;
  }
}

/** Type-check a renderer's add request; the error, or null when it is well-formed. */
export function mcpAddShapeError(req: McpAddRequest): string | null {
  const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  if (!str(req.id, 128) || !/^[A-Za-z0-9._-]+$/.test(req.id)) {
    return "id must be 1-128 letters, digits, '.', '_' or '-'";
  }
  if (!str(req.label, 200)) return "label must be a short string";
  const t = req.transport as Record<string, unknown>;
  if (t.kind === "stdio") {
    if (!str(t.command, 4096)) return "command must be a string";
    if (
      t.args !== undefined &&
      !(Array.isArray(t.args) && t.args.every((x) => typeof x === "string"))
    ) {
      return "args must be a list of strings";
    }
    if (t.cwd !== undefined && !str(t.cwd, 4096)) return "cwd must be a string";
    if (
      t.env !== undefined &&
      (typeof t.env !== "object" ||
        t.env === null ||
        Array.isArray(t.env) ||
        !Object.values(t.env).every((x) => typeof x === "string"))
    ) {
      return "env must map names to strings";
    }
  }
  return null;
}

/** Register the `mcp:*` handlers over one manager; returns a disposer. */
export function registerMcpIpcHandlers(opts: McpIpcOptions): () => void {
  const home = opts.home ?? prometheusHome();
  const nativeApprover = opts.nativeApprover ?? electronNativeApprover;
  const confirmStdio = opts.confirmStdio ?? nativeConfirmStdio;
  const clampLevel = opts.clampLevel ?? ((l: number) => Math.min(l, DEFAULT_AUTH_LEVEL));
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
    const shape = mcpAddShapeError(req);
    if (shape) return { ok: false, error: shape };
    // Re-adding an existing id replaced its config — and with it the pinned tool-list hash that
    // detects a server changing its tools after approval. Remove it first, deliberately.
    if (manager.get(req.id)) {
      return { ok: false, error: `a connector named "${req.id}" already exists — remove it first` };
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
    // A stdio connector is a PROGRAM this app will start, as the user, unsandboxed, every time it
    // is enabled. nemesis scores the command line only — never the script it names — so the
    // human sees exactly what will run, in main, before it is saved.
    if (
      t.kind === "stdio" &&
      !(await confirmStdio([
        { id: req.id, command: t.command, args: t.args, cwd: t.cwd, env: t.env },
      ]))
    ) {
      return { ok: false, error: "not added — you did not approve running that program" };
    }
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
    // every program an import would let this app start, approved once, together, in main
    const fresh = found.filter((c) => !manager.get(c.id));
    const programs = fresh.flatMap((c) =>
      c.transport.kind === "stdio"
        ? [
            {
              id: c.id,
              command: c.transport.command,
              args: c.transport.args,
              cwd: c.transport.cwd,
              env: c.transport.env,
            },
          ]
        : [],
    );
    if (programs.length > 0 && !(await confirmStdio(programs))) {
      return { ok: false, imported: 0, servers: listViews(), error: "import cancelled" };
    }
    for (const cfg of fresh) {
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
   * The renderer's agent loop asks the human (or applies the ladder / a remembered grant) BEFORE
   * it sends this. That used to be the whole story — `confirm: async () => true` — so any
   * renderer, or any drift between its ladder and main's, ran another process's tool with no
   * one asked. Now main applies the ladder itself, on core's `ladderAnnotations` over the
   * server's own descriptor and the CLAMPED level: a call the ladder would ask about runs only
   * with the single-use token minted when the human approved it, or after main's own native
   * prompt. `confirm` then answers with that decision.
   */
  ipcMain.handle(IPC.mcpAgentCall, async (_e, arg: unknown): Promise<AgentSystemToolResult> => {
    const req = (arg ?? {}) as Partial<McpAgentCallRequest>;
    if (typeof req.serverId !== "string" || typeof req.tool !== "string") {
      return { ok: false, summary: "mcp:agent-call: malformed request" };
    }
    if (
      req.args !== undefined &&
      (req.args === null || typeof req.args !== "object" || Array.isArray(req.args))
    ) {
      return { ok: false, summary: "mcp:agent-call: args must be an object" };
    }
    const args = (req.args ?? {}) as Record<string, unknown>;
    const name = agentProtocol.mcpToolName(req.serverId, req.tool);
    const cfg = manager.get(req.serverId);
    const descriptor = cfg?.capabilities?.tools?.find((d) => d.name === req.tool);
    const annotations =
      cfg && descriptor ? agentProtocol.ladderAnnotations(cfg, descriptor) : undefined;
    const level = clampLevel(
      Math.max(
        0,
        Math.min(
          Math.trunc(typeof req.authLevel === "number" ? req.authLevel : DEFAULT_AUTH_LEVEL),
          7,
        ),
      ),
    );
    const approved = sharedApprovals.consume(req.approval, name, args);
    if (
      !approved &&
      mainNeedsApprovalFor(name, annotations, level) &&
      !(await askApproval(nativeApprover, approvalPrompt(name, args)))
    ) {
      return { ok: false, summary: `denied: you did not approve ${req.tool} on ${req.serverId}` };
    }
    try {
      const res = await manager.callTool(req.serverId, req.tool, args, {
        confirm: async () => true, // decided above, by main
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
