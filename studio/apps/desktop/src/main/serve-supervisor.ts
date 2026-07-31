/**
 * main/serve-supervisor.ts — the Model-Hub serve status-machine over the C8
 * ServerSupervisor (file 05 §8).
 *
 * The core `ServerSupervisor` (packages/core) owns the long-lived child-process
 * registry — it spawns the runner (llama.cpp / vLLM / ollama) and reports process
 * LIVENESS (starting → running → stopped/errored). But §8 demands an HTTP-HEALTH
 * machine on top: a served profile is only `ready` once `GET {base_url}/models`
 * answers 200; it is `error` if the child exits OR the poll never succeeds within
 * a timeout. THIS module is that machine.
 *
 * For each served engine-bridge ServeProfile it:
 *   1. maps the fit-derived `argv` → a core domain ServeProfile (command + args),
 *   2. calls `supervisor.start(profile)` to actually spawn the child (C8 — the
 *      MAIN process owns the runner, NOT the sidecar, NOT the engine),
 *   3. polls `{base_url}/models` on an interval: a 200 ⇒ `ready`; the child
 *      exiting ⇒ `error`; the deadline elapsing with no 200 ⇒ `error` (timeout),
 *   4. emits the §2.4 status (stopped → starting → ready | error) the Serving
 *      panel renders, and tears the poll down on stop/unserve.
 *
 * MAIN-PROCESS ONLY — it composes the core supervisor (which spawns real children)
 * and so is never imported into the sandboxed renderer (C5). It NEVER fakes a
 * profile as `ready`: `ready` is reached ONLY through a real 200 from the poll fn.
 *
 * ENV LIMIT (honest): the runner binaries are NOT installed in this sandbox, so a
 * real spawn fails to ever answer /models — that resolves to `error` (timeout/
 * exit), which is EXPECTED. The status-machine, poll loop, and supervisor wiring
 * are what is correct + deterministically tested (injected spawn + poll fn).
 *
 * Node built-ins only (composed into the core supervisor). The HTTP poll uses an
 * injectable `pollModels` (defaults to global `fetch`) so the loop is testable
 * without a network — exactly the injected-spawn discipline sidecar-supervisor.ts
 * already uses.
 */

import { EventEmitter } from "node:events";

import type { ServeProfile as DomainServeProfile, ServerSupervisor } from "@prometheus/core";

/** The §2.4 serve status the Serving panel renders. */
export type ServeStatus = "stopped" | "starting" | "ready" | "error";

/**
 * The engine-bridge serve profile the sidecar built (the fit-derived recipe). We
 * accept the FIELDS we need structurally so this module doesn't depend on the
 * engine-bridge runtime — model-ipc.ts passes the real client `ServeProfile`.
 */
export interface ServeRecipe {
  id: string;
  modelId: string;
  quant: string;
  runner: "llamacpp" | "vllm" | "ollama";
  endpoint: { host: string; port: number; baseUrl: string };
  apiKey: string;
  args: {
    ctxLen: number;
    gpuLayers?: number;
    tensorParallel?: number;
    kvCacheDtype?: "auto" | "fp8";
    maxModelLen?: number;
    servedModelName: string;
  };
  /** the fit-derived runner command line the MAIN-process supervisor spawns (C8). */
  argv: string[];
  autostart: boolean;
}

/** A live serve-profile row the §7 Serving panel renders (recipe + live status). */
export interface ServeRow extends ServeRecipe {
  status: ServeStatus;
  pid?: number;
  lastError?: string;
}

/** The result of one `/models` poll attempt (injectable so it tests offline). */
export interface PollResult {
  /** true ONLY when the endpoint answered 200 (the only path to `ready`). */
  ok: boolean;
  status?: number;
  error?: string;
}

/** A poll fn the supervisor calls each interval (defaults to `fetch {base}/models`). */
export type PollModelsFn = (baseUrl: string) => Promise<PollResult>;

/** Typed events the serve supervisor emits (mirrors the core supervisor surface). */
export interface ServeSupervisorEvents {
  /** a profile's §2.4 status changed (the Serving panel re-renders from this). */
  status: [ServeRow];
}

export interface ServeSupervisorOptions {
  /** the core C8 supervisor that actually spawns the child (MAIN process owns it). */
  supervisor: ServerSupervisor;
  /** the `/models` poll fn — defaults to a `fetch`-based probe. Injectable for tests. */
  pollModels?: PollModelsFn;
  /** poll interval (ms). Default 1000. */
  pollIntervalMs?: number;
  /** ready deadline (ms): no 200 by then ⇒ `error` (timeout). Default 60_000. */
  readyTimeoutMs?: number;
  /** an injectable timer set/clear (so the machine is deterministic in tests). */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (h: unknown) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: unknown) => void;
  /** the wall clock (ms) — injectable so the deadline check is deterministic. */
  now?: () => number;
}

interface Entry {
  row: ServeRow;
  pollHandle?: unknown;
  deadlineHandle?: unknown;
  /** the supervisor child-exit listener so we can detach it on stop. */
  onExit?: (status: { id: string; state: string; lastError?: string }) => void;
  startedAt: number;
}

/** The default `fetch`-based /models probe (best-effort; any failure ⇒ not ok). */
async function defaultPollModels(baseUrl: string): Promise<PollResult> {
  try {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) return { ok: false, error: "fetch unavailable" };
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    const res = await f(url, { method: "GET" });
    return { ok: res.status === 200, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Map an engine-bridge ServeRecipe → the core domain ServeProfile the supervisor spawns. */
export function toDomainProfile(recipe: ServeRecipe): DomainServeProfile {
  const [command, ...args] = recipe.argv.length > 0 ? recipe.argv : [recipe.runner];
  return {
    id: recipe.id,
    label: `${recipe.modelId} (${recipe.quant}) · ${recipe.runner}`,
    command: command ?? recipe.runner,
    args,
    autostart: recipe.autostart,
    // an HTTP health url the GUI/supervisor may poll (we poll it ourselves below).
    healthUrl: `${recipe.endpoint.baseUrl.replace(/\/$/, "")}/models`,
  };
}

/**
 * The Model-Hub serve supervisor: drives the C8 ServerSupervisor + the §8 HTTP
 * health status-machine. Construct ONE per MAIN process (alongside the core
 * supervisor it composes).
 */
export class ServeSupervisor extends EventEmitter {
  private readonly core: ServerSupervisor;
  private readonly pollModels: PollModelsFn;
  private readonly pollIntervalMs: number;
  private readonly readyTimeoutMs: number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (h: unknown) => void;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (h: unknown) => void;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: ServeSupervisorOptions) {
    super();
    this.core = opts.supervisor;
    // Each started profile keeps an `exit`/`errored` listener on the core for its
    // whole life (post-ready liveness — see teardownPoll keepExit). With >5 live
    // profiles that exceeds EventEmitter's default 10-listener cap and prints a
    // spurious MaxListenersExceededWarning; lift the cap (0 = unlimited).
    if (
      typeof (this.core as { setMaxListeners?: (n: number) => void }).setMaxListeners === "function"
    ) {
      (this.core as { setMaxListeners: (n: number) => void }).setMaxListeners(0);
    }
    this.pollModels = opts.pollModels ?? defaultPollModels;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
    // default interval/timeout use node timers with unref so they never hold the
    // process open; the injected versions in tests are deterministic.
    this.setIntervalFn =
      opts.setIntervalFn ??
      ((fn, ms) => {
        const h = setInterval(fn, ms);
        if (typeof h.unref === "function") h.unref();
        return h;
      });
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
    this.setTimeoutFn =
      opts.setTimeoutFn ??
      ((fn, ms) => {
        const h = setTimeout(fn, ms);
        if (typeof h.unref === "function") h.unref();
        return h;
      });
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.now = opts.now ?? Date.now;
  }

  // --- typed EventEmitter overrides ------------------------------------- //
  override on<K extends keyof ServeSupervisorEvents>(
    event: K,
    listener: (...args: ServeSupervisorEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof ServeSupervisorEvents>(
    event: K,
    ...args: ServeSupervisorEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  /** A serialisable snapshot of one serve row (or undefined if unknown). */
  status(id: string): ServeRow | undefined {
    const e = this.entries.get(id);
    return e ? { ...e.row } : undefined;
  }

  /** A serialisable snapshot of every serve row the supervisor knows about. */
  list(): ServeRow[] {
    return [...this.entries.values()].map((e) => ({ ...e.row }));
  }

  /**
   * Register a recipe WITHOUT starting it (a `stopped` row the Serving panel
   * shows). Re-registering an id keeps the existing row's live status.
   */
  register(recipe: ServeRecipe): ServeRow {
    const existing = this.entries.get(recipe.id);
    if (existing) {
      existing.row = { ...existing.row, ...recipe, status: existing.row.status };
      return { ...existing.row };
    }
    const row: ServeRow = { ...recipe, status: "stopped" };
    this.entries.set(recipe.id, { row, startedAt: 0 });
    return { ...row };
  }

  /**
   * Start (spawn + poll) a profile. Drives the core supervisor to spawn the child
   * (C8), moves the row to `starting`, and begins the §8 `/models` poll loop. A
   * 200 ⇒ `ready`; the child exiting ⇒ `error`; the deadline ⇒ `error` (timeout).
   * Idempotent for an already-starting/ready id (returns the current row).
   */
  start(recipe: ServeRecipe): ServeRow {
    this.register(recipe);
    const entry = this.entries.get(recipe.id);
    if (!entry) throw new Error(`serve register failed: ${recipe.id}`);
    if (entry.row.status === "starting" || entry.row.status === "ready") {
      return { ...entry.row };
    }
    entry.row = { ...entry.row, ...recipe };
    entry.startedAt = this.now();

    // 1) spawn the child via the core C8 supervisor.
    const profile = toDomainProfile(recipe);
    let spawnedPid: number | undefined;
    let spawnError: string | undefined;
    try {
      const st = this.core.start(profile);
      spawnedPid = st.pid;
      if (st.state === "errored") spawnError = st.lastError ?? "spawn failed";
    } catch (e) {
      spawnError = e instanceof Error ? e.message : String(e);
    }

    // a spawn that errored synchronously fails closed to `error` (no poll).
    if (spawnError) {
      this.transition(recipe.id, "error", { lastError: spawnError });
      return { ...this.entries.get(recipe.id)!.row };
    }

    this.transition(recipe.id, "starting", { pid: spawnedPid });

    // 2) listen for the child exiting → `error` (the runner died before /models).
    const onExit = (status: { id: string; state: string; lastError?: string }): void => {
      if (status.id !== recipe.id) return;
      const cur = this.entries.get(recipe.id);
      if (!cur) return;
      // a clean stop() already moved us to `stopped`; only an unexpected exit errs.
      if (cur.row.status === "starting" || cur.row.status === "ready") {
        this.transition(recipe.id, "error", {
          lastError: status.lastError ?? "runner exited before becoming ready",
        });
        this.teardownPoll(recipe.id);
      }
    };
    entry.onExit = onExit;
    this.core.on("exit", onExit);
    this.core.on("errored", onExit);

    // 3) start the /models poll loop + the ready deadline.
    entry.pollHandle = this.setIntervalFn(() => {
      void this.pollOnce(recipe.id);
    }, this.pollIntervalMs);
    entry.deadlineHandle = this.setTimeoutFn(() => {
      const cur = this.entries.get(recipe.id);
      if (cur && cur.row.status === "starting") {
        this.transition(recipe.id, "error", {
          lastError: `runner did not answer ${recipe.endpoint.baseUrl}/models within ${this.readyTimeoutMs}ms`,
        });
        this.teardownPoll(recipe.id);
      }
    }, this.readyTimeoutMs);

    // fire one immediate poll so a fast runner flips to ready without waiting an
    // interval (matters in tests + for an already-warm endpoint).
    void this.pollOnce(recipe.id);

    return { ...entry.row };
  }

  /** One `/models` poll attempt: a 200 flips `starting → ready` (the ONLY path). */
  async pollOnce(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.row.status !== "starting") return;
    const res = await this.pollModels(entry.row.endpoint.baseUrl);
    // re-read: status may have changed while the poll was in flight.
    const cur = this.entries.get(id);
    if (!cur || cur.row.status !== "starting") return;
    if (res.ok) {
      this.transition(id, "ready", {});
      // keepExit: stop the poll loop + deadline but KEEP the exit listener so a
      // runner that dies AFTER becoming ready still flips ready → error (otherwise
      // the row would report a permanently stale "ready" for a dead process).
      this.teardownPoll(id, { keepExit: true });
    }
    // a non-200 is NOT an error on its own — the runner may still be warming up;
    // the deadline (readyTimeoutMs) is the only thing that fails a slow start.
  }

  /**
   * Stop a profile: tears down the poll, stops the core child (SIGTERM→SIGKILL),
   * and moves the row to `stopped`. Resolves once the child has exited. A no-op
   * for an unknown id (returns a synthetic stopped row).
   */
  async stop(id: string): Promise<ServeRow> {
    const entry = this.entries.get(id);
    if (!entry) {
      return { ...syntheticStopped(id) };
    }
    this.teardownPoll(id);
    // mark stopped BEFORE the core stop so the exit listener treats it as intentional.
    this.transition(id, "stopped", { lastError: undefined });
    try {
      await this.core.stop(id);
    } catch {
      /* a missing/already-dead child is fine — the row is already stopped. */
    }
    return { ...(this.entries.get(id)?.row ?? syntheticStopped(id)) };
  }

  /** Stop every profile (used on app shutdown). */
  async stopAll(): Promise<ServeRow[]> {
    return Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  /** Remove a (stopped) profile entirely from the registry. */
  remove(id: string): void {
    this.teardownPoll(id);
    this.entries.delete(id);
  }

  /**
   * Tear down the poll loop + deadline for a profile, and (unless `keepExit`) the
   * exit listeners too. `keepExit` is used on the `ready` transition so a runner
   * that dies later is still detected; stop()/remove()/error paths drop everything.
   */
  private teardownPoll(id: string, opts: { keepExit?: boolean } = {}): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.pollHandle !== undefined) {
      this.clearIntervalFn(entry.pollHandle);
      entry.pollHandle = undefined;
    }
    if (entry.deadlineHandle !== undefined) {
      this.clearTimeoutFn(entry.deadlineHandle);
      entry.deadlineHandle = undefined;
    }
    if (!opts.keepExit && entry.onExit) {
      this.core.off("exit", entry.onExit as (...a: unknown[]) => void);
      this.core.off("errored", entry.onExit as (...a: unknown[]) => void);
      entry.onExit = undefined;
    }
  }

  /** Apply a status transition + patch, then emit the new row. */
  private transition(id: string, status: ServeStatus, patch: Partial<ServeRow>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.row = { ...entry.row, ...patch, status };
    // leaving error clears the stale message unless the patch set one.
    if (status !== "error" && patch.lastError === undefined) entry.row.lastError = undefined;
    this.emit("status", { ...entry.row });
  }
}

/** A synthetic stopped row for an unknown id (so callers always get a row). */
function syntheticStopped(id: string): ServeRow {
  return {
    id,
    modelId: id,
    quant: "",
    runner: "llamacpp",
    endpoint: { host: "127.0.0.1", port: 0, baseUrl: "" },
    apiKey: "local",
    args: { ctxLen: 0, servedModelName: id },
    argv: [],
    autostart: false,
    status: "stopped",
  };
}
