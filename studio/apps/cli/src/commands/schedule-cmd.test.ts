/**
 * commands/schedule-cmd.test.ts — `prometheus tasks …` over a REAL temp `--home` directory
 * (never the real `~/.prometheus`, per this feature's own safety lesson: a store/persistence
 * function is never called here with its default path omitted).
 *
 * `run-due` is mostly exercised through the directly-exported `handleRunDue`, with an INJECTED
 * fake `runDue` — not through `runScheduleCommand(["run-due"], …)`, which would reach the real
 * `session/schedule-runner.ts` and, through it, a real headless agent turn. The one exception is
 * the JSON-purity regression test below, which calls the real dispatcher against a deliberately
 * EMPTY store — nothing is ever due, so `runOneShot` is never reached and no model is spawned.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { agent } from "@prometheus/core";

import { loadSchedules } from "../session/schedule-store.js";
import {
  type RunDueDeps,
  handleAdd,
  handleDisable,
  handleEnable,
  handleInstallCron,
  handleList,
  handleRemove,
  handleRunDue,
  runScheduleCommand,
} from "./schedule-cmd.js";

/** A temp `home` per test, always cleaned up — never the real `prometheusHome()`. */
function tempHome(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `prom-schedule-cmd-${prefix}-`));
}

/** Captures every `write()` call, in order, for assertions on the printed text. */
function capture(): { write: (line: string) => void; lines: string[]; text: () => string } {
  const lines: string[] = [];
  return { write: (l) => lines.push(l), lines, text: () => lines.join("\n") };
}

function scheduledTask(overrides: Partial<agent.ScheduledTask> = {}): agent.ScheduledTask {
  return {
    id: "sched-fixture",
    name: "Fixture task",
    cronExpr: "0 6 * * *",
    task: "do the thing",
    autonomy: "readonly",
    enabled: true,
    createdIso: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

/* ── add ──────────────────────────────────────────────────────────────────── */

test("add: an invalid cron expression is refused (exit 2) and persists nothing", async () => {
  const home = tempHome("add-invalid-cron");
  try {
    const out = capture();
    const res = await runScheduleCommand(
      ["add", "--name", "nightly", "--cron", "70 * * * *", "--task", "summarize commits"],
      { home, json: false, write: out.write },
    );
    assert.equal(res.exitCode, 2);
    assert.ok(
      out.text().toLowerCase().includes("cron"),
      `expected the error to name the cron problem, got:\n${out.text()}`,
    );
    assert.deepEqual(loadSchedules(home), {}, "an invalid add must not write anything to disk");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("add: missing --name / --cron / --task are each refused (exit 2), nothing persisted", async () => {
  const home = tempHome("add-missing-flags");
  try {
    const missingName = handleAdd(["--cron", "0 6 * * *", "--task", "t"], home);
    assert.equal(missingName.exitCode, 2);
    const missingCron = handleAdd(["--name", "n", "--task", "t"], home);
    assert.equal(missingCron.exitCode, 2);
    const missingTask = handleAdd(["--name", "n", "--cron", "0 6 * * *"], home);
    assert.equal(missingTask.exitCode, 2);
    assert.deepEqual(loadSchedules(home), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("add: an invalid --autonomy value is refused (exit 2), nothing persisted", async () => {
  const home = tempHome("add-invalid-autonomy");
  try {
    const res = handleAdd(
      ["--name", "n", "--cron", "0 6 * * *", "--task", "t", "--autonomy", "godmode"],
      home,
    );
    assert.equal(res.exitCode, 2);
    assert.deepEqual(loadSchedules(home), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("add: a valid cron persists the task, and a follow-up list shows the readonly default when --autonomy is omitted", async () => {
  const home = tempHome("add-valid-default-autonomy");
  try {
    const addOut = capture();
    const addRes = await runScheduleCommand(
      ["add", "--name", "nightly", "--cron", "0 6 * * *", "--task", "summarize commits"],
      { home, json: true, write: addOut.write },
    );
    assert.equal(addRes.exitCode, 0);
    const addPayload = JSON.parse(addOut.lines[0] as string) as {
      ok: boolean;
      task: agent.ScheduledTask;
    };
    assert.equal(addPayload.ok, true);
    assert.equal(addPayload.task.autonomy, "readonly");
    assert.equal(addPayload.task.enabled, true);

    const listOut = capture();
    const listRes = await runScheduleCommand(["list"], { home, json: true, write: listOut.write });
    assert.equal(listRes.exitCode, 0);
    const listPayload = JSON.parse(listOut.lines[0] as string) as {
      ok: boolean;
      tasks: agent.ScheduledTask[];
    };
    assert.equal(listPayload.tasks.length, 1);
    assert.equal(listPayload.tasks[0]?.name, "nightly");
    assert.equal(listPayload.tasks[0]?.autonomy, "readonly");
    assert.equal(listPayload.tasks[0]?.id, addPayload.task.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("add: an explicit --autonomy is honored and persisted", async () => {
  const home = tempHome("add-explicit-autonomy");
  try {
    const res = handleAdd(
      [
        "--name",
        "n",
        "--cron",
        "*/30 * * * *",
        "--task",
        "t",
        "--autonomy",
        "edits",
        "--cwd",
        "/repo",
      ],
      home,
    );
    assert.equal(res.exitCode, 0);
    const store = loadSchedules(home);
    const tasks = Object.values(store);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.autonomy, "edits");
    assert.equal(tasks[0]?.cwd, "/repo");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── list ─────────────────────────────────────────────────────────────────── */

test("list: an empty store prints 'no scheduled tasks yet' rather than a bare header", () => {
  const home = tempHome("list-empty");
  try {
    const res = handleList(home);
    assert.equal(res.exitCode, 0);
    assert.deepEqual(res.json, { ok: true, tasks: [] });
    assert.ok(
      res.lines.some((l) => l.includes("no scheduled tasks yet")),
      `expected the empty-store message, got:\n${res.lines.join("\n")}`,
    );
    assert.equal(res.lines.length, 1, "an empty store should not print a header + table");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── remove ───────────────────────────────────────────────────────────────── */

test("remove: a real id is removed; an unknown id is refused (exit 2) rather than silently succeeding", async () => {
  const home = tempHome("remove");
  try {
    const added = handleAdd(["--name", "n", "--cron", "0 6 * * *", "--task", "t"], home);
    const id = (added.json.task as agent.ScheduledTask).id;

    const badRemove = handleRemove(["does-not-exist"], home);
    assert.equal(badRemove.exitCode, 2);
    assert.deepEqual(loadSchedules(home), { [id]: added.json.task as agent.ScheduledTask });

    const goodRemove = handleRemove([id], home);
    assert.equal(goodRemove.exitCode, 0);
    assert.deepEqual(loadSchedules(home), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── enable / disable ────────────────────────────────────────────────────── */

test("enable/disable: each flips the persisted `enabled` flag; an unknown id is refused (exit 2)", () => {
  const home = tempHome("enable-disable");
  try {
    const added = handleAdd(["--name", "n", "--cron", "0 6 * * *", "--task", "t"], home);
    const id = (added.json.task as agent.ScheduledTask).id;
    assert.equal(loadSchedules(home)[id]?.enabled, true);

    const disableRes = handleDisable([id], home);
    assert.equal(disableRes.exitCode, 0);
    assert.equal(loadSchedules(home)[id]?.enabled, false);

    const enableRes = handleEnable([id], home);
    assert.equal(enableRes.exitCode, 0);
    assert.equal(loadSchedules(home)[id]?.enabled, true);

    const badEnable = handleEnable(["nope"], home);
    assert.equal(badEnable.exitCode, 2);
    const badDisable = handleDisable(["nope"], home);
    assert.equal(badDisable.exitCode, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── run-due (fake runner only — never the real schedule-runner.ts) ─────────── */

test("run-due: delegates to an injected fake runner and renders its ran/skipped summary", async () => {
  const home = tempHome("run-due");
  try {
    const out = capture();
    let calledWithHome: string | undefined;
    const deps: RunDueDeps = {
      runDue: async (h, runnerDeps) => {
        calledWithHome = h;
        runnerDeps.write?.('▶ running scheduled task "fixture"');
        return {
          ran: [
            scheduledTask({
              id: "sched-a",
              name: "fixture",
              lastResult: {
                ok: true,
                summary: "did the thing",
                ranIso: "2026-08-18T06:00:00.000Z",
                toolCalls: [],
              },
            }),
          ],
          skipped: 2,
        };
      },
    };
    const res = await handleRunDue(home, out.write, deps);
    assert.equal(res.exitCode, 0);
    assert.equal(calledWithHome, home);
    assert.equal(res.json.ranCount, 1);
    assert.equal(res.json.skipped, 2);
    assert.ok(
      res.lines.some((l) => l.includes("1 ran, 2 skipped")),
      `expected a ran/skipped summary, got:\n${res.lines.join("\n")}`,
    );
    assert.ok(res.lines.some((l) => l.includes("fixture")));
    // the fake's own progress write() went straight to the caller's write, in real time.
    assert.ok(out.lines.some((l) => l.includes("running scheduled task")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("run-due: a failed task is rendered distinctly from a ran/ok task", async () => {
  const home = tempHome("run-due-fail");
  try {
    const deps: RunDueDeps = {
      runDue: async () => ({
        ran: [
          scheduledTask({
            id: "sched-fail",
            name: "broken task",
            lastResult: {
              ok: false,
              summary: "boom",
              ranIso: "2026-08-18T06:00:00.000Z",
              toolCalls: [],
            },
          }),
        ],
        skipped: 0,
      }),
    };
    const out = capture();
    const res = await handleRunDue(home, out.write, deps);
    assert.equal(res.exitCode, 0);
    assert.ok(res.lines.some((l) => l.includes("broken task") && l.includes("boom")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("run-due (--json) via the real dispatcher: an empty store never touches runOneShot and stdout stays ONE clean object", async () => {
  // Unlike the tests above, this DOES go through runScheduleCommand(["run-due"], …) — the real
  // session/schedule-runner.ts — but with an EMPTY store it can never reach runOneShot (nothing
  // is due), so no model turn happens. This is the regression test for a real bug: run-due used
  // to forward the live progress `write` straight through even under --json, which would leak
  // non-JSON lines onto the same sink the final JSON object is written to (CLI-084/CLI-085 —
  // stdout must stay ONE clean object under --json).
  const home = tempHome("run-due-json-purity");
  try {
    const out = capture();
    const res = await runScheduleCommand(["run-due"], { home, json: true, write: out.write });
    assert.equal(res.exitCode, 0);
    assert.equal(
      out.lines.length,
      1,
      `expected exactly one write() call, got:\n${out.lines.join("\n")}`,
    );
    assert.deepEqual(JSON.parse(out.lines[0] as string), {
      ok: true,
      ranCount: 0,
      skipped: 0,
      ran: [],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── install-cron ─────────────────────────────────────────────────────────── */

test("install-cron: prints the crontab line + explanation and never touches the filesystem", async () => {
  const home = tempHome("install-cron");
  try {
    const out = capture();
    const res = await runScheduleCommand(["install-cron"], { home, json: false, write: out.write });
    assert.equal(res.exitCode, 0);
    assert.ok(out.text().includes("run-due"), `expected "run-due" in the output:\n${out.text()}`);
    assert.ok(out.text().includes("crontab"), `expected "crontab" in the output:\n${out.text()}`);
    // no store file (nor even the state/ dir) was created as a side effect.
    assert.equal(existsSync(join(home, "state", "schedules.json")), false);
    assert.equal(existsSync(join(home, "state")), false);
    assert.deepEqual(loadSchedules(home), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install-cron (--json) reports ok + a cronLine containing 'tasks run-due'", () => {
  const res = handleInstallCron();
  assert.equal(res.exitCode, 0);
  const cronLine = res.json.cronLine as string;
  assert.ok(cronLine.includes("tasks run-due"), cronLine);
});

/* ── unknown / missing subcommand ────────────────────────────────────────── */

test("an unknown or missing subcommand prints usage and exits 2", async () => {
  const home = tempHome("usage");
  try {
    const out1 = capture();
    const res1 = await runScheduleCommand([], { home, json: false, write: out1.write });
    assert.equal(res1.exitCode, 2);
    assert.ok(out1.text().includes("usage:"));

    const out2 = capture();
    const res2 = await runScheduleCommand(["bogus"], { home, json: false, write: out2.write });
    assert.equal(res2.exitCode, 2);
    assert.ok(out2.text().includes("usage:"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install-cron names the node executable — cron's PATH does not have it", () => {
  // regression: the line was just the script path and relied on the shebang finding `node` on
  // PATH. cron runs with a minimal PATH (/usr/bin:/bin), where a Homebrew/nvm/volta node is not
  // present, so EVERY scheduled run died. Measured:
  //   env -i PATH=/usr/bin:/bin <script> tasks run-due  → rc 127, "env: node: No such file"
  // after the fix the same invocation exits 0. That is the one failure an unattended scheduler
  // cannot report to anyone, which is why the line has to be self-sufficient.
  const cronLine = handleInstallCron().json.cronLine as string;
  const argv1 = process.argv[1] ?? "";
  if (/\.[cm]?js$/.test(argv1) && argv1 !== process.execPath) {
    assert.ok(
      cronLine.includes(process.execPath),
      `the cron line must spell out the interpreter: ${cronLine}`,
    );
    assert.ok(cronLine.includes(argv1), cronLine);
    // and the interpreter comes FIRST — `<node> <script> tasks run-due`.
    assert.ok(
      cronLine.indexOf(process.execPath) < cronLine.indexOf(argv1),
      `interpreter must precede the script: ${cronLine}`,
    );
  }
  // whatever the packaging, the line still schedules the right verb on a valid 5-field spec.
  assert.ok(cronLine.includes("tasks run-due"), cronLine);
  assert.match(cronLine, /^\S+ \S+ \S+ \S+ \S+ /, `not a 5-field cron spec: ${cronLine}`);
});
