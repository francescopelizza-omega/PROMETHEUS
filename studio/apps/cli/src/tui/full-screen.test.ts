// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * full-screen.test.ts — `prometheus disk-space` straight from the shell: the program owns the
 * terminal until it quits or Ctrl+D ends it, then the terminal is given back and the call
 * resolves so Prometheus can exit. Fake terminal, fake child.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runFullScreen } from "./full-screen.js";
import { CTRL_D, CTRL_RIGHT_BRACKET } from "./overlay-session.js";

function harness() {
  const raw: boolean[] = [];
  const out: string[] = [];
  const toChild: string[] = [];
  const killed: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode(on: boolean) {
      raw.push(on);
      this.isRaw = on;
      return this;
    },
    resume() {},
    pause() {},
  });
  const stdout = Object.assign(new EventEmitter(), {
    columns: 100,
    rows: 30,
    write: (s: string) => {
      out.push(s);
      return true;
    },
  });
  const ctl: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 999,
    stdin: { write: (b: Buffer | string) => toChild.push(String(b)) },
    stdout: new EventEmitter(),
    stdio: [null, null, null, { write: (s: string) => ctl.push(s) }],
    kill: (sig?: string) => {
      killed.push(sig ?? "SIGTERM");
      // the relay forwards the signal; the program ends and the pipe closes
      queueMicrotask(() => child.emit("close", 143, null));
      return true;
    },
  });
  const spawned: string[][] = [];
  const run = runFullScreen(
    {
      label: "disk-space",
      argv: ["/py", "/t/disk_space.py", "--no-sudo"],
      python: "/py",
      ptyHost: "/t/pty_host.py",
      cwd: "/home/u",
    },
    { stdin, stdout },
    {
      spawn: ((cmd: string, args: string[]) => {
        spawned.push([cmd, ...args]);
        return child;
      }) as never,
    },
  );
  return { run, raw, out, toChild, killed, stdin, stdout, child, ctl, spawned };
}

test("the program gets the whole terminal, raw, at its size; keys go straight to it", () => {
  const h = harness();
  assert.deepEqual(h.spawned[0]?.slice(0, 6), ["/py", "-I", "/t/pty_host.py", "100", "30", "--"]);
  assert.deepEqual(h.raw, [true]);
  h.stdin.emit("data", Buffer.from("jj\x1b"));
  assert.deepEqual(h.toChild, ["jj\x1b"]);
  h.child.stdout.emit("data", Buffer.from("SCREEN"));
  assert.ok(h.out.includes("SCREEN"));
});

test("Ctrl+] is the program's own key here — there is nothing to minimise to", () => {
  const h = harness();
  h.stdin.emit("data", Buffer.from(CTRL_RIGHT_BRACKET));
  assert.deepEqual(h.toChild, [CTRL_RIGHT_BRACKET]);
});

test("Ctrl+D ends it, the terminal is restored, and the run resolves as a deliberate exit", async () => {
  const h = harness();
  h.child.stdout.emit("data", Buffer.from("\x1b[?1049h"));
  h.stdin.emit("data", Buffer.from(CTRL_D));
  const r = await h.run;
  assert.deepEqual(h.killed, ["SIGTERM"]);
  assert.deepEqual(r, { code: 143, terminated: true });
  assert.deepEqual(h.raw, [true, false], "raw mode is switched back off");
  assert.match(h.out.join(""), /\x1b\[\?1049l/, "the alternate screen is left");
  assert.equal(h.stdin.listenerCount("data"), 0);
  assert.equal(h.stdout.listenerCount("resize"), 0);
});

test("the program quitting on its own (q) resolves with its code", async () => {
  const h = harness();
  h.child.emit("close", 0, null);
  assert.deepEqual(await h.run, { code: 0, terminated: false });
});

test("a terminal resize reaches the program", () => {
  const h = harness();
  h.stdout.columns = 140;
  h.stdout.emit("resize");
  assert.deepEqual(h.ctl, ["resize 140 30\n"]);
});
