/**
 * run-step.test.ts — the runner behind "update everything", with spawn, kill and the reaper faked.
 *
 * Nothing here spawns a process, registers a pid with the process-wide reaper, or reaches a real
 * `process.kill`: a fake pid handed to either is exactly the shape of the defect that once
 * SIGKILLed this machine's whole session (CLAUDE.md §2, Hazard A).
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { test } from "node:test";

import { type ChildLike, type SpawnFn, cleanLine, killGroup, makeStepRunner } from "./run-step.js";

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid?: number;
  constructor(pid?: number) {
    super();
    if (pid !== undefined) this.pid = pid;
  }
  out(s: string): void {
    this.stdout.emit("data", Buffer.from(s, "utf8"));
  }
  err(s: string): void {
    this.stderr.emit("data", Buffer.from(s, "utf8"));
  }
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
}

interface Harness {
  child: FakeChild;
  spawned: { cmd: string; args: readonly string[]; opts: Record<string, unknown> }[];
  kills: [number, NodeJS.Signals][];
  tracked: { pid: number | undefined; group?: boolean; label?: string; command?: string }[];
  untracked: number;
  run: ReturnType<typeof makeStepRunner>;
}

function harness(pid: number | null = 4242, graceMs = 5, drainMs = 10): Harness {
  const h: Harness = {
    child: new FakeChild(pid ?? undefined),
    spawned: [],
    kills: [],
    tracked: [],
    untracked: 0,
    run: undefined as never,
  };
  const spawnImpl: SpawnFn = (cmd, args, opts) => {
    h.spawned.push({ cmd, args, opts });
    return h.child;
  };
  h.run = makeStepRunner({
    spawnImpl,
    killImpl: (pgid, signal) => {
      h.kills.push([pgid, signal]);
    },
    trackImpl: (c) => {
      h.tracked.push(c);
      return () => {
        h.untracked += 1;
      };
    },
    graceMs,
    drainMs,
  });
  return h;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("spawns shell-free, detached, with stdin closed, from the home directory, tracked", async () => {
  const h = harness();
  const env = { PATH: "/usr/bin", HOMEBREW_NO_SUDO: "1" };
  const p = h.run(["brew", "upgrade", "--formula", "--yes", "ripgrep"], { env });
  await tick();
  h.child.close(0);
  const res = await p;
  assert.equal(res.code, 0);
  const s = h.spawned[0];
  assert.equal(s?.cmd, "brew");
  assert.deepEqual(s?.args, ["upgrade", "--formula", "--yes", "ripgrep"]);
  assert.equal(s?.opts.shell, false);
  assert.equal(s?.opts.detached, true);
  assert.deepEqual(s?.opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(s?.opts.cwd, homedir());
  assert.equal(s?.opts.env, env);
  assert.deepEqual(h.tracked[0], {
    pid: 4242,
    group: true,
    label: "updates:brew",
    command: "brew upgrade --formula --yes ripgrep",
  });
  assert.equal(h.untracked, 1, "untracked the moment it exited, so a recycled pid is never hit");
});

test("streams whole, cleaned lines from both streams; keeps the raw tail for parsing", async () => {
  const h = harness();
  const lines: string[] = [];
  const p = h.run(["npm", "install", "-g", "x@1.0.0"], { env: {}, onLine: (l) => lines.push(l) });
  await tick();
  h.child.out("added 1 pack");
  h.child.out("age in 2s\n\n\u001b[32mok\u001b[0m\n");
  h.child.err("progress 10%\rprogress 100%\n");
  h.child.out("no newline at the end");
  h.child.close(0);
  const res = await p;
  assert.deepEqual(lines, [
    "added 1 package in 2s",
    "ok",
    "progress 100%",
    "no newline at the end",
  ]);
  assert.match(res.stdout, /\u001b\[32mok/, "the captured stdout is raw — callers parse it");
});

test("cleanLine: escape sequences, carriage-return frames, control bytes and length", () => {
  assert.equal(cleanLine("\u001b[1;31mred\u001b[0m"), "red");
  assert.equal(
    cleanLine("\u001b]11;rgb:00/00/00\u0007after"),
    "after",
    "an OSC would recolour the TUI",
  );
  assert.equal(cleanLine("10%\r50%\r100%"), "100%");
  assert.equal(cleanLine("done\r   \r"), "done", "a trailing blank frame does not erase the line");
  assert.equal(cleanLine("a\u0000b\u0007c\u009bd\tTab"), "abcd\tTab");
  assert.equal(cleanLine("x".repeat(3000)).length, 2001);
});

test("Ctrl-C: SIGTERM to the GROUP, then SIGKILL after the grace period, status 130", async () => {
  const h = harness(4242, 5);
  const ac = new AbortController();
  const p = h.run(["brew", "upgrade", "--cask", "--yes", "codex"], { env: {}, signal: ac.signal });
  await tick();
  ac.abort();
  assert.deepEqual(h.kills, [[4242, "SIGTERM"]]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.kills, [
    [4242, "SIGTERM"],
    [4242, "SIGKILL"],
  ]);
  h.child.close(null, "SIGKILL");
  const res = await p;
  assert.equal(res.code, 130);
  assert.equal(res.aborted, true);
});

test("a child that exits on SIGTERM is never SIGKILLed", async () => {
  const h = harness(4242, 20);
  const ac = new AbortController();
  const p = h.run(["pipx", "upgrade", "black"], { env: {}, signal: ac.signal });
  await tick();
  ac.abort();
  h.child.close(null, "SIGTERM");
  const res = await p;
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(h.kills, [[4242, "SIGTERM"]]);
  assert.equal(res.code, 130);
});

test("already cancelled: nothing is spawned", async () => {
  const h = harness();
  const ac = new AbortController();
  ac.abort();
  const res = await h.run(["brew", "upgrade", "x"], { env: {}, signal: ac.signal });
  assert.equal(res.code, 130);
  assert.equal(h.spawned.length, 0);
  assert.equal(h.tracked.length, 0);
});

test("the wall clock stops a step like an abort, with status 124", async () => {
  const h = harness(4242, 5);
  const p = h.run(["brew", "upgrade", "x"], { env: {}, timeoutMs: 5 });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(h.kills[0]?.[1], "SIGTERM");
  h.child.close(null, "SIGTERM");
  const res = await p;
  assert.equal(res.code, 124);
  assert.equal(res.timedOut, true);
});

test("a program that is not there is a 127 with its message, never a throw", async () => {
  const h = harness();
  const p = h.run(["nosuchtool", "upgrade"], { env: {} });
  await tick();
  h.child.emit("error", new Error("spawn nosuchtool ENOENT"));
  h.child.close(-2);
  const res = await p;
  assert.equal(res.code, 127);
  assert.match(res.stderr, /ENOENT/);

  const throwing = makeStepRunner({
    spawnImpl: () => {
      throw new Error("EAGAIN");
    },
    killImpl: () => {},
    trackImpl: () => () => {},
  });
  const res2 = await throwing(["brew"], { env: {} });
  assert.equal(res2.code, 127);
});

test("no pid, no signal: an unspawned child is never killed", async () => {
  const h = harness(null, 5);
  const ac = new AbortController();
  const p = h.run(["brew", "upgrade", "x"], { env: {}, signal: ac.signal });
  await tick();
  ac.abort();
  h.child.close(null, null);
  await p;
  assert.deepEqual(h.kills, []);
});

test("a leader that exits while a grandchild holds the pipes: untracked at once, settled after the drain", async () => {
  const h = harness(4242, 5, 10);
  const p = h.run(["brew", "upgrade", "x"], { env: {} });
  await tick();
  h.child.emit("exit", 0, null); // the leader is reaped; 'close' never comes
  assert.equal(h.untracked, 1, "the pid is the OS's now — out of the reaper the moment it exits");
  const res = await p;
  assert.equal(res.code, 0, "the step succeeded, it did not time out");
  assert.deepEqual(h.kills, []);
});

test("after 'exit', a stop never signals the (possibly recycled) group", async () => {
  const h = harness(4242, 5, 10_000);
  const ac = new AbortController();
  const p = h.run(["brew", "upgrade", "x"], { env: {}, signal: ac.signal });
  await tick();
  h.child.emit("exit", 0, null);
  ac.abort();
  const res = await p;
  assert.deepEqual(h.kills, [], "no SIGTERM/SIGKILL to a reaped leader's group");
  assert.equal(res.aborted, true);

  // and a SIGTERM already sent is not followed by a SIGKILL once the leader has exited
  const h2 = harness(4243, 5, 10_000);
  const ac2 = new AbortController();
  const p2 = h2.run(["brew", "upgrade", "y"], { env: {}, signal: ac2.signal });
  await tick();
  ac2.abort();
  h2.child.emit("exit", null, "SIGTERM");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h2.kills, [[4243, "SIGTERM"]]);
  h2.child.close(null, "SIGTERM");
  await p2;
});

test("once a step has settled, a lingering grandchild's output is dropped, not shown under the next step", async () => {
  const h = harness(4242, 5, 5);
  const lines: string[] = [];
  const p = h.run(["brew", "upgrade", "x"], { env: {}, onLine: (l) => lines.push(l) });
  await tick();
  h.child.out("before\n");
  h.child.emit("exit", 0, null);
  await p; // settled by the drain timer: the pipes never closed
  h.child.out("after the step ended\n");
  assert.deepEqual(lines, ["before"]);
});

test("killGroup REFUSES every pid kill(2) reads as a broadcast, and signals the GROUP of a real one", () => {
  // A recording killFn — never the real process.kill (Hazard A): it must never see these at all.
  const calls: [number, string][] = [];
  const record = (pid: number, sig: NodeJS.Signals): void => {
    calls.push([pid, sig]);
  };
  for (const pgid of [-1, 0, 1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    killGroup(pgid, "SIGKILL", record);
  }
  assert.deepEqual(calls, [], "0 is our own group, -1 every process this user owns");
  killGroup(4242, "SIGTERM", record);
  assert.deepEqual(calls, [[-4242, "SIGTERM"]], "the negated pid: brew's curl goes with brew");
  // a group that is already gone is not an error
  killGroup(4242, "SIGTERM", () => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  });
});
