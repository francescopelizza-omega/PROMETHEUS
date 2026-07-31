/**
 * worker-host.test.ts — node:test coverage for the decoupled WorkerHost.
 *
 * Runs NOW (no electron). It drives the host with a FAKE worker handle (an
 * EventEmitter-backed stand-in for utilityProcess / child_process.fork) so the
 * request/response correlation, timeout (fail-closed), and crash→reject behaviour
 * are exercised deterministically. A SEPARATE integration test forks the REAL
 * worker entry; this one isolates the host state machine.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { TaskRequest, TaskResponse } from "../worker/tasks.js";
import { type WorkerHandle, WorkerHost } from "./worker-host.js";

/**
 * A controllable fake worker. `mode` decides how it reacts to a posted task:
 *  - "echo": immediately reply with a canned ok response,
 *  - "silent": never reply (to exercise the timeout),
 *  - "crash": emit exit on the next tick (to exercise crash handling).
 */
class FakeWorker extends EventEmitter implements WorkerHandle {
  posted: TaskRequest[] = [];
  killed = false;
  private readonly mode: "echo" | "silent" | "crash";
  constructor(mode: "echo" | "silent" | "crash") {
    super();
    this.mode = mode;
  }
  postMessage(message: unknown): void {
    const req = message as TaskRequest;
    this.posted.push(req);
    if (this.mode === "echo") {
      const res: TaskResponse = {
        id: req.id,
        kind: "log.aggregate",
        ok: true,
        result: { events: [], counts: {}, total: 0, errors: 0, warnings: 0 },
      };
      queueMicrotask(() => this.emit("message", res));
    } else if (this.mode === "crash") {
      queueMicrotask(() => this.emit("exit", 1));
    }
    // "silent": deliberately nothing.
  }
  kill(): void {
    this.killed = true;
    this.emit("exit", null);
  }
}

test("WorkerHost lazily spawns the worker on first run and correlates the reply", async () => {
  let spawns = 0;
  const fake = new FakeWorker("echo");
  const host = new WorkerHost({
    spawn: () => {
      spawns += 1;
      return fake;
    },
  });

  assert.equal(host.isRunning, false);
  const res = await host.run({ kind: "log.aggregate", payload: { lines: [] } });
  assert.equal(spawns, 1);
  assert.equal(host.isRunning, true);
  assert.equal(res.ok, true);
  // the request was assigned an id and forwarded.
  assert.equal(fake.posted.length, 1);
  assert.equal(typeof fake.posted[0]?.id, "string");
  host.dispose();
});

test("WorkerHost reuses one worker across multiple requests", async () => {
  let spawns = 0;
  const host = new WorkerHost({
    spawn: () => {
      spawns += 1;
      return new FakeWorker("echo");
    },
  });
  await host.run({ kind: "log.aggregate", payload: { lines: [] } });
  await host.run({ kind: "log.aggregate", payload: { lines: [] } });
  assert.equal(spawns, 1); // single long-lived worker
  host.dispose();
});

test("WorkerHost fails closed on a per-request timeout", async () => {
  const host = new WorkerHost({
    spawn: () => new FakeWorker("silent"),
    requestTimeoutMs: 30,
  });
  await assert.rejects(
    () => host.run({ kind: "log.aggregate", payload: { lines: [] } }),
    /timed out/,
  );
  host.dispose();
});

test("WorkerHost rejects in-flight requests when the worker crashes", async () => {
  const fake = new FakeWorker("crash");
  let crashedInFlight = -1;
  const host = new WorkerHost({ spawn: () => fake, requestTimeoutMs: 1000 });
  host.on("crashed", ({ inFlight }) => {
    crashedInFlight = inFlight;
  });

  await assert.rejects(
    () => host.run({ kind: "log.aggregate", payload: { lines: [] } }),
    /worker exited/,
  );
  assert.equal(crashedInFlight, 1);
  // after a crash the host drops the handle and will respawn on the next run.
  assert.equal(host.isRunning, false);
  host.dispose();
});

test("WorkerHost respawns after a crash on the next request", async () => {
  let spawns = 0;
  const host = new WorkerHost({
    spawn: () => {
      spawns += 1;
      // first worker crashes, second echoes.
      return new FakeWorker(spawns === 1 ? "crash" : "echo");
    },
    requestTimeoutMs: 1000,
  });

  await assert.rejects(() => host.run({ kind: "log.aggregate", payload: { lines: [] } }));
  const res = await host.run({ kind: "log.aggregate", payload: { lines: [] } });
  assert.equal(res.ok, true);
  assert.equal(spawns, 2);
  host.dispose();
});

test("WorkerHost throttles a crash-LOOP (2nd rapid crash backs off; clears after the window)", async () => {
  let spawns = 0;
  let nowMs = 1_000;
  const host = new WorkerHost({
    // every spawn crashes until the backoff window elapses, then it echoes.
    spawn: () => {
      spawns += 1;
      return new FakeWorker(nowMs < 5_000 ? "crash" : "echo");
    },
    requestTimeoutMs: 1000,
    now: () => nowMs,
  });

  // 1st crash → immediate respawn allowed (normal recovery, no backoff).
  await assert.rejects(() => host.run({ kind: "log.aggregate", payload: { lines: [] } }));
  // 2nd rapid crash → consecutiveCrashes climbs to 2.
  await assert.rejects(() => host.run({ kind: "log.aggregate", payload: { lines: [] } }));
  assert.equal(spawns, 2);

  // 3rd request within the window is REFUSED by backoff — no new spawn (no fork-bomb).
  await assert.rejects(
    () => host.run({ kind: "log.aggregate", payload: { lines: [] } }),
    /crash-loop backoff/,
  );
  assert.equal(spawns, 2, "backoff prevented a 3rd immediate spawn");

  // advancing past the window (and the worker now healthy) lets it respawn + succeed,
  // which clears the crash counter.
  nowMs = 6_000;
  const res = await host.run({ kind: "log.aggregate", payload: { lines: [] } });
  assert.equal(res.ok, true);
  assert.equal(spawns, 3);
  host.dispose();
});

test("WorkerHost.run rejects after dispose", async () => {
  const host = new WorkerHost({ spawn: () => new FakeWorker("echo") });
  host.dispose();
  await assert.rejects(
    () => host.run({ kind: "log.aggregate", payload: { lines: [] } }),
    /disposed/,
  );
});

/* ── APP-066: progress routing + idle-timeout reset + cooperative cancel ───── */

/** A fake that streams N progress ticks (each ~intervalMs apart) then a final reply. */
class ProgressFake extends EventEmitter implements WorkerHandle {
  private readonly ticks: number;
  private readonly intervalMs: number;
  constructor(ticks: number, intervalMs: number) {
    super();
    this.ticks = ticks;
    this.intervalMs = intervalMs;
  }
  postMessage(message: unknown): void {
    const req = message as TaskRequest;
    let sent = 0;
    const tick = (): void => {
      if (sent < this.ticks) {
        this.emit("message", {
          id: req.id,
          kind: req.kind,
          progress: { scanned: (sent + 1) * 100 },
        });
        sent += 1;
        setTimeout(tick, this.intervalMs).unref?.();
      } else {
        this.emit("message", {
          id: req.id,
          kind: "file.search",
          ok: true,
          result: { root: "/r", matches: [], scanned: this.ticks * 100, truncated: false },
        } satisfies TaskResponse);
      }
    };
    setTimeout(tick, this.intervalMs).unref?.();
  }
  kill(): void {
    this.emit("exit", null);
  }
}

test("WorkerHost routes progress ticks AND resets the idle timeout each tick (APP-066)", async () => {
  // 6 progress ticks 30ms apart (final ~210ms) with a 50ms base timeout: without the
  // per-tick reset the request would time out at 50ms; the resets keep it alive to the end.
  const host = new WorkerHost({ spawn: () => new ProgressFake(6, 30), requestTimeoutMs: 50 });
  const seen: number[] = [];
  const res = await host.run(
    { kind: "file.search", payload: { root: "/r" } },
    { onProgress: (p) => seen.push(p.scanned) },
  );
  assert.equal(res.ok, true);
  assert.ok(seen.length >= 3, `progress delivered (${seen.length} ticks)`);
  assert.deepEqual(seen.slice(0, 3), [100, 200, 300]);
  host.dispose();
});

/** A fake that only replies once it receives a `{cancel:id}` message (cooperative stop). */
class CancelFake extends EventEmitter implements WorkerHandle {
  gotCancel: string | null = null;
  postMessage(message: unknown): void {
    const m = message as { cancel?: string; id?: string; kind?: string };
    if (typeof m.cancel === "string") {
      this.gotCancel = m.cancel;
      this.emit("message", {
        id: m.cancel,
        kind: "file.search",
        ok: true,
        result: { root: "/r", matches: [], scanned: 3, truncated: false, cancelled: true },
      } satisfies TaskResponse);
    }
    // a task message: deliberately never auto-replies (waits for cancel).
  }
  kill(): void {
    this.emit("exit", null);
  }
}

test("WorkerHost.cancel posts a cancel message; the worker resolves with a cancelled result", async () => {
  const fake = new CancelFake();
  const host = new WorkerHost({ spawn: () => fake, requestTimeoutMs: 1000 });
  const p = host.run({ kind: "file.search", payload: { root: "/r" } }, { id: "req-1" });
  // nothing has resolved yet — cancel the specific in-flight task.
  host.cancel("req-1");
  const res = await p;
  assert.equal(fake.gotCancel, "req-1");
  assert.equal(res.ok, true);
  assert.equal(res.kind, "file.search");
  assert.equal(res.ok && res.kind === "file.search" ? res.result.cancelled : false, true);
  host.dispose();
});

test("WorkerHost runs concurrent tasks without head-of-line blocking (out-of-order replies)", async () => {
  // a fake that replies to task B before task A (proves the correlation table, not a queue).
  class ReorderFake extends EventEmitter implements WorkerHandle {
    private pending: TaskRequest[] = [];
    postMessage(message: unknown): void {
      const req = message as TaskRequest;
      this.pending.push(req);
      if (this.pending.length === 2) {
        for (const r of [...this.pending].reverse()) {
          this.emit("message", {
            id: r.id,
            kind: "log.aggregate",
            ok: true,
            result: { events: [], counts: {}, total: 0, errors: 0, warnings: 0 },
          } satisfies TaskResponse);
        }
      }
    }
    kill(): void {
      this.emit("exit", null);
    }
  }
  const host = new WorkerHost({ spawn: () => new ReorderFake(), requestTimeoutMs: 1000 });
  const [a, b] = await Promise.all([
    host.run({ kind: "log.aggregate", payload: { lines: ["a"] } }, { id: "A" }),
    host.run({ kind: "log.aggregate", payload: { lines: ["b"] } }, { id: "B" }),
  ]);
  assert.equal(a.id, "A");
  assert.equal(b.id, "B");
  host.dispose();
});
