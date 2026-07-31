/**
 * live-terminal.test.ts — LAUNCH the previewed terminal argv as a live child (P5).
 *
 * Deterministic + spawn-free: a FAKE PtyBackend records the spawn opts and lets the
 * test DRIVE the round-trip (push child output → assert it reached stdout; capture
 * forwarded keystrokes; fire onExit → assert the resolved code). A fake stdin (TTY,
 * raw-mode tracked), fake stdout, fake signal registrar, and fake typed-confirm mean
 * NO real pty/tmux/engine is ever touched. We assert:
 *   1. the engine's argv/env/cwd are spawned EXACTLY (env merged, overrides win);
 *   2. data streams child→stdout, keystrokes stdin→child, SIGWINCH→resize;
 *   3. exit code (and 128+signal) is returned, stdin is ALWAYS restored to cooked;
 *   4. never-force: bypass requires a typed confirm — decline/throw ⇒ NO spawn, exit 2;
 *   5. crash-free: a spawn throw / ok:false / empty argv renders friendly + a code,
 *      never a throw, and the terminal is never left in raw mode.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ChatTerminalEnvelope } from "@prometheus/engine-bridge";

import type { PtyBackend, PtyProcess, PtySpawnOptions } from "./backend.js";
import {
  BYPASS_CONFIRM_PHRASE,
  type LiveInputStream,
  type LiveOutputStream,
  type SignalRegistrar,
  bypassConfirmPrompt,
  mergeLaunchEnv,
  renderLaunchNotes,
  runLiveTerminal,
} from "./live-terminal.js";

/* ------------------------------------------------------------------ */
/* Fakes                                                              */
/* ------------------------------------------------------------------ */

/** A fake child the test drives: capture writes/resizes, fire data + exit on demand. */
class FakeProc implements PtyProcess {
  pid = 4242;
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed: string[] = [];
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb;
  }
  kill(signal?: string): void {
    this.killed.push(signal ?? "SIGTERM");
  }
  /** test driver: emit a chunk of child output. */
  emitData(d: string): void {
    this.dataCb?.(d);
  }
  /** test driver: end the child with a code (and optional signal). */
  emitExit(exitCode: number, signal?: number): void {
    this.exitCb?.(signal !== undefined ? { exitCode, signal } : { exitCode });
  }
}

interface FakeBackend extends PtyBackend {
  opts: PtySpawnOptions | null;
  proc: FakeProc;
}

/** A backend that hands back a FakeProc and records the spawn opts. */
function fakeBackend(opts: { throws?: string } = {}): FakeBackend {
  const proc = new FakeProc();
  const be: FakeBackend = {
    opts: null,
    proc,
    spawn(o: PtySpawnOptions): PtyProcess {
      if (opts.throws) throw new Error(opts.throws);
      be.opts = o;
      return proc;
    },
  };
  return be;
}

/** A fake stdin TTY: tracks raw mode, replays a captured data listener. */
function fakeStdin(isTTY = true): LiveInputStream & {
  emit(chunk: string): void;
  rawHistory: boolean[];
  resumed: number;
  paused: number;
} {
  let listener: ((c: Buffer | string) => void) | null = null;
  const rawHistory: boolean[] = [];
  const api = {
    isTTY,
    isRaw: false,
    rawHistory,
    resumed: 0,
    paused: 0,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
      rawHistory.push(mode);
      return this;
    },
    resume() {
      this.resumed++;
      return this;
    },
    pause() {
      this.paused++;
      return this;
    },
    on(_e: "data", l: (c: Buffer | string) => void) {
      listener = l;
      return this;
    },
    off(_e: "data", l: (c: Buffer | string) => void) {
      if (listener === l) listener = null;
      return this;
    },
    emit(chunk: string) {
      listener?.(chunk);
    },
  };
  return api;
}

/** A fake stdout capturing every write; carries a fixed size for resize tests. */
function fakeStdout(columns = 120, rows = 40): LiveOutputStream & { out: string[] } {
  const out: string[] = [];
  return {
    isTTY: true,
    columns,
    rows,
    out,
    write(d: string) {
      out.push(d);
      return true;
    },
  };
}

/** A fake SIGWINCH registrar the test can fire. */
function fakeSignals(): SignalRegistrar & { fire(): void; listeners: number } {
  let l: (() => void) | null = null;
  return {
    listeners: 0,
    on(_s: "SIGWINCH", listener: () => void) {
      l = listener;
      this.listeners++;
      return this;
    },
    off(_s: "SIGWINCH", listener: () => void) {
      if (l === listener) {
        l = null;
        this.listeners--;
      }
      return this;
    },
    fire() {
      l?.();
    },
  };
}

/** Build a valid terminal envelope (engine already returned the injection-safe argv). */
function envelope(over: Partial<ChatTerminalEnvelope> = {}): ChatTerminalEnvelope {
  return {
    command: "chat",
    ok: true,
    mode: "terminal",
    cli: "claude",
    label: "Claude Code",
    argv: ["claude", "--model", "opus"],
    env: { CLAUDE_X: "1" },
    notes: ["one-shot session"],
    bypass: false,
    tmux: null,
    interactive: true,
    model: "opus",
    cwd: "/work/proj",
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Pure builders                                                      */
/* ------------------------------------------------------------------ */

test("mergeLaunchEnv: base inherited, envelope overrides win, undefined dropped", () => {
  const merged = mergeLaunchEnv(
    { env: { CLAUDE_X: "2", NEW: "y" } },
    { PATH: "/bin", CLAUDE_X: "1", GONE: undefined },
  );
  assert.equal(merged.PATH, "/bin");
  assert.equal(merged.CLAUDE_X, "2"); // envelope wins
  assert.equal(merged.NEW, "y");
  assert.ok(!("GONE" in merged)); // undefined base value dropped
});

test("renderLaunchNotes: surfaces label + notes verbatim, flags a bypass", () => {
  const plain = renderLaunchNotes(envelope());
  assert.ok(plain.some((l) => l.includes("Claude Code")));
  assert.ok(plain.some((l) => l.includes("one-shot session")));
  assert.ok(!plain.some((l) => /BYPASS/i.test(l)));

  const danger = renderLaunchNotes(envelope({ bypass: true }));
  assert.ok(danger.some((l) => /bypass/i.test(l.toLowerCase())));
});

test("bypassConfirmPrompt: demands the exact phrase", () => {
  assert.ok(bypassConfirmPrompt(envelope()).includes(BYPASS_CONFIRM_PHRASE));
});

/* ------------------------------------------------------------------ */
/* Launch round-trip                                                  */
/* ------------------------------------------------------------------ */

test("spawns the engine argv EXACTLY with merged env in the resolved cwd", async () => {
  const backend = fakeBackend();
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const signals = fakeSignals();

  const run = runLiveTerminal(envelope(), {
    backend,
    stdin,
    stdout,
    signals,
    baseEnv: { PATH: "/usr/bin", CLAUDE_X: "base" },
  });

  // let the microtasks wire up, then end the child.
  await Promise.resolve();
  backend.proc.emitExit(0);
  const code = await run;

  assert.equal(code, 0);
  assert.ok(backend.opts);
  assert.equal(backend.opts?.shell, "claude");
  assert.deepEqual(backend.opts?.args, ["--model", "opus"]);
  assert.equal(backend.opts?.cwd, "/work/proj");
  assert.equal(backend.opts?.env.PATH, "/usr/bin");
  assert.equal(backend.opts?.env.CLAUDE_X, "1"); // envelope override won
  // size came from stdout's columns/rows.
  assert.equal(backend.opts?.cols, 120);
  assert.equal(backend.opts?.rows, 40);
});

test("streams child output → stdout and forwards keystrokes → child", async () => {
  const backend = fakeBackend();
  const stdin = fakeStdin();
  const stdout = fakeStdout();

  const run = runLiveTerminal(envelope(), { backend, stdin, stdout, signals: fakeSignals() });
  await Promise.resolve();

  backend.proc.emitData("hello from child");
  stdin.emit("ls\n");

  backend.proc.emitExit(0);
  await run;

  assert.ok(stdout.out.includes("hello from child"));
  assert.ok(backend.proc.writes.includes("ls\n"));
});

test("SIGWINCH propagates the current size to child.resize", async () => {
  const backend = fakeBackend();
  const stdout = fakeStdout(100, 30);
  const signals = fakeSignals();

  const run = runLiveTerminal(envelope(), { backend, stdin: fakeStdin(), stdout, signals });
  await Promise.resolve();

  signals.fire();
  assert.deepEqual(backend.proc.resizes.at(-1), { cols: 100, rows: 30 });

  backend.proc.emitExit(0);
  await run;
});

test("raw mode is set on launch and ALWAYS restored to cooked on exit", async () => {
  const backend = fakeBackend();
  const stdin = fakeStdin(true);

  const run = runLiveTerminal(envelope(), {
    backend,
    stdin,
    stdout: fakeStdout(),
    signals: fakeSignals(),
  });
  await Promise.resolve();
  assert.equal(stdin.isRaw, true); // entered raw mode

  backend.proc.emitExit(0);
  await run;

  assert.equal(stdin.isRaw, false); // restored to cooked
  assert.deepEqual(stdin.rawHistory, [true, false]);
});

test("returns the child exit code; a signal maps to 128+signal", async () => {
  const backend = fakeBackend();
  const run = runLiveTerminal(envelope(), {
    backend,
    stdin: fakeStdin(),
    stdout: fakeStdout(),
    signals: fakeSignals(),
  });
  await Promise.resolve();
  backend.proc.emitExit(0, 9); // SIGKILL
  assert.equal(await run, 137);
});

test("a non-zero clean exit is propagated verbatim", async () => {
  const backend = fakeBackend();
  const run = runLiveTerminal(envelope(), {
    backend,
    stdin: fakeStdin(),
    stdout: fakeStdout(),
    signals: fakeSignals(),
  });
  await Promise.resolve();
  backend.proc.emitExit(3);
  assert.equal(await run, 3);
});

/* ------------------------------------------------------------------ */
/* Never-force: the bypass gate                                       */
/* ------------------------------------------------------------------ */

test("never-force: bypass DECLINED ⇒ no spawn, friendly line, exit 2", async () => {
  const backend = fakeBackend();
  const prompts: Array<{ prompt: string; phrase: string }> = [];
  const out: string[] = [];

  const code = await runLiveTerminal(envelope({ bypass: true }), {
    backend,
    stdin: fakeStdin(),
    stdout: fakeStdout(),
    signals: fakeSignals(),
    write: (l) => out.push(l),
    confirm: async (prompt, phrase) => {
      prompts.push({ prompt, phrase });
      return false; // decline
    },
  });

  assert.equal(code, 2);
  assert.equal(backend.opts, null); // NEVER spawned
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.phrase, BYPASS_CONFIRM_PHRASE);
  assert.ok(out.some((l) => /not launched/i.test(l)));
});

test("never-force: a THROWN confirm is treated as a denial (no spawn, exit 2)", async () => {
  const backend = fakeBackend();
  const code = await runLiveTerminal(envelope({ bypass: true }), {
    backend,
    stdin: fakeStdin(),
    stdout: fakeStdout(),
    signals: fakeSignals(),
    write: () => {},
    confirm: async () => {
      throw new Error("prompt aborted");
    },
  });
  assert.equal(code, 2);
  assert.equal(backend.opts, null);
});

test("never-force: bypass CONFIRMED proceeds to launch", async () => {
  const backend = fakeBackend();
  const run = runLiveTerminal(envelope({ bypass: true }), {
    backend,
    stdin: fakeStdin(),
    stdout: fakeStdout(),
    signals: fakeSignals(),
    write: () => {},
    confirm: async () => true,
  });
  await Promise.resolve();
  backend.proc.emitExit(0);
  assert.equal(await run, 0);
  assert.ok(backend.opts); // launched after confirm
});

test("never-force default: no confirm seam ⇒ a bypass launch is denied", async () => {
  const backend = fakeBackend();
  const code = await runLiveTerminal(envelope({ bypass: true }), {
    backend,
    stdin: fakeStdin(),
    stdout: fakeStdout(),
    signals: fakeSignals(),
    write: () => {},
  });
  assert.equal(code, 2);
  assert.equal(backend.opts, null);
});

/* ------------------------------------------------------------------ */
/* Crash-free                                                         */
/* ------------------------------------------------------------------ */

test("crash-free: a spawn throw renders friendly + returns 1, tty never left raw", async () => {
  const backend = fakeBackend({ throws: "node-pty native addon not found" });
  const stdin = fakeStdin(true);
  const out: string[] = [];

  const code = await runLiveTerminal(envelope(), {
    backend,
    stdin,
    stdout: fakeStdout(),
    signals: fakeSignals(),
    write: (l) => out.push(l),
  });

  assert.equal(code, 1);
  assert.equal(stdin.isRaw, false); // never entered raw, definitely not left raw
  assert.ok(out.some((l) => /failed to launch/i.test(l)));
  assert.ok(out.some((l) => /node-pty/i.test(l))); // graceful hint surfaced
});

test("crash-free: an ok:false envelope is refused without spawning", async () => {
  const backend = fakeBackend();
  const out: string[] = [];
  const code = await runLiveTerminal(envelope({ ok: false, error: "engine declined", _exit: 2 }), {
    backend,
    stdin: fakeStdin(),
    stdout: fakeStdout(),
    signals: fakeSignals(),
    write: (l) => out.push(l),
  });
  assert.equal(code, 2);
  assert.equal(backend.opts, null);
  assert.ok(out.some((l) => /declined/i.test(l)));
});

test("crash-free: an empty argv is refused (exit 2, no spawn)", async () => {
  const backend = fakeBackend();
  const code = await runLiveTerminal(envelope({ argv: [] }), {
    backend,
    stdin: fakeStdin(),
    stdout: fakeStdout(),
    signals: fakeSignals(),
    write: () => {},
  });
  assert.equal(code, 2);
  assert.equal(backend.opts, null);
});

test("listeners are detached on exit (stdin data + SIGWINCH unsubscribed)", async () => {
  const backend = fakeBackend();
  const signals = fakeSignals();
  const stdin = fakeStdin();

  const run = runLiveTerminal(envelope(), {
    backend,
    stdin,
    stdout: fakeStdout(),
    signals,
  });
  await Promise.resolve();
  assert.equal(signals.listeners, 1);

  backend.proc.emitExit(0);
  await run;

  assert.equal(signals.listeners, 0); // SIGWINCH detached
  // after teardown a late keystroke must not reach the (gone) child.
  const before = backend.proc.writes.length;
  stdin.emit("late");
  assert.equal(backend.proc.writes.length, before);
});

test("non-TTY stdin: never calls setRawMode (line-buffered fallback, no crash)", async () => {
  const backend = fakeBackend();
  const stdin = fakeStdin(false); // not a TTY
  const run = runLiveTerminal(envelope(), {
    backend,
    stdin,
    stdout: fakeStdout(),
    signals: fakeSignals(),
  });
  await Promise.resolve();
  backend.proc.emitExit(0);
  await run;
  assert.deepEqual(stdin.rawHistory, []); // raw mode never touched
});
