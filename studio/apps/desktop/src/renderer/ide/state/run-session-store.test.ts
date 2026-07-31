/**
 * run-session-store.test.ts — the before-launch + compound EXECUTION chain (APP-035).
 *
 * Drives the SHARED run-session store against a FAKE window.prometheus.ide that records
 * every gated `runStart`, scripts a per-argv outcome (exit code / gate refusal / a
 * never-exiting background task), and emits `run.exit` events. Proves the invariants the
 * gated engine can't be asked to fake: a failing pre-launch task never spawns the main
 * config; a serial compound stops at the first refusal; a parallel-flagged compound
 * dispatches every member; a background pre-task is started-not-awaited; loadTasks reads
 * tasks.json. No real process is spawned.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { RunConfig } from "./run-config.js";
import { useRunSessionStore } from "./run-session-store.js";
import type { TaskConfig } from "./tasks-config.js";

interface RunReq {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  workspaceRoot: string;
}
type Outcome = { refuse: "gate" | "guard" } | { code: number } | { background: true };

let emitCb: ((ev: unknown) => void) | null = null;
let counter = 0;

const fake = {
  calls: [] as { cmd: string; args: string[]; runId: string | null }[],
  outcomes: new Map<string, Outcome>(),
  fsFiles: new Map<string, string>(),
  onEvent(cb: (ev: unknown) => void): () => void {
    emitCb = cb;
    return () => {
      emitCb = null;
    };
  },
  emit(ev: unknown): void {
    emitCb?.(ev);
  },
  async runStart(req: RunReq): Promise<unknown> {
    const key = [req.cmd, ...req.args].join(" ");
    let outcome: Outcome = { code: 0 };
    for (const [sub, o] of fake.outcomes) {
      if (key.includes(sub)) {
        outcome = o;
        break;
      }
    }
    if ("refuse" in outcome) {
      fake.calls.push({ cmd: req.cmd, args: req.args, runId: null });
      return { ok: false, refusedBy: outcome.refuse, error: "refused", gate: null };
    }
    const runId = `run${++counter}`;
    fake.calls.push({ cmd: req.cmd, args: req.args, runId });
    if ("code" in outcome) {
      // exit on a macrotask so the store has registered its exit waiter first.
      setTimeout(
        () => fake.emit({ channel: "run.exit", runId, exitCode: outcome.code, killed: false }),
        0,
      );
    }
    return { ok: true, runId };
  },
  async runKill(): Promise<void> {},
  async fsRead(uri: string): Promise<{ ok: boolean; text?: string }> {
    for (const [suffix, text] of fake.fsFiles) if (uri.endsWith(suffix)) return { ok: true, text };
    return { ok: false };
  },
};

(globalThis as { window?: unknown }).window = { prometheus: { ide: fake } };

const mkTask = (over: Partial<TaskConfig> = {}): TaskConfig => ({
  label: "x",
  type: "process",
  command: "echo",
  args: [],
  group: "none",
  isDefault: false,
  ...over,
});
const mkCfg = (name: string, over: Partial<RunConfig> = {}): RunConfig => ({
  name,
  type: "python",
  request: "launch",
  program: `${name}.py`,
  raw: {},
  ...over,
});
const spawnedArg = (needle: string): boolean =>
  fake.calls.some((c) => c.args.some((a) => a.includes(needle)));

beforeEach(() => {
  fake.calls = [];
  fake.outcomes = new Map();
  fake.fsFiles = new Map();
  useRunSessionStore.setState({
    runId: null,
    runLabel: null,
    output: "",
    exit: null,
    error: null,
    gate: null,
    tasks: [],
  });
});

test("a failing pre-launch task never spawns the main config", async () => {
  fake.outcomes.set("prefail", { code: 1 });
  useRunSessionStore.setState({ tasks: [mkTask({ label: "pre", command: "prefail" })] });
  await useRunSessionStore
    .getState()
    .startByName("app", [mkCfg("app", { preLaunchTask: "pre" })], "/ws");
  assert.deepEqual(
    fake.calls.map((c) => c.cmd),
    ["prefail"],
  );
  assert.ok(!spawnedArg("app.py")); // the config was never reached
  assert.match(useRunSessionStore.getState().error ?? "", /pre-launch task "pre" failed/);
});

test("a pre-task exit 0 lets the config launch (before-launch happy path)", async () => {
  useRunSessionStore.setState({ tasks: [mkTask({ label: "pre", command: "preok" })] });
  await useRunSessionStore
    .getState()
    .startByName("app", [mkCfg("app", { preLaunchTask: "pre" })], "/ws");
  assert.equal(fake.calls[0]?.cmd, "preok"); // pre ran first…
  assert.ok(spawnedArg("app.py")); // …then the config launched
});

test("a serial compound stops at the first member that is refused", async () => {
  fake.outcomes.set("a.py", { refuse: "gate" });
  const configs: RunConfig[] = [
    mkCfg("a"),
    mkCfg("b"),
    { name: "grp", type: "compound", request: "launch", compound: ["a", "b"], raw: {} },
  ];
  await useRunSessionStore.getState().startByName("grp", configs, "/ws");
  assert.ok(spawnedArg("a.py")); // attempted (and refused)
  assert.ok(!spawnedArg("b.py")); // remainder never dispatched
});

test("a parallel-flagged compound dispatches every member", async () => {
  const configs: RunConfig[] = [
    mkCfg("a"),
    mkCfg("b"),
    {
      name: "grp",
      type: "compound",
      request: "launch",
      compound: ["a", "b"],
      raw: { parallel: true },
    },
  ];
  await useRunSessionStore.getState().startByName("grp", configs, "/ws");
  assert.ok(spawnedArg("a.py"));
  assert.ok(spawnedArg("b.py"));
});

test("a background (isBackground) pre-task is started but not awaited; the config still launches", async () => {
  fake.outcomes.set("watcher", { background: true }); // never emits an exit
  useRunSessionStore.setState({
    tasks: [mkTask({ label: "watch", command: "watcher", isBackground: true })],
  });
  await useRunSessionStore
    .getState()
    .startByName("app", [mkCfg("app", { preLaunchTask: "watch" })], "/ws");
  assert.ok(fake.calls.some((c) => c.cmd === "watcher"));
  assert.ok(spawnedArg("app.py")); // did not hang waiting for the watch task
  // drain the still-live background run so later tests start from an idle store.
  const watcher = fake.calls.find((c) => c.cmd === "watcher");
  if (watcher?.runId)
    fake.emit({ channel: "run.exit", runId: watcher.runId, exitCode: 0, killed: false });
});

test("loadTasks reads .vscode/tasks.json into the store", async () => {
  fake.fsFiles.set(".vscode/tasks.json", `{ "tasks": [ { "label": "t", "command": "echo" } ] }`);
  await useRunSessionStore.getState().loadTasks("/ws");
  const tasks = useRunSessionStore.getState().tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.label, "t");
});

test("loadTasks on a missing tasks.json clears tasks to []", async () => {
  useRunSessionStore.setState({ tasks: [mkTask()] });
  await useRunSessionStore.getState().loadTasks("/ws");
  assert.deepEqual(useRunSessionStore.getState().tasks, []);
});
