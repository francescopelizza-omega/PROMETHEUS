/**
 * sidecar-supervisor.test.ts — node:test coverage for the dual-mode supervisor.
 *
 * Runs NOW (imports @prometheus/engine-bridge, NOT electron). It drives the
 * LONG-LIVED restart state machine with a FAKE child + injectable clock so the
 * policy (max retries, backoff, healthy-reset, graceful stop) is deterministic,
 * and verifies the PER-COMMAND (one-shot) path fails closed when the engine is
 * missing (PROMETHEUS_PY pointed at a non-existent file).
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { type ChildLike, type LongLivedSpec, SidecarSupervisor } from "./sidecar-supervisor.js";

/** A controllable fake child: emit exit/error on demand to drive the policy. */
class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  killed: NodeJS.Signals[] = [];
  stdout = { on: () => {} };
  stderr = { on: () => {} };
  private exited = false;
  /**
   * A well-behaved process: a SIGTERM/SIGKILL records the signal AND honours it
   * by exiting cleanly on the next tick (so the supervisor's graceful stop()
   * resolves). Guarded so a double signal / a manual finish() can't double-exit.
   */
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
    if (!this.exited) {
      this.exited = true;
      queueMicrotask(() => this.emit("exit", 0, signal ?? "SIGTERM"));
    }
    return true;
  }
  // crash with a code (unexpected exit).
  crash(code = 1): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, null);
  }
  // clean exit (code 0).
  finish(): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", 0, null);
  }
}

const SPEC: LongLivedSpec = {
  id: "watcher",
  command: "/bin/true",
  args: ["--watch"],
  policy: { maxRetries: 2, baseBackoffMs: 1, maxBackoffMs: 2, healthyAfterMs: 10_000 },
};

test("startLongLived spawns a running child and reports healthy", () => {
  const child = new FakeChild();
  const sup = new SidecarSupervisor({ spawner: () => child, now: () => 1000 });
  const status = sup.startLongLived(SPEC);
  assert.equal(status.state, "running");
  assert.equal(status.pid, 4242);
  assert.equal(sup.health("watcher").healthy, true);
});

test("startLongLived is idempotent for an already-running id", () => {
  let spawns = 0;
  const sup = new SidecarSupervisor({
    spawner: () => {
      spawns += 1;
      return new FakeChild();
    },
    now: () => 1000,
  });
  sup.startLongLived(SPEC);
  sup.startLongLived(SPEC);
  assert.equal(spawns, 1);
});

test("a crash within healthyAfterMs restarts up to maxRetries then fails", async () => {
  const children: FakeChild[] = [];
  let clock = 0;
  const sup = new SidecarSupervisor({
    spawner: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    // clock barely advances → every run is "unhealthy" (crash loop), so retries accumulate.
    now: () => {
      clock += 1;
      return clock;
    },
  });

  const events: string[] = [];
  sup.on("crashed", () => events.push("crashed"));
  sup.on("restarting", () => events.push("restarting"));
  sup.on("failed", () => events.push("failed"));

  sup.startLongLived(SPEC); // spawn #1

  // crash #1 → restart scheduled (restarts=1)
  children[0]?.crash(1);
  await waitFor(() => children.length === 2, 500);
  // crash #2 → restart scheduled (restarts=2)
  children[1]?.crash(1);
  await waitFor(() => children.length === 3, 500);
  // crash #3 → restarts(2) >= maxRetries(2) → failed, no spawn #4
  children[2]?.crash(1);
  await waitFor(() => sup.status("watcher")?.state === "failed", 500);

  assert.equal(children.length, 3, "exactly maxRetries restarts occurred");
  assert.equal(sup.status("watcher")?.state, "failed");
  assert.ok(events.includes("failed"));
  assert.ok(events.filter((e) => e === "crashed").length >= 3);

  await sup.dispose();
});

test("a run healthy past healthyAfterMs resets the retry counter", async () => {
  const children: FakeChild[] = [];
  // clock jumps far enough that the supervisor treats each run as healthy.
  let clock = 0;
  const sup = new SidecarSupervisor({
    spawner: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    now: () => {
      clock += 1_000_000; // always far beyond healthyAfterMs since lastSpawnAt
      return clock;
    },
  });

  sup.startLongLived(SPEC);
  // Each crash looks like a fresh fault (healthy run) → restarts reset to 0 each
  // time → it never reaches "failed", keeps restarting.
  children[0]?.crash(1);
  await waitFor(() => children.length === 2, 500);
  children[1]?.crash(1);
  await waitFor(() => children.length === 3, 500);

  assert.notEqual(sup.status("watcher")?.state, "failed");
  assert.equal(sup.status("watcher")?.restarts, 1, "counter reset each healthy run");
  await sup.dispose();
});

test("stop() sends SIGTERM, marks intentional, and does NOT restart", async () => {
  const child = new FakeChild();
  const sup = new SidecarSupervisor({ spawner: () => child, now: () => 1000 });
  sup.startLongLived(SPEC);

  const stopP = sup.stop("watcher");
  // the supervisor asked for a graceful SIGTERM; the (well-behaved) fake child
  // honours it by exiting cleanly, so the stop promise resolves to "stopped".
  assert.ok(child.killed.includes("SIGTERM"));
  const status = await stopP;
  assert.equal(status.state, "stopped");

  // a stopped sidecar does not auto-restart on its (already-handled) exit.
  assert.equal(sup.status("watcher")?.state, "stopped");
});

test("stop() on an unknown id resolves to a stopped status", async () => {
  const sup = new SidecarSupervisor({ spawner: () => new FakeChild() });
  const status = await sup.stop("ghost");
  assert.equal(status.state, "stopped");
  assert.equal(status.healthy, false);
});

test("runOnce fails closed when the engine script is missing (C5)", async () => {
  const sup = new SidecarSupervisor({
    engineConfig: { prometheusPy: "/no/such/prometheus.py" },
    spawner: () => new FakeChild(),
  });
  await assert.rejects(() => sup.runOnce(["scan"]), /prometheus\.py not found/);
});

test("engineVersion parses a plain-text version token from the probe", async () => {
  // fake child that emits "prometheus.py 9.9.9" on stdout then exits 0.
  const sup = new SidecarSupervisor({
    spawner: (cmd, args) => {
      const c = new FakeChild();
      // assert the probe used --version
      assert.ok(args.includes("--version"));
      queueMicrotask(() => {
        c.emit("__stdout", Buffer.from("prometheus.py 9.9.9\n"));
        c.finish();
      });
      // wire stdout.on to forward our synthetic data
      c.stdout = {
        on: (_e: string, cb: (b: Buffer) => void) => c.on("__stdout", cb),
      } as unknown as ChildLike["stdout"];
      return c;
    },
  });
  const r = await sup.engineVersion(5000);
  assert.equal(r.ok, true);
  assert.equal(r.version, "9.9.9");
});

/** Poll a predicate until true or timeout (test helper for async restarts). */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}
