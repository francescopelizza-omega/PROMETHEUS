/**
 * schedule-view.test.ts — Settings ▸ Scheduled Tasks: pure mapping/formatting/validation helpers.
 *
 * This app has no `.test.tsx` component-render suite anywhere (see model-health-view.test.ts's
 * own header — the node:test runner's dev-resolver can't transform JSX), so
 * ScheduledTasksPage.tsx itself is exercised only by hand/e2e; what's unit-tested here is every
 * pure helper factored out of it, per this dir's own hooks-panel.test.ts / model-health-view.test.ts
 * precedent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_TASK_DRAFT,
  SCHEDULE_AUTONOMY_OPTIONS,
  type ScheduleTaskDraft,
  type ScheduledTaskView,
  autonomyPillStatus,
  buildTaskFromDraft,
  describeNextRun,
  taskToDraft,
  validateCronField,
  validateTaskDraft,
} from "./schedule-view.js";

/* ── validateCronField ────────────────────────────────────────────────────── */

test("validateCronField: a legal 5-field expression parses clean (undefined)", () => {
  assert.equal(validateCronField("0 9 * * *"), undefined);
  assert.equal(validateCronField("*/15 * * * *"), undefined);
});

test("validateCronField: a malformed expression returns core's own field-specific reason", () => {
  const err = validateCronField("70 * * * *");
  assert.ok(err, "expected an error message");
  assert.match(err ?? "", /minute/);
});

test("validateCronField: wrong field count is rejected, not silently accepted", () => {
  const err = validateCronField("* * *");
  assert.ok(err, "expected an error message");
  assert.match(err ?? "", /5 fields/);
});

/* ── EMPTY_TASK_DRAFT ─────────────────────────────────────────────────────── */

test("EMPTY_TASK_DRAFT: its cron expression is already valid — a fresh form shows no cron error", () => {
  assert.equal(validateCronField(EMPTY_TASK_DRAFT.cronExpr), undefined);
  assert.equal(EMPTY_TASK_DRAFT.autonomy, "readonly");
});

/* ── SCHEDULE_AUTONOMY_OPTIONS ────────────────────────────────────────────── */

test("SCHEDULE_AUTONOMY_OPTIONS: exactly the 3-tier ladder, safest first", () => {
  assert.deepEqual(
    SCHEDULE_AUTONOMY_OPTIONS.map((o) => o.value),
    ["readonly", "edits", "commands"],
  );
});

/* ── autonomyPillStatus ───────────────────────────────────────────────────── */

test("autonomyPillStatus: readonly/edits/commands map to ok/degraded/down (louder = more permissive)", () => {
  assert.equal(autonomyPillStatus("readonly"), "ok");
  assert.equal(autonomyPillStatus("edits"), "degraded");
  assert.equal(autonomyPillStatus("commands"), "down");
});

/* ── describeNextRun ──────────────────────────────────────────────────────── */

test("describeNextRun: buckets minutes/hours/days correctly", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z"); // a Tuesday
  // fires at :30 past every hour → next at 12:30, 30 minutes out.
  assert.equal(describeNextRun("30 * * * *", now), "in 30m");
  // fires at 15:00 daily → 3 hours out.
  assert.equal(describeNextRun("0 15 * * *", now), "in 3h");
  // fires at 00:00 on the 21st → 2 days, 12 hours out, rounds to 3d.
  assert.equal(describeNextRun("0 0 21 8 *", now), "in 3d");
});

test("describeNextRun: an invalid cron expression reads as 'invalid schedule', never a crash/NaN", () => {
  assert.equal(describeNextRun("not a cron", Date.now()), "invalid schedule");
  assert.equal(describeNextRun("70 * * * *", Date.now()), "invalid schedule");
});

test("describeNextRun: a match less than a minute out reads as 'in under a minute'", () => {
  const now = Date.parse("2026-08-18T11:59:30.500Z");
  assert.equal(describeNextRun("* * * * *", now), "in under a minute");
});

test("describeNextRun: a VALID but rare schedule with no match in the ~1yr scan window reads as 'no run within a year', not 'invalid schedule'", () => {
  // "0 0 29 2 *" (midnight on Feb 29th) is a perfectly legal, accepted cron expression — it is
  // simply rare enough that, called right after a leap day, the next occurrence is ~4 years
  // away and falls outside nextRunAfterResult's default ~1-year scan window. This must read
  // differently from a genuinely malformed expression: the schedule IS valid and will fire.
  const justAfterLeapDay = Date.parse("2028-03-01T00:00:00.000Z");
  assert.equal(describeNextRun("0 0 29 2 *", justAfterLeapDay), "no run within a year");
});

test("describeNextRun: memoized per (cronExpr, minute) — same minute reuses the cached text, a new minute recomputes", () => {
  const cron = "45 6 * * *"; // a cron string unique to this test, to avoid cross-test cache hits
  const withinSameMinute = Date.parse("2026-08-18T09:00:00.100Z");
  const stillSameMinute = Date.parse("2026-08-18T09:00:59.900Z");
  const nextMinute = Date.parse("2026-08-18T09:01:00.000Z");

  const first = describeNextRun(cron, withinSameMinute);
  const second = describeNextRun(cron, stillSameMinute);
  assert.equal(second, first, "two calls in the same minute bucket must agree");

  const third = describeNextRun(cron, nextMinute);
  assert.equal(
    third,
    first,
    "the underlying answer is unchanged a minute later — still correct, not stale",
  );
});

/* ── validateTaskDraft ────────────────────────────────────────────────────── */

test("validateTaskDraft: the empty draft is rejected for name + task, but NOT cron (its default is valid)", () => {
  const errors = validateTaskDraft(EMPTY_TASK_DRAFT);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /Name is required/.test(e)));
  assert.ok(errors.some((e) => /Task prompt is required/.test(e)));
  assert.ok(!errors.some((e) => /Cron expression/.test(e)));
});

test("validateTaskDraft: an invalid cron expression is reported with core's own reason inline", () => {
  const draft: ScheduleTaskDraft = {
    name: "nightly",
    cronExpr: "70 * * * *",
    task: "summarize today's commits",
    cwd: "",
    autonomy: "readonly",
  };
  const errors = validateTaskDraft(draft);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /^Cron expression:/);
  assert.match(errors[0] ?? "", /minute/);
});

test("validateTaskDraft: a fully valid draft has no errors", () => {
  const draft: ScheduleTaskDraft = {
    name: "nightly summary",
    cronExpr: "0 2 * * *",
    task: "summarize today's commits",
    cwd: "",
    autonomy: "edits",
  };
  assert.deepEqual(validateTaskDraft(draft), []);
});

/* ── buildTaskFromDraft / taskToDraft ─────────────────────────────────────── */

test("buildTaskFromDraft: a brand-new task trims fields, drops an empty cwd, mints an id, and starts enabled", () => {
  const draft: ScheduleTaskDraft = {
    name: "  nightly  ",
    cronExpr: " 0 2 * * * ",
    task: "  summarize today's commits  ",
    cwd: "   ",
    autonomy: "readonly",
  };
  const task = buildTaskFromDraft(draft);
  assert.equal(task.name, "nightly");
  assert.equal(task.cronExpr, "0 2 * * *");
  assert.equal(task.task, "summarize today's commits");
  assert.equal(task.cwd, undefined);
  assert.equal(task.enabled, true);
  assert.ok(task.id.length > 0);
  assert.equal(task.lastRunIso, undefined);
  assert.equal(task.lastResult, undefined);
  assert.ok(!Number.isNaN(Date.parse(task.createdIso)));
});

test("buildTaskFromDraft: keeps a non-blank cwd, trimmed", () => {
  const draft: ScheduleTaskDraft = {
    name: "n",
    cronExpr: "0 2 * * *",
    task: "t",
    cwd: "  /repo  ",
    autonomy: "readonly",
  };
  assert.equal(buildTaskFromDraft(draft).cwd, "/repo");
});

test("buildTaskFromDraft: two new tasks never collide on id", () => {
  const draft: ScheduleTaskDraft = {
    name: "n",
    cronExpr: "0 2 * * *",
    task: "t",
    cwd: "",
    autonomy: "readonly",
  };
  const a = buildTaskFromDraft(draft);
  const b = buildTaskFromDraft(draft);
  assert.notEqual(a.id, b.id);
});

test("buildTaskFromDraft: editing an existing task keeps its id/enabled/createdIso/lastRunIso/lastResult, but takes every other field from the draft", () => {
  const existing: ScheduledTaskView = {
    id: "t1",
    name: "old name",
    cronExpr: "0 2 * * *",
    task: "old task",
    autonomy: "readonly",
    enabled: false,
    createdIso: "2026-01-01T00:00:00.000Z",
    lastRunIso: "2026-08-18T02:00:00.000Z",
    lastResult: {
      ok: true,
      summary: "did the thing",
      ranIso: "2026-08-18T02:00:05.000Z",
      toolCalls: ["read_file"],
    },
  };
  const draft: ScheduleTaskDraft = {
    name: "new name",
    cronExpr: "0 9 * * *",
    task: "new task",
    cwd: "",
    autonomy: "commands",
  };
  const next = buildTaskFromDraft(draft, existing);
  assert.equal(next.id, "t1");
  assert.equal(next.name, "new name");
  assert.equal(next.cronExpr, "0 9 * * *");
  assert.equal(next.task, "new task");
  assert.equal(next.autonomy, "commands");
  // an edit never silently flips enabled/history — those aren't fields on the form at all.
  assert.equal(next.enabled, false);
  assert.equal(next.createdIso, "2026-01-01T00:00:00.000Z");
  assert.equal(next.lastRunIso, "2026-08-18T02:00:00.000Z");
  assert.deepEqual(next.lastResult, existing.lastResult);
});

test("taskToDraft / buildTaskFromDraft round-trip a task's editable fields", () => {
  const task: ScheduledTaskView = {
    id: "t1",
    name: "nightly",
    cronExpr: "0 2 * * *",
    task: "summarize today's commits",
    cwd: "/repo",
    autonomy: "edits",
    enabled: true,
    createdIso: "2026-01-01T00:00:00.000Z",
  };
  const draft = taskToDraft(task);
  assert.deepEqual(draft, {
    name: "nightly",
    cronExpr: "0 2 * * *",
    task: "summarize today's commits",
    cwd: "/repo",
    autonomy: "edits",
  });
  assert.deepEqual(buildTaskFromDraft(draft, task), task);
});

test("taskToDraft: an absent cwd becomes an empty-string draft field", () => {
  const task: ScheduledTaskView = {
    id: "t1",
    name: "n",
    cronExpr: "0 2 * * *",
    task: "t",
    autonomy: "readonly",
    enabled: true,
    createdIso: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(taskToDraft(task).cwd, "");
});
