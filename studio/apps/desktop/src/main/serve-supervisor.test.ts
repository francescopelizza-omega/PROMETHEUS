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
  /** the next start() result (so we can simulate a synchronous spawn error). */
  nextStart: { pid?: number; state: string; lastError?: string } = { pid: 4242, state: "running" };

  start(profile: { id: string }): { id: string; state: string; pid?: number; lastError?: string } {
    this.spawned.push(profile.id);
    return { id: profile.id, ...this.nextStart };
  }
  stop(id: string): Promise<{ id: string; state: string }> {
    this.stopped.push(id);
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

/** Build a supervisor wired to a fake core + injected poll/timers/clock. */
function makeSup(poll: (base: string) => Promise<PollResult>, now = () => 1000) {
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
  });
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
