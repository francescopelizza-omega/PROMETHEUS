/**
 * child-reaper.test.ts — the CLI's shutdown contract.
 *
 * Two of these tests spawn REAL processes and assert they are actually dead afterwards,
 * because the bug being fixed is exactly the kind that unit tests with fake signals miss:
 * every seam looked correct in isolation, and children still outlived the CLI.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import {
  OWNER_PID_ENV,
  __resetForTests,
  installChildReaper,
  reapNow,
  trackChild,
  trackChildProcess,
  trackedChildren,
  trackedCount,
} from "./child-reaper.js";

/** Is `pid` still alive? signal 0 probes without delivering anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait until `fn()` is true, or throw after `ms`. */
async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}

test("a REAL detached child is dead after reapNow (the actual orphan bug)", async () => {
  __resetForTests();
  // `sleep 300` in its own process group — the shape the swarm spawner uses, and the shape
  // that survived the CLI before the reaper existed.
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  await until(() => typeof child.pid === "number");
  const pid = child.pid as number;
  assert.ok(alive(pid), "fixture must actually be running");

  trackChild({ pid, group: true, label: "test" });
  assert.equal(trackedCount(), 1);

  const killed = reapNow("SIGKILL");
  assert.equal(killed, 1);
  await until(() => !alive(pid));
  assert.equal(trackedCount(), 0, "reaped children are forgotten");
});

test("reaping a GROUP also kills grandchildren (never orphans the tree)", async () => {
  __resetForTests();
  // a shell that spawns its own child, then waits — killing only the shell would leave the
  // grandchild behind, which is why the spawner detaches into a process group at all.
  const child = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout?.on("data", (d: Buffer) => {
    out += d.toString();
  });
  await until(() => out.trim().length > 0);
  const grandchild = Number.parseInt(out.trim(), 10);
  assert.ok(alive(grandchild), "grandchild fixture must be running");

  trackChild({ pid: child.pid as number, group: true });
  reapNow("SIGKILL");
  await until(() => !alive(grandchild));
});

test("trackChildProcess untracks on the child's own exit (no recycled-pid signal)", async () => {
  __resetForTests();
  const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
  trackChildProcess(child, { label: "quick" });
  await until(() => trackedCount() === 0);
  // nothing left to signal — the danger being avoided is killing whatever inherits the pid
  assert.equal(reapNow("SIGKILL"), 0);
});

test("pid 0, -0, 1 and non-integers are REFUSED (a stale pid must not kill our own group)", () => {
  __resetForTests();
  // process.kill(-0) and (0) both target the CALLER's process group: signalling one would
  // take down the CLI and the shell that launched it. This guard is why that cannot happen.
  for (const bad of [0, -0, 1, -5, Number.NaN, 1.5, undefined]) {
    trackChild({ pid: bad as number | undefined, group: true });
  }
  assert.equal(trackedCount(), 0, "no invalid pid is ever tracked");
  assert.equal(reapNow(), 0);
});

test("untrack from trackChild removes exactly that child", () => {
  __resetForTests();
  const un = trackChild({ pid: 424242, label: "a" });
  trackChild({ pid: 424243, label: "b" });
  assert.equal(trackedCount(), 2);
  un();
  assert.deepEqual(
    trackedChildren().map((c) => c.label),
    ["b"],
  );
});

test("installChildReaper: exit reaps; a lone signal handler exits 128+signo", () => {
  __resetForTests();
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  installChildReaper({
    on: (event, listener) => handlers.set(event, listener as () => void),
    // 1 = only ours ⇒ nothing else will stop the process, so we must
    listenerCount: () => 1,
    exit: (code) => {
      exits.push(code);
    },
  });
  assert.ok(handlers.has("exit") && handlers.has("SIGINT"), "exit + signals are hooked");

  trackChild({ pid: 424242 });
  handlers.get("exit")?.();
  assert.equal(trackedCount(), 0, "exit reaps synchronously");

  handlers.get("SIGINT")?.();
  assert.deepEqual(exits, [130], "SIGINT ⇒ 128+2");
  handlers.get("SIGHUP")?.();
  assert.deepEqual(exits, [130, 129], "SIGHUP ⇒ 128+1");
});

test("installChildReaper does NOT pre-empt another signal handler (the TUI restores the tty)", () => {
  __resetForTests();
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  installChildReaper({
    on: (event, listener) => handlers.set(event, listener as () => void),
    // 2 = the TUI also listens; it owns shutdown so the terminal is restored before exit
    listenerCount: () => 2,
    exit: (code) => {
      exits.push(code);
    },
  });
  handlers.get("SIGINT")?.();
  assert.deepEqual(exits, [], "we reap, then step aside");
});

test("the owner-pid env var is exported for post-mortem orphan identification", () => {
  // A SIGKILL of the CLI runs no handler at all; the stamp is what makes the survivors
  // identifiable afterwards rather than anonymous `node` processes.
  assert.equal(OWNER_PID_ENV, "PROMETHEUS_OWNER_PID");
});
