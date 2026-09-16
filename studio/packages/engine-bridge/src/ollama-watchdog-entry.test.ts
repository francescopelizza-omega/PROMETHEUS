/**
 * ollama-watchdog-entry.test.ts — the idle-shutdown watchdog's own helpers, imported directly
 * (never as the spawned `node ollama-watchdog-entry.js` process — see the module's own guard).
 *
 * `stopOllama` calls this package's own `./model-server.js` (`listenersOnPort`/`signalPid`),
 * which shells out to `lsof`/`process.kill` for real — substituted here with `mock.module` (the
 * same mechanism this repo's Electron IPC tests use for "electron") so this suite never touches
 * a real port or a real process. `mock.module` may only be called once per process; this file
 * gets its own node:test worker, same as every other suite `run-tests.mjs` lists.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

import { CRITICAL_RAM_CEILING_PCT } from "./launch-guard.js";

type Listeners = { processes: { pid: number; command: string }[] };
let listenersQueue: Listeners[] = [];
const signalCalls: { pid: number; signal: string }[] = [];
const execCalls: { command: string; args: string[] }[] = [];

mock.module("./model-server.js", {
  exports: {
    listenersOnPort: async (_port: number): Promise<Listeners> =>
      listenersQueue.shift() ?? { processes: [] },
    signalPid: (pid: number, signal: "SIGTERM" | "SIGKILL") => {
      signalCalls.push({ pid, signal });
      return { pid, ok: true };
    },
  },
});

mock.module("./system-probe.js", {
  exports: {
    execCapture: async (command: string, args: string[] = []) => {
      execCalls.push({ command, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  },
});

const {
  activityPath,
  CRITICAL_POLLS_REQUIRED,
  nextCriticalStreak,
  parseStopCmd,
  pidfilePath,
  readLastActiveAt,
  stopOllama,
  stopRunner,
  stopViaCommand,
  touchActivity,
} = await import("./ollama-watchdog-entry.js");

const dirs: string[] = [];
function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), "prom-watchdog-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("pidfilePath / activityPath: both live under <home>/{run,state}", () => {
  const home = "/home/.prometheus";
  assert.equal(pidfilePath(home, "ollama"), join(home, "run", "ollama-watchdog.pid"));
  assert.equal(activityPath(home), join(home, "state", "model-activity.json"));
});

test("pidfilePath: two different runnerIds get two DIFFERENT lock files — no cross-runner collision", () => {
  const home = "/home/.prometheus";
  assert.equal(pidfilePath(home, "lmstudio"), join(home, "run", "lmstudio-watchdog.pid"));
  assert.notEqual(pidfilePath(home, "ollama"), pidfilePath(home, "lmstudio"));
});

test("readLastActiveAt: a missing activity file reads as 'just now', never 'idle forever'", () => {
  const home = tmpHome();
  const before = Date.now();
  const at = readLastActiveAt(home);
  assert.ok(at >= before, "a missing file must never look idle since the epoch");
});

test("readLastActiveAt: a corrupt activity file also reads as 'just now'", () => {
  const home = tmpHome();
  touchActivity(home);
  // Overwrite with garbage — touchActivity already proved the directory exists.
  writeFileSync(activityPath(home), "{ not json");
  const before = Date.now();
  assert.ok(readLastActiveAt(home) >= before);
});

test("touchActivity then readLastActiveAt round-trips a real timestamp", () => {
  const home = tmpHome();
  const before = Date.now();
  touchActivity(home);
  const after1 = Date.now();
  const at = readLastActiveAt(home);
  assert.ok(at >= before && at <= after1, "the recorded timestamp must fall inside the call window");
});

test("touchActivity creates the state directory", () => {
  const home = tmpHome();
  touchActivity(home);
  assert.doesNotThrow(() => readFileSync(activityPath(home), "utf8"));
});

test("stopOllama: nothing listening on the port → no signal sent at all", async () => {
  listenersQueue = [{ processes: [] }];
  signalCalls.length = 0;
  await stopOllama("ollama", 11434);
  assert.deepEqual(signalCalls, []);
});

test("stopOllama: a matching process gets SIGTERM, then — if still listed after the grace check — SIGKILL", async () => {
  listenersQueue = [
    { processes: [{ pid: 555, command: "ollama" }] }, // first listenersOnPort: still up
    { processes: [{ pid: 555, command: "ollama" }] }, // after the grace sleep: STILL up → escalate
  ];
  signalCalls.length = 0;
  await stopOllama("ollama", 11434);
  assert.deepEqual(signalCalls, [
    { pid: 555, signal: "SIGTERM" },
    { pid: 555, signal: "SIGKILL" },
  ]);
});

test("stopOllama: the process exits cleanly after SIGTERM → no SIGKILL follow-up", async () => {
  listenersQueue = [
    { processes: [{ pid: 555, command: "ollama" }] }, // first: up
    { processes: [] }, // after grace: gone — SIGTERM alone did it
  ];
  signalCalls.length = 0;
  await stopOllama("ollama", 11434);
  assert.deepEqual(signalCalls, [{ pid: 555, signal: "SIGTERM" }]);
});

test("stopOllama: only processes matching processMatch are signalled, never an unrelated listener", () => {
  listenersQueue = [{ processes: [{ pid: 999, command: "some-other-daemon" }] }];
  signalCalls.length = 0;
  return stopOllama("ollama", 11434).then(() => {
    assert.deepEqual(signalCalls, []);
  });
});

test("re-exports nextCriticalStreak/CRITICAL_POLLS_REQUIRED from launch-guard.js unchanged — full behavioral coverage lives in launch-guard.test.ts", () => {
  assert.equal(typeof nextCriticalStreak, "function");
  assert.equal(nextCriticalStreak(0, CRITICAL_RAM_CEILING_PCT), 1);
  assert.equal(typeof CRITICAL_POLLS_REQUIRED, "number");
  assert.ok(CRITICAL_POLLS_REQUIRED >= 2, "must require SUSTAINED pressure, never a single spike");
});

/* ── parseStopCmd: fail-soft flag parsing ────────────────────────────────────────────────── */

test("parseStopCmd: a valid JSON string array parses cleanly", () => {
  assert.deepEqual(parseStopCmd('["lms","server","stop"]'), ["lms", "server", "stop"]);
});

test("parseStopCmd: undefined/empty input is 'no stop command', not an error", () => {
  assert.equal(parseStopCmd(undefined), undefined);
  assert.equal(parseStopCmd(""), undefined);
});

test("parseStopCmd: malformed JSON degrades to undefined rather than crashing a detached process", () => {
  assert.equal(parseStopCmd("{ not json"), undefined);
});

test("parseStopCmd: a JSON value that isn't a non-empty array of strings is rejected", () => {
  assert.equal(parseStopCmd("[]"), undefined, "an empty array is not a runnable command");
  assert.equal(parseStopCmd('{"bin":"lms"}'), undefined, "an object is not an argv");
  assert.equal(parseStopCmd("[1,2,3]"), undefined, "non-string elements are not a valid argv");
  assert.equal(parseStopCmd('["lms", 3]'), undefined, "a MIXED array is still rejected, not truncated");
});

/* ── stopViaCommand: the graceful, vendor-owned stop path ────────────────────────────────── */

test("stopViaCommand: runs the given argv via execCapture, split into bin + args", async () => {
  execCalls.length = 0;
  await stopViaCommand(["lms", "server", "stop"]);
  assert.deepEqual(execCalls, [{ command: "lms", args: ["server", "stop"] }]);
});

test("stopViaCommand: an empty argv is a safe no-op (never calls execCapture with an empty bin)", async () => {
  execCalls.length = 0;
  await stopViaCommand([]);
  assert.deepEqual(execCalls, []);
});

/* ── stopRunner: dispatches to the CORRECT mechanism for the runner ──────────────────────── */

test("stopRunner: with a stopCmd, uses the graceful command and NEVER signals a process", async () => {
  execCalls.length = 0;
  signalCalls.length = 0;
  listenersQueue = [{ processes: [{ pid: 555, command: "Bionic" }] }];
  await stopRunner("LM Studio", 1234, ["lms", "server", "stop"]);
  assert.deepEqual(execCalls, [{ command: "lms", args: ["server", "stop"] }]);
  assert.deepEqual(signalCalls, [], "must never SIGTERM/SIGKILL a process that has its own stop command");
});

test("stopRunner: with NO stopCmd, falls back to the signal-based escalation (Ollama's real path)", async () => {
  execCalls.length = 0;
  signalCalls.length = 0;
  listenersQueue = [
    { processes: [{ pid: 555, command: "ollama" }] },
    { processes: [] }, // exits cleanly after SIGTERM
  ];
  await stopRunner("ollama", 11434, undefined);
  assert.deepEqual(execCalls, [], "no stop command known ⇒ never touches execCapture");
  assert.deepEqual(signalCalls, [{ pid: 555, signal: "SIGTERM" }]);
});
