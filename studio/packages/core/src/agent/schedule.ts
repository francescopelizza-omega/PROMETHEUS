// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/schedule.ts — scheduled/autonomous agent runs: "run this task on this cron schedule,
 * unattended, at a bounded autonomy level."
 *
 * PURE: a standard 5-field cron matcher (minute hour day-of-month month day-of-week), the
 * "is this task due right now" decision, and the persisted `ScheduledTask` shape both the CLI
 * store and the desktop's mirror it. The actual EXECUTION (running a real headless turn,
 * writing the result back) is necessarily host-specific — see `session/schedule-store.ts` and
 * `session/schedule-runner.ts` on the CLI side — and lives outside this module on purpose.
 *
 * WHY BOUNDED AUTONOMY IS PART OF THE TYPE, NOT AN AFTERTHOUGHT: an unattended run has no
 * human at the keyboard to approve a destructive tool, which is exactly the scenario the
 * existing headless one-shot path (`session/one-shot.ts`) was already built around — default
 * READ-ONLY, with `edits`/`commands` as explicit, named escalations. A scheduled task reuses
 * that exact ladder rather than inventing a second one, because a nightly cron job that can
 * silently escalate itself is a worse product than one that cannot act at all without being
 * told to.
 */

/** How much autonomy an unattended run of this task is granted — mirrors the CLI's one-shot
 *  ladder (`session/one-shot.ts`'s `headlessAuthLevel`) exactly, by name rather than number, so
 *  a schedule entry reads as a decision ("this job may write files") rather than a magic level. */
export type ScheduleAutonomy = "readonly" | "edits" | "commands";

/** One user-defined scheduled task. */
export interface ScheduledTask {
  id: string;
  /** short human label, shown in `prometheus schedule list` and the desktop panel. */
  name: string;
  /** standard 5-field cron expression: "minute hour day-of-month month day-of-week". */
  cronExpr: string;
  /** the prompt/goal handed to the agent, verbatim — same contract as `prometheus -p`. */
  task: string;
  /** the working directory the run executes in; undefined ⇒ wherever `run-due` itself runs. */
  cwd?: string;
  autonomy: ScheduleAutonomy;
  /** a disabled task is kept (so re-enabling doesn't lose its history) but never fires. */
  enabled: boolean;
  createdIso: string;
  /** ISO timestamp of the most recent run this task actually started (due-or-not is irrelevant
   *  once it starts — this is set the moment execution begins, not when it finishes). */
  lastRunIso?: string;
  lastResult?: ScheduleRunResult;
}

export interface ScheduleRunResult {
  ok: boolean;
  /** a short, human summary — the reply's first ~200 chars, or the error. */
  summary: string;
  ranIso: string;
  /** tool names the run actually called, in order — same honesty contract as one-shot's. */
  toolCalls: string[];
}

export type ScheduleStore = Record<string, ScheduledTask>;

/** Merge one task into a store, keyed by id — mirrors `ai/model-health.ts`'s `mergeHealthRecord`. */
export function mergeTask(store: ScheduleStore, task: ScheduledTask): ScheduleStore {
  return { ...store, [task.id]: task };
}

/** Remove one task by id. A no-op (not an error) when the id is already gone. */
export function removeTask(store: ScheduleStore, id: string): ScheduleStore {
  if (!(id in store)) return store;
  const next = { ...store };
  delete next[id];
  return next;
}

/* ── the cron matcher ─────────────────────────────────────────────────────── */

/** One parsed cron field: the set of values it matches, or "every value" (a bare `*`). */
type CronField = { kind: "any" } | { kind: "set"; values: ReadonlySet<number> };

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

/** Parse one cron FIELD ("*", "5", "1-5", "*\/15", "1-10/2", "1,15,30", or a comma-mix of
 *  those) into the set of values it matches within `[min,max]`. Throws a short, actionable
 *  message on anything malformed — never silently accepts garbage as "matches nothing" or
 *  "matches everything", both of which would run a job at the wrong time with no warning. */
function parseField(raw: string, min: number, max: number, label: string): CronField {
  const trimmed = raw.trim();
  if (trimmed === "*") return { kind: "any" };
  const values = new Set<number>();
  for (const part of trimmed.split(",")) {
    const seg = part.trim();
    if (seg === "") throw new Error(`${label}: empty value in "${raw}"`);
    const stepMatch = /^(\*|\d+-\d+|\d+)\/(\d+)$/.exec(seg);
    const [rangePart, stepPart] = stepMatch
      ? [stepMatch[1] as string, stepMatch[2] as string]
      : [seg, undefined];
    const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`${label}: step must be a positive integer in "${seg}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      // `split(sep, limit)` truncates the RESULT to `limit` entries rather than stopping at the
      // limit-th separator — `"9-17-8".split("-", 2)` silently yields `["9","17"]`, dropping the
      // "-8" instead of failing to match a clean two-part shape. Splitting with NO limit first
      // and checking the count catches a malformed 3+-part range instead of truncating it.
      const rangeParts = rangePart.split("-");
      if (rangeParts.length !== 2) {
        throw new Error(`${label}: not a valid range in "${seg}"`);
      }
      const [a, b] = rangeParts;
      lo = Number.parseInt(a as string, 10);
      hi = Number.parseInt(b as string, 10);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        throw new Error(`${label}: not a valid range in "${seg}"`);
      }
      if (lo > hi) throw new Error(`${label}: range start after end in "${seg}"`);
    } else {
      lo = Number.parseInt(rangePart, 10);
      hi = lo;
      if (!Number.isFinite(lo)) throw new Error(`${label}: "${seg}" is not a number`);
    }
    if (lo < min || hi > max) {
      throw new Error(`${label}: "${seg}" is out of range ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { kind: "set", values };
}

/**
 * Parse a standard 5-field cron expression. Throws with a field-specific reason on anything
 * malformed (wrong field count, an out-of-range value, a non-numeric token) — a scheduled task
 * whose cron string typo'd `70` for the minute must be REFUSED at creation time, not silently
 * treated as "never due" or "always due".
 */
export function parseCronExpr(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `a cron expression needs exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}: "${expr}"`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minute: parseField(minute, 0, 59, "minute"),
    hour: parseField(hour, 0, 23, "hour"),
    dayOfMonth: parseField(dayOfMonth, 1, 31, "day-of-month"),
    month: parseField(month, 1, 12, "month"),
    // 0 and 7 both mean Sunday in POSIX cron — normalized here (not at match time, where
    // `Date.getUTCDay()` can never actually produce a 7 to normalize against) so a literal "7"
    // in the field, alone or as part of a range/step like "5-7", is folded into the same 0 a
    // real Sunday reports as.
    dayOfWeek: normalizeSundaySeven(parseField(dayOfWeek, 0, 7, "day-of-week")),
  };
}

/** Fold a literal 7 (POSIX's alternate "Sunday") into 0, so day-of-week matching only ever has
 *  to compare against `Date.getUTCDay()`'s own 0–6 range. */
function normalizeSundaySeven(field: CronField): CronField {
  if (field.kind === "any" || !field.values.has(7)) return field;
  const values = new Set(field.values);
  values.delete(7);
  values.add(0);
  return { kind: "set", values };
}

/** Validate a cron expression without needing to use the result — for a UI/CLI that just
 *  wants to know "is this typeable string legal" before accepting it. Returns the error
 *  message, or undefined when it parses cleanly. */
export function validateCronExpr(expr: string): string | undefined {
  try {
    parseCronExpr(expr);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.kind === "any" || field.values.has(value);
}

/**
 * Whether `parsed` matches the given UTC-based wall-clock instant, to MINUTE granularity.
 *
 * POSIX cron's documented (if surprising) rule: when BOTH day-of-month and day-of-week are
 * restricted (neither is a bare `*`), the two are OR'd, not AND'd — "the 1st of the month OR
 * every Monday" is what `1 * * * 1` means, not "only when the 1st is a Monday". Getting this
 * backwards silently makes a schedule fire far less often than the user wrote, which is a much
 * quieter failure than firing too often.
 */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const mon = date.getUTCMonth() + 1;
  const dow = date.getUTCDay();
  if (!fieldMatches(parsed.minute, minute)) return false;
  if (!fieldMatches(parsed.hour, hour)) return false;
  if (!fieldMatches(parsed.month, mon)) return false;
  const domRestricted = parsed.dayOfMonth.kind === "set";
  const dowRestricted = parsed.dayOfWeek.kind === "set";
  if (domRestricted && dowRestricted) {
    return fieldMatches(parsed.dayOfMonth, dom) || fieldMatches(parsed.dayOfWeek, dow);
  }
  if (domRestricted) return fieldMatches(parsed.dayOfMonth, dom);
  if (dowRestricted) return fieldMatches(parsed.dayOfWeek, dow);
  return true;
}

/**
 * Whether `task` should run right now.
 *
 * Guards against firing twice for the same matching minute (a `run-due` invoked more than once
 * within one minute — a cron line set too tight, a manual re-run, the desktop's own poll
 * overlapping a CLI invocation) by comparing `lastRunIso` against the CURRENT minute, truncated
 * to the minute — not by comparing full timestamps, since the run itself takes real time and a
 * naive "has it been ≥60s" check would still refire mid-run-adjacent windows.
 */
export function isDue(task: ScheduledTask, nowMs: number): boolean {
  // A STRICT check, not a loose truthy `!task.enabled`: a hand-edited/corrupted store with
  // `"enabled": "false"` (a non-empty STRING, not the boolean) is truthy in JS, so `!"false"` is
  // `false` — the loose form would silently treat that record as enabled anyway.
  if (task.enabled !== true) return false;
  const now = new Date(nowMs);
  now.setUTCSeconds(0, 0);
  if (task.lastRunIso) {
    const last = new Date(task.lastRunIso);
    last.setUTCSeconds(0, 0);
    if (last.getTime() === now.getTime()) return false;
  }
  let parsed: ParsedCron;
  try {
    parsed = parseCronExpr(task.cronExpr);
  } catch {
    return false; // an invalid expression never fires — validated at creation, not at runtime.
  }
  return cronMatches(parsed, now);
}

/** Why `nextRunAfterResult` found no match, when it didn't — see that function's own doc for why
 *  these two cases must never collapse onto the same sentinel. */
export type NextRunResult =
  | { kind: "match"; ms: number }
  | { kind: "invalid-expression" }
  | { kind: "no-match-in-window" };

/**
 * The next UTC instant (minute-truncated) at or after `fromMs` that matches — for display
 * ("next run: ..."), and for tests. Scans forward minute-by-minute up to `maxMinutes` (default
 * a little over a year) rather than solving the field constraints analytically: a 5-field cron
 * matcher's constraints interact in ways (the day-of-month/day-of-week OR) that make a closed-
 * form "next match" meaningfully more code for a value only ever shown to a human, who will not
 * notice the difference between an O(1) and an O(n) answer at this scale.
 *
 * Returns a DISCRIMINATED result rather than a bare number-or-null: a cron expression that fails
 * to parse and one that parses fine but has no match within the scan window (e.g. a genuine
 * leap-day-only `0 0 29 2 *` schedule, whose next Feb 29 can be more than a year away) are
 * completely different situations for a caller to describe to a human — the first is a schedule
 * the user typed wrong, the second is a schedule that IS valid and will eventually fire. A caller
 * that only wants "when, or nothing" can still use the `nextRunAfter` wrapper below.
 */
export function nextRunAfterResult(
  cronExpr: string,
  fromMs: number,
  maxMinutes = 60 * 24 * 366,
): NextRunResult {
  let parsed: ParsedCron;
  try {
    parsed = parseCronExpr(cronExpr);
  } catch {
    return { kind: "invalid-expression" };
  }
  const cursor = new Date(fromMs);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let i = 0; i < maxMinutes; i++) {
    if (cronMatches(parsed, cursor)) return { kind: "match", ms: cursor.getTime() };
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return { kind: "no-match-in-window" };
}

/** Thin `number | null` wrapper over `nextRunAfterResult`, for a caller that doesn't need to
 *  distinguish an invalid expression from one with no match in the scan window. */
export function nextRunAfter(
  cronExpr: string,
  fromMs: number,
  maxMinutes = 60 * 24 * 366,
): number | null {
  const r = nextRunAfterResult(cronExpr, fromMs, maxMinutes);
  return r.kind === "match" ? r.ms : null;
}
