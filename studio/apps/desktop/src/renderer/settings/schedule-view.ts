/**
 * schedule-view.ts — pure Settings ▸ Scheduled Tasks helpers.
 *
 * Split out of ScheduledTasksPage.tsx for the same reason model-health-view.ts is split out of
 * ModelHealthPage.tsx (mirrors this dir's own hooks-panel.ts / HooksPage.tsx split): the
 * run-tests.mjs node:test runner loads suites straight from TS source via Node's native
 * type-stripping loader (apps/cli/dev-resolver.mjs), which erases TYPE annotations but does NOT
 * transform JSX — a `.tsx` file can't be `import`ed by a test at all. So every pure
 * mapping/formatting/validation helper this page needs tested lives here instead, in a plain
 * `.ts` sibling, exactly like every other Settings sub-page's pure logic does.
 *
 * Cron parsing/validation/next-run math is NOT reimplemented here — `@prometheus/core`'s
 * `agent` module (packages/core/src/agent/schedule.ts) is the single source of truth for what
 * counts as a legal cron expression and when it next fires; every function below either wraps
 * or formats ITS answer, never recomputes one of its own.
 *
 * Renderer-SANDBOXED (C5): react-free. Imports the `agent` namespace as a VALUE from bare
 * "@prometheus/core" (no dedicated "agent-schedule" pure subpath exists yet — confirmed against
 * packages/core/package.json's `exports` map) — this mirrors ModelHealthPage.tsx's own already-
 * accepted precedent of importing value-level `@prometheus/core` functions directly in
 * renderer-sandboxed code (describeBreaker/describeContextWindow/describeTransport), rather than
 * hooks-panel.ts's narrower `@prometheus/core/agent-hooks` subpath, which exists specifically
 * because one was already cut for hooks.
 *
 * PURE — no DOM, no IPC, no React.
 */
import * as agent from "@prometheus/core/agent-schedule";
import type { HealthViewStatus } from "@prometheus/ui";

import type { ScheduledTaskView } from "../shared/schedule/useSchedules.js";

export type { ScheduledTaskView };

/* ------------------------------------------------------------------------------------------ */
/* the Add/Edit form's draft                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * The Add/Edit form's field values — always strings (raw control state) except `autonomy` (a
 * fixed 3-way select) — unlike `ScheduledTaskView`, which additionally carries the id/enabled/
 * createdIso/last-run bookkeeping this form never edits directly (see `buildTaskFromDraft`).
 */
export interface ScheduleTaskDraft {
  name: string;
  cronExpr: string;
  task: string;
  cwd: string;
  autonomy: agent.ScheduleAutonomy;
}

/**
 * A blank draft for the "Add task" form. `cronExpr` defaults to an already-VALID expression
 * (top of every hour) rather than an empty string, so a brand-new form doesn't open already
 * showing a cron validation error before the user has typed anything.
 */
export const EMPTY_TASK_DRAFT: ScheduleTaskDraft = {
  name: "",
  cronExpr: "0 * * * *",
  task: "",
  cwd: "",
  autonomy: "readonly",
};

/**
 * The autonomy `<select>`'s options, safest first — mirrors the ladder's own doc comment in
 * schedule.ts (readonly ⇒ no flags, edits ⇒ allow-writes, commands ⇒ allow-commands) and the
 * one-shot headless path (session/one-shot.ts's `headlessAuthLevel`) it maps onto.
 */
export const SCHEDULE_AUTONOMY_OPTIONS: ReadonlyArray<{
  value: agent.ScheduleAutonomy;
  label: string;
  hint: string;
}> = [
  {
    value: "readonly",
    label: "Read-only",
    hint: "Can look, but cannot change anything — the default for every new task.",
  },
  {
    value: "edits",
    label: "Edits",
    hint: "May also write and edit files.",
  },
  {
    value: "commands",
    label: "Commands",
    hint: "May also run shell commands — the most permissive tier.",
  },
];

/* ------------------------------------------------------------------------------------------ */
/* cron: validate / describe next run                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * Whether `expr` is a legal 5-field cron expression — the error message, or undefined when it
 * parses cleanly. A thin wrap of core's own `validateCronExpr`; do not re-implement cron
 * parsing here (see this file's own header).
 */
export function validateCronField(expr: string): string | undefined {
  return agent.validateCronExpr(expr);
}

/**
 * Memoized per (cronExpr, minute-bucket): `nextRunAfterResult` scans up to ~a year of minutes
 * on a `null`-producing call, and `ScheduledTasksPage` polls every 5s — without this, every
 * visible row whose cron has no match in-window (or any row at all, before the fix, since the
 * page re-renders + resorts on every poll tick) paid that full scan again every 5 seconds. The
 * result only changes once a minute at most (the matcher's own granularity), so a cache keyed on
 * the current minute is exact, never stale within its own bucket. Capped so an unbounded stream
 * of distinct cron strings (unlikely — these are the user's own saved tasks) can't grow forever.
 */
const nextRunCache = new Map<string, { minuteBucket: number; text: string }>();
const NEXT_RUN_CACHE_MAX = 200;

/**
 * A short "next run" caption for a cron expression, given the current time: "in 3h", "in 2d",
 * "in under a minute", "invalid schedule" for one that doesn't parse, or "no run within a year"
 * for one that parses fine but has no match in the scan window (e.g. a genuine leap-day-only
 * schedule) — these are different situations and must not share the same caption: the first is
 * a schedule the user typed wrong, the second is valid and will eventually fire. Wraps core's own
 * `nextRunAfterResult` — never recomputes cron matching itself.
 */
export function describeNextRun(cronExpr: string, nowMs: number): string {
  const minuteBucket = Math.floor(nowMs / 60_000);
  const cached = nextRunCache.get(cronExpr);
  if (cached && cached.minuteBucket === minuteBucket) return cached.text;

  const result = agent.nextRunAfterResult(cronExpr, nowMs);
  const text = ((): string => {
    if (result.kind === "invalid-expression") return "invalid schedule";
    if (result.kind === "no-match-in-window") return "no run within a year";
    const minutes = Math.round(Math.max(0, result.ms - nowMs) / 60_000);
    if (minutes < 1) return "in under a minute";
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `in ${hours}h`;
    const days = Math.round(hours / 24);
    return `in ${days}d`;
  })();

  if (nextRunCache.size >= NEXT_RUN_CACHE_MAX && !nextRunCache.has(cronExpr)) {
    const oldestKey = nextRunCache.keys().next().value;
    if (oldestKey !== undefined) nextRunCache.delete(oldestKey);
  }
  nextRunCache.set(cronExpr, { minuteBucket, text });
  return text;
}

/* ------------------------------------------------------------------------------------------ */
/* autonomy: the pill's warning coloring                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * The autonomy `StatusPill`'s status. This reuses the same 3-tier ok/degraded/down visual
 * language Settings already uses for HEALTH, but here it is a WARNING signal, not a health one:
 * a user should feel a LOUDER visual signal the more autonomy a schedule has been given —
 * readonly (safest) reads "ok", edits reads "degraded", commands (most permissive) reads "down".
 */
export function autonomyPillStatus(autonomy: agent.ScheduleAutonomy): HealthViewStatus {
  return autonomy === "readonly" ? "ok" : autonomy === "edits" ? "degraded" : "down";
}

/* ------------------------------------------------------------------------------------------ */
/* validate + build a task from a draft (mirrors hooks-panel.ts's validateHookDraft /            */
/* draftToHookSpec pair, and its own proactive-validation rationale)                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * Human-readable reasons a draft would be rejected — proactive validation so Save can be
 * disabled with a NAMED reason, rather than either silently failing once submitted or (worse)
 * silently accepting an unschedulable cron string. Mirrors `validateHookDraft`'s own contract.
 */
export function validateTaskDraft(draft: ScheduleTaskDraft): string[] {
  const errors: string[] = [];
  if (draft.name.trim().length === 0) {
    errors.push("Name is required.");
  }
  const cronError = validateCronField(draft.cronExpr);
  if (cronError) {
    errors.push(`Cron expression: ${cronError}`);
  }
  if (draft.task.trim().length === 0) {
    errors.push("Task prompt is required.");
  }
  return errors;
}

/** A best-effort unique task id (crypto.randomUUID with a fallback) — mirrors this app's own
 *  changelist-store.ts / query/hooks.ts convention for minting a fresh entity id client-side. */
function newTaskId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? `sched_${c.randomUUID()}` : `sched_${Date.now().toString(36)}`;
}

/**
 * Build the `ScheduledTaskView` a draft would persist as: trims every text field, and drops an
 * empty `cwd` (undefined, not `""` — "wherever the runner itself runs", per that field's own
 * doc comment in schedule.ts). `existing` carries over everything the form never edits
 * directly — id, enabled, createdIso, lastRunIso, lastResult — when editing a task in place; a
 * brand-new task (no `existing`) mints a fresh id/createdIso and starts enabled.
 */
export function buildTaskFromDraft(
  draft: ScheduleTaskDraft,
  existing?: ScheduledTaskView,
): ScheduledTaskView {
  const cwd = draft.cwd.trim();
  return {
    id: existing?.id ?? newTaskId(),
    name: draft.name.trim(),
    cronExpr: draft.cronExpr.trim(),
    task: draft.task.trim(),
    ...(cwd ? { cwd } : {}),
    autonomy: draft.autonomy,
    enabled: existing?.enabled ?? true,
    createdIso: existing?.createdIso ?? new Date().toISOString(),
    ...(existing?.lastRunIso ? { lastRunIso: existing.lastRunIso } : {}),
    ...(existing?.lastResult ? { lastResult: existing.lastResult } : {}),
  };
}

/** Load an existing task into editable draft form — the inverse of `buildTaskFromDraft`'s
 *  persisted-only fields. */
export function taskToDraft(task: ScheduledTaskView): ScheduleTaskDraft {
  return {
    name: task.name,
    cronExpr: task.cronExpr,
    task: task.task,
    cwd: task.cwd ?? "",
    autonomy: task.autonomy,
  };
}
