/**
 * tasks-config.test.ts — node:test for the PURE tasks.json model (plan 13/22).
 *
 * Pins parsing (label/command required, group string + object forms, options.cwd),
 * shell-quoting of the command line, and default-task-per-group resolution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { RunConfig } from "./run-config.js";
import {
  type TaskConfig,
  defaultTaskFor,
  expandTask,
  parseTasksJson,
  planPreTasks,
  planTaskRun,
  taskCommandLine,
  taskInvocation,
} from "./tasks-config.js";

const mkTask = (over: Partial<TaskConfig> = {}): TaskConfig => ({
  label: "x",
  type: "process",
  command: "echo",
  args: [],
  group: "none",
  isDefault: false,
  ...over,
});

test("parseTasksJson normalizes tasks (JSONC-tolerant)", () => {
  const tasks = parseTasksJson(`{
    // build config
    "version": "2.0.0",
    "tasks": [
      { "label": "build", "type": "shell", "command": "make", "args": ["all"],
        "group": { "kind": "build", "isDefault": true }, "options": { "cwd": "src" } },
      { "label": "lint", "type": "process", "command": "ruff", "group": "test" },
      { "command": "nolabel" }
    ]
  }`);
  assert.equal(tasks.length, 2); // the no-label entry dropped
  const build = tasks.find((t) => t.label === "build");
  assert.ok(build);
  assert.equal(build.type, "shell");
  assert.equal(build.group, "build");
  assert.equal(build.isDefault, true);
  assert.equal(build.cwd, "src");
  assert.equal(tasks.find((t) => t.label === "lint")?.group, "test");
});

test("a task without a command is dropped; a bare array is accepted", () => {
  const tasks = parseTasksJson(`[{ "label": "x" }, { "label": "ok", "command": "echo" }]`);
  assert.deepEqual(
    tasks.map((t) => t.label),
    ["ok"],
  );
});

test("taskCommandLine quotes only args that need it", () => {
  const [t] = parseTasksJson(
    `{ "tasks": [ { "label": "t", "command": "echo", "args": ["hello", "a b", "x&y", ""] } ] }`,
  );
  assert.ok(t);
  assert.equal(taskCommandLine(t), 'echo hello "a b" "x&y" ""');
});

test("taskCommandLine escapes embedded quotes/backslashes", () => {
  const [t] = parseTasksJson(
    `{ "tasks": [ { "label": "t", "command": "sh", "args": ["-c", "say \\"hi\\""] } ] }`,
  );
  assert.ok(t);
  assert.equal(taskCommandLine(t), 'sh -c "say \\"hi\\""');
});

test("defaultTaskFor prefers isDefault, else first-in-group", () => {
  const tasks = parseTasksJson(`{
    "tasks": [
      { "label": "b1", "command": "a", "group": "build" },
      { "label": "b2", "command": "b", "group": { "kind": "build", "isDefault": true } },
      { "label": "t1", "command": "c", "group": "test" }
    ]
  }`);
  assert.equal(defaultTaskFor(tasks, "build")?.label, "b2"); // isDefault wins
  assert.equal(defaultTaskFor(tasks, "test")?.label, "t1"); // first-in-group
  assert.equal(defaultTaskFor(tasks, "none"), undefined);
});

/* ── APP-035: execution invocation + before-launch/compound planning ─────────── */

test("taskInvocation: type:process → direct argv, shell:false", () => {
  const inv = taskInvocation(mkTask({ type: "process", command: "node", args: ["a", "b"] }), "/ws");
  assert.deepEqual(inv, { cmd: "node", args: ["a", "b"], cwd: "/ws", shell: false });
});

test("taskInvocation: type:shell → explicit sh -c / cmd /c, flagged shell:true", () => {
  const posix = taskInvocation(
    mkTask({ type: "shell", command: "echo", args: ["hi there"] }),
    "/ws",
  );
  assert.deepEqual(posix, { cmd: "sh", args: ["-c", 'echo "hi there"'], cwd: "/ws", shell: true });
  const win = taskInvocation(mkTask({ type: "shell", command: "echo", args: ["hi"] }), "/ws", {
    platform: "win32",
  });
  assert.deepEqual(win, { cmd: "cmd", args: ["/c", "echo hi"], cwd: "/ws", shell: true });
});

test("taskInvocation: {value,quoting} arg objects are coerced (never argv-passed as [object Object])", () => {
  const [t] = parseTasksJson(
    `{ "tasks": [ { "label": "t", "type": "process", "command": "tool",
       "args": [ { "value": "--flag", "quoting": "strong" }, "plain" ] } ] }`,
  );
  assert.ok(t);
  assert.deepEqual(taskInvocation(t, "/ws")?.args, ["--flag", "plain"]);
});

test("taskInvocation: ${workspaceFolder}/${file} substitute in command + args + cwd", () => {
  const inv = taskInvocation(
    mkTask({
      type: "process",
      command: "${workspaceFolder}/run.sh",
      args: ["${file}"],
      cwd: "${workspaceFolder}/sub",
    }),
    "/ws",
    { file: "/ws/a.py" },
  );
  assert.equal(inv?.cmd, "/ws/run.sh");
  assert.deepEqual(inv?.args, ["/ws/a.py"]);
  assert.equal(inv?.cwd, "/ws/sub");
});

test("taskInvocation: a composite task (no command) yields null (only its deps run)", () => {
  assert.equal(taskInvocation(mkTask({ command: "", dependsOn: ["a"] }), "/ws"), null);
});

test("expandTask: missing label returns an error string", () => {
  const r = expandTask([], "nope");
  assert.ok(typeof r === "string" && /not found/.test(r));
});

test("expandTask: dependsOn resolves depth-first with the task itself last", () => {
  const r = expandTask(
    [mkTask({ label: "a", dependsOn: ["b"] }), mkTask({ label: "b", command: "mkb" })],
    "a",
  );
  if (typeof r === "string") throw new Error(r);
  assert.deepEqual(
    r.map((t) => t.label),
    ["b", "a"],
  );
});

test("expandTask: a dependsOn cycle is caught (no infinite loop)", () => {
  const r = expandTask(
    [mkTask({ label: "a", dependsOn: ["b"] }), mkTask({ label: "b", dependsOn: ["a"] })],
    "a",
  );
  assert.ok(typeof r === "string" && /cycle/.test(r));
});

test("expandTask: ${defaultBuildTask} resolves via the default build task", () => {
  const r = expandTask(
    [
      mkTask({ label: "build", command: "make", group: "build", isDefault: true }),
      mkTask({ label: "other", command: "x", group: "build" }),
    ],
    "${defaultBuildTask}",
  );
  if (typeof r === "string") throw new Error(r);
  assert.deepEqual(
    r.map((t) => t.label),
    ["build"],
  );
});

test("planPreTasks: no preLaunchTask → [], a set one expands its chain", () => {
  const tasks = [mkTask({ label: "pre", command: "p" })];
  assert.deepEqual(planPreTasks(tasks, {}), []);
  const r = planPreTasks(tasks, { preLaunchTask: "pre" });
  if (typeof r === "string") throw new Error(r);
  assert.deepEqual(
    r.map((t) => t.label),
    ["pre"],
  );
});

const mkCfg = (name: string, over: Partial<RunConfig> = {}): RunConfig => ({
  name,
  type: "python",
  request: "launch",
  program: `${name}.py`,
  raw: {},
  ...over,
});

test("planTaskRun: unknown config name → error string", () => {
  assert.ok(typeof planTaskRun([], [], "ghost") === "string");
});

test("planTaskRun: serial by default; compound members carry their own pre-task chains; parallel from raw", () => {
  const tasks = [mkTask({ label: "pre", command: "p" })];
  const configs: RunConfig[] = [
    mkCfg("a", { preLaunchTask: "pre" }),
    mkCfg("b"),
    {
      name: "both",
      type: "compound",
      request: "launch",
      compound: ["a", "b"],
      raw: { parallel: true },
    },
  ];
  const plan = planTaskRun(tasks, configs, "both");
  if (typeof plan === "string") throw new Error(plan);
  assert.equal(plan.parallel, true);
  assert.deepEqual(
    plan.members.map((m) => m.config.name),
    ["a", "b"],
  );
  assert.deepEqual(
    plan.members[0]?.preTasks.map((t) => t.label),
    ["pre"],
  );
  assert.deepEqual(plan.members[1]?.preTasks, []);

  const serial = planTaskRun([], [mkCfg("a")], "a");
  if (typeof serial === "string") throw new Error(serial);
  assert.equal(serial.parallel, false);
});

test("planTaskRun: a member's missing pre-task aborts the whole plan", () => {
  const r = planTaskRun([], [mkCfg("a", { preLaunchTask: "ghost" })], "a");
  assert.ok(typeof r === "string" && /not found/.test(r));
});
