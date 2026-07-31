/**
 * guardrails.test.ts — cost estimation, §4.2 enforcement, the meter fold/reset, and
 * the §4.3 meter view-model + the §6 localai repoint (file 12 §4/§6).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getProvider, loadProviders, newConnector } from "../providers/index.js";
import type { ConnectorConfig, CostGuardrail, Provider } from "../providers/types.js";
import { planLocalRepoint, repointToLocal } from "../repoint/index.js";
import {
  enforceGuardrail,
  estimateCost,
  nextMonthIso,
  recordSpend,
  resetIfDue,
  spendBar,
  spendMeterView,
} from "./index.js";

const PROVIDERS = loadProviders();
const provider = (id: string): Provider => getProvider(PROVIDERS, id) as Provider;

function guardrail(over: Partial<CostGuardrail> = {}): CostGuardrail {
  return {
    monthlyCapUsd: 20,
    warnAtPct: 0.8,
    spentThisMonthUsd: 0,
    onCap: "auto-disable",
    resetsOn: "2026-07-01T00:00:00Z",
    ...over,
  };
}

// ---- estimateCost ---------------------------------------------------------- //

test("estimateCost uses per-Mtok prices; free models cost $0", () => {
  // 1M in @ $0.27 + 1M out @ $1.10 = $1.37
  assert.equal(
    estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { pricePerMTokIn: 0.27, pricePerMTokOut: 1.1 },
    ),
    1.37,
  );
  assert.equal(
    estimateCost(
      { inputTokens: 5000, outputTokens: 5000 },
      { pricePerMTokIn: null, pricePerMTokOut: null },
    ),
    0,
  );
});

// ---- enforceGuardrail (§4.2) ---------------------------------------------- //

test("enforceGuardrail allows a small call within budget", () => {
  const d = enforceGuardrail(guardrail(), 0.5);
  assert.equal(d.allow, true);
  assert.equal(d.action, "ok");
});

test("enforceGuardrail blocks a single call over the per-request ceiling", () => {
  const d = enforceGuardrail(guardrail({ perRequestMaxUsd: 1 }), 2.5);
  assert.equal(d.allow, false);
  assert.equal(d.action, "block");
});

test("enforceGuardrail auto-disables when the projected month would exceed the cap", () => {
  const d = enforceGuardrail(guardrail({ spentThisMonthUsd: 19.5, onCap: "auto-disable" }), 1);
  assert.equal(d.allow, false);
  assert.equal(d.action, "auto-disable");
});

test("enforceGuardrail warn-only allows past the cap but flags it", () => {
  const d = enforceGuardrail(guardrail({ spentThisMonthUsd: 19.5, onCap: "warn-only" }), 1);
  assert.equal(d.allow, true);
  assert.equal(d.action, "warn");
});

test("enforceGuardrail warns inside the warn band (>= warnAtPct)", () => {
  const d = enforceGuardrail(guardrail({ spentThisMonthUsd: 17 }), 0.1); // 85% of 20
  assert.equal(d.allow, true);
  assert.equal(d.action, "warn");
});

// ---- recordSpend + resetIfDue --------------------------------------------- //

test("recordSpend folds actual cost into the meter immutably", () => {
  const g0 = guardrail({ spentThisMonthUsd: 3 });
  const g1 = recordSpend(g0, 1.25);
  assert.equal(g1.spentThisMonthUsd, 4.25);
  assert.equal(g1.lastEstimateUsd, 1.25);
  assert.equal(g0.spentThisMonthUsd, 3, "original is untouched");
});

test("resetIfDue rolls the meter over only on/after the reset date", () => {
  const g = guardrail({ spentThisMonthUsd: 12, resetsOn: "2026-07-01T00:00:00Z" });
  assert.equal(resetIfDue(g, "2026-06-30T23:59:00Z").spentThisMonthUsd, 12, "not due");
  const rolled = resetIfDue(g, "2026-07-01T00:00:00Z");
  assert.equal(rolled.spentThisMonthUsd, 0);
  assert.equal(rolled.resetsOn, "2026-08-01T00:00:00.000Z");
});

test("nextMonthIso clamps day-of-month (Jan 31 -> Feb 28)", () => {
  assert.equal(nextMonthIso("2026-01-31T00:00:00Z"), "2026-02-28T00:00:00.000Z");
});

// ---- spend meter (§4.3) ---------------------------------------------------- //

test("spendMeterView formats the line + bands", () => {
  const v = spendMeterView(guardrail({ spentThisMonthUsd: 3.2 }));
  assert.equal(v.line, "$3.20 / $20.00 · 16%");
  assert.equal(v.band, "ok");
  assert.equal(spendMeterView(guardrail({ spentThisMonthUsd: 17 })).band, "warn");
  assert.equal(spendMeterView(guardrail({ spentThisMonthUsd: 25 })).band, "over");
});

test("spendBar fills proportionally and clamps", () => {
  assert.equal(spendBar(0.5, 10), "█████░░░░░");
  assert.equal(spendBar(2, 4), "████");
  assert.equal(spendBar(-1, 4), "░░░░");
});

// ---- §6 localai repoint ---------------------------------------------------- //

function meteredOpenWeight(): ConnectorConfig {
  const host = provider("open-weight-api-host");
  return {
    ...newConnector(host, "api-key", "deepseek-chat", ["agent-pane"]),
    baseUrl: "https://openrouter.ai/api/v1",
    keyRef: { service: "com.prometheus.studio", account: "open-weight-api-host" },
    guardrail: guardrail(),
    confirmedCostWarningAt: "2026-06-19T00:00:00Z",
  };
}

test("planLocalRepoint repoints an open-weight metered connector to a free local serve", () => {
  const plan = planLocalRepoint(meteredOpenWeight(), provider("open-weight-api-host"));
  assert.equal(plan.eligible, true);
  assert.equal(plan.ollamaTag, "deepseek-v3");
  assert.equal(plan.connector?.kind, "local-serve");
  assert.equal(plan.connector?.effectiveTier, "A");
  assert.equal(plan.connector?.keyRef, undefined);
  assert.equal(plan.connector?.guardrail, undefined);
  assert.equal(plan.dummyKeyEnv.OPENAI_API_KEY, "ollama");
});

test("planLocalRepoint refuses a closed-weight model", () => {
  const claude = provider("claude");
  const c = {
    ...newConnector(claude, "oauth-subscription-bridge", "claude-opus-4-8", ["agent-pane"]),
    oauthRef: { service: "s", account: "a" },
  };
  const plan = planLocalRepoint(c, claude);
  assert.equal(plan.eligible, false);
  assert.match(plan.reason, /not open-weight/);
});

test("repointToLocal pulls the weights via the injected runner then returns the local connector", async () => {
  const pulled: string[] = [];
  const local = await repointToLocal(
    meteredOpenWeight(),
    provider("open-weight-api-host"),
    async (tag) => {
      pulled.push(tag);
    },
  );
  assert.deepEqual(pulled, ["deepseek-v3"]);
  assert.equal(local.kind, "local-serve");
  assert.equal(local.effectiveTier, "A");
});

test("repointToLocal throws (never silently keeps spending) on an ineligible connector", async () => {
  const claude = provider("claude");
  const c = {
    ...newConnector(claude, "oauth-subscription-bridge", "claude-opus-4-8", ["agent-pane"]),
    oauthRef: { service: "s", account: "a" },
  };
  await assert.rejects(() => repointToLocal(c, claude, async () => {}), /cannot repoint/);
});

/* ── CLI-030: session/daily budget windows ────────────────────────────────── */

import { type SpendRecord, evaluateBudgets } from "./budgetWindows.js";

// a price table: "gpt-metered" costs $10/$30 per MTok; everything else (local) = free.
const priceFor = (model: string) =>
  model === "gpt-metered" ? { pricePerMTokIn: 10, pricePerMTokOut: 30 } : undefined;

const rec = (over: Partial<SpendRecord> = {}): SpendRecord => ({
  model: "gpt-metered",
  promptTokens: 100_000, // $1.00 in
  completionTokens: 100_000, // $3.00 out → $4.00/record
  estimated: false,
  atIso: "2026-07-17T12:00:00.000Z",
  ...over,
});

test("evaluateBudgets: session cap exceeded → block naming the window", () => {
  const recs = [rec(), rec()]; // $8 spent
  const d = evaluateBudgets(recs, { sessionUsd: 5 }, "2026-07-17T13:00:00Z", priceFor);
  assert.equal(d.action, "block");
  assert.equal(d.window, "session");
  assert.ok(d.spentUsd >= 8);
  assert.match(d.reason ?? "", /session budget exceeded/);
});

test("evaluateBudgets: crossing warn_at_percent → warn (not block)", () => {
  const recs = [rec()]; // $4 of a $5 cap = 80%
  const d = evaluateBudgets(
    recs,
    { sessionUsd: 5, warnAtPercent: 80 },
    "2026-07-17T13:00:00Z",
    priceFor,
  );
  assert.equal(d.action, "warn");
  assert.match(d.reason ?? "", /80% used/);
});

test("evaluateBudgets: below warn threshold → ok", () => {
  const d = evaluateBudgets([rec()], { sessionUsd: 100 }, "2026-07-17T13:00:00Z", priceFor);
  assert.equal(d.action, "ok");
});

test("evaluateBudgets: local/free model spend is $0 (never trips a cap)", () => {
  const recs = Array.from({ length: 50 }, () => rec({ model: "local-qwen" }));
  const d = evaluateBudgets(recs, { sessionUsd: 1 }, "2026-07-17T13:00:00Z", priceFor);
  assert.equal(d.action, "ok");
  assert.equal(d.spentUsd, 0);
});

test("evaluateBudgets: daily window counts only the local calendar day", () => {
  // now == the "today" record's exact instant → same local day in EVERY timezone; the
  // other record is 24h earlier → always a different calendar day, TZ-independent.
  const nowIso = "2026-07-17T12:00:00.000Z";
  const recs = [rec({ atIso: "2026-07-16T12:00:00.000Z" }), rec({ atIso: nowIso })];
  // session sees both ($8), daily sees only today ($4).
  const d = evaluateBudgets(recs, { dailyUsd: 20 }, nowIso, priceFor);
  assert.equal(d.action, "ok"); // today's $4 << $20 daily cap
  const blocked = evaluateBudgets(recs, { dailyUsd: 3 }, nowIso, priceFor);
  assert.equal(blocked.action, "block"); // today's $4 ≥ $3
  assert.equal(blocked.window, "daily");
});

test("evaluateBudgets: no caps → ok regardless of spend (zero regression)", () => {
  const recs = Array.from({ length: 100 }, () => rec());
  assert.equal(evaluateBudgets(recs, {}, "2026-07-17T13:00:00Z", priceFor).action, "ok");
});
