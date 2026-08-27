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

import {
  type ExitingChild,
  trackChildProcess,
} from "../../agent/system/host/reaper/child-reaper.js";
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
/** How much of a server's stderr to retain for diagnostics (bytes). */
const STDERR_TAIL_MAX = 8192;

export class StdioMcpTransport implements McpClientTransport {
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  /** set once the child process has exited — see the `exit` handler in `connect`. */
  private exited: { code: number | null } | null = null;
  /** Last few KB the server wrote to stderr — kept for diagnostics, bounded so it cannot grow. */
  private stderrTail = "";
  /** un-registers this child from the exit reaper; a no-op before `connect`. */
  private untrack: () => void = () => {};
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
    /**
     * The reaper, which every other spawn in this codebase is already wired to.
     *
     * `close()` kills the child, and `close()` was called by nothing on the exit paths that
     * actually happen: Ctrl-C, a crash, a `process.exit`. An MCP stdio server is typically
     * `npx some-server`, which is a Node process that will happily outlive the CLI forever —
     * so a few start/stop cycles left a pile of orphaned servers holding their own ports and
     * file handles. The exec runner has been tracked since the reaper was written; this spawn
     * simply was not, and nothing in the type system connects the two.
     *
     * `once("exit")` auto-untracks, so a server that dies on its own is never signalled later
     * through a recycled pid.
     */
    this.untrack = trackChildProcess(child as unknown as ExitingChild, {
      label: `mcp:${this.cfg.id}`,
      command: t.command,
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    /**
     * DRAIN stderr. Nothing read it, and that is a deadlock, not a missing feature.
     *
     * The child is spawned with stderr as a PIPE, so the server's log goes into a kernel pipe
     * buffer of about 64–128 KB. With no reader that buffer fills, the server blocks inside
     * write(2) on stderr, and a blocked server stops reading stdin — so every later request
     * expires at the request timeout. The process is still ALIVE, so `isDead()` stays false and
     * the manager never reaps it: health keeps reading "ready", the tools stay advertised to the
     * model, and every call comes back a bare timeout with nothing connecting it to the cause.
     *
     * It bites a server whose stderr write is a blocking syscall — a Python, Go or shell server
     * rather than a Node one — and only once it has logged enough, so it looks like a server
     * that worked and then mysteriously stopped.
     *
     * The tail is kept rather than discarded: when a server does fail, what it printed is
     * usually the only explanation available, and `stdio: "ignore"` would throw that away.
     */
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_MAX);
    });
    child.on("exit", (code) => {
      /**
       * The child DIED. Say so, rather than only failing the in-flight requests.
       *
       * `failAll` rejects what is pending and nothing else, so a server that crashed between
       * calls left `health` reading `"ready"` — the manager kept advertising its tools, the
       * model kept calling them, and every call failed with a transport error the user had no
       * way to connect to "that server is gone". `exited` is the fact the manager needs.
       */
      this.exited = { code: code ?? null };
      const tail = this.stderrTail.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
      this.failAll(new Error(`MCP server exited (${code ?? "signal"})${tail ? `: ${tail}` : ""}`));
    });
    child.on("error", (e) => {
      this.exited = { code: null };
      this.failAll(e instanceof Error ? e : new Error(String(e)));
    });

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

  /**
   * Has the child process exited?
   *
   * The manager reads this to decide whether a server is still serving. Without it a crashed
   * server stayed `health:"ready"` forever: the tools kept being advertised, the model kept
   * calling them, and each call came back as a transport error with nothing linking it to the
   * fact that the process was gone.
   */
  isDead(): boolean {
    return this.exited !== null;
  }

  async close(): Promise<void> {
    this.failAll(new Error("MCP transport closed"));
    this.untrack();
    this.untrack = () => {};
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
      let msg: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a non-JSON log line leaked to stdout — ignore
      }
      /**
       * `method` is what separates a REQUEST from a RESPONSE, and checking it is load-bearing.
       *
       * JSON-RPC is bidirectional: a server may send us a request (`ping` is legal from either
       * side at any time, irrespective of declared capabilities) and it numbers its ids from
       * its own counter — which starts where ours does. Without this check, a server `ping`
       * carrying id 1 was matched against OUR pending id 1, resolved it with `undefined`, and
       * `listTools` turned that into `[]`. The server connects, reports healthy, and offers
       * zero tools, with nothing anywhere saying why. That is the exact silent-failure shape
       * this transport must not have.
       */
      if (typeof msg.method === "string") {
        this.onInbound(msg.method, msg.id);
        continue;
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

  /**
   * Handle a server-initiated request or notification.
   *
   * A NOTIFICATION (no id) is dropped: we advertise no capabilities, so nothing a server
   * notifies us about changes our behaviour, and answering one is a protocol error.
   *
   * A REQUEST (with an id) must be ANSWERED, because a compliant server may block on it.
   * `ping` gets the spec's empty result. Everything else gets METHOD_NOT_FOUND rather than
   * silence — we declare `capabilities: {}`, so a server asking for sampling or roots is
   * asking for something we truthfully do not have, and an error says so in one round trip
   * instead of stalling it until its own timeout.
   */
  private onInbound(method: string, id: unknown): void {
    if (id === undefined || id === null) return; // a notification — nothing to answer
    if (method === "ping") {
      this.respond(id, { result: {} });
      return;
    }
    this.respond(id, {
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }

  /** Write one JSON-RPC response. Never throws — a dead pipe is the caller's problem, not ours. */
  private respond(id: unknown, body: { result?: unknown; error?: unknown }): void {
    try {
      this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
    } catch {
      /* the child is gone; `failAll` on its exit is what the caller will see */
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
