// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/ide/dap-host.ts — spawn + supervise debug adapters (file 07 §5).
 *
 * Debug adapters run the SAME shape as language servers: child processes IN THE
 * MAIN PROCESS (C5), speaking DAP over stdio (a `Content-Length`-framed envelope
 * with a request/response/event body, NOT JSON-RPC). The renderer's DebugPanel
 * proxies launch/attach/setBreakpoints/stackTrace through the `dap:*` IPC channel
 * → this host routes by sessionId.
 *
 * It owns the SESSION lifecycle + request routing:
 *   - launch(config)  spawns the adapter, runs the `initialize` → `launch`/`attach`
 *     handshake, returns a sessionId.
 *   - request(sessionId, command, args)  correlates a DAP response to its request
 *     by the request `seq` (fail-closed on timeout / a dead adapter).
 *   - events (stopped/output/terminated/…) are emitted to the renderer.
 *
 * DECOUPLED FROM ELECTRON + THE REAL ADAPTERS (honest env limit): debugpy /
 * js-debug are NOT installed here, so the spawn fn is INJECTED. A test passes a
 * fake DAP child and drives the launch/routing/event state machine without any
 * adapter binary. The framing + builders come from the PURE core `dap/protocol.ts`.
 *
 * The SECURITY WRINKLE (file 07 §5.2) — "starting a debug session executes the
 * project's code" — is enforced UPSTREAM of this host by `gate.ts`/`ide-ipc.ts`:
 * the FIRST run/debug of an untrusted workspace passes the run-gate BEFORE a
 * launch reaches this host. This host spawns an already-cleared adapter; it makes
 * NO safety decision (C5).
 *
 * Node built-ins only: node:events. (The real spawn is injected from main/index.ts.)
 */

import { EventEmitter } from "node:events";

import {
  type DapCapabilities,
  type DapMessage,
  DapMessageReader,
  type DapResponse,
  type DebugConfig,
  type SourceBreakpoint,
  encodeDapMessage,
  isDapEvent,
  isDapResponse,
  makeDapRequest,
  makeSeqGenerator,
} from "@prometheus/core";

/* ------------------------------------------------------------------------- *
 * The injected child (real OR fake)
 * ------------------------------------------------------------------------- */

/** The minimal stdio-child surface the DAP host relies on (same shape as LSP). */
export interface DapChild {
  pid?: number;
  stdin: { write(data: string): void };
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: string): void;
}

/** Spawn fn (injected) for one debug adapter: (cmd, args, opts) → a live DapChild. */
export type DapSpawn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env?: Record<string, string> },
) => DapChild;

/**
 * The minimal `net.Socket` surface the DAP host relies on for REMOTE/ATTACH sessions
 * (APP-080). A socket and a child's stdio are both duplex streams; the socket is
 * adapted into the SAME `DapChild` shape (`socketToChild`) so there is ONE protocol
 * path (framing/seq/pending) for both transports. Injected so tests stay binary-free
 * (an in-process fake TCP adapter, no real `node:net`).
 */
export interface DapSocket {
  write(data: string): void;
  setNoDelay(noDelay: boolean): void;
  destroy(): void;
  destroyed: boolean;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "connect", listener: () => void): void;
  on(event: "close", listener: (hadError: boolean) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  once(event: "connect", listener: () => void): void;
  once(event: "error", listener: (err: Error) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
  removeAllListeners(): void;
}

/** Connect fn (injected) for a remote/attach DAP session: dials `host:port` and
 *  returns a connecting `DapSocket` (the host gates on its `'connect'` event). */
export type DapConnect = (host: string, port: number) => DapSocket;

/** A static adapter spec: which binary backs a `type` (file 07 §5.3). */
export interface DapAdapterSpec {
  cmd: string;
  args: readonly string[];
}

/**
 * Adapter registry (file 07 §5.3): js-debug/codelldb distributions are undecided
 * (on-demand, gated upstream, never spawned for an un-downloaded binary) — their
 * argv stays a placeholder pending that choice. `python` is NOT a placeholder: it
 * is resolved dynamically by `adapterFor` below to the REAL debugpy invocation
 * (`<interpreter> -m debugpy.adapter`, debugpy's standard stdio DAP adapter mode)
 * against whichever interpreter the launch config specifies. The renderer never
 * supplies a spawnable command (C5) — it picks a `type` (+ optional interpreter
 * path), the host resolves the real argv here.
 */
export const DAP_ADAPTERS: Readonly<Record<string, DapAdapterSpec>> = Object.freeze({
  node: { cmd: "js-debug", args: [] },
  rust: { cmd: "codelldb", args: [] },
});

/** The default python3 interpreter when a launch config carries none. */
export const DEFAULT_PYTHON = "python3";

/**
 * Resolve a debug `type` to its adapter spec (undefined if unknown). `pythonPath`
 * (the launch config's resolved interpreter, file 04) drives the `python` case —
 * every other type is the static (placeholder) registry above.
 */
export function adapterFor(type: string, pythonPath?: string): DapAdapterSpec | undefined {
  if (type === "python")
    return { cmd: pythonPath || DEFAULT_PYTHON, args: ["-m", "debugpy.adapter"] };
  return DAP_ADAPTERS[type];
}

/* ------------------------------------------------------------------------- *
 * Session state
 * ------------------------------------------------------------------------- */

/** The lifecycle a debug session moves through. */
export type DapSessionState = "starting" | "running" | "terminated" | "failed";

/** A serialisable snapshot of one debug session. */
export interface DapSessionStatus {
  sessionId: string;
  type: string;
  name: string;
  state: DapSessionState;
  pid?: number;
  lastError?: string;
}

/** One source's launch-time breakpoints (absolute path + its DAP SourceBreakpoints). */
export interface DapSourcePlan {
  path: string;
  breakpoints: SourceBreakpoint[];
}

/**
 * The launch-time configuration the RENDERER hands the host so the host — not the
 * renderer — sequences the strict DAP config phase (initialized → setBreakpoints /
 * setExceptionBreakpoints → configurationDone). Breakpoints must be known BEFORE the
 * adapter emits `initialized`, so they ride in with `launch` (a later call would race).
 */
export interface DapLaunchPlan {
  /** per-source breakpoints (REPLACE-ALL per source). */
  sources?: DapSourcePlan[];
  /** exception breakpoint filter IDs to arm (`[]` clears; omitted ⇒ don't send). */
  exceptionFilters?: string[];
}

/** Non-DAP launch options the host acts on but never forwards to the adapter (APP-080). */
export interface DapLaunchOptions {
  /** the caller confirmed a REMOTE (non-loopback) attach — required to open a remote socket. */
  allowRemote?: boolean;
}

/** Events the host emits (the IPC layer forwards them to the renderer's DebugPanel). */
export interface DapHostEvents {
  /** any DAP event (stopped/output/terminated/thread/breakpoint/…). */
  event: [{ sessionId: string; event: string; body: unknown }];
  /** the session state changed. */
  state: [DapSessionStatus];
  /** a stderr line from the adapter. */
  stderr: [{ sessionId: string; line: string }];
  /** a launch-time `setBreakpoints` response, so the renderer store folds verified
   *  flags + adapter-adjusted lines (the host owns this send, not the renderer). */
  configApplied: [{ sessionId: string; path: string; sentLines: number[]; breakpoints: unknown[] }];
}

export interface DapHostTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

const REAL_TIMERS: DapHostTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h.unref === "function") h.unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** One adapter's availability (APP-029: no more silent "no debug adapter available"). */
export interface DapAdapterAvailability {
  type: string;
  available: boolean;
  detail: string;
}

/** Read-only probe: does `type` (against `pythonPath` for python) actually run? Injected
 *  so tests stay binary-free — a host with none configured fails closed (never "available"). */
export type DapAdapterDetector = (
  type: string,
  pythonPath?: string,
) => Promise<DapAdapterAvailability>;

/** The outcome of an install attempt — mirrors env-ipc.ts's GatedInstallResult shape
 *  (ok / blocked / needsConfirm) so DebugPanel can reuse the same VerdictSheet pattern. */
export interface DapAdapterInstallResult {
  ok: boolean;
  /** true when nemesis blocked the staged download — never installed. */
  blocked?: boolean;
  /** true on a WARN verdict awaiting `opts.confirm` — nothing installed yet. */
  needsConfirm?: boolean;
  output: string;
  error?: string;
}

/**
 * Stage → gate → install ONE adapter dependency. GATE NOTE (C5): this function itself
 * performs the gating (unlike `launch`, which trusts an upstream gate) because install
 * is the ONE dap-host action that fetches + executes third-party code — there is no
 * upstream run-gate for "installing a debugger" the way there is for "running a
 * project". Injected so tests never touch real pip/nemesis.
 */
export type DapAdapterInstaller = (
  type: string,
  opts: { pythonPath?: string; confirm?: boolean },
) => Promise<DapAdapterInstallResult>;

export interface DapHostOptions {
  spawn: DapSpawn;
  /** injected TCP connect for remote/attach sessions (APP-080); absent ⇒ a `connect:`
   *  config is refused fail-closed (this host cannot open a socket). */
  connect?: DapConnect;
  /** per-request timeout (ms) — an unanswered DAP request fails closed. Default 30_000. */
  requestTimeoutMs?: number;
  timers?: DapHostTimers;
  /** id minter (injectable for deterministic tests). Default a counter. */
  mintId?: () => string;
  /** injected adapter-presence probe (APP-029); absent ⇒ detectAdapter always reports unavailable. */
  detector?: DapAdapterDetector;
  /** injected stage→gate→install (APP-029); absent ⇒ installAdapter always refuses. */
  installer?: DapAdapterInstaller;
}

interface Pending {
  resolve: (body: unknown) => void;
  reject: (err: Error) => void;
  timer: unknown;
  command: string;
}

interface Session {
  sessionId: string;
  type: string;
  name: string;
  config: DebugConfig;
  child: DapChild | null;
  state: DapSessionState;
  reader: DapMessageReader;
  nextSeq: () => number;
  pending: Map<number, Pending>;
  lastError?: string;
  /** the adapter's `initialize` response capabilities (APP-079); empty until captured. */
  capabilities: DapCapabilities;
  /** the renderer's launch-time breakpoint/exception plan, applied on `initialized`. */
  plan?: DapLaunchPlan;
  /** guard: the initialized→config phase runs exactly once per session. */
  configured: boolean;
}

/**
 * The DAP host: spawns one adapter per debug session + routes DAP requests by seq.
 * Construct ONE per MAIN process. Decoupled from Electron + adapters via the
 * injected spawn fn.
 */
export class DapHost extends EventEmitter {
  private readonly spawn: DapSpawn;
  private readonly connect: DapConnect | undefined;
  private readonly requestTimeoutMs: number;
  private readonly timers: DapHostTimers;
  private readonly mintId: () => string;
  private readonly detector: DapAdapterDetector | undefined;
  private readonly installer: DapAdapterInstaller | undefined;
  private readonly sessions = new Map<string, Session>();
  private idCounter = 0;
  private disposed = false;

  constructor(opts: DapHostOptions) {
    super();
    this.spawn = opts.spawn;
    this.connect = opts.connect;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.timers = opts.timers ?? REAL_TIMERS;
    this.mintId = opts.mintId ?? (() => `dap-${++this.idCounter}`);
    this.detector = opts.detector;
    this.installer = opts.installer;
  }

  /**
   * Whether `type`'s adapter is actually runnable right now (APP-029) — a real probe,
   * never a guess from the static registry. No detector configured ⇒ unavailable with
   * an honest reason (never silently "available").
   */
  async detectAdapter(type: string, pythonPath?: string): Promise<DapAdapterAvailability> {
    if (type !== "python" && !DAP_ADAPTERS[type]) {
      return { type, available: false, detail: `unknown debug type "${type}"` };
    }
    if (!this.detector) {
      return { type, available: false, detail: "adapter detection unavailable in this host" };
    }
    return this.detector(type, pythonPath);
  }

  /**
   * Fetch + install the adapter dependency for `type` (currently: debugpy for python
   * only — js-debug/codelldb have no chosen distribution yet, §5.3). No installer
   * configured ⇒ refuses (never fakes a successful install).
   */
  async installAdapter(
    type: string,
    opts: { pythonPath?: string; confirm?: boolean } = {},
  ): Promise<DapAdapterInstallResult> {
    if (!this.installer) {
      return { ok: false, output: "", error: "adapter install unavailable in this host" };
    }
    return this.installer(type, opts);
  }

  override on<K extends keyof DapHostEvents>(
    event: K,
    listener: (...args: DapHostEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof DapHostEvents>(event: K, ...args: DapHostEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Launch a debug session (file 07 §5): spawn the adapter for `config.type`, run
   * the `initialize` → `launch`/`attach` handshake, and return its sessionId. The
   * returned promise resolves once the launch request is acknowledged; it rejects
   * if the adapter is unknown, the spawn fails, or the handshake times out.
   *
   * GATE NOTE (C5): the run-gate (§5.2) runs UPSTREAM (ide-ipc → gate.ts) before
   * this is ever called for an untrusted workspace. This host makes NO safety call.
   */
  async launch(
    config: DebugConfig,
    plan?: DapLaunchPlan,
    opts?: DapLaunchOptions,
  ): Promise<{ sessionId: string; capabilities: DapCapabilities }> {
    if (this.disposed) throw new Error("DapHost disposed");
    // REMOTE/ATTACH (APP-080): a `connect` target opens a socket instead of spawning a
    // local adapter. Both transport-selection AND the fail-closed remote gate run BEFORE
    // any session/socket exists — a refused remote attach never opens a connection.
    const target = readConnectTarget(config);
    let spec: DapAdapterSpec | undefined;
    if (!target) {
      spec = adapterFor(config.type, config.python);
      if (!spec) throw new Error(`no debug adapter registered for type "${config.type}"`);
    } else {
      if (config.request !== "attach") {
        throw new Error(`a "connect" target requires request "attach", not "${config.request}"`);
      }
      if (!this.connect) throw new Error("socket debug transport is unavailable in this host");
      // Non-loopback = remote code execution → require the caller's typed confirmation.
      // Literal loopback only; a hostname is NEVER DNS-resolved to classify (SSRF-style
      // rebind), so a non-literal host is treated as remote, fail-closed.
      if (!isLoopbackHost(target.host) && !opts?.allowRemote) {
        throw new Error(
          `remote debug attach to ${target.host}:${target.port} requires confirmation`,
        );
      }
    }

    const sessionId = this.mintId();
    const session: Session = {
      sessionId,
      type: config.type,
      name: config.name,
      config,
      child: null,
      state: "starting",
      reader: new DapMessageReader(),
      nextSeq: makeSeqGenerator(1),
      pending: new Map(),
      capabilities: {},
      configured: false,
      // provided AT launch so the plan is known before `initialized` can fire (§ ordering).
      ...(plan ? { plan } : {}),
    };
    this.sessions.set(sessionId, session);
    this.emitState(session);

    let child: DapChild;
    try {
      child = target
        ? await this.openSocketChild(target)
        : this.spawn(spec!.cmd, spec!.args, {
            ...(config.cwd ? { cwd: config.cwd } : {}),
            ...(config.python
              ? { env: { ...envSnapshot(), PROMETHEUS_DEBUG_PYTHON: config.python } }
              : {}),
          });
    } catch (err) {
      session.lastError = err instanceof Error ? err.message : String(err);
      session.state = "failed";
      this.emitState(session);
      throw err instanceof Error ? err : new Error(String(err));
    }

    session.child = child;
    session.state = "running";
    this.emitState(session);

    child.stdout.on("data", (chunk) => {
      for (const msg of this.safeFeed(session, chunk)) this.dispatch(session, msg);
    });
    child.stderr.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (line) this.emit("stderr", { sessionId, line });
      }
    });
    child.on("error", (err) => {
      session.lastError = err.message;
    });
    child.on("exit", (code, signal) => this.handleExit(session, code, signal));

    // initialize → launch/attach handshake (DAP §"Initialization"). The initialize
    // RESPONSE body IS the adapter's Capabilities — capture it: it drives whether we
    // send configurationDone, which exception filters exist, and logpoint support.
    const initBody = await this.send(session, "initialize", {
      clientID: "prometheus-studio",
      adapterID: config.type,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
      supportsConfigurationDoneRequest: true,
    });
    session.capabilities = asCapabilities(initBody);
    await this.send(session, config.request, stripControlFields(config));
    return { sessionId, capabilities: session.capabilities };
  }

  /**
   * Open a TCP socket to a remote/attach target and adapt it to the ONE `DapChild`
   * protocol path (APP-080). Resolves once the socket fires `'connect'`; rejects
   * (and destroys the socket) on `'error'` (e.g. ECONNREFUSED, distinct from a later
   * `'close'`) or the per-request connect timeout, so a stuck dial never wedges
   * launch. `setNoDelay(true)` kills Nagle (~40ms/step on a request/response protocol).
   */
  private async openSocketChild(target: { host: string; port: number }): Promise<DapChild> {
    const socket = this.connect!(target.host, target.port);
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        finish();
        socket.destroy();
        reject(
          new Error(
            `connect to ${target.host}:${target.port} timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);
      const onConnect = (): void => {
        finish();
        resolve();
      };
      const onError = (err: Error): void => {
        finish();
        socket.destroy();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const finish = (): void => {
        this.timers.clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    return socketToChild(socket);
  }

  /**
   * The strict DAP config phase (APP-079), sequenced HERE (not the renderer) so the
   * ordering is unraceable: on the adapter's `initialized` event send every source's
   * `setBreakpoints` (with condition/hitCondition/logMessage), then
   * `setExceptionBreakpoints`, then `configurationDone` (only if the adapter advertises
   * `supportsConfigurationDoneRequest`; older adapters resume on the last config
   * request). Runs exactly once. Each setBreakpoints response is emitted back so the
   * renderer store can fold verified flags + adapter-adjusted lines.
   */
  private async applyConfiguration(session: Session): Promise<void> {
    if (session.configured) return;
    session.configured = true;
    const plan = session.plan;
    try {
      for (const src of plan?.sources ?? []) {
        const sentLines = src.breakpoints.map((b) => b.line);
        const body = (await this.send(session, "setBreakpoints", {
          source: { path: src.path },
          breakpoints: src.breakpoints,
        }).catch(() => undefined)) as { breakpoints?: unknown[] } | undefined;
        this.emit("configApplied", {
          sessionId: session.sessionId,
          path: src.path,
          sentLines,
          breakpoints: body?.breakpoints ?? [],
        });
      }
      if (plan?.exceptionFilters !== undefined) {
        await this.send(session, "setExceptionBreakpoints", {
          filters: plan.exceptionFilters,
        }).catch(() => {});
      }
      if (session.capabilities.supportsConfigurationDoneRequest) {
        await this.send(session, "configurationDone", {}).catch(() => {});
      }
    } catch {
      /* the config phase is best-effort — a dead adapter surfaces via state/events */
    }
  }

  /** Decode adapter stdout; a malformed frame is logged + dropped. */
  private safeFeed(session: Session, chunk: Buffer | string): DapMessage[] {
    try {
      return session.reader.feed(chunk);
    } catch (err) {
      this.emit("stderr", {
        sessionId: session.sessionId,
        line: `protocol error: ${err instanceof Error ? err.message : String(err)}`,
      });
      return [];
    }
  }

  /** Route one decoded DAP message: a response settles a pending; an event emits. */
  private dispatch(session: Session, msg: DapMessage): void {
    if (isDapResponse(msg)) {
      const r = msg as DapResponse;
      const pend = session.pending.get(r.request_seq);
      if (!pend) return;
      session.pending.delete(r.request_seq);
      this.timers.clearTimeout(pend.timer);
      if (r.success) pend.resolve(r.body);
      else pend.reject(new Error(`DAP ${pend.command} failed: ${r.message ?? "unknown error"}`));
      return;
    }
    if (isDapEvent(msg)) {
      const ev = msg.event;
      const body = msg.body;
      this.emit("event", { sessionId: session.sessionId, event: ev, body });
      if (ev === "initialized") {
        // DAP-fixed ordering: breakpoints/exception filters are only valid AFTER this
        // event and MUST precede configurationDone — the host owns that sequence.
        void this.applyConfiguration(session);
      } else if (ev === "terminated" || ev === "exited") {
        session.state = "terminated";
        this.emitState(session);
      }
    }
  }

  /**
   * Route a renderer DAP request to a session (setBreakpoints/stackTrace/scopes/
   * variables/continue/step/evaluate/…). Resolves the adapter's response body;
   * rejects fail-closed on timeout / unknown session / a dead adapter.
   */
  request(sessionId: string, command: string, args?: unknown): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error(`no debug session ${sessionId}`));
    return this.send(session, command, args);
  }

  /** Internal: allocate a seq, write the framed request, await the matching response. */
  private send(session: Session, command: string, args?: unknown): Promise<unknown> {
    if (!session.child || session.state === "terminated" || session.state === "failed") {
      return Promise.reject(
        new Error(`debug session ${session.sessionId} not running (${session.state})`),
      );
    }
    const seq = session.nextSeq();
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (session.pending.delete(seq)) {
          reject(new Error(`DAP ${command} timed out after ${this.requestTimeoutMs}ms`));
        }
      }, this.requestTimeoutMs);
      session.pending.set(seq, { resolve, reject, timer, command });
      try {
        session.child!.stdin.write(encodeDapMessage(makeDapRequest(seq, command, args)));
      } catch (err) {
        session.pending.delete(seq);
        this.timers.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Terminate a session: a BEST-EFFORT `disconnect` request (raced against a short
   * deadline so a hung adapter never blocks shutdown), then SIGTERM the child.
   */
  async terminate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.child && session.state === "running") {
      // race the disconnect against a 1s cap: a hung adapter must not stall quit.
      const disconnect = this.send(session, "disconnect", { terminateDebuggee: true }).catch(
        () => {},
      );
      let deadlineHandle: ReturnType<typeof this.timers.setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        deadlineHandle = this.timers.setTimeout(resolve, 1_000);
      });
      try {
        await Promise.race([disconnect, deadline]);
      } finally {
        // a fast disconnect must not leave the 1s timer dangling (clear on both paths).
        if (deadlineHandle !== undefined) this.timers.clearTimeout(deadlineHandle);
      }
    }
    const child = session.child;
    session.child = null;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    this.rejectAllPending(session, "session terminated");
    session.state = "terminated";
    this.emitState(session);
    this.sessions.delete(sessionId);
  }

  /** Handle an adapter exit: reject pending, mark terminated/failed (no auto-restart). */
  private handleExit(session: Session, code: number | null, signal: string | null): void {
    if (session.child === null) return; // already torn down via terminate().
    session.child = null;
    this.rejectAllPending(
      session,
      `adapter exited (code ${code ?? "null"}, signal ${signal ?? "null"})`,
    );
    // A debug session is single-shot: a crash is terminal (unlike an LSP server).
    if (session.state !== "terminated") {
      session.state = code === 0 ? "terminated" : "failed";
      if (code !== null && code !== 0 && session.lastError === undefined) {
        session.lastError = `adapter exited with code ${code}`;
      }
      this.emitState(session);
    }
    this.sessions.delete(session.sessionId);
  }

  private rejectAllPending(session: Session, reason: string): void {
    for (const [, pend] of session.pending) {
      this.timers.clearTimeout(pend.timer);
      pend.reject(new Error(`DAP ${pend.command}: ${reason}`));
    }
    session.pending.clear();
  }

  /** A serialisable snapshot of one session (or undefined). */
  status(sessionId: string): DapSessionStatus | undefined {
    const s = this.sessions.get(sessionId);
    return s ? this.toStatus(s) : undefined;
  }

  /** Snapshot of every live session. */
  list(): DapSessionStatus[] {
    return [...this.sessions.values()].map((s) => this.toStatus(s));
  }

  /** Tear down every session (app shutdown). */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.terminate(id)));
  }

  private emitState(session: Session): void {
    this.emit("state", this.toStatus(session));
  }

  private toStatus(s: Session): DapSessionStatus {
    return {
      sessionId: s.sessionId,
      type: s.type,
      name: s.name,
      state: s.state,
      pid: s.child?.pid,
      lastError: s.lastError,
    };
  }
}

/* ------------------------------------------------------------------------- *
 * Small pure helpers
 * ------------------------------------------------------------------------- */

/** Coerce an `initialize` response body to the capability subset the host gates on
 *  (junk / a non-object body ⇒ empty capabilities, i.e. everything "false"). */
function asCapabilities(body: unknown): DapCapabilities {
  if (!body || typeof body !== "object") return {};
  const o = body as Record<string, unknown>;
  const out: DapCapabilities = {};
  for (const k of [
    "supportsConfigurationDoneRequest",
    "supportsConditionalBreakpoints",
    "supportsHitConditionalBreakpoints",
    "supportsLogPoints",
    "supportsExceptionFilterOptions",
    "supportsSetVariable",
  ] as const) {
    if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  }
  if (Array.isArray(o.exceptionBreakpointFilters)) {
    const filters = o.exceptionBreakpointFilters
      .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
      .filter((f) => typeof f.filter === "string")
      .map((f) => ({
        filter: f.filter as string,
        label: typeof f.label === "string" ? f.label : (f.filter as string),
        ...(typeof f.description === "string" ? { description: f.description } : {}),
        ...(typeof f.default === "boolean" ? { default: f.default } : {}),
        ...(typeof f.supportsCondition === "boolean"
          ? { supportsCondition: f.supportsCondition }
          : {}),
      }));
    out.exceptionBreakpointFilters = filters;
  }
  return out;
}

/** A snapshot of process.env as a plain Record. */
function envSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof process !== "undefined" && process.env) {
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Strip the launch-config fields that aren't part of the DAP launch ARGUMENTS
 * (the adapter doesn't want our routing metadata). Returns a plain object the host
 * sends as the `launch`/`attach` request arguments. Note `connect` SURVIVES: debugpy's
 * client-mode attach arguments carry `{ connect: { host, port } }` verbatim (APP-080).
 */
function stripControlFields(config: DebugConfig): Record<string, unknown> {
  const { type: _type, request: _request, ...args } = config;
  return args as Record<string, unknown>;
}

/** Read a validated attach `connect` target off a config (undefined when absent/malformed). */
function readConnectTarget(config: DebugConfig): { host: string; port: number } | undefined {
  const c = config.connect;
  if (!c || typeof c.host !== "string" || typeof c.port !== "number") return undefined;
  return { host: c.host, port: c.port };
}

/**
 * True only for a LITERAL loopback host (APP-080): `localhost`, `::1` (optionally
 * bracketed `[::1]`), or any `127.0.0.0/8` address. `0.0.0.0`/`::` are WILDCARDS, not
 * loopback (→ remote). A hostname is NEVER DNS-resolved to classify (an SSRF-style
 * rebind trick) — a non-literal host is remote, fail-closed.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // [::1] → ::1
  if (h === "localhost" || h === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Adapt a `DapSocket` to the `DapChild` surface (APP-080) so the session's ONE
 * protocol path (framing/seq/pending) never forks: `write` maps to the socket, `data`
 * to stdout, socket `close` to child `exit`, and `kill` to `destroy()` + drop every
 * listener (a leaked half-open remote adapter would keep the fd). A socket has no
 * separate stderr channel, so that reader is a no-op.
 */
function socketToChild(socket: DapSocket): DapChild {
  return {
    stdin: { write: (data: string): void => socket.write(data) },
    stdout: {
      on: (_event: "data", listener: (chunk: Buffer | string) => void): void =>
        socket.on("data", listener),
    },
    stderr: { on: (): void => {} },
    on: (event: "exit" | "error", listener: (...a: never[]) => void): void => {
      if (event === "exit") {
        socket.on("close", (hadError: boolean) =>
          (listener as unknown as (code: number | null, signal: string | null) => void)(
            hadError ? 1 : 0,
            null,
          ),
        );
      } else {
        socket.on("error", listener as unknown as (err: Error) => void);
      }
    },
    kill: (): void => {
      try {
        socket.destroy();
      } finally {
        socket.removeAllListeners();
      }
    },
  };
}
