/**
 * run-host.test.ts — named run sessions + the gated-start spine (APP-032).
 *
 * node-pty is absent in this env: everything drives the FAKE PtyBackend exactly
 * as pty-host.test.ts does. Pins: argv-array spawn (no shell), venv-inherited env
 * with the loader-hijack denylist enforced AGAIN in main, live output relay,
 * kill → SIGTERM→SIGKILL escalation + `killed` exit, and the NON-NEGOTIABLE
 * gate → guard → spawn order (a refusal at either stage spawns NOTHING; an
 * unreadable telemetry blocks fail-closed).
 *
 * Run: node --import ../../../../../apps/cli/dev-register.mjs --test run-host.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PtyBackend, PtyProcess, PtySpawnOptions } from "./pty-host.js";
import { RunHost, sanitizeRunEnvKeys, startGatedRun } from "./run-host.js";

class FakeProc implements PtyProcess {
  pid = 4242;
  killSignals: (string | undefined)[] = [];
  readonly opts: PtySpawnOptions;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  constructor(opts: PtySpawnOptions) {
    this.opts = opts;
  }
  write(): void {}
  resize(): void {}
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb;
  }
  kill(signal?: string): void {
    this.killSignals.push(signal);
  }
  emitData(d: string): void {
    this.dataCb?.(d);
  }
  emitExit(e: { exitCode: number; signal?: number }): void {
    this.exitCb?.(e);
  }
}

function fakeBackend(): { backend: PtyBackend; spawned: FakeProc[] } {
  const spawned: FakeProc[] = [];
  return {
    backend: {
      spawn(opts: PtySpawnOptions): PtyProcess {
        const p = new FakeProc(opts);
        spawned.push(p);
        return p;
      },
    },
    spawned,
  };
}

test("sanitizeRunEnvKeys strips loader-hijack + malformed keys, keeps values verbatim", () => {
  assert.deepEqual(
    sanitizeRunEnvKeys({
      DEBUG: "1",
      LD_PRELOAD: "/evil.so",
      dyld_insert_libraries: "/evil.dylib",
      PATH: "/evil:/bin",
      NODE_OPTIONS: "--require evil",
      "BAD KEY": "x",
      "0LEAD": "x",
      MY_FLAG: "--not-a-flag-here; rm -rf", // a VALUE is data — kept verbatim
    }),
    { DEBUG: "1", MY_FLAG: "--not-a-flag-here; rm -rf" },
  );
  assert.deepEqual(sanitizeRunEnvKeys(undefined), {});
});

test("start(): argv-array spawn through the backend with venv-inherited env", () => {
  const fb = fakeBackend();
  const host = new RunHost({
    backend: fb.backend,
    baseEnv: { PATH: "/usr/bin", HOME: "/home/u", PYTHONHOME: "/stale" },
    mintId: () => "run-1",
  });
  const { runId } = host.start({
    cmd: "/proj/.venv/bin/python",
    args: ["-m", "pytest", "-k", "smoke or fast"], // a spaced token stays ONE token
    cwd: "/proj",
    venv: { root: "/proj/.venv", platform: "posix" },
    env: { DEBUG: "1", LD_PRELOAD: "/evil.so" },
  });
  assert.equal(runId, "run-1");
  const proc = fb.spawned[0];
  assert.ok(proc);
  assert.equal(proc.opts.shell, "/proj/.venv/bin/python");
  assert.deepEqual(proc.opts.args, ["-m", "pytest", "-k", "smoke or fast"]);
  assert.equal(proc.opts.cwd, "/proj");
  // venv env built exactly like a terminal: bin prepended, VIRTUAL_ENV set,
  // PYTHONHOME dropped; the hostile LD_PRELOAD override never reaches the child.
  assert.equal(proc.opts.env.PATH, "/proj/.venv/bin:/usr/bin");
  assert.equal(proc.opts.env.VIRTUAL_ENV, "/proj/.venv");
  assert.equal(proc.opts.env.PYTHONHOME, undefined);
  assert.equal(proc.opts.env.DEBUG, "1");
  assert.equal(proc.opts.env.LD_PRELOAD, undefined);
  assert.equal(host.status("run-1")?.alive, true);
});

test("output streams live and a natural exit reports killed:false", () => {
  const fb = fakeBackend();
  const host = new RunHost({ backend: fb.backend, baseEnv: {}, mintId: () => "r" });
  const data: string[] = [];
  const exits: Array<{ exitCode: number; killed: boolean }> = [];
  host.on("data", (e) => data.push(e.data));
  host.on("exit", (e) => exits.push({ exitCode: e.exitCode, killed: e.killed }));
  host.start({ cmd: "python3", args: ["x.py"], cwd: "/p" });
  fb.spawned[0]?.emitData("hello\n");
  fb.spawned[0]?.emitData("world\n");
  fb.spawned[0]?.emitExit({ exitCode: 3 });
  assert.deepEqual(data, ["hello\n", "world\n"]);
  assert.deepEqual(exits, [{ exitCode: 3, killed: false }]);
  assert.equal(host.status("r"), undefined, "finished runs are dropped");
});

test("kill(): SIGTERM first, SIGKILL after the grace period, exit reports killed:true", () => {
  const fb = fakeBackend();
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const host = new RunHost({
    backend: fb.backend,
    baseEnv: {},
    mintId: () => "r",
    killGraceMs: 3000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return 0;
    },
  });
  const exits: Array<{ signal?: number; killed: boolean }> = [];
  host.on("exit", (e) =>
    exits.push({ ...(e.signal !== undefined ? { signal: e.signal } : {}), killed: e.killed }),
  );
  host.start({ cmd: "python3", args: [], cwd: "/p" });
  assert.equal(host.kill("r"), true);
  const proc = fb.spawned[0];
  assert.deepEqual(proc?.killSignals, ["SIGTERM"]);
  assert.equal(timers[0]?.ms, 3000);
  // the process ignored SIGTERM — the grace timer escalates to SIGKILL
  timers[0]?.fn();
  assert.deepEqual(proc?.killSignals, ["SIGTERM", "SIGKILL"]);
  proc?.emitExit({ exitCode: 1, signal: 9 });
  assert.deepEqual(exits, [{ signal: 9, killed: true }]);
  assert.equal(host.kill("r"), false, "a finished run cannot be killed again");
});

/* ── the gated-start spine ──────────────────────────────────────────────────*/

const REQ = { cmd: "python3", args: ["x.py"], cwd: "/p", workspaceRoot: "/p" };

test("startGatedRun: gate refusal spawns NOTHING and names the stage", async () => {
  let spawned = 0;
  const out = await startGatedRun(REQ, {
    gate: async () => ({ mayLaunch: false, reason: "nemesis: block — 3 findings" }),
    readTelemetry: async () => {
      throw new Error("must not be read after a gate refusal");
    },
    start: () => {
      spawned += 1;
      return { runId: "x" };
    },
  });
  assert.deepEqual(out, {
    ok: false,
    refusedBy: "gate",
    gateReason: "nemesis: block — 3 findings",
    error: "nemesis: block — 3 findings",
  });
  assert.equal(spawned, 0);
});

test("startGatedRun: guard over threshold blocks pre-flight (no spawn)", async () => {
  let spawned = 0;
  const out = await startGatedRun(REQ, {
    gate: async () => ({ mayLaunch: true, reason: "allow" }),
    readTelemetry: async () => ({ guard: { allow: false, reason: "CPU 97% ≥ 90%" } }),
    start: () => {
      spawned += 1;
      return { runId: "x" };
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.refusedBy, "guard");
  assert.match(out.error ?? "", /97%/);
  assert.equal(spawned, 0);
});

test("startGatedRun: UNREADABLE telemetry blocks fail-closed (never spawn in the catch)", async () => {
  let spawned = 0;
  const out = await startGatedRun(REQ, {
    gate: async () => ({ mayLaunch: true, reason: "allow" }),
    readTelemetry: async () => {
      throw new Error("probe crashed");
    },
    start: () => {
      spawned += 1;
      return { runId: "x" };
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.refusedBy, "guard");
  assert.match(out.error ?? "", /telemetry unavailable/);
  assert.equal(spawned, 0);
});

test("startGatedRun: both checks green → spawn, in gate→guard order", async () => {
  const order: string[] = [];
  const out = await startGatedRun(REQ, {
    gate: async (id) => {
      order.push(`gate:${id.workspaceRoot}`);
      return { mayLaunch: true, reason: "allow" };
    },
    readTelemetry: async () => {
      order.push("guard");
      return { guard: { allow: true } };
    },
    start: (req) => {
      order.push(`spawn:${req.cmd}`);
      return { runId: "run-7" };
    },
  });
  assert.deepEqual(out, { ok: true, runId: "run-7" });
  assert.deepEqual(order, ["gate:/p", "guard", "spawn:python3"]);
});
