// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
import {
  CRITICAL_POLLS_REQUIRED,
  CRITICAL_RAM_CEILING_PCT,
  type EvictionEvent,
  nextCriticalStreak,
  ramCeilingVerdict,
  ramPctNow,
  recordEvictionEvent,
} from "@prometheus/engine-bridge";

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
  /** a served (`ready`) recipe was force-killed under SUSTAINED critical RAM pressure — a
   *  distinct signal from a normal status change so the shell can raise a system notification
   *  ("Prometheus stopped X to prevent a machine freeze") rather than a routine status update. */
  evicted: [EvictionEvent];
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
  /**
   * The shared 90% RAM launch ceiling (engine-bridge's launch-guard.ts — the same one
   * `ensureOllamaRunning` and the CLI's autostart already refuse a cold Ollama start on).
   * `start()` is synchronous, so this stays synchronous too (RAM% alone, not the CPU-delta
   * sample that needs a real sleep) — checked ONCE per actual spawn, never per poll tick.
   * Injectable for tests; defaults to the real, live machine reading.
   */
  resourceGuardFn?: () => { ok: boolean; reason?: string };
  /**
   * ACTIVE EVICTION: how often, while ≥1 recipe is `starting` or `ready`, to check for SUSTAINED
   * critical RAM pressure and force-kill every currently-served recipe if found — the same
   * mechanism (and the same shared eviction-log) as ollama-watchdog-entry.ts's idle-shutdown
   * watchdog, for the heavier launch path (real model weights, not just the lightweight
   * `ollama serve` daemon).
   * Default 2s, matching POLL_MS in ollama-watchdog-entry.ts — a 30s poll with
   * CRITICAL_POLLS_REQUIRED=2 cannot react for 60-90s to a collapse measured at two seconds.
   * The timer is armed ONLY while something is live (see syncCriticalCheck): each tick is a
   * `vm_stat` fork+exec on darwin, so an always-on 2s poll would block the Electron main thread
   * ~43,200 times a day in a session that never serves a model. Injectable for tests.
   */
  criticalCheckIntervalMs?: number;
  /** the RAM% ceiling that triggers eviction (default engine-bridge's CRITICAL_RAM_CEILING_PCT,
   *  deliberately stricter than `resourceGuardFn`'s launch ceiling — eviction of an ACTIVE,
   *  in-use server is a last resort, never the same bar as merely refusing a new one). */
  criticalRamCeilingPct?: number;
  /** raw RAM% reader for the critical-pressure streak — injectable for tests (never the real
   *  live machine reading in a unit test). Defaults to the real `ramPctNow`. */
  ramSampleFn?: () => number;
  /** records one eviction notice to the shared cross-surface log. Injectable for tests so they
   *  never touch a real path on disk; defaults to the real `recordEvictionEvent`. */
  recordEvictionFn?: (event: Omit<EvictionEvent, "id" | "at">) => EvictionEvent;
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
  private readonly resourceGuardFn: () => { ok: boolean; reason?: string };
  private readonly criticalCheckIntervalMs: number;
  private readonly criticalRamCeilingPct: number;
  private readonly ramSampleFn: () => number;
  private readonly recordEvictionFn: (event: Omit<EvictionEvent, "id" | "at">) => EvictionEvent;
  private criticalStreak = 0;
  private criticalCheckHandle: unknown = null;
  /** once `disposeCriticalCheck()` has run (app shutdown), no status change may re-arm the poll. */
  private criticalCheckDisposed = false;
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
    this.resourceGuardFn = opts.resourceGuardFn ?? (() => ramCeilingVerdict(ramPctNow()));
    // 2 s, not 30 s — see POLL_MS in engine-bridge/ollama-watchdog-entry.ts. A 30 s poll
    // with CRITICAL_POLLS_REQUIRED=2 cannot react for 60-90 s to a collapse measured at
    // two seconds, which made this guard decorative on the machine it was written for.
    this.criticalCheckIntervalMs = opts.criticalCheckIntervalMs ?? 2_000;
    this.criticalRamCeilingPct = opts.criticalRamCeilingPct ?? CRITICAL_RAM_CEILING_PCT;
    this.ramSampleFn = opts.ramSampleFn ?? ramPctNow;
    this.recordEvictionFn = opts.recordEvictionFn ?? recordEvictionEvent;
    // NOT armed here. `ramSampleFn` defaults to engine-bridge's `ramPctNow`, whose 250ms
    // available-bytes cache is always cold at a 2s cadence, so on darwin — the platform this
    // repo targets — every tick reaches `execFileSync("/usr/bin/vm_stat")`: a BLOCKING fork+exec
    // on the Electron main thread, which stalls every ipcMain handler, paint and streaming-token
    // relay for its duration. This supervisor is constructed at module scope in main/index.ts,
    // so arming in the constructor cost a session that never serves a model ~43,200 forks/day.
    // `syncCriticalCheck()` arms it on the first `starting`/`ready` entry and disarms it when the
    // last one goes away, so the poll exists exactly while there is something to evict.
  }

  /**
   * ACTIVE EVICTION tick: sample RAM, and once SUSTAINED critical pressure is confirmed (never a
   * single spike — see nextCriticalStreak), force-kill every currently `ready` recipe and record
   * one eviction notice per kill. Multiple simultaneously-served recipes are ALL evicted together
   * — this supervisor has no reliable per-process RAM attribution to single out "the" offender,
   * and letting even one of several heavy servers keep running would not resolve the pressure
   * that triggered this in the first place.
   */
  private checkCriticalPressure(): void {
    // This runs from a timer in the Electron MAIN process. Anything that escapes here is an
    // uncaught exception on the main thread, which takes the whole app down — and the failure
    // would be invisible, because the only thing that fires this tick is memory pressure the
    // user is already suffering. `recordEvictionFn` writes to disk and can throw (EACCES, ENOSPC,
    // a lock timeout); a guard that crashes the app it is guarding is worse than no guard.
    try {
      this.checkCriticalPressureInner();
    } catch {
      /* swallow: the next tick re-samples. Never let a timer callback kill the main process. */
    }
  }

  private checkCriticalPressureInner(): void {
    const ramPct = this.ramSampleFn();
    this.criticalStreak = nextCriticalStreak(
      this.criticalStreak,
      ramPct,
      this.criticalRamCeilingPct,
    );
    if (this.criticalStreak < CRITICAL_POLLS_REQUIRED) return;
    this.criticalStreak = 0; // reset regardless of outcome — never re-fire every tick in a row
    const ready = [...this.entries.values()].filter((e) => e.row.status === "ready");
    for (const entry of ready) {
      const reason = `RAM at ${ramPct}% ≥ ${this.criticalRamCeilingPct}% for ${CRITICAL_POLLS_REQUIRED} consecutive checks — stopped to prevent a machine-wide freeze`;
      const event = this.recordEvictionFn({
        runnerId: entry.row.id,
        name: `${entry.row.modelId} (${entry.row.quant})`,
        pid: entry.row.pid,
        ramPct,
        ceiling: this.criticalRamCeilingPct,
        reason,
      });
      // `.catch` is not optional: a rejecting kill() here is an unhandled rejection every
      // eviction, in the main process, under memory pressure. The eviction is still recorded —
      // `recordEvictionFn` already ran — so a failed kill stays visible in the log.
      void this.kill(entry.row.id).then(
        () => {
          this.emit("evicted", event);
        },
        () => {
          /* kill failed; the entry stays and the next critical streak retries it */
        },
      );
    }
  }

  /**
   * Arm or disarm the critical-pressure poll to match reality: it runs exactly while at least one
   * entry is `starting` or `ready`, i.e. while there is something an eviction could actually free.
   * `starting` counts — a model's weights are being paged in during `starting`, which is when
   * pressure climbs fastest and when the guard is most needed.
   *
   * Idempotent, and called after every status transition and removal.
   */
  private syncCriticalCheck(): void {
    // `disposeCriticalCheck()` is a one-way latch: without this, a status transition after
    // shutdown (a queued kill resolving, say) would silently re-arm the poll we just tore down.
    if (this.criticalCheckDisposed) return;
    const live = [...this.entries.values()].some(
      (e) => e.row.status === "starting" || e.row.status === "ready",
    );
    if (live && this.criticalCheckHandle === null) {
      // Reset the streak on arm as well as disarm: a streak of 1 left over from a previous serve
      // session would otherwise survive the idle gap and let the FIRST critical tick after
      // re-arming evict on a single sample, breaking nextCriticalStreak's "never a lone spike".
      this.criticalStreak = 0;
      this.criticalCheckHandle = this.setIntervalFn(() => {
        this.checkCriticalPressure();
      }, this.criticalCheckIntervalMs);
      return;
    }
    if (!live && this.criticalCheckHandle !== null) {
      this.clearIntervalFn(this.criticalCheckHandle);
      this.criticalCheckHandle = null;
      this.criticalStreak = 0;
    }
  }

  /** Stop the critical-pressure monitor — call on app shutdown alongside `stopAll()`. */
  disposeCriticalCheck(): void {
    // Null-safe: index.ts calls this on every quit path, including sessions that never served
    // anything and so never armed the timer.
    this.criticalCheckDisposed = true;
    if (this.criticalCheckHandle === null) return;
    this.clearIntervalFn(this.criticalCheckHandle);
    this.criticalCheckHandle = null;
    this.criticalStreak = 0;
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

    // The shared 90% RAM launch ceiling — a served recipe loads real model weights into memory,
    // the single most direct way a "start one more thing" decision turns into the exact
    // black-screen-freeze failure mode this exists to prevent. Refused BEFORE the core spawns
    // anything: no child, no poll loop, no listeners registered.
    const resourceVerdict = this.resourceGuardFn();
    if (!resourceVerdict.ok) {
      this.transition(recipe.id, "error", {
        lastError: `refused — ${resourceVerdict.reason}. Free resources and retry.`,
      });
      return { ...this.entries.get(recipe.id)!.row };
    }

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

  /**
   * Force-kill a profile: same teardown as `stop()`, but with `graceMs:0` so
   * `core.stop()`'s SIGTERM→SIGKILL escalation fires SIGKILL on the next tick
   * instead of waiting out the usual 5s grace window — "if something is not
   * responding properly" (the user's own words for this control) means it has
   * already ignored SIGTERM once; waiting another 5s to confirm that again
   * before escalating is the whole problem being reported, not a safety net.
   */
  async kill(id: string): Promise<ServeRow> {
    const entry = this.entries.get(id);
    if (!entry) {
      return { ...syntheticStopped(id) };
    }
    this.teardownPoll(id);
    this.transition(id, "stopped", { lastError: undefined });
    try {
      await this.core.stop(id, 0);
    } catch {
      /* a missing/already-dead child is fine — the row is already stopped. */
    }
    return { ...(this.entries.get(id)?.row ?? syntheticStopped(id)) };
  }

  /** Remove a (stopped) profile entirely from the registry. */
  remove(id: string): void {
    this.teardownPoll(id);
    this.entries.delete(id);
    // dropping the last live entry must disarm the eviction poll — `transition` never runs here.
    this.syncCriticalCheck();
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
    // Every status change is a candidate arm/disarm point for the eviction poll.
    this.syncCriticalCheck();
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
