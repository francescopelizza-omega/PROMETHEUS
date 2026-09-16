/**
 * serve-supervisor.test.ts — node:test for the Model-Hub serve status-machine
 * over the C8 supervisor (file 05 §8).
 *
 * Runs NOW (imports the core ServerSupervisor type + this module, NOT electron).
 * It drives the §8 status-machine with a FAKE core supervisor (so no real child is
 * spawned), an INJECTED `pollModels` (so the /models probe is deterministic +
 * offline), and INJECTED timers + clock (so the poll loop + ready deadline fire on
 * command). It pins the load-bearing C8 contract:
 *
 *   1. start() spawns via the core supervisor + moves the row to `starting`,
 *   2. a /models 200 flips `starting → ready` (the ONLY path to ready — never faked),
 *   3. the runner EXITING before ready ⇒ `error` (the supervisor's exit event),
 *   4. the ready DEADLINE elapsing with no 200 ⇒ `error` (timeout),
 *   5. stop() tears down the poll + moves the row to `stopped` (intentional — no
 *      error), and the core child is stopped.
 *
 * ENV LIMIT pin: the runner binary is absent in the real app, so a real spawn never
 * answers /models — which resolves to `error` here exactly as cases (3)/(4) prove.
 * `ready` is reached ONLY through an injected 200, never faked (C5/C8).
 *
 * Run: node --import ../../../apps/cli/dev-register.mjs --test serve-supervisor.test.ts
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { EvictionEvent } from "@prometheus/engine-bridge";

import {
  type PollResult,
  type ServeRecipe,
  ServeSupervisor,
  toDomainProfile,
} from "./serve-supervisor.js";

/** A fake core ServerSupervisor: records spawns, lets the test emit exit/errored. */
class FakeCoreSupervisor extends EventEmitter {
  spawned: string[] = [];
  stopped: string[] = [];
  /** the `graceMs` each stop() call was made with — asserts kill() actually passes 0
   *  instead of silently falling back to the default 5s grace window. */
  stopGraceMs: (number | undefined)[] = [];
  /** the next start() result (so we can simulate a synchronous spawn error). */
  nextStart: { pid?: number; state: string; lastError?: string } = { pid: 4242, state: "running" };

  start(profile: { id: string }): { id: string; state: string; pid?: number; lastError?: string } {
    this.spawned.push(profile.id);
    return { id: profile.id, ...this.nextStart };
  }
  stop(id: string, graceMs?: number): Promise<{ id: string; state: string }> {
    this.stopped.push(id);
    this.stopGraceMs.push(graceMs);
    return Promise.resolve({ id, state: "stopped" });
  }
  list(): { id: string; state: string }[] {
    return [];
  }
  /** simulate the child exiting (the supervisor emits exit + errored). */
  emitExit(id: string, lastError = "exited"): void {
    this.emit("exit", { id, state: "errored", lastError });
    this.emit("errored", { id, state: "errored", lastError });
  }
}

/** A controllable timer harness: the test fires intervals/timeouts on demand. */
function timerHarness() {
  const intervals: { id: number; fn: () => void }[] = [];
  const timeouts: { id: number; fn: () => void }[] = [];
  let next = 1;
  return {
    setIntervalFn: (fn: () => void): unknown => {
      const id = next++;
      intervals.push({ id, fn });
      return id;
    },
    clearIntervalFn: (h: unknown): void => {
      const i = intervals.findIndex((x) => x.id === h);
      if (i >= 0) intervals.splice(i, 1);
    },
    setTimeoutFn: (fn: () => void): unknown => {
      const id = next++;
      timeouts.push({ id, fn });
      return id;
    },
    clearTimeoutFn: (h: unknown): void => {
      const i = timeouts.findIndex((x) => x.id === h);
      if (i >= 0) timeouts.splice(i, 1);
    },
    /** fire every live interval once (a poll tick). */
    tickIntervals(): void {
      for (const x of [...intervals]) x.fn();
    },
    /** fire every live timeout once (the ready deadline). */
    fireTimeouts(): void {
      for (const x of [...timeouts]) x.fn();
    },
    intervals,
    timeouts,
  };
}

const RECIPE: ServeRecipe = {
  id: "qwen3-8b-q4-k-m-llamacpp",
  modelId: "qwen3-8b",
  quant: "Q4_K_M",
  runner: "llamacpp",
  endpoint: { host: "127.0.0.1", port: 8080, baseUrl: "http://127.0.0.1:8080/v1" },
  apiKey: "local",
  args: { ctxLen: 32768, gpuLayers: 36, servedModelName: "qwen3-8b" },
  argv: ["llama-server", "-m", "/tmp/x.gguf", "-ngl", "36", "-c", "32768"],
  autostart: false,
};

/** Overrides for the ACTIVE EVICTION monitor — see makeSup's `criticalOpts` param. */
interface CriticalOpts {
  /** keep the critical-pressure interval alive in `timers` (default: disposed immediately, so
   *  every test written before this feature existed keeps seeing `timers.intervals.length` as
   *  it always has — only a test specifically exercising eviction opts in). */
  keepCriticalCheck?: boolean;
  ramSampleFn?: () => number;
  recordEvictionFn?: (event: Omit<EvictionEvent, "id" | "at">) => EvictionEvent;
  criticalRamCeilingPct?: number;
}

/** Build a supervisor wired to a fake core + injected poll/timers/clock. */
function makeSup(
  poll: (base: string) => Promise<PollResult>,
  now = () => 1000,
  resourceGuardFn: () => { ok: boolean; reason?: string } = () => ({ ok: true }),
  criticalOpts: CriticalOpts = {},
) {
  const core = new FakeCoreSupervisor();
  const timers = timerHarness();
  const sup = new ServeSupervisor({
    // the fake satisfies the structural surface the supervisor calls (start/stop/
    // list/on/off); a precise cast keeps it type-checked without dragging the real
    // node:child_process supervisor into the test.
    supervisor: core as unknown as ConstructorParameters<typeof ServeSupervisor>[0]["supervisor"],
    pollModels: poll,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    now,
    // A fake, always-clear resource guard by default — the real one reads THIS machine's live
    // RAM, which would make tests flaky on a loaded box. A test exercising the ceiling passes
    // its own via the third parameter.
    resourceGuardFn,
    // Always-clear by default too — same reasoning, for the SEPARATE critical-eviction monitor.
    ramSampleFn: criticalOpts.ramSampleFn ?? (() => 10),
    recordEvictionFn:
      criticalOpts.recordEvictionFn ??
      ((e): EvictionEvent => ({ ...e, id: "test-event", at: "1970-01-01T00:00:00.000Z" })),
    criticalRamCeilingPct: criticalOpts.criticalRamCeilingPct,
  });
  // Every pre-existing test in this file predates the eviction monitor and asserts exact
  // `timers.intervals`/`timers.timeouts` counts for the PER-RECIPE poll/deadline machinery only
  // — disposing this supervisor-wide interval immediately keeps those assertions meaningful.
  if (!criticalOpts.keepCriticalCheck) sup.disposeCriticalCheck();
  return { sup, core, timers };
}

test("toDomainProfile maps the fit-derived argv → command + args (the C8 spawn input)", () => {
  const p = toDomainProfile(RECIPE);
  assert.equal(p.id, RECIPE.id);
  assert.equal(p.command, "llama-server");
  assert.deepEqual(p.args, ["-m", "/tmp/x.gguf", "-ngl", "36", "-c", "32768"]);
  assert.equal(p.healthUrl, "http://127.0.0.1:8080/v1/models");
});

test("start() spawns via the core supervisor and moves the row to starting", async () => {
  // a poll that never answers 200 keeps us in `starting` until told otherwise.
  const { sup, core } = makeSup(async () => ({ ok: false, status: 503 }));
  const row = sup.start(RECIPE);
  assert.equal(core.spawned.length, 1);
  assert.equal(core.spawned[0], RECIPE.id);
  assert.equal(row.status, "starting");
  assert.equal(row.pid, 4242);
  // the immediate poll (503) did NOT promote it.
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "starting");
});

test("a /models 200 flips starting → ready (the ONLY path to ready, never faked)", async () => {
  let answer200 = false;
  const events: string[] = [];
  const { sup, timers } = makeSup(async () => ({ ok: answer200, status: answer200 ? 200 : 503 }));
  sup.on("status", (r) => events.push(r.status));
  sup.start(RECIPE);
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "starting");

  // the endpoint comes up; the next poll tick promotes to ready.
  answer200 = true;
  timers.tickIntervals();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "ready");
  assert.ok(events.includes("ready"));
  // the poll loop was torn down once ready (no live intervals remain).
  assert.equal(timers.intervals.length, 0);
});

test("a runner dying AFTER becoming ready ⇒ error (post-ready liveness, listener kept)", async () => {
  let answer200 = false;
  const { sup, core, timers } = makeSup(async () => ({
    ok: answer200,
    status: answer200 ? 200 : 503,
  }));
  sup.start(RECIPE);
  await Promise.resolve();
  answer200 = true;
  timers.tickIntervals();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "ready");

  // the ready runner crashes later — the kept exit listener must flip ready → error,
  // not leave a permanently stale "ready" row pointing at a dead process.
  core.emitExit(RECIPE.id, "runner crashed post-ready");
  assert.equal(sup.status(RECIPE.id)?.status, "error");
  assert.match(sup.status(RECIPE.id)?.lastError ?? "", /crashed|exited before/);
});

test("the runner EXITING before ready ⇒ error (the supervisor's exit event)", async () => {
  const { sup, core } = makeSup(async () => ({ ok: false, status: 503 }));
  sup.start(RECIPE);
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "starting");

  // the child dies before /models ever answered → error.
  core.emitExit(RECIPE.id, "runner crashed");
  assert.equal(sup.status(RECIPE.id)?.status, "error");
  assert.match(sup.status(RECIPE.id)?.lastError ?? "", /runner crashed|exited before/);
});

test("the ready DEADLINE elapsing with no 200 ⇒ error (timeout) — the env-limit case", async () => {
  // the runner binary is absent → /models never answers → the deadline fails it.
  const { sup, timers } = makeSup(async () => ({ ok: false, error: "ECONNREFUSED" }));
  sup.start(RECIPE);
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "starting");

  // a few poll ticks: still no 200, still starting.
  timers.tickIntervals();
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "starting");

  // the ready deadline fires → error (timeout).
  timers.fireTimeouts();
  assert.equal(sup.status(RECIPE.id)?.status, "error");
  assert.match(sup.status(RECIPE.id)?.lastError ?? "", /did not answer|within/);
  assert.equal(timers.intervals.length, 0, "poll loop torn down on timeout");
});

test("a synchronous spawn error fails closed to error (no poll loop started)", async () => {
  const { sup, core } = makeSup(async () => ({ ok: true, status: 200 }));
  core.nextStart = { state: "errored", lastError: "ENOENT: llama-server not found" };
  const row = sup.start(RECIPE);
  assert.equal(row.status, "error");
  assert.match(row.lastError ?? "", /ENOENT|not found/);
  // even though the poll WOULD answer 200, no poll loop was started → still error.
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "error");
});

test("start() refuses on a saturated machine — no spawn, no poll loop, error names the reason", async () => {
  const { sup, core } = makeSup(
    async () => ({ ok: true, status: 200 }),
    undefined,
    () => ({ ok: false, reason: "RAM at 94% ≥ 90% ceiling" }),
  );
  const row = sup.start(RECIPE);
  assert.equal(row.status, "error");
  assert.match(row.lastError ?? "", /RAM at 94%/);
  assert.deepEqual(core.spawned, [], "the core supervisor must never see this recipe");
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "error");
});

test("start() proceeds normally when resources are clear", () => {
  const { sup, core } = makeSup(
    async () => ({ ok: true, status: 200 }),
    undefined,
    () => ({ ok: true }),
  );
  const row = sup.start(RECIPE);
  assert.equal(row.status, "starting");
  assert.deepEqual(core.spawned, [RECIPE.id]);
});

test("checkCriticalPressure: SUSTAINED critical RAM force-kills a ready recipe and records/emits one eviction", async () => {
  // [readying tick: harmless] [1st critical reading: not enough alone] [2nd: sustained → evict]
  const ramReadings = [50, 96, 97];
  let ramIdx = 0;
  const recorded: Omit<EvictionEvent, "id" | "at">[] = [];
  const events: EvictionEvent[] = [];
  const { sup, core, timers } = makeSup(
    async () => ({ ok: true, status: 200 }),
    undefined,
    () => ({ ok: true }),
    {
      keepCriticalCheck: true,
      ramSampleFn: () => ramReadings[Math.min(ramIdx++, ramReadings.length - 1)] as number,
      recordEvictionFn: (e): EvictionEvent => {
        recorded.push(e);
        return { ...e, id: `evt-${recorded.length}`, at: "2026-01-01T00:00:00.000Z" };
      },
      criticalRamCeilingPct: 95,
    },
  );
  sup.on("evicted", (e) => events.push(e));

  sup.start(RECIPE);
  await Promise.resolve();
  timers.tickIntervals(); // resolves the /models poll → ready (consumes ramReadings[0], harmless)
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "ready");
  assert.deepEqual(core.stopped, [], "not evicted yet — no critical reading has happened");

  timers.tickIntervals(); // 1st critical reading (96) — one alone must never evict
  assert.equal(sup.status(RECIPE.id)?.status, "ready");
  assert.deepEqual(core.stopped, []);

  timers.tickIntervals(); // 2nd consecutive critical reading (97) — SUSTAINED → evict
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(core.stopped, [RECIPE.id]);
  assert.equal(core.stopGraceMs.at(-1), 0, "eviction force-kills, same as the manual kill() control");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.runnerId, RECIPE.id);
  assert.equal(recorded[0]?.ramPct, 97);
  assert.equal(recorded[0]?.ceiling, 95);
  assert.match(recorded[0]?.reason ?? "", /RAM at 97%/);
  assert.equal(events.length, 1, "the 'evicted' event fired exactly once");
  assert.equal(events[0]?.id, "evt-1");
  assert.equal(sup.status(RECIPE.id)?.status, "stopped");
});

test("the eviction poll is not armed at all while nothing is live — no vm_stat fork per 2s tick", () => {
  const { timers } = makeSup(
    async () => ({ ok: false, status: 503 }),
    undefined,
    () => ({ ok: true }),
    { keepCriticalCheck: true, ramSampleFn: () => 99, criticalRamCeilingPct: 95 },
  );
  // Nothing registered or started, so there is nothing an eviction could free. On darwin each
  // tick is a BLOCKING `vm_stat` fork on the Electron main thread, so an idle supervisor must
  // hold no timer whatsoever — not merely decline to evict.
  assert.equal(timers.intervals.length, 0, "no critical-check interval while nothing is live");
  assert.doesNotThrow(() => {
    timers.tickIntervals();
    timers.tickIntervals();
  });
});

test("the eviction poll arms on the first live recipe and disarms when the last one stops", async () => {
  let answers200 = false; // stay "starting" until the test says otherwise
  const { sup, timers } = makeSup(
    async () => (answers200 ? { ok: true, status: 200 } : { ok: false, status: 503 }),
    undefined,
    () => ({ ok: true }),
    { keepCriticalCheck: true, ramSampleFn: () => 10, criticalRamCeilingPct: 95 },
  );
  assert.equal(timers.intervals.length, 0, "idle: nothing armed");

  sup.start(RECIPE); // → starting: weights are paging in, which is when pressure climbs fastest
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "starting");
  assert.equal(timers.intervals.length, 2, "the per-recipe poll AND the critical check are live");

  answers200 = true;
  timers.tickIntervals(); // the /models poll answers 200 → ready (its own poll loop tears down)
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "ready");
  assert.equal(timers.intervals.length, 1, "poll gone, critical check stays while ready");

  await sup.stop(RECIPE.id);
  assert.equal(timers.intervals.length, 0, "last live recipe gone → the critical check disarms");

  answers200 = false; // keep the next serve in "starting" so both timers are observable
  sup.start(RECIPE); // and it re-arms for the next serve
  await Promise.resolve();
  assert.equal(timers.intervals.length, 2, "re-armed on the next start");
});

test("checkCriticalPressure: a non-ready recipe (still starting) is left alone even under sustained critical pressure", async () => {
  const { sup, core, timers } = makeSup(
    async () => ({ ok: false, status: 503 }), // never answers — stays "starting"
    undefined,
    () => ({ ok: true }),
    { keepCriticalCheck: true, ramSampleFn: () => 99, criticalRamCeilingPct: 95 },
  );
  sup.start(RECIPE);
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "starting");

  timers.tickIntervals();
  timers.tickIntervals();
  await Promise.resolve();

  assert.deepEqual(core.stopped, [], "a starting (not yet ready) recipe is never an eviction target");
  assert.equal(sup.status(RECIPE.id)?.status, "starting");
});

test("disposeCriticalCheck stops the monitor — no further eviction, even under sustained critical pressure", async () => {
  const { sup, core, timers } = makeSup(
    async () => ({ ok: true, status: 200 }),
    undefined,
    () => ({ ok: true }),
    { keepCriticalCheck: true, ramSampleFn: () => 99, criticalRamCeilingPct: 95 },
  );
  sup.start(RECIPE);
  await Promise.resolve();
  timers.tickIntervals();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "ready");

  sup.disposeCriticalCheck();
  assert.equal(timers.intervals.length, 0, "the critical-check interval itself is torn down");
  timers.tickIntervals(); // no-op now — nothing left to tick
  await Promise.resolve();
  assert.deepEqual(core.stopped, []);
  assert.equal(sup.status(RECIPE.id)?.status, "ready");
});

test("stop() tears down the poll, stops the core child, and moves to stopped (intentional)", async () => {
  let answer200 = true;
  const { sup, core, timers } = makeSup(async () => ({ ok: answer200, status: 200 }));
  // start NOT-yet-ready so we exercise stop() from `starting`.
  answer200 = false;
  sup.start(RECIPE);
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "starting");

  const stopped = await sup.stop(RECIPE.id);
  assert.equal(stopped.status, "stopped");
  assert.ok(core.stopped.includes(RECIPE.id));
  assert.equal(timers.intervals.length, 0, "poll loop torn down on stop");
  // a later (stale) exit from the child does NOT flip a stopped row back to error.
  core.emitExit(RECIPE.id, "late exit");
  assert.equal(sup.status(RECIPE.id)?.status, "stopped");
});

test("kill() tears down the poll, force-stops the core child with graceMs:0, and moves to stopped", async () => {
  let answer200 = true;
  const { sup, core, timers } = makeSup(async () => ({ ok: answer200, status: 200 }));
  // start NOT-yet-ready — "not responding properly" is exactly what kill() is for.
  answer200 = false;
  sup.start(RECIPE);
  await Promise.resolve();
  assert.equal(sup.status(RECIPE.id)?.status, "starting");

  const killed = await sup.kill(RECIPE.id);
  assert.equal(killed.status, "stopped");
  assert.ok(core.stopped.includes(RECIPE.id));
  assert.equal(
    core.stopGraceMs.at(-1),
    0,
    "kill() must skip the grace window, not just call the regular stop()",
  );
  assert.equal(timers.intervals.length, 0, "poll loop torn down on kill");
  // a later (stale) exit from the child does NOT flip a stopped row back to error.
  core.emitExit(RECIPE.id, "late exit");
  assert.equal(sup.status(RECIPE.id)?.status, "stopped");
});

test("kill() on an unknown id resolves to a synthetic stopped row", async () => {
  const { sup } = makeSup(async () => ({ ok: true, status: 200 }));
  const row = await sup.kill("ghost");
  assert.equal(row.status, "stopped");
  assert.equal(row.id, "ghost");
});

test("start() is idempotent for an already-starting id (one spawn)", async () => {
  const { sup, core } = makeSup(async () => ({ ok: false, status: 503 }));
  sup.start(RECIPE);
  sup.start(RECIPE);
  await Promise.resolve();
  assert.equal(core.spawned.length, 1);
});

test("register() shows a stopped row without spawning", () => {
  const { sup, core } = makeSup(async () => ({ ok: true, status: 200 }));
  const row = sup.register(RECIPE);
  assert.equal(row.status, "stopped");
  assert.equal(core.spawned.length, 0);
  assert.equal(sup.list().length, 1);
});

test("stop() on an unknown id resolves to a synthetic stopped row", async () => {
  const { sup } = makeSup(async () => ({ ok: true, status: 200 }));
  const row = await sup.stop("ghost");
  assert.equal(row.status, "stopped");
  assert.equal(row.id, "ghost");
});
