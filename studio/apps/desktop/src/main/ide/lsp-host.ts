/**
 * main/ide/lsp-host.ts — spawn + supervise language servers (file 07 §4).
 *
 * Language servers run as child processes IN THE ELECTRON MAIN PROCESS (never the
 * renderer — C5), ONE per `(languageId, workspaceRoot)`, speaking LSP over stdio
 * JSON-RPC. The renderer's Monaco providers proxy every request through the
 * `lsp:request` IPC channel → this host routes it to the right server.
 *
 * This module owns the LIFECYCLE + ROUTING (file 07 §4.2):
 *   - LAZY START: a server boots on the first `ensure(language, root)`, not at app
 *     launch.
 *   - CRASH SUPERVISION: a crashed server restarts with backoff (3 tries / 30 s);
 *     the 4th crash leaves it `failed` and surfaces the stderr tail.
 *   - IDLE GC: a server with zero open documents for 5 min is shut down.
 *   - REQUEST ROUTING + CANCELLATION: a JSON-RPC id correlates each request to its
 *     response; an in-flight request can be cancelled (`$/cancelRequest`).
 *   - pythonPath / interpreter SWAP → `workspace/didChangeConfiguration` (or a
 *     restart for servers that need it, e.g. pyright reading initOptions).
 *
 * DECOUPLED FROM ELECTRON + THE REAL BINARIES (honest env limit): pyright /
 * tsserver are NOT installed here, so the spawn fn is INJECTED. A test passes a
 * fake JSON-RPC child (an EventEmitter-backed stand-in) and drives the whole
 * supervision/routing/cancel/idle state machine without any server binary. The
 * framing + message builders come from the PURE core `lsp/protocol.ts`.
 *
 * Node built-ins only: node:events. (The real spawn is supplied by the caller in
 * main/index.ts via node:child_process — never imported here, so this is testable.)
 */

import { EventEmitter } from "node:events";

import {
  type LspWorkspace,
  MessageReader,
  type PublishDiagnosticsParams,
  type RpcId,
  type RpcMessage,
  type RpcResponse,
  encodeMessage,
  initOptionsFor,
  isNotification,
  isResponse,
  isServerRequest,
  makeCancel,
  makeErrorResponse,
  makeIdGenerator,
  makeNotification,
  makeRequest,
  makeResponse,
  serverFor,
} from "@prometheus/core";

/* ------------------------------------------------------------------------- *
 * The injected child (real OR fake) — the ONLY thing the host spawns through
 * ------------------------------------------------------------------------- */

/**
 * The minimal stdio-child surface the host relies on. The real child is a
 * node:child_process ChildProcess (its stdin/stdout/stderr); a test passes a
 * fake EventEmitter-backed stand-in. The host writes LSP frames to `stdin.write`
 * and reads them off `stdout`'s "data" events.
 */
export interface LspChild {
  pid?: number;
  stdin: { write(data: string): void };
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: string): void;
}

/** The spawn fn the host uses (injected): (cmd, args, opts) → a live LspChild. */
export type LspSpawn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> },
) => LspChild;

/* ------------------------------------------------------------------------- *
 * Supervision policy + state
 * ------------------------------------------------------------------------- */

/** Resilience knobs (file 07 §4.2 defaults: 3 tries / 30 s window, 5 min idle GC). */
export interface LspHostPolicy {
  /** max automatic restarts inside the crash window before `failed`. Default 3. */
  maxRestarts?: number;
  /** crash window (ms): restarts older than this no longer count. Default 30_000. */
  restartWindowMs?: number;
  /** idle GC (ms): a server with zero open docs this long is shut down. Default 300_000. */
  idleGcMs?: number;
  /** per-request timeout (ms): an unanswered request rejects fail-closed. Default 30_000. */
  requestTimeoutMs?: number;
}

const DEFAULT_POLICY: Required<LspHostPolicy> = {
  maxRestarts: 3,
  restartWindowMs: 30_000,
  idleGcMs: 300_000,
  requestTimeoutMs: 30_000,
};

/** APP-078: fail-closed timebox for a relayed `workspace/applyEdit` (renderer tab may close). */
const APPLY_EDIT_TIMEOUT_MS = 5_000;

/** The health a server row reports to the status spine (`◐ pyright ●/✗`). */
export type LspServerState = "starting" | "running" | "restarting" | "failed" | "stopped";

/** A serialisable snapshot of one live server (no live handle leaks out). */
export interface LspServerStatus {
  /** the `(id, root)` key. */
  key: string;
  serverId: string;
  languageId: string;
  workspaceRoot: string;
  state: LspServerState;
  pid?: number;
  /** count of restarts inside the current crash window. */
  restarts: number;
  /** number of currently-open documents (drives idle GC). */
  openDocs: number;
  lastError?: string;
  /** the stderr tail (last lines), surfaced in the Output → <server> channel. */
  stderrTail: string;
}

/** Events the host emits (the IPC layer forwards diagnostics/state to the renderer). */
export interface LspHostEvents {
  /** the server pushed `textDocument/publishDiagnostics` → Monaco markers. */
  diagnostics: [{ serverId: string; params: PublishDiagnosticsParams }];
  /** any server→client notification (progress, logMessage, …) — cosmetic. */
  notify: [{ serverId: string; method: string; params: unknown }];
  /** a server's state changed (the status spine re-renders from this). */
  state: [LspServerStatus];
  /** a stderr line (Output → <server> channel). */
  stderr: [{ serverId: string; line: string }];
  /** APP-078: a server→client `workspace/applyEdit` REQUEST — the renderer applies the edit
   *  then acks via `respondApplyEdit`, resolving the server's pending request. */
  applyEdit: [{ serverId: string; workspaceRoot: string; requestId: RpcId; params: unknown }];
}

/** One injected timer surface so the idle-GC + request-timeout are deterministic. */
export interface LspHostTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  now(): number;
}

const REAL_TIMERS: LspHostTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h.unref === "function") h.unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface LspHostOptions {
  /** the injected spawn fn (tests pass a fake-child factory). */
  spawn: LspSpawn;
  policy?: LspHostPolicy;
  timers?: LspHostTimers;
}

/** One in-flight request awaiting its response (id → resolve/reject + timer). */
interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: unknown;
  method: string;
}

/** The mutable per-server record the host supervises. */
interface Server {
  key: string;
  serverId: string;
  languageId: string;
  workspaceRoot: string;
  cmd: string;
  args: readonly string[];
  ws: LspWorkspace;
  child: LspChild | null;
  state: LspServerState;
  reader: MessageReader;
  nextId: () => number;
  pending: Map<number, Pending>;
  /** APP-078: timeboxes for relayed `workspace/applyEdit` requests (key = String(requestId)). */
  applyEditTimers: Map<string, unknown>;
  openDocs: Set<string>;
  /** wall-clock ms of each recent restart (for the 3/30s window). */
  restartTimes: number[];
  lastError?: string;
  stderrLines: string[];
  idleTimer?: unknown;
  /** set true by stop()/dispose so an exit does NOT auto-restart. */
  intentionalStop: boolean;
}

const STDERR_TAIL_LINES = 50;

/**
 * The LSP host: lazily spawns + supervises one server per (languageId, root) and
 * routes JSON-RPC requests. Construct ONE per MAIN process (alongside the other
 * IDE hosts). Decoupled from Electron + binaries via the injected spawn fn.
 */
export class LspHost extends EventEmitter {
  private readonly spawn: LspSpawn;
  private readonly policy: Required<LspHostPolicy>;
  private readonly timers: LspHostTimers;
  private readonly servers = new Map<string, Server>();
  private disposed = false;

  constructor(opts: LspHostOptions) {
    super();
    this.spawn = opts.spawn;
    this.policy = { ...DEFAULT_POLICY, ...opts.policy };
    this.timers = opts.timers ?? REAL_TIMERS;
  }

  // --- typed EventEmitter overrides ------------------------------------- //
  override on<K extends keyof LspHostEvents>(
    event: K,
    listener: (...args: LspHostEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof LspHostEvents>(event: K, ...args: LspHostEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  /** The `(id, root)` key a server is registered under (tsserver backs ts+js). */
  private static keyFor(serverId: string, workspaceRoot: string): string {
    return `${serverId}::${workspaceRoot}`;
  }

  /**
   * Ensure a language server exists for `(languageId, workspaceRoot)`, spawning it
   * LAZILY on the first call (file 07 §4.2). Returns the stable `serverId` the
   * renderer uses for subsequent `request`/`cancel`/`didOpen` calls. Idempotent:
   * a second ensure for the same key returns the existing server. An unknown
   * language (no registered server) throws — the caller never silently no-ops.
   *
   * `ws` carries the interpreter path from the env-manager (file 04) so pyright's
   * `initializationOptions` analyses against the right venv (§4.1). On-demand
   * servers (rust-analyzer/gopls) are NOT spawned here — their binary download is
   * gated upstream; this host only spawns an already-present binary.
   */
  ensure(languageId: string, ws: LspWorkspace): { serverId: string } {
    if (this.disposed) throw new Error("LspHost disposed");
    const spec = serverFor(languageId);
    if (!spec) throw new Error(`no language server registered for "${languageId}"`);
    const key = LspHost.keyFor(spec.id, ws.rootUri);
    const existing = this.servers.get(key);
    if (existing) {
      // keep the freshest workspace context (interpreter may have changed).
      existing.ws = ws;
      return { serverId: existing.serverId };
    }
    const server: Server = {
      key,
      serverId: spec.id,
      languageId,
      workspaceRoot: ws.rootUri,
      cmd: spec.cmd,
      args: spec.args,
      ws,
      child: null,
      state: "starting",
      reader: new MessageReader(),
      nextId: makeIdGenerator(1),
      pending: new Map(),
      applyEditTimers: new Map(),
      openDocs: new Set(),
      restartTimes: [],
      stderrLines: [],
      intentionalStop: false,
    };
    this.servers.set(key, server);
    this.spawnServer(server, /*isRestart*/ false);
    return { serverId: spec.id };
  }

  /** Spawn (or respawn) the child for a server and wire its stdio. */
  private spawnServer(server: Server, isRestart: boolean): void {
    server.state = isRestart ? "restarting" : "starting";
    this.emitState(server);

    let child: LspChild;
    try {
      child = this.spawn(server.cmd, server.args, {
        cwd: toFsPath(server.workspaceRoot),
        ...(server.ws.interpreterPath
          ? { env: { ...envSnapshot(), PROMETHEUS_LSP_INTERPRETER: server.ws.interpreterPath } }
          : {}),
      });
    } catch (err) {
      server.lastError = err instanceof Error ? err.message : String(err);
      this.handleExit(server, null, null);
      return;
    }

    server.child = child;
    server.reader = new MessageReader();
    server.state = "running";
    this.emitState(server);

    child.stdout.on("data", (chunk) => {
      const msgs = this.safeFeed(server, chunk);
      for (const msg of msgs) this.dispatch(server, msg);
    });
    child.stderr.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (!line) continue;
        server.stderrLines.push(line);
        if (server.stderrLines.length > STDERR_TAIL_LINES) server.stderrLines.shift();
        this.emit("stderr", { serverId: server.serverId, line });
      }
    });
    child.on("error", (err) => {
      server.lastError = err.message;
    });
    child.on("exit", (code, signal) => {
      // Ignore the exit of a SUPERSEDED child (a restart already swapped in a new
      // handle, e.g. the interpreter swap). Only the CURRENT child's exit faults.
      if (server.child !== child) return;
      server.child = null;
      this.handleExit(server, code, signal);
    });

    // LSP `initialize` handshake (server-specific initOptions from §4.1 / file 04).
    const initOptions = initOptionsFor(server.languageId, server.ws);
    void this.sendRequest(server, "initialize", {
      processId: typeof process !== "undefined" ? (process.pid ?? null) : null,
      rootUri: server.workspaceRoot,
      // APP-075: advertise typeHierarchy so servers answer prepare/supertypes (go-to-super).
      // APP-098: prefer markdown for hover/signature docs (Quick Doc) + labelOffsetSupport so
      // signatureHelp param labels arrive as [start,end] tuples (reliable stub param names).
      // Additive only — a server that switches string hovers to markdown is handled by the
      // existing lspContentsToMarkdown flattener (Outline/Call/TypeHierarchy stay string-safe).
      capabilities: {
        textDocument: {
          typeHierarchy: { dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ["markdown", "plaintext"],
              parameterInformation: { labelOffsetSupport: true },
            },
          },
        },
      },
      initializationOptions: initOptions,
      workspaceFolders: [{ uri: server.workspaceRoot, name: basename(server.workspaceRoot) }],
    }).then(
      () => this.notify(server, "initialized", {}),
      () => {
        /* a failed initialize surfaces via the request rejection; supervision handles exit. */
      },
    );
  }

  /** Decode stdout bytes; a malformed frame is logged + dropped, never crashes. */
  private safeFeed(server: Server, chunk: Buffer | string): RpcMessage[] {
    try {
      return server.reader.feed(chunk);
    } catch (err) {
      const line = `protocol error: ${err instanceof Error ? err.message : String(err)}`;
      this.emit("stderr", { serverId: server.serverId, line });
      return [];
    }
  }

  /** Route one decoded message: a response settles a pending; a notification emits. */
  private dispatch(server: Server, msg: RpcMessage): void {
    if (isResponse(msg)) {
      const id = (msg as RpcResponse).id;
      if (typeof id !== "number") return;
      const pend = server.pending.get(id);
      if (!pend) return;
      server.pending.delete(id);
      this.timers.clearTimeout(pend.timer);
      const r = msg as RpcResponse;
      if (r.error)
        pend.reject(new Error(`LSP ${pend.method} error ${r.error.code}: ${r.error.message}`));
      else pend.resolve(r.result);
      return;
    }
    if (isNotification(msg)) {
      const method = (msg as { method: string }).method;
      const params = (msg as { params?: unknown }).params;
      if (method === "textDocument/publishDiagnostics") {
        this.emit("diagnostics", {
          serverId: server.serverId,
          params: params as PublishDiagnosticsParams,
        });
      } else {
        this.emit("notify", { serverId: server.serverId, method, params });
      }
      return;
    }
    // APP-078: a server→client REQUEST (id + method) — MUST be answered or the server hangs.
    if (isServerRequest(msg)) this.handleServerRequest(server, msg);
  }

  /**
   * Answer a server→client request. `workspace/applyEdit` is relayed to the renderer (which
   * applies the edit + acks via `respondApplyEdit`); a 5s timebox fails it closed so the id
   * never dangles. Every OTHER request gets a MethodNotFound response immediately.
   */
  private handleServerRequest(server: Server, msg: RpcMessage): void {
    const req = msg as { id: RpcId; method: string; params?: unknown };
    if (req.method === "workspace/applyEdit") {
      // arm a fail-closed timebox: if the renderer never acks (tab closed), reply applied:false.
      const key = String(req.id);
      const timer = this.timers.setTimeout(() => {
        if (server.applyEditTimers.delete(key))
          this.writeResponse(server, req.id, { applied: false });
      }, APPLY_EDIT_TIMEOUT_MS);
      server.applyEditTimers.set(key, timer);
      this.emit("applyEdit", {
        serverId: server.serverId,
        workspaceRoot: server.workspaceRoot,
        requestId: req.id,
        params: req.params,
      });
      return;
    }
    // window/showMessageRequest, workspace/configuration, client/registerCapability, … → decline.
    this.writeResponse(server, req.id, undefined, true);
  }

  /** Write a JSON-RPC response (success `{result}` or a MethodNotFound error) to a server. */
  private writeResponse(server: Server, id: RpcId, result: unknown, asError = false): void {
    if (!server.child) return;
    const msg = asError ? makeErrorResponse(id) : makeResponse(id, result);
    try {
      server.child.stdin.write(encodeMessage(msg));
    } catch {
      /* server already gone — nothing to answer */
    }
  }

  /**
   * APP-078: the renderer's ack for a relayed `workspace/applyEdit` — resolve the server's
   * pending request with `{ applied }`. A no-op if the timebox already fired or the id is stale.
   */
  respondApplyEdit(
    serverId: string,
    workspaceRoot: string,
    requestId: RpcId,
    applied: boolean,
  ): void {
    const server = this.servers.get(LspHost.keyFor(serverId, workspaceRoot));
    if (!server) return;
    const key = String(requestId);
    const timer = server.applyEditTimers.get(key);
    if (timer === undefined) return; // already timed out / answered
    this.timers.clearTimeout(timer);
    server.applyEditTimers.delete(key);
    this.writeResponse(server, requestId, { applied });
  }

  /**
   * Route a renderer LSP request to a live server by serverId+root and resolve the
   * server's response. The returned promise rejects fail-closed on timeout / a
   * dead server (the renderer renders the failure, never a fabricated result).
   * `requestId` is returned so the renderer can `cancel(serverId, requestId)`.
   */
  request(
    serverId: string,
    workspaceRoot: string,
    method: string,
    params?: unknown,
  ): { id: number; result: Promise<unknown> } {
    const server = this.servers.get(LspHost.keyFor(serverId, workspaceRoot));
    if (!server) {
      return {
        id: -1,
        result: Promise.reject(new Error(`no LSP server ${serverId} for ${workspaceRoot}`)),
      };
    }
    const id = server.nextId();
    const result = this.sendRequestWithId(server, id, method, params);
    return { id, result };
  }

  /** Internal: allocate an id and send. */
  private sendRequest(server: Server, method: string, params?: unknown): Promise<unknown> {
    return this.sendRequestWithId(server, server.nextId(), method, params);
  }

  /** Internal: send a request with a chosen id (so request() can return it for cancel). */
  private sendRequestWithId(
    server: Server,
    id: number,
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    if (!server.child || server.state === "failed" || server.state === "stopped") {
      return Promise.reject(
        new Error(`LSP server ${server.serverId} not running (${server.state})`),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (server.pending.delete(id)) {
          // cancel the in-flight request on the server side, then fail closed.
          this.notify(server, "$/cancelRequest", { id });
          reject(new Error(`LSP ${method} timed out after ${this.policy.requestTimeoutMs}ms`));
        }
      }, this.policy.requestTimeoutMs);
      server.pending.set(id, { resolve, reject, timer, method });
      try {
        server.child!.stdin.write(encodeMessage(makeRequest(id, method, params)));
      } catch (err) {
        server.pending.delete(id);
        this.timers.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Cancel an in-flight request (Monaco passes a CancellationToken on fast typing /
   * model close, file 07 §4.2). Sends LSP `$/cancelRequest` and settles the local
   * pending promise as a rejection. A no-op for an unknown id.
   */
  cancel(serverId: string, workspaceRoot: string, requestId: number): void {
    const server = this.servers.get(LspHost.keyFor(serverId, workspaceRoot));
    if (!server) return;
    const pend = server.pending.get(requestId);
    if (!pend) return;
    server.pending.delete(requestId);
    this.timers.clearTimeout(pend.timer);
    if (server.child) {
      try {
        server.child.stdin.write(encodeMessage(makeCancel(requestId)));
      } catch {
        /* a dead server can't be cancelled — the reject below is enough. */
      }
    }
    pend.reject(new Error(`LSP ${pend.method} cancelled`));
  }

  /** Send a fire-and-forget notification to a server (didOpen/didChange/…). */
  private notify(server: Server, method: string, params?: unknown): void {
    if (!server.child) return;
    try {
      server.child.stdin.write(encodeMessage(makeNotification(method, params)));
    } catch {
      /* a dropped notification is non-fatal; supervision handles a dead child. */
    }
  }

  /**
   * Track an opened document (drives idle GC) and forward `didOpen`. The renderer
   * calls this on tab open; closing the last doc starts the 5-min idle timer.
   */
  didOpen(
    serverId: string,
    workspaceRoot: string,
    uri: string,
    languageId: string,
    text: string,
    version = 1,
  ): void {
    const server = this.servers.get(LspHost.keyFor(serverId, workspaceRoot));
    if (!server) return;
    server.openDocs.add(uri);
    this.clearIdleTimer(server);
    this.notify(server, "textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
    this.emitState(server);
  }

  /** Forward a `didChange` (incremental edits are out of scope — full-text sync). */
  didChange(
    serverId: string,
    workspaceRoot: string,
    uri: string,
    text: string,
    version: number,
  ): void {
    const server = this.servers.get(LspHost.keyFor(serverId, workspaceRoot));
    if (!server) return;
    this.notify(server, "textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /** Untrack a closed document; the LAST close arms the idle-GC timer (§4.2). */
  didClose(serverId: string, workspaceRoot: string, uri: string): void {
    const server = this.servers.get(LspHost.keyFor(serverId, workspaceRoot));
    if (!server) return;
    server.openDocs.delete(uri);
    this.notify(server, "textDocument/didClose", { textDocument: { uri } });
    if (server.openDocs.size === 0) this.armIdleTimer(server);
    this.emitState(server);
  }

  /**
   * Swap the workspace interpreter (file 04 → §4.1): send `didChangeConfiguration`
   * with the new pythonPath. Pyright reads its interpreter from initializationOptions,
   * so when the path actually changes we RESTART it (no app restart) so the new
   * options take effect — exactly the §4.1 behaviour. A no-op when the path is
   * unchanged. Returns true iff a restart was triggered.
   */
  setInterpreter(serverId: string, workspaceRoot: string, interpreterPath: string): boolean {
    const server = this.servers.get(LspHost.keyFor(serverId, workspaceRoot));
    if (!server) return false;
    const changed = server.ws.interpreterPath !== interpreterPath;
    server.ws = { ...server.ws, interpreterPath };
    // Always notify (cheap; some servers honour live config).
    this.notify(server, "workspace/didChangeConfiguration", {
      settings: { python: { pythonPath: interpreterPath } },
    });
    if (changed && server.languageId === "python") {
      // pyright needs the new interpreter in initializationOptions → restart.
      this.restartNow(server);
      return true;
    }
    return false;
  }

  /** Force a clean restart NOW (used by the interpreter swap). */
  private restartNow(server: Server): void {
    const child = server.child;
    server.child = null;
    server.intentionalStop = false; // exit handler should NOT treat this as a stop…
    // …but it WILL try to auto-restart; suppress by spawning immediately and
    // marking the old child as superseded.
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    this.rejectAllPending(server, "server restarting (interpreter changed)");
    this.spawnServer(server, /*isRestart*/ true);
  }

  /**
   * Handle a child exit: reject pending requests, then decide RESTART vs FAILED per
   * the 3-tries-in-30s window (file 07 §4.2). An intentional stop goes to `stopped`.
   */
  private handleExit(server: Server, code: number | null, signal: string | null): void {
    // The caller (the exit listener) has already nulled server.child for the CURRENT
    // child; a SUPERSEDED old child's exit was filtered there and never reaches here.
    // The spawn-failure path also enters with a null child. So no guard is needed.
    this.rejectAllPending(
      server,
      `server exited (code ${code ?? "null"}, signal ${signal ?? "null"})`,
    );

    if (server.intentionalStop || this.disposed) {
      server.state = "stopped";
      this.emitState(server);
      return;
    }

    if (server.lastError === undefined && code !== null && code !== 0) {
      server.lastError = `exited with code ${code}`;
    } else if (server.lastError === undefined && signal) {
      server.lastError = `killed by signal ${signal}`;
    }

    // Prune restart timestamps outside the window, then decide.
    const now = this.timers.now();
    server.restartTimes = server.restartTimes.filter((t) => now - t < this.policy.restartWindowMs);
    if (server.restartTimes.length >= this.policy.maxRestarts) {
      server.state = "failed";
      this.emitState(server);
      return;
    }
    server.restartTimes.push(now);
    server.lastError = undefined;
    this.spawnServer(server, /*isRestart*/ true);
  }

  /** Reject every in-flight request for a server (on exit / restart). */
  private rejectAllPending(server: Server, reason: string): void {
    for (const [, pend] of server.pending) {
      this.timers.clearTimeout(pend.timer);
      pend.reject(new Error(`LSP ${pend.method}: ${reason}`));
    }
    server.pending.clear();
  }

  /** Arm the idle-GC timer (last doc closed → shut down after idleGcMs). */
  private armIdleTimer(server: Server): void {
    this.clearIdleTimer(server);
    server.idleTimer = this.timers.setTimeout(() => {
      if (server.openDocs.size === 0) void this.stop(server.serverId, server.workspaceRoot);
    }, this.policy.idleGcMs);
  }

  private clearIdleTimer(server: Server): void {
    if (server.idleTimer !== undefined) {
      this.timers.clearTimeout(server.idleTimer);
      server.idleTimer = undefined;
    }
  }

  /** Stop one server (SIGTERM the child; mark `stopped`). Idempotent. */
  stop(serverId: string, workspaceRoot: string): void {
    const server = this.servers.get(LspHost.keyFor(serverId, workspaceRoot));
    if (!server) return;
    server.intentionalStop = true;
    this.clearIdleTimer(server);
    const child = server.child;
    server.child = null;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    this.rejectAllPending(server, "server stopped");
    server.state = "stopped";
    this.emitState(server);
    this.servers.delete(server.key);
  }

  /** A serialisable snapshot of one server (or undefined if unknown). */
  status(serverId: string, workspaceRoot: string): LspServerStatus | undefined {
    const s = this.servers.get(LspHost.keyFor(serverId, workspaceRoot));
    return s ? this.toStatus(s) : undefined;
  }

  /** A snapshot of every supervised server (the status spine reads this). */
  list(): LspServerStatus[] {
    return [...this.servers.values()].map((s) => this.toStatus(s));
  }

  /** Tear down every server (app shutdown). */
  dispose(): void {
    this.disposed = true;
    for (const server of [...this.servers.values()]) {
      this.stop(server.serverId, server.workspaceRoot);
    }
  }

  private emitState(server: Server): void {
    this.emit("state", this.toStatus(server));
  }

  private toStatus(s: Server): LspServerStatus {
    return {
      key: s.key,
      serverId: s.serverId,
      languageId: s.languageId,
      workspaceRoot: s.workspaceRoot,
      state: s.state,
      pid: s.child?.pid,
      restarts: s.restartTimes.length,
      openDocs: s.openDocs.size,
      lastError: s.lastError,
      stderrTail: s.stderrLines.join("\n"),
    };
  }
}

/* ------------------------------------------------------------------------- *
 * Small pure helpers (no node:* needed)
 * ------------------------------------------------------------------------- */

/** A snapshot of process.env as a plain Record (best-effort; {} off-process). */
function envSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof process !== "undefined" && process.env) {
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Convert a `file:///abs/path` URI to a filesystem path (best-effort, no node:url). */
function toFsPath(uri: string): string {
  if (uri.startsWith("file://")) {
    const path = decodeURIComponent(uri.slice("file://".length));
    // file:///abs → /abs ; file://host/abs is unsupported (local only).
    return path.startsWith("/") ? path : `/${path}`;
  }
  return uri;
}

/** The trailing path segment of a uri/path (for the workspaceFolder name). */
function basename(p: string): string {
  const clean = p.replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx === -1 ? clean : clean.slice(idx + 1);
}
