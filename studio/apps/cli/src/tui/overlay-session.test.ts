// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * overlay-session.test.ts — a full-screen program over the TUI that can be minimised and
 * resumed without stopping it (`/disk-space`). Fake child, fake terminal, fake clock.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CTRL_D, CTRL_RIGHT_BRACKET, OverlaySession } from "./overlay-session.js";

function harness(size = { cols: 120, rows: 40 }, minimizable?: boolean) {
  const out: string[] = [];
  const stdin: string[] = [];
  const ctl: string[] = [];
  const killed: string[] = [];
  const spawned: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const timers: { ms: number; fn: () => void }[] = [];
  const ctlPipe = Object.assign(new EventEmitter(), { write: (s: string) => ctl.push(s) });
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    stdin: Object.assign(new EventEmitter(), {
      write: (b: Buffer | string) => stdin.push(String(b)),
    }),
    stdout: new EventEmitter(),
    stdio: [null, null, null, ctlPipe],
    kill: (sig?: string) => {
      killed.push(sig ?? "SIGTERM");
      return true;
    },
  });
  const events: string[] = [];
  const s = new OverlaySession({
    label: "disk-space",
    argv: ["/usr/bin/python3", "/t/disk_space.py", "--no-sudo"],
    python: "/usr/bin/python3",
    ptyHost: "/t/pty_host.py",
    cwd: "/home/u",
    term: { write: (x) => out.push(x), size: () => size },
    spawn: ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawned.push({ cmd, args, opts });
      return child;
    }) as never,
    setTimer: (fn, ms) => {
      timers.push({ ms, fn });
      return timers.length as never;
    },
    clearTimer: () => {},
    onDetach: (why) => events.push(`detach:${why}`),
    onExit: (code, attached) => events.push(`exit:${code}:${attached}`),
    ...(minimizable === undefined ? {} : { minimizable }),
  });
  return { s, out, stdin, ctl, killed, spawned, timers, child, events };
}

const emitOut = (child: EventEmitter & { stdout: EventEmitter }, text: string) =>
  child.stdout.emit("data", Buffer.from(text, "latin1"));

test("start: the program runs under pty_host at the terminal's size, attached", () => {
  const h = harness();
  h.s.start();
  assert.equal(h.spawned[0]?.cmd, "/usr/bin/python3");
  assert.deepEqual(h.spawned[0]?.args, [
    "-I",
    "/t/pty_host.py",
    "120",
    "40",
    "--",
    "/usr/bin/python3",
    "/t/disk_space.py",
    "--no-sudo",
  ]);
  assert.equal((h.spawned[0]?.opts.stdio as unknown[]).length, 4, "fd 3 is the resize channel");
  assert.equal(h.s.state, "attached");
});

test("attached: its screen goes to the terminal and keystrokes go to it", () => {
  const h = harness();
  h.s.start();
  emitOut(h.child, "hello");
  h.s.input(Buffer.from("jjq"));
  assert.ok(h.out.includes("hello"));
  assert.deepEqual(h.stdin, ["jjq"]);
});

test("ESC is the program's own key — it passes through untouched", () => {
  const h = harness();
  h.s.start();
  h.s.input(Buffer.from("\x1b"));
  h.s.input(Buffer.from("\x1b[A"));
  assert.deepEqual(h.stdin, ["\x1b", "\x1b[A"]);
  assert.equal(h.s.state, "attached");
});

test("Ctrl+] minimises: keys before it still arrive, the program keeps running, its screen modes are undone", () => {
  const h = harness();
  h.s.start();
  emitOut(h.child, "\x1b[?1049h\x1b[?1000h\x1b[?25l"); // alt screen, mouse, hidden cursor
  h.s.input(Buffer.from(`ab${CTRL_RIGHT_BRACKET}cd`));
  assert.deepEqual(h.stdin, ["ab"]);
  assert.equal(h.s.state, "minimized");
  assert.deepEqual(h.events, ["detach:minimized"]);
  assert.equal(h.killed.length, 0, "minimising never stops the program");
  const reset = h.out.at(-1) ?? "";
  assert.match(reset, /\x1b\[\?1000l/);
  assert.match(reset, /\x1b\[\?25h/);
  assert.match(reset, /\x1b\[\?1049l/);
  // while hidden its output is drained, never painted over Prometheus
  emitOut(h.child, "SECRET-REPAINT");
  assert.ok(!h.out.join("").includes("SECRET-REPAINT"));
});

test("resume: back on its screen with its modes restored, then a resize nudge makes it repaint", () => {
  const h = harness();
  h.s.start();
  emitOut(h.child, "\x1b[?1049h\x1b[?1000h");
  h.s.input(Buffer.from(CTRL_RIGHT_BRACKET));
  h.s.resume();
  assert.equal(h.s.state, "attached");
  const replay = h.out.at(-1) ?? "";
  assert.match(replay, /^\x1b\[\?1049h/);
  assert.match(replay, /\x1b\[2J/);
  assert.match(replay, /\x1b\[\?1000h/);
  assert.deepEqual(h.ctl, ["resize 120 39\n"]);
  h.timers.at(-1)?.fn();
  assert.deepEqual(h.ctl, ["resize 120 39\n", "resize 120 40\n"]);
});

test("Ctrl+D ends the program: SIGTERM, then SIGKILL if it lingers", () => {
  const h = harness();
  h.s.start();
  h.s.input(Buffer.from(`x${CTRL_D}`));
  assert.deepEqual(h.stdin, ["x"]);
  assert.deepEqual(h.killed, ["SIGTERM"]);
  const grace = h.timers.find((t) => t.ms === 2000);
  grace?.fn();
  assert.deepEqual(h.killed, ["SIGTERM", "SIGKILL"]);
});

test("the program quitting on its own hands the screen back (attached) or just reports (minimised)", () => {
  const a = harness();
  a.s.start();
  emitOut(a.child, "\x1b[?1049h");
  a.child.emit("close", 0, null);
  assert.equal(a.s.state, "exited");
  assert.match(a.out.at(-1) ?? "", /\x1b\[\?1049l/);
  assert.deepEqual(a.events, ["exit:0:true"]);

  const m = harness();
  m.s.start();
  m.s.input(Buffer.from(CTRL_RIGHT_BRACKET));
  m.child.emit("close", 143, null);
  assert.deepEqual(m.events, ["detach:minimized", "exit:143:false"]);
});

test("a terminal resize while attached is forwarded; while minimised it waits for resume", () => {
  const h = harness();
  h.s.start();
  h.s.resize();
  assert.deepEqual(h.ctl, ["resize 120 40\n"]);
  h.s.input(Buffer.from(CTRL_RIGHT_BRACKET));
  h.s.resize();
  assert.deepEqual(h.ctl, ["resize 120 40\n"]);
});

test("a mode sequence split across two chunks is still tracked", () => {
  const h = harness();
  h.s.start();
  emitOut(h.child, "\x1b[?10");
  emitOut(h.child, "49h");
  h.s.input(Buffer.from(CTRL_RIGHT_BRACKET));
  assert.match(h.out.at(-1) ?? "", /\x1b\[\?1049l/);
});

test("not minimizable (a one-shot run has nothing to minimise to): Ctrl+] is the program's key", () => {
  const h = harness(undefined, false);
  h.s.start();
  h.s.input(Buffer.from(`a${CTRL_RIGHT_BRACKET}b`));
  assert.deepEqual(h.stdin, [`a${CTRL_RIGHT_BRACKET}b`]);
  assert.equal(h.s.state, "attached");
  h.s.input(Buffer.from(CTRL_D));
  assert.deepEqual(h.killed, ["SIGTERM"], "Ctrl+D still ends it");
});

test("`terminated` says the human ended it with Ctrl+D, not the program on its own", () => {
  const h = harness();
  h.s.start();
  assert.equal(h.s.terminated, false);
  h.s.input(Buffer.from(CTRL_D));
  assert.equal(h.s.terminated, true);
});

test("a key typed after the program ended (EPIPE on its pipes) is not a crash", () => {
  // an 'error' event with no listener throws: the CLI's crash guard then printed
  // "prometheus: unexpected: write EPIPE" into the restored terminal and exited 2
  const h = harness();
  h.s.start();
  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  assert.doesNotThrow(() => h.child.stdin.emit("error", epipe));
  assert.doesNotThrow(() => (h.child.stdio[3] as EventEmitter).emit("error", epipe));
});
