/**
 * budgetGate.test.ts — the SHARED pre-turn spend gate.
 *
 * Every test here names a way a cap can silently stop being a cap. That is not paranoia about
 * a hypothetical: this repo shipped THREE cost evaluators, two of which (`enforceGuardrail`,
 * `evaluateGuardrail`) had full unit coverage and zero production callers, while the desktop
 * displayed a `capUsd` from localStorage that nothing consulted. Passing tests over an
 * uncalled function is exactly the failure mode, so these pin the DECISION that both hosts
 * now route through.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type BudgetGateInput, decideBudget, hasBudgetCap, mergeDayRecords } from "./budgetGate.js";
import type { PriceFor, SpendRecord } from "./budgetWindows.js";

const NOW = "2026-08-12T13:00:00Z";

/** $10 per Mtok in and out — round numbers so the arithmetic in each test is obvious. */
const priced: PriceFor = () => ({ pricePerMTokIn: 10, pricePerMTokOut: 10 });
/** A model we have NO price for — the fail-closed case. */
const unpriced: PriceFor = () => undefined;

function rec(over: Partial<SpendRecord> = {}): SpendRecord {
  return {
    model: "gpt-x",
    promptTokens: 100_000,
    completionTokens: 100_000, // 0.2 Mtok × $10 = $2.00
    estimated: false,
    atIso: NOW,
    ...over,
  };
}

function input(over: Partial<BudgetGateInput> = {}): BudgetGateInput {
  return {
    sessionRecords: [],
    config: {},
    nowIso: NOW,
    priceFor: priced,
    warned: new Set<string>(),
    ...over,
  };
}

/* ── the block, which is the whole point ────────────────────────────────────*/

test("decideBudget: over the session cap BLOCKS — the turn must not fire", () => {
  const d = decideBudget(
    input({ sessionRecords: [rec(), rec()], config: { sessionUsd: 3 } }), // $4 spent vs $3
  );
  assert.equal(d.action, "block");
  assert.match(d.message ?? "", /budget hard-stop/);
});

test("decideBudget: under the cap is ok and says nothing", () => {
  const d = decideBudget(input({ sessionRecords: [rec()], config: { sessionUsd: 100 } }));
  assert.equal(d.action, "ok");
  assert.equal(d.message, undefined);
});

test("decideBudget: no configured window never blocks, whatever was spent", () => {
  // The zero-config path. A gate that blocked here would break every user who never set a cap.
  const d = decideBudget(input({ sessionRecords: [rec(), rec(), rec(), rec()], config: {} }));
  assert.equal(d.action, "ok");
});

/* ── fail-closed: the property that makes the cap real ──────────────────────*/

test("decideBudget: an unreadable store BLOCKS rather than reading as $0 spent", () => {
  /**
   * The regression this pins is a documented one from the CLI: `readAccounting` used to
   * swallow its error and return `[]`, so a deleted or chmod-000 store read as "$0 spent" and
   * the cap silently stopped enforcing — a one-command bypass of the user's own limit.
   */
  const d = decideBudget(
    input({
      config: { sessionUsd: 1 },
      priceFor: () => {
        throw new Error("EACCES: permission denied");
      },
      sessionRecords: [rec()],
    }),
  );
  assert.equal(d.action, "block");
  assert.match(d.message ?? "", /fail-closed/);
});

test("decideBudget: --force-budget downgrades a block to a NOISY proceed, never a silent one", () => {
  const d = decideBudget(
    input({ sessionRecords: [rec(), rec()], config: { sessionUsd: 3 }, forceBudget: true }),
  );
  assert.equal(d.action, "ok");
  assert.match(d.message ?? "", /--force-budget/, "the override must announce itself");
});

test("decideBudget: --force-budget also downgrades the fail-closed block", () => {
  const d = decideBudget(
    input({
      config: { sessionUsd: 1 },
      priceFor: () => {
        throw new Error("boom");
      },
      sessionRecords: [rec()],
    }),
  );
  assert.equal(d.action, "block");
  const forced = decideBudget(
    input({
      config: { sessionUsd: 1 },
      forceBudget: true,
      priceFor: () => {
        throw new Error("boom");
      },
      sessionRecords: [rec()],
    }),
  );
  assert.equal(forced.action, "ok");
});

test("decideBudget: an UNPRICED model fails closed by default (a cap that cannot apply must not pass)", () => {
  // Most cloud providers have no price row. Counting those records as $0 is precisely what let
  // a huge session slip past a $1 cap while identical tokens on a priced model blocked.
  const d = decideBudget(
    input({ sessionRecords: [rec()], config: { sessionUsd: 1 }, priceFor: unpriced }),
  );
  assert.equal(d.action, "block");
});

/* ── the two windows are evaluated over DIFFERENT record sets ───────────────*/

test("decideBudget: the DAILY window sees the whole day, so quitting cannot reset the cap", () => {
  /**
   * The bug this pins: evaluating both windows from the session's records alone meant a fresh
   * session id on every launch reset `daily_usd` to $0, and a user could spend N times their
   * daily cap by quitting and reopening N times.
   */
  const earlier = rec({ atIso: "2026-08-12T02:00:00Z" }); // $2, an earlier launch today
  const thisRun = rec(); // $2, this launch
  const d = decideBudget(
    input({
      sessionRecords: [thisRun],
      dayRecords: [earlier, thisRun],
      config: { dailyUsd: 3 }, // $4 across the day
    }),
  );
  assert.equal(d.action, "block");
  assert.match(d.message ?? "", /daily/);
});

test("decideBudget: the SESSION window does NOT see the rest of the day", () => {
  // The mirror of the test above, and the reason the two lists are separate parameters: summing
  // one merged array would make `session_usd` trip on the whole machine's day.
  const earlier = rec({ atIso: "2026-08-12T02:00:00Z" });
  const thisRun = rec();
  const d = decideBudget(
    input({
      sessionRecords: [thisRun], // $2 this session
      dayRecords: [earlier, thisRun],
      config: { sessionUsd: 3 }, // and no daily cap
    }),
  );
  assert.equal(d.action, "ok");
});

test("decideBudget: the MORE SEVERE window wins — a cap is a floor, not an average", () => {
  // NOTE the distinct timestamps: `mergeDayRecords` dedupes on (time, model, tokens), so three
  // byte-identical rows are ONE call as far as the day is concerned — which is correct, and is
  // why they have to differ here to represent three real calls.
  const d = decideBudget(
    input({
      sessionRecords: [rec()],
      dayRecords: [
        rec({ atIso: "2026-08-12T01:00:00Z" }),
        rec({ atIso: "2026-08-12T02:00:00Z" }),
        rec({ atIso: "2026-08-12T03:00:00Z" }),
      ],
      // session is nowhere near its cap ($2 of $100); the DAY is over ($8 of $3).
      config: { sessionUsd: 100, dailyUsd: 3 },
    }),
  );
  assert.equal(d.action, "block");
  assert.match(d.message ?? "", /daily/);
});

/* ── the warn, latched ──────────────────────────────────────────────────────*/

test("decideBudget: warns ONCE per window, not once per turn", () => {
  const warned = new Set<string>();
  const args = (): BudgetGateInput =>
    input({ sessionRecords: [rec()], config: { sessionUsd: 2.2, warnAtPercent: 80 }, warned });
  const first = decideBudget(args()); // $2 of $2.20 = 90%
  assert.equal(first.action, "warn");
  assert.match(first.message ?? "", /⚠/);
  const second = decideBudget(args());
  assert.equal(second.action, "ok", "a long session must not repeat the same warning every turn");
});

/* ── helpers ────────────────────────────────────────────────────────────────*/

test("mergeDayRecords: the session's own rows appear in both lists and are counted ONCE", () => {
  const shared = rec();
  const other = rec({ atIso: "2026-08-12T02:00:00Z" });
  const merged = mergeDayRecords([shared], [other, shared]);
  assert.equal(merged.length, 2);
});

test("mergeDayRecords: two genuinely distinct calls are both kept", () => {
  // Identity is (time, model, tokens); a collision needs the same model billing the same counts
  // in the same millisecond. Differing on any one of them must NOT dedupe.
  const a = rec();
  const b = rec({ completionTokens: 99 });
  assert.equal(mergeDayRecords([a], [b]).length, 2);
});

test("hasBudgetCap: only a configured WINDOW counts as a cap", () => {
  // Guards the fast path: without this a host pays a store read every turn to reach `ok`.
  assert.equal(hasBudgetCap(undefined), false);
  assert.equal(hasBudgetCap({}), false);
  assert.equal(hasBudgetCap({ warnAtPercent: 80 }), false, "a warn threshold alone caps nothing");
  assert.equal(hasBudgetCap({ sessionUsd: 5 }), true);
  assert.equal(hasBudgetCap({ dailyUsd: 5 }), true);
});
