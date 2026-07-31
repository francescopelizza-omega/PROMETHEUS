/**
 * mcp/host/stdio-transport.ts — the real stdio MCP client transport (CLI-036 core lift).
 *
 * Lifted verbatim from the audited desktop `main/mcp/transport.ts` so the CLI and the
 * desktop share ONE implementation. Speaks the MCP stdio wire protocol directly:
 * newline-delimited JSON-RPC 2.0 over the child's stdin/stdout (stderr = the server's log
 * channel, ignored). Handshake: `initialize` → `notifications/initialized`, then
 * `tools/list` / `tools/call`. Requests are id-correlated with a per-request timeout so a
 * hung server can never wedge the manager. The launch command is nemesis-GATED before this
 * runs (McpHostManager.addServer), so an unscanned bin is never spawned.
 *
 * NODE-ONLY — it spawns a child (`node:child_process`). It is deliberately NOT re-exported
 * from the `mcp/host` barrel (renderer-import-safe); consume it via the `@prometheus/core/
 * mcp-node` subpath. The env is sanitized inline (no engine-bridge dep → no import cycle).
 */
// biome-ignore lint/nursery/noRestrictedImports: deliberate Node-only mcp-node subpath (CLI-036), never in the renderer barrel.
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

import type { McpClientTransport, McpToolCallResult, TransportFactory } from "./transports.js";
import type { McpServerConfig, McpToolDescriptor } from "./types.js";

/**
 * The child-spawn seam (default `node:child_process.spawn`). Injectable so the e2e harness
 * (CLI-038) can spawn a DETACHED group leader with a further-sanitized env and retain the child
 * for a whole-group teardown — production paths pass nothing and get the plain spawn.
 */
export type StdioSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface StdioTransportDeps {
  spawn?: StdioSpawn;
}

const REQUEST_TIMEOUT_MS = 15_000;
const PROTOCOL_VERSION = "2024-11-05";

/** Env vars that can hijack what a child interpreter loads/executes (mirror of safe-env). */
const STRIP_EXACT = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PYTHONEXECUTABLE",
  "PYTHONUSERBASE",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
]);

/** A curated child env: the parent env minus hijack-class vars, plus explicit overrides. */
function safeSpawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || STRIP_EXACT.has(k) || k.startsWith("DYLD_")) continue;
    out[k] = v;
  }
  if (extra) for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A single JSON-RPC-over-stdio MCP client connection. */
export class StdioMcpTransport implements McpClientTransport {
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly cfg: McpServerConfig;
  private readonly spawnFn: StdioSpawn;

  constructor(cfg: McpServerConfig, deps: StdioTransportDeps = {}) {
    this.cfg = cfg;
    this.spawnFn = deps.spawn ?? spawn;
  }

  async connect(): Promise<void> {
    const t = this.cfg.transport;
    if (t.kind !== "stdio") {
      throw new Error(`transport "${t.kind}" is not supported by the stdio transport`);
    }
    const child = this.spawnFn(t.command, t.args, {
      shell: false,
      ...(t.cwd ? { cwd: t.cwd } : {}),
      env: { ...safeSpawnEnv(), ...(t.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.on("exit", (code) => this.failAll(new Error(`MCP server exited (${code ?? "signal"})`)));
    child.on("error", (e) => this.failAll(e instanceof Error ? e : new Error(String(e))));

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "prometheus", version: "0.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const r = (await this.request("tools/list", {})) as { tools?: unknown };
    const tools = Array.isArray(r?.tools) ? r.tools : [];
    return tools.map((raw): McpToolDescriptor => {
      const t = (raw ?? {}) as Record<string, unknown>;
      return {
        name: String(t.name ?? ""),
        ...(typeof t.title === "string" ? { title: t.title } : {}),
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        inputSchema: t.inputSchema,
        ...(t.annotations && typeof t.annotations === "object"
          ? { annotations: t.annotations as McpToolDescriptor["annotations"] }
          : {}),
      };
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const r = (await this.request("tools/call", { name, arguments: args })) as {
      content?: unknown;
      isError?: unknown;
    };
    return { content: r?.content, isError: r?.isError === true };
  }

  async close(): Promise<void> {
    this.failAll(new Error("MCP transport closed"));
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL"); // SIGKILL, not just close the pipe, so no orphan is left
      } catch {
        /* already dead */
      }
      this.proc = null;
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard line-splitting loop
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a non-JSON log line leaked to stdout — ignore
      }
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
        else p.resolve(msg.result);
      }
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error("MCP server is not connected"));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** The real stdio TransportFactory (CLI + desktop both inject this). `deps.spawn` overrides the
 *  child spawner (the e2e harness injects a detached, retained one); production passes nothing. */
export function createStdioTransportFactory(deps: StdioTransportDeps = {}): TransportFactory {
  return (cfg: McpServerConfig): McpClientTransport => new StdioMcpTransport(cfg, deps);
}
