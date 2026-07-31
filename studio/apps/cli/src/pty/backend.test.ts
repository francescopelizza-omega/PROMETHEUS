/**
 * pty/backend.test.ts — node:test for the CLI pty backend resolver (P5).
 *
 * Runs NOW with NO native addon + NO real shell: node-pty is required through an
 * INJECTED fake `requireFn`, and the child_process fallback spawns through an
 * INJECTED fake `spawnFn`. It pins:
 *   - nodePtyAvailable: true with a fake module exposing spawn, false otherwise +
 *     crash-free when require throws,
 *   - resolvePtyBackend: prefers the node-pty adapter when present (real-pty path),
 *     forwards write/resize/onData/onExit/kill to the fake IPty,
 *   - the child_process FALLBACK (forceChildProcess / node-pty absent): write→stdin,
 *     stdout+stderr→onData, exit→onExit (with signal mapping), kill→child.kill,
 *     resize is a best-effort no-op, a spawn `error` degrades to exit 127, and a
 *     write after the child is gone never throws.
 *
 * Run: node --import ../../dev-register.mjs --test src/pty/backend.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PtyBackendDeps,
  type RequireFn,
  type SpawnFn,
  type SpawnedChild,
  nodePtyAvailable,
  resolvePtyBackend,
} from "./backend.js";

/* ── a fake node-pty (IPty) the adapter drives ─────────────────────────────── */

class FakeIPty {
  pid = 4242;
  writes: string[] = [];
  resizes: { c: number; r: number }[] = [];
  killSignals: (string | undefined)[] = [];
  spawnArgs: { shell: string; args: string[]; o: Record<string, unknown> } | null = null;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  write(d: string): void {
    this.writes.push(d);
  }
  resize(c: number, r: number): void {
    this.resizes.push({ c, r });
  }
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb;
  }
  kill(s?: string): void {
    this.killSignals.push(s);
  }
  emitData(d: string): void {
    this.dataCb?.(d);
  }
  emitExit(e: { exitCode: number; signal?: number }): void {
    this.exitCb?.(e);
  }
}

/** A fake require returning a node-pty-like module that hands back the FakeIPty. */
function fakeNodePtyRequire(): { requireFn: RequireFn; last(): FakeIPty | undefined } {
  let last: FakeIPty | undefined;
  const requireFn: RequireFn = (id) => {
    if (id !== "node-pty") throw new Error(`unexpected require(${id})`);
    return {
      spawn(shell: string, args: string[], o: Record<string, unknown>) {
        const p = new FakeIPty();
        p.spawnArgs = { shell, args, o };
        last = p;
        return p;
      },
    };
  };
  return { requireFn, last: () => last };
}

/* ── a fake child_process child the fallback drives ────────────────────────── */

class FakeChild implements SpawnedChild {
  pid = 777;
  stdinWrites: string[] = [];
  killed: (NodeJS.Signals | number | undefined)[] = [];
  stdinClosed = false;
  readonly stdin: { write(d: string): void };
  readonly stdout: { on(e: "data", cb: (c: Buffer | string) => void): void };
  readonly stderr: { on(e: "data", cb: (c: Buffer | string) => void): void };
  private stdoutCb: ((c: Buffer | string) => void) | null = null;
  private stderrCb: ((c: Buffer | string) => void) | null = null;
  private exitCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  private errorCb: ((err: Error) => void) | null = null;

  constructor() {
    this.stdin = {
      write: (d: string) => {
        if (this.stdinClosed) throw new Error("write after end");
        this.stdinWrites.push(d);
      },
    };
    this.stdout = {
      on: (_e, cb) => {
        this.stdoutCb = cb;
      },
    };
    this.stderr = {
      on: (_e, cb) => {
        this.stderrCb = cb;
      },
    };
  }
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit" | "error", cb: (...a: never[]) => void): void {
    if (event === "exit") this.exitCb = cb as (c: number | null, s: NodeJS.Signals | null) => void;
    else this.errorCb = cb as (e: Error) => void;
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal);
    return true;
  }
  emitStdout(c: Buffer | string): void {
    this.stdoutCb?.(c);
  }
  emitStderr(c: Buffer | string): void {
    this.stderrCb?.(c);
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCb?.(code, signal);
  }
  emitError(err: Error): void {
    this.errorCb?.(err);
  }
}

/** A fake spawner that records the spawn call + hands back the FakeChild. */
function fakeSpawner(): { spawnFn: SpawnFn; last(): FakeChild | undefined; calls: number } {
  const state = { last: undefined as FakeChild | undefined, calls: 0 };
  const spawnFn: SpawnFn = (command, args, options) => {
    state.calls += 1;
    const child = new FakeChild();
    // stash the call shape on the child for assertions.
    (child as unknown as { spawnCall: unknown }).spawnCall = { command, args, options };
    state.last = child;
    return child;
  };
  return {
    spawnFn,
    get calls() {
      return state.calls;
    },
    last: () => state.last,
  };
}

/* ── nodePtyAvailable ──────────────────────────────────────────────────────── */

test("nodePtyAvailable is true when the fake require yields a module with spawn", () => {
  const { requireFn } = fakeNodePtyRequire();
  assert.equal(nodePtyAvailable({ requireFn }), true);
});

test("nodePtyAvailable is false when require has no node-pty (crash-free)", () => {
  const requireFn: RequireFn = (id) => {
    throw new Error(`Cannot find module '${id}'`);
  };
  assert.equal(nodePtyAvailable({ requireFn }), false);
});

test("nodePtyAvailable is false when require returns a module WITHOUT spawn", () => {
  const requireFn: RequireFn = () => ({ notSpawn: true });
  assert.equal(nodePtyAvailable({ requireFn }), false);
});

/* ── resolvePtyBackend → node-pty adapter (real-pty path) ──────────────────── */

test("resolvePtyBackend prefers node-pty and forwards spawn opts + I/O round-trip", () => {
  const { requireFn, last } = fakeNodePtyRequire();
  const backend = resolvePtyBackend({ requireFn });
  const proc = backend.spawn({
    shell: "claude",
    args: ["--print"],
    cwd: "/proj",
    env: { TERM: "xterm-color" },
    cols: 100,
    rows: 30,
  });
  const ipty = last()!;
  assert.equal(ipty.spawnArgs?.shell, "claude");
  assert.deepEqual(ipty.spawnArgs?.args, ["--print"]);
  assert.equal(ipty.spawnArgs?.o.cwd, "/proj");
  assert.equal(ipty.spawnArgs?.o.cols, 100);
  assert.equal(ipty.spawnArgs?.o.rows, 30);
  assert.equal(ipty.spawnArgs?.o.name, "xterm-color");
  assert.equal(proc.pid, 4242);

  // write / resize forward to the IPty.
  proc.write("hello\n");
  proc.resize(120, 40);
  assert.deepEqual(ipty.writes, ["hello\n"]);
  assert.deepEqual(ipty.resizes, [{ c: 120, r: 40 }]);

  // onData relays; onExit fires through.
  const out: string[] = [];
  proc.onData((d) => out.push(d));
  ipty.emitData("(claude) ");
  assert.deepEqual(out, ["(claude) "]);

  const exits: { exitCode: number; signal?: number }[] = [];
  proc.onExit((e) => exits.push(e));
  ipty.emitExit({ exitCode: 0 });
  assert.deepEqual(exits, [{ exitCode: 0 }]);

  proc.kill("SIGTERM");
  assert.deepEqual(ipty.killSignals, ["SIGTERM"]);
});

test("resolvePtyBackend defaults cols/rows to 80x24 for node-pty", () => {
  const { requireFn, last } = fakeNodePtyRequire();
  const backend = resolvePtyBackend({ requireFn });
  backend.spawn({ shell: "sh", cwd: "/", env: {} });
  const ipty = last()!;
  assert.equal(ipty.spawnArgs?.o.cols, 80);
  assert.equal(ipty.spawnArgs?.o.rows, 24);
  assert.deepEqual(ipty.spawnArgs?.args, []);
});

/* ── resolvePtyBackend → child_process FALLBACK ────────────────────────────── */

function fallbackDeps(): {
  deps: PtyBackendDeps;
  spawner: ReturnType<typeof fakeSpawner>;
} {
  const spawner = fakeSpawner();
  return { deps: { forceChildProcess: true, spawnFn: spawner.spawnFn }, spawner };
}

test("fallback: forceChildProcess uses spawnFn even when node-pty WOULD resolve", () => {
  const { requireFn } = fakeNodePtyRequire(); // node-pty present...
  const spawner = fakeSpawner();
  const backend = resolvePtyBackend({
    requireFn,
    forceChildProcess: true, // ...but we force the fallback
    spawnFn: spawner.spawnFn,
  });
  backend.spawn({ shell: "claude", args: ["chat"], cwd: "/proj", env: { FOO: "bar" } });
  assert.equal(spawner.calls, 1);
  const child = spawner.last()!;
  const call = (
    child as unknown as {
      spawnCall: { command: string; args: string[]; options: Record<string, unknown> };
    }
  ).spawnCall;
  assert.equal(call.command, "claude");
  assert.deepEqual(call.args, ["chat"]);
  assert.equal(call.options.cwd, "/proj");
  assert.deepEqual(call.options.env, { FOO: "bar" });
  assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
});

test("fallback: falls through to spawnFn when node-pty is ABSENT (no force needed)", () => {
  const requireFn: RequireFn = (id) => {
    throw new Error(`Cannot find module '${id}'`);
  };
  const spawner = fakeSpawner();
  const backend = resolvePtyBackend({ requireFn, spawnFn: spawner.spawnFn });
  backend.spawn({ shell: "sh", cwd: "/", env: {} });
  assert.equal(spawner.calls, 1);
});

test("fallback: write→stdin, stdout+stderr→onData, kill→child.kill, resize is a no-op", () => {
  const { deps, spawner } = fallbackDeps();
  const proc = resolvePtyBackend(deps).spawn({ shell: "sh", cwd: "/", env: {} });
  const child = spawner.last()!;
  assert.equal(proc.pid, 777);

  proc.write("ls\n");
  assert.deepEqual(child.stdinWrites, ["ls\n"]);

  const out: string[] = [];
  proc.onData((d) => out.push(d));
  child.emitStdout(Buffer.from("file-a\n"));
  child.emitStderr("warn: x\n"); // string chunk also relayed
  assert.deepEqual(out, ["file-a\n", "warn: x\n"]);

  // resize must not throw and must not be forwarded (no controlling tty).
  proc.resize(200, 50);

  proc.kill();
  assert.deepEqual(child.killed, ["SIGTERM"]); // default signal
});

test("fallback: child exit forwards exitCode + maps the signal name to a number", () => {
  const { deps, spawner } = fallbackDeps();
  const proc = resolvePtyBackend(deps).spawn({ shell: "sh", cwd: "/", env: {} });
  const child = spawner.last()!;
  const exits: { exitCode: number; signal?: number }[] = [];
  proc.onExit((e) => exits.push(e));
  child.emitExit(0, "SIGINT");
  assert.deepEqual(exits, [{ exitCode: 0, signal: 2 }]); // SIGINT → 2

  // a second exit/error is ignored (fired exactly once).
  child.emitExit(1, null);
  assert.equal(exits.length, 1);
});

test("fallback: a clean exit with no signal yields just an exitCode", () => {
  const { deps, spawner } = fallbackDeps();
  const proc = resolvePtyBackend(deps).spawn({ shell: "sh", cwd: "/", env: {} });
  const child = spawner.last()!;
  const exits: { exitCode: number; signal?: number }[] = [];
  proc.onExit((e) => exits.push(e));
  child.emitExit(3, null);
  assert.deepEqual(exits, [{ exitCode: 3 }]);
  assert.ok(!("signal" in exits[0]!));
});

test("fallback: a spawn ERROR (e.g. ENOENT) degrades to exit 127, never crashes", () => {
  const { deps, spawner } = fallbackDeps();
  const proc = resolvePtyBackend(deps).spawn({ shell: "missing-bin", cwd: "/", env: {} });
  const child = spawner.last()!;
  const exits: { exitCode: number; signal?: number }[] = [];
  proc.onExit((e) => exits.push(e));
  child.emitError(new Error("spawn missing-bin ENOENT"));
  assert.deepEqual(exits, [{ exitCode: 127 }]);
});

test("fallback: write after the child is gone never throws", () => {
  const { deps, spawner } = fallbackDeps();
  const proc = resolvePtyBackend(deps).spawn({ shell: "sh", cwd: "/", env: {} });
  const child = spawner.last()!;
  child.stdinClosed = true; // simulate a closed stdin (child exited)
  assert.doesNotThrow(() => proc.write("late\n"));
});

test("fallback: kill on an already-dead child is swallowed (no throw)", () => {
  const { deps, spawner } = fallbackDeps();
  const proc = resolvePtyBackend(deps).spawn({ shell: "sh", cwd: "/", env: {} });
  const child = spawner.last()!;
  child.kill = () => {
    throw new Error("ESRCH");
  };
  assert.doesNotThrow(() => proc.kill("SIGKILL"));
});
