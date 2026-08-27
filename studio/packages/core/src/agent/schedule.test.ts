/**
 * agent/schedule.test.ts — the cron matcher, the due/refire guard, and the store merge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ScheduledTask,
  cronMatches,
  isDue,
  mergeTask,
  nextRunAfter,
  nextRunAfterResult,
  parseCronExpr,
  removeTask,
  validateCronExpr,
} from "./schedule.js";

function utc(iso: string): number {
  return new Date(iso).getTime();
}

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "nightly",
    cronExpr: "0 2 * * *",
    task: "summarize today's commits",
    autonomy: "readonly",
    enabled: true,
    createdIso: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/* ── field parsing ────────────────────────────────────────────────────────── */

test("parseCronExpr: a bare '*' matches every minute of every hour", () => {
  const p = parseCronExpr("* * * * *");
  assert.ok(cronMatches(p, new Date(utc("2026-03-14T00:00:00.000Z"))));
  assert.ok(cronMatches(p, new Date(utc("2026-03-14T23:59:00.000Z"))));
});

test("parseCronExpr: a single number matches only that value", () => {
  const p = parseCronExpr("30 2 * * *");
  assert.ok(cronMatches(p, new Date(utc("2026-03-14T02:30:00.000Z"))));
  assert.equal(cronMatches(p, new Date(utc("2026-03-14T02:31:00.000Z"))), false);
  assert.equal(cronMatches(p, new Date(utc("2026-03-14T03:30:00.000Z"))), false);
});

test("parseCronExpr: a range matches every value inside it, inclusive", () => {
  const p = parseCronExpr("0 9-17 * * *");
  assert.ok(cronMatches(p, new Date(utc("2026-03-14T09:00:00.000Z"))));
  assert.ok(cronMatches(p, new Date(utc("2026-03-14T17:00:00.000Z"))));
  assert.equal(cronMatches(p, new Date(utc("2026-03-14T18:00:00.000Z"))), false);
  assert.equal(cronMatches(p, new Date(utc("2026-03-14T08:00:00.000Z"))), false);
});

test("parseCronExpr: a malformed 3-part range (e.g. a mistyped '9-17-8') is REJECTED, never silently truncated", () => {
  // `\"9-17-8\".split(\"-\", 2)` used to silently yield [\"9\",\"17\"], dropping the \"-8\" — a
  // 3-hyphen field has no meaning in cron syntax and must be refused, not reinterpreted.
  assert.throws(() => parseCronExpr("0 9-17-8 * * *"), /not a valid range/);
  assert.throws(() => parseCronExpr("1-2-3 * * * *"), /not a valid range/);
  assert.equal(validateCronExpr("0 9-17-8 * * *") === undefined, false);
});

test("parseCronExpr: a bare step (*/15) matches every Nth value from the field's minimum", () => {
  const p = parseCronExpr("*/15 * * * *");
  for (const m of [0, 15, 30, 45]) {
    assert.ok(cronMatches(p, new Date(utc(`2026-03-14T00:${String(m).padStart(2, "0")}:00.000Z`))));
  }
  assert.equal(cronMatches(p, new Date(utc("2026-03-14T00:10:00.000Z"))), false);
});

test("parseCronExpr: a ranged step (1-10/2) matches every other value within the range only", () => {
  const p = parseCronExpr("0 0 1-10/2 * *");
  assert.ok(cronMatches(p, new Date(utc("2026-03-01T00:00:00.000Z"))));
  assert.ok(cronMatches(p, new Date(utc("2026-03-03T00:00:00.000Z"))));
  assert.equal(cronMatches(p, new Date(utc("2026-03-02T00:00:00.000Z"))), false);
  assert.equal(cronMatches(p, new Date(utc("2026-03-11T00:00:00.000Z"))), false);
});

test("parseCronExpr: a comma list unions every listed value/range/step", () => {
  const p = parseCronExpr("0,15,45 * * * *");
  assert.ok(cronMatches(p, new Date(utc("2026-03-14T00:00:00.000Z"))));
  assert.ok(cronMatches(p, new Date(utc("2026-03-14T00:15:00.000Z"))));
  assert.ok(cronMatches(p, new Date(utc("2026-03-14T00:45:00.000Z"))));
  assert.equal(cronMatches(p, new Date(utc("2026-03-14T00:20:00.000Z"))), false);
});

test("parseCronExpr: rejects a wrong field count, an out-of-range value, and a backwards range", () => {
  assert.throws(() => parseCronExpr("* * * *"), /5 fields/);
  assert.throws(() => parseCronExpr("70 * * * *"), /minute/);
  assert.throws(() => parseCronExpr("* 25 * * *"), /hour/);
  assert.throws(() => parseCronExpr("* * 32 * *"), /day-of-month/);
  assert.throws(() => parseCronExpr("* * * 13 *"), /month/);
  assert.throws(() => parseCronExpr("* * * * 8"), /day-of-week/);
  assert.throws(() => parseCronExpr("10-5 * * * *"), /range start after end/);
  assert.throws(() => parseCronExpr("abc * * * *"), /minute/);
});

test("validateCronExpr: undefined on valid input, the reason string on invalid input", () => {
  assert.equal(validateCronExpr("0 2 * * *"), undefined);
  assert.match(validateCronExpr("bogus") ?? "", /5 fields/);
});

/* ── the day-of-month / day-of-week OR rule ──────────────────────────────────*/

test("cronMatches: day-of-month and day-of-week are OR'd when BOTH are restricted", () => {
  // "the 1st of the month, OR any Monday" — POSIX semantics, not an AND.
  const p = parseCronExpr("0 0 1 * 1");
  // Sunday 2026-03-01 — matches on day-of-month alone.
  assert.ok(cronMatches(p, new Date(utc("2026-03-01T00:00:00.000Z"))));
  // Monday 2026-03-02 — matches on day-of-week alone.
  assert.ok(cronMatches(p, new Date(utc("2026-03-02T00:00:00.000Z"))));
  // Tuesday 2026-03-03 — matches neither.
  assert.equal(cronMatches(p, new Date(utc("2026-03-03T00:00:00.000Z"))), false);
});

test("cronMatches: day-of-week alone (day-of-month left as '*') applies normally, not OR'd", () => {
  const p = parseCronExpr("0 0 * * 1"); // every Monday
  assert.ok(cronMatches(p, new Date(utc("2026-03-02T00:00:00.000Z")))); // Monday
  assert.equal(cronMatches(p, new Date(utc("2026-03-03T00:00:00.000Z"))), false); // Tuesday
});

test("cronMatches: day 0 and day 7 both mean Sunday", () => {
  const sunday = new Date(utc("2026-03-01T00:00:00.000Z"));
  assert.ok(cronMatches(parseCronExpr("0 0 * * 0"), sunday));
  assert.ok(cronMatches(parseCronExpr("0 0 * * 7"), sunday));
});

/* ── isDue: enabled + cron match + no-refire-this-minute ─────────────────────*/

test("isDue: a disabled task is never due, even at a matching minute", () => {
  const t = task({ cronExpr: "* * * * *", enabled: false });
  assert.equal(isDue(t, utc("2026-03-14T12:00:00.000Z")), false);
});

test("isDue: a STRING 'false' (a hand-edited/corrupted store, not the boolean) is NOT treated as enabled", () => {
  // `!\"false\"` is `false` in JS (a non-empty string is truthy) — a loose `!task.enabled` check
  // would fall through and let this fire anyway. The field must be checked strictly.
  const t = task({ cronExpr: "* * * * *", enabled: "false" as unknown as boolean });
  assert.equal(isDue(t, utc("2026-03-14T12:00:00.000Z")), false);
});

test("isDue: an invalid cron expression never fires (fail-closed, not fail-open)", () => {
  const t = task({ cronExpr: "not a cron" });
  assert.equal(isDue(t, utc("2026-03-14T12:00:00.000Z")), false);
});

test("isDue: fires once at a matching minute with no prior run", () => {
  const t = task({ cronExpr: "0 2 * * *" });
  assert.ok(isDue(t, utc("2026-03-14T02:00:30.000Z")));
  assert.equal(isDue(t, utc("2026-03-14T02:01:00.000Z")), false);
});

test("isDue: does NOT refire within the same matching minute it already ran in", () => {
  const t = task({ cronExpr: "* * * * *", lastRunIso: "2026-03-14T02:00:45.000Z" });
  // Same minute, later second — must not refire (a second `run-due` invocation, a slow poll).
  assert.equal(isDue(t, utc("2026-03-14T02:00:59.000Z")), false);
  // The NEXT minute — must fire again ('*' matches every minute).
  assert.ok(isDue(t, utc("2026-03-14T02:01:00.000Z")));
});

/* ── nextRunAfter ─────────────────────────────────────────────────────────── */

test("nextRunAfter: the very next matching minute for a tight schedule", () => {
  const next = nextRunAfter("0 2 * * *", utc("2026-03-14T00:00:00.000Z"));
  assert.equal(new Date(next as number).toISOString(), "2026-03-14T02:00:00.000Z");
});

test("nextRunAfter: rolls over to the next day once today's slot has passed", () => {
  const next = nextRunAfter("0 2 * * *", utc("2026-03-14T03:00:00.000Z"));
  assert.equal(new Date(next as number).toISOString(), "2026-03-15T02:00:00.000Z");
});

test("nextRunAfter: null on an invalid expression, never a throw", () => {
  assert.equal(nextRunAfter("garbage", utc("2026-03-14T00:00:00.000Z")), null);
});

/* ── nextRunAfterResult (discriminated: invalid vs. no-match-in-window) ──────── */

test("nextRunAfterResult: a match reports {kind:'match', ms}", () => {
  const r = nextRunAfterResult("0 2 * * *", utc("2026-03-14T00:00:00.000Z"));
  assert.equal(r.kind, "match");
  assert.equal(r.kind === "match" && new Date(r.ms).toISOString(), "2026-03-14T02:00:00.000Z");
});

test("nextRunAfterResult: an invalid expression reports {kind:'invalid-expression'}, distinct from no-match", () => {
  const r = nextRunAfterResult("garbage", utc("2026-03-14T00:00:00.000Z"));
  assert.deepEqual(r, { kind: "invalid-expression" });
});

test("nextRunAfterResult: a VALID but rare schedule with no match in the default ~1yr window reports {kind:'no-match-in-window'}, never 'invalid-expression'", () => {
  // "0 0 29 2 *" (midnight on Feb 29th) is legal cron — validateCronExpr accepts it — but its
  // next occurrence from just after a leap day is ~4 years away, outside the default scan
  // window. This must be told apart from a genuinely malformed expression.
  assert.equal(validateCronExpr("0 0 29 2 *"), undefined, "a leap-day-only cron IS valid syntax");
  const justAfterLeapDay = utc("2028-03-01T00:00:00.000Z");
  const r = nextRunAfterResult("0 0 29 2 *", justAfterLeapDay);
  assert.deepEqual(r, { kind: "no-match-in-window" });
  // And it genuinely DOES fire eventually — proving this isn't secretly unmatchable.
  const eventual = nextRunAfterResult("0 0 29 2 *", justAfterLeapDay, 60 * 24 * 366 * 5);
  assert.equal(eventual.kind, "match");
});

/* ── store merge ──────────────────────────────────────────────────────────── */

test("mergeTask: keys by id, replaces only that entry", () => {
  const a = task({ id: "a" });
  const b = task({ id: "b" });
  const store = mergeTask(mergeTask({}, a), b);
  assert.deepEqual(Object.keys(store).sort(), ["a", "b"]);
  const aUpdated = { ...a, enabled: false };
  const store2 = mergeTask(store, aUpdated);
  assert.equal(store2.a?.enabled, false);
  assert.equal(store2.b?.enabled, true);
});

test("removeTask: drops the named id, leaves the rest, and no-ops on an unknown id", () => {
  const store = mergeTask(mergeTask({}, task({ id: "a" })), task({ id: "b" }));
  const store2 = removeTask(store, "a");
  assert.deepEqual(Object.keys(store2), ["b"]);
  const store3 = removeTask(store2, "does-not-exist");
  assert.deepEqual(Object.keys(store3), ["b"]);
});
