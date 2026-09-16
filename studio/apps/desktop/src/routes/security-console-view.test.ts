/**
 * security-console-view.test.ts — the §4 view model.
 *
 * Two of these matter more than the rest: an unknown verdict must not be counted as an allow,
 * and the history must be newest-first. Both fail silently — a wrong tally still renders three
 * plausible pills, and a reversed history looks completely normal.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type AuditRowLike,
  ageLabel,
  findingsSummary,
  gateBanner,
  gateCounts,
  gateModeOf,
  historyRows,
  remediationLineLevel,
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
  // NOT "clean": that is a SEVERITY word (packages/ui/src/tokens.ts says so verbatim), and
  // deriving it from the TIER `allow` restates the decision as a second, corroborating
  // measurement — the §4 conflation, in the row beside the verdict chip.
  assert.equal(
    findingsSummary({ at: at(1), target: "x", verdict: "allow" }),
    "no findings recorded",
  );
  assert.equal(
    findingsSummary({ at: at(1), target: "x", verdict: "warn", blocking_reasons: ["a", "b"] }),
    "2 reasons",
  );
  assert.equal(
    findingsSummary({ at: at(1), target: "x", verdict: "warn", blocking_reasons: ["a"] }),
    "1 reason",
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

/* ── §4: "✓ done green, … active amber" ──────────────────────────────────────────── */

test("remediationLineLevel: the engine's markers decide the tint", () => {
  assert.equal(remediationLineLevel("✓ removed postinstall script"), "success");
  assert.equal(remediationLineLevel("✔ pinned dependency hashes"), "success");
  assert.equal(remediationLineLevel("… rewriting fetch calls (2 of 3)"), "warn");
  assert.equal(remediationLineLevel("... still working"), "warn");
  assert.equal(remediationLineLevel("✗ could not rewrite"), "error");
  assert.equal(remediationLineLevel("⚠ partial"), "warn");
});

test("remediationLineLevel: outcome words are honoured without a marker", () => {
  assert.equal(remediationLineLevel("disinfect failed for 1 item"), "error");
  assert.equal(remediationLineLevel("2 findings unresolved"), "warn");
  assert.equal(remediationLineLevel("Unable to open quarantine dir"), "error");
});

test("remediationLineLevel: an unrecognised line stays neutral, never a guessed ✓", () => {
  // a green tick beside a line that never claimed success is a lie the user will trust
  assert.equal(remediationLineLevel("remediate shadow-fetch → strip network hooks"), "info");
  assert.equal(remediationLineLevel(""), "info");
  assert.equal(remediationLineLevel("scanning 41 files"), "info");
});

test("remediationLineLevel: leading whitespace does not defeat the marker", () => {
  assert.equal(remediationLineLevel("   ✓ done"), "success");
  assert.equal(remediationLineLevel("\t… working"), "warn");
});

/* ── §4: the banner must describe the gate's ACTUAL mode ─────────────────────────── */

test("gateModeOf normalises the engine's string; anything else is unknown", () => {
  assert.equal(gateModeOf("enforce"), "enforce");
  assert.equal(gateModeOf(" WARN "), "warn");
  assert.equal(gateModeOf("off"), "off");
  assert.equal(gateModeOf("permissive"), "unknown", "an unrecognised mode is not a pass");
  assert.equal(gateModeOf(undefined), "unknown");
  assert.equal(gateModeOf(null), "unknown");
  assert.equal(gateModeOf(""), "unknown");
});

test("PROMETHEUS_GATE=off must never render as armed, and never green", () => {
  // the defect: the console asserted "nemesis gate — armed, fail-closed" under a green
  // shield while the engine was running with the gate switched off entirely.
  const b = gateBanner([{ gate_mode: "off" }]);
  assert.equal(b.mode, "off");
  assert.match(b.title, /OFF/);
  assert.doesNotMatch(b.title, /armed/i);
  assert.equal(b.role, "danger");
});

test("warn mode says plainly that nothing is blocked", () => {
  const b = gateBanner([{ gate_mode: "warn" }]);
  assert.equal(b.role, "warn");
  assert.match(b.title, /nothing is blocked/i);
  assert.doesNotMatch(b.title, /fail-closed/i);
});

test("only enforce earns the armed claim and the green shield", () => {
  const b = gateBanner([{ gate_mode: "enforce" }]);
  assert.equal(b.mode, "enforce");
  assert.equal(b.role, "ok");
  assert.match(b.title, /armed, fail-closed/);
});

test("the NEWEST row wins among the rows considered (newest-first ordering)", () => {
  // auditLog() returns newest-first, and the mode is a property of the run that wrote the
  // row, not of the installation. NOTE: ordering alone does not bound the row to this session —
  // that is what `sinceMs` is for; see the test below.
  const b = gateBanner([{ gate_mode: "off" }, { gate_mode: "enforce" }, { gate_mode: "enforce" }]);
  assert.equal(b.mode, "off");
  // rows without a mode are skipped rather than treated as unknown-and-stop
  assert.equal(gateBanner([{}, { gate_mode: "warn" }]).mode, "warn");
});

test("the LIVE configured mode outranks the history entirely", () => {
  /**
   * `$PROMETHEUS_GATE` in main's env is what `safeChildEnv()` hands the next engine spawn, so it
   * is a fact about this session rather than an inference from what some earlier one did. A log
   * full of `enforce` rows must not paint green over a process configured `off`.
   */
  const rows = [{ gate_mode: "enforce", at: "2026-09-06T09:30:00.000Z" }];
  const off = gateBanner(rows, { configured: "off", sinceMs: 0 });
  assert.equal(off.mode, "off");
  assert.equal(off.role, "danger");
  assert.doesNotMatch(off.title, /armed/i);
  // it wins in the reassuring direction too — a fresh enforce needs no corroborating row
  assert.equal(gateBanner([], { configured: "enforce" }).mode, "enforce");
  assert.equal(gateBanner(null, { configured: "warn" }).mode, "warn");
  // an unrecognised or absent value is NOT a mode: fall through to the bounded history
  assert.equal(gateBanner(rows, { configured: "banana", sinceMs: 0 }).mode, "enforce");
  assert.equal(gateBanner(rows, { configured: null, sinceMs: 0 }).mode, "enforce");
  assert.equal(gateBanner([], { configured: "banana" }).mode, "unknown");
});

test("a row older than this session cannot vouch for it — never a stale green", () => {
  /**
   * The real defect the "newest row" rule does not cover: with no gated action yet performed by
   * THIS app, the newest row in the log is whatever the last run wrote — so an `enforce` row
   * from a previous session painted `role: "ok"` over a session started with
   * `PROMETHEUS_GATE=off`. That is the same false-green claim, one step removed.
   */
  const start = Date.parse("2026-09-06T09:00:00.000Z");
  const stale = { gate_mode: "enforce", at: "2026-09-01T12:00:00.000Z" };
  const fresh = { gate_mode: "enforce", at: "2026-09-06T09:30:00.000Z" };

  const b = gateBanner([stale], { sinceMs: start });
  assert.equal(b.mode, "unknown", "a pre-session row is not evidence about this session");
  assert.notEqual(b.role, "ok");
  assert.doesNotMatch(b.title, /armed/i);

  // a row written by THIS session still counts
  assert.equal(gateBanner([fresh], { sinceMs: start }).mode, "enforce");
  // …and an in-session `off` still wins over an older enforce
  assert.equal(
    gateBanner([{ gate_mode: "off", at: "2026-09-06T10:00:00.000Z" }, fresh], { sinceMs: start })
      .mode,
    "off",
  );
  // an unparseable/absent timestamp is not treated as recent
  assert.equal(gateBanner([{ gate_mode: "enforce" }], { sinceMs: start }).mode, "unknown");
  // with no bound at all the old behaviour stands (the other tests in this file rely on it)
  assert.equal(gateBanner([stale]).mode, "enforce");
});

test("an empty or unreadable log is UNKNOWN, not armed", () => {
  // the bridge fails soft to [] for both, so the honest banner in both cases is "we cannot
  // see our own evidence" — never a reassurance.
  for (const rows of [[], null, undefined]) {
    const b = gateBanner(rows);
    assert.equal(b.mode, "unknown");
    assert.notEqual(b.role, "ok", "an unknown gate mode must not paint green");
    assert.doesNotMatch(b.title, /armed/i);
  }
});

test("DRIFT GUARD: the console renders the derived banner, not the constants", () => {
  const src = readFileSync(new URL("./security.tsx", import.meta.url), "utf8");
  assert.match(src, /const banner = gateBanner\(auditLog, \{/);
  assert.match(src, /sinceMs: APP_START_MS/);
  // the LIVE mode from main must be threaded in — history alone cannot describe this session
  assert.match(src, /configured: gateMode/);
  assert.match(src, /\{banner\.title\}/);
  assert.match(src, /\{banner\.note\}/);
  assert.doesNotMatch(src, /\{GATE_BANNER_TITLE\}/, "the hardcoded claim is back on screen");
  // the shield chip must follow the mode too, or an OFF gate keeps its green badge
  assert.match(src, /var\(--\$\{banner\.role\}\)/);
});
