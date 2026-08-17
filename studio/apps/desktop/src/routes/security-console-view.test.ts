/**
 * security-console-view.test.ts — the §4 view model.
 *
 * Two of these matter more than the rest: an unknown verdict must not be counted as an allow,
 * and the history must be newest-first. Both fail silently — a wrong tally still renders three
 * plausible pills, and a reversed history looks completely normal.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AuditRowLike,
  ageLabel,
  findingsSummary,
  gateCounts,
  historyRows,
  remediationProgress,
} from "./security-console-view.js";

const T0 = Date.parse("2026-08-10T12:00:00.000Z");
const at = (minutesAgo: number): string => new Date(T0 - minutesAgo * 60_000).toISOString();

/* ── the banner's counts ─────────────────────────────────────────────────────*/

test("counts are per DECISION, so a retried block counts twice", () => {
  // The pills say "the gate blocked twice", not "two bad artifacts exist". De-duplicating
  // would hide a user re-running a blocked install, which is the pattern worth surfacing.
  const rows: AuditRowLike[] = [
    { at: at(1), target: "evil/repo", verdict: "block" },
    { at: at(2), target: "evil/repo", verdict: "block" },
    { at: at(3), target: "ok/repo", verdict: "allow" },
  ];
  const c = gateCounts(rows);
  assert.equal(c.block, 2);
  assert.equal(c.allow, 1);
  assert.equal(c.total, 3);
});

test("an UNKNOWN verdict counts as error — never as allow", () => {
  // The log is written by the engine and read here. A verdict this build does not recognise
  // is exactly the case where assuming "fine" is unsafe.
  const c = gateCounts([
    { at: at(1), target: "x", verdict: "quarantined" },
    { at: at(2), target: "y", verdict: "" },
    { at: at(3), target: "z", verdict: "error" },
  ]);
  assert.equal(c.allow, 0, "an unrecognised verdict was counted as an allow");
  assert.equal(c.error, 3);
});

test("error is tallied apart from block — they have different fixes", () => {
  const c = gateCounts([
    { at: at(1), target: "a", verdict: "block" },
    { at: at(2), target: "b", verdict: "error" },
  ]);
  assert.equal(c.block, 1);
  assert.equal(c.error, 1);
});

/* ── ages ────────────────────────────────────────────────────────────────────*/

test("ages are coarse and human; an unparseable timestamp is a dash, not NaN", () => {
  assert.equal(ageLabel(at(0), T0), "now");
  assert.equal(ageLabel(at(4), T0), "4m");
  assert.equal(ageLabel(at(180), T0), "3h");
  assert.equal(ageLabel(at(60 * 24 * 6), T0), "6d");
  assert.equal(ageLabel(at(60 * 24 * 21), T0), "3w");
  assert.equal(ageLabel("not a date", T0), "—");
});

/* ── history rows ────────────────────────────────────────────────────────────*/

test("history is NEWEST first, whatever order the engine wrote", () => {
  // A reversed history island renders perfectly and is completely wrong, so the sort is
  // explicit rather than inherited from the log's order.
  const rows: AuditRowLike[] = [
    { at: at(90), target: "old", verdict: "allow" },
    { at: at(1), target: "new", verdict: "block" },
    { at: at(30), target: "mid", verdict: "warn" },
  ];
  assert.deepEqual(
    historyRows(rows, { now: T0 }).map((r) => r.artifact),
    ["new", "mid", "old"],
  );
});

test("the limit applies AFTER the sort — never to the engine's raw order", () => {
  const rows: AuditRowLike[] = [
    { at: at(90), target: "old", verdict: "allow" },
    { at: at(1), target: "new", verdict: "block" },
  ];
  assert.deepEqual(
    historyRows(rows, { now: T0, limit: 1 }).map((r) => r.artifact),
    ["new"],
  );
});

test("source falls back from label to tier to a dash", () => {
  const [a, b, c] = historyRows(
    [
      { at: at(1), target: "x", verdict: "allow", label: "catalog install" },
      { at: at(2), target: "y", verdict: "allow", tier: "official" },
      { at: at(3), target: "z", verdict: "allow" },
    ],
    { now: T0 },
  );
  assert.equal(a?.source, "catalog install");
  assert.equal(b?.source, "official");
  assert.equal(c?.source, "—");
});

test("a non-allow verdict with no reasons is NOT reported as clean", () => {
  // "clean" beside a BLOCK would contradict the verdict chip in the same row.
  assert.equal(findingsSummary({ at: at(1), target: "x", verdict: "block" }), "no reason recorded");
  assert.equal(findingsSummary({ at: at(1), target: "x", verdict: "allow" }), "clean");
  assert.equal(
    findingsSummary({ at: at(1), target: "x", verdict: "warn", blocking_reasons: ["a", "b"] }),
    "2 findings",
  );
  assert.equal(
    findingsSummary({ at: at(1), target: "x", verdict: "warn", blocking_reasons: ["a"] }),
    "1 finding",
  );
});

/* ── remediation progress ────────────────────────────────────────────────────*/

test("progress is null until the run produces a result — no invented steps", () => {
  // `resolved`/`unresolved` come from the post-fix RE-SCAN, so they do not exist mid-run.
  assert.equal(remediationProgress(null), null);
  assert.equal(remediationProgress(undefined), null);
  assert.equal(remediationProgress({}), null, "an empty result is not 0/0");
});

test("progress is resolved out of resolved+unresolved", () => {
  assert.deepEqual(remediationProgress({ resolved: ["a", "b"], unresolved: ["c"] }), {
    done: 2,
    total: 3,
  });
  assert.deepEqual(remediationProgress({ resolved: ["a"], unresolved: [] }), { done: 1, total: 1 });
});
