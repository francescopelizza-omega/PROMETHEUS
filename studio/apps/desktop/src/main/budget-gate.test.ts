/**
 * budget-gate.test.ts — the desktop's spend cap: the store, the config, and the refusal.
 *
 * The desktop had NO spend enforcement at all before this, and the thing that made that hard
 * to notice was that it looked like it did: a `SpendMeter` with a `capUsd` from localStorage
 * and an "auto-disable at cap" caption, over a turn nothing ever stopped. So these tests are
 * about the two halves that were missing — a DURABLE record (the old `usageMap` died on
 * window reload, so there was never a number to compare against) and a refusal that halts.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  DesktopBudgetGate,
  accountingDir,
  appendSpendRecord,
  budgetConfigFromSettings,
  dayFileName,
  isLocalModelId,
  parseAccountingFile,
  readDayRecords,
  readSessionRecords,
} from "./budget-gate.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "prom-budget-"));
  dirs.push(d);
  return d;
}

/**
 * A throwaway SHARED-ledger directory, passed explicitly to everything that touches it.
 *
 * The daily window reads `$PROMETHEUS_HOME/accounting` so that Studio and the terminal count
 * one number (they used to keep disjoint ledgers, so `budget.dailyUsd` was enforced twice).
 * That default is right in production and wrong in a test: without an override these cases
 * read — and appended to — the developer's real spend log, and this file's own "a store that
 * was never written is []" is what catches it. Every call below passes one of these.
 */
function sharedTmp(): string {
  return tmp();
}
after(() => {
  for (const d of dirs) {
    try {
      chmodSync(d, 0o700);
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const NOW = "2026-08-12T13:00:00Z";
const PRICED = { "gpt-x": { inputUsdPerMTok: 10, outputUsdPerMTok: 10, match: "gpt-x" } };

/* ── the store ──────────────────────────────────────────────────────────────*/

test("appendSpendRecord → readDayRecords round-trips a call (a DURABLE record, unlike usageMap)", () => {
  const home = tmp();
  const sh = sharedTmp();
  appendSpendRecord(
    home,
    {
      atIso: NOW,
      model: "gpt-x",
      promptTokens: 10,
      completionTokens: 20,
      estimated: false,
    },
    sh,
  );
  const back = readDayRecords(home, NOW, sh);
  assert.equal(back.length, 1);
  assert.equal(back[0]?.model, "gpt-x");
  assert.equal(back[0]?.promptTokens, 10);
});

test("readDayRecords: a store that was never written is [] — the normal first run, not an error", () => {
  assert.deepEqual(readDayRecords(tmp(), NOW, sharedTmp()), []);
});

test("readDayRecords: an UNREADABLE store THROWS, so the gate can fail closed", () => {
  /**
   * The load-bearing one. If this returned `[]` the cap would read "$0 spent" whenever the
   * file was deleted or chmod-000 — the documented CLI regression, reproduced on the desktop.
   */
  const home = tmp();
  const dir = accountingDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, dayFileName(NOW));
  writeFileSync(file, '{"atIso":"x"}\n');
  chmodSync(file, 0o000);
  // root can read a 000 file, so skip rather than assert a false pass in that environment.
  let readable = false;
  try {
    readDayRecords(home, NOW, sharedTmp());
    readable = true;
  } catch {
    /* expected */
  }
  if (readable && process.getuid?.() === 0) return;
  assert.equal(readable, false, "an existing but unreadable store must throw");
});

test("parseAccountingFile: a torn line is skipped, the rest of the store survives", () => {
  // A crash mid-append must not permanently block every future turn — that would be a
  // fail-closed that never reopens.
  const recs = parseAccountingFile(
    '{"atIso":"a","model":"m","promptTokens":1,"completionTokens":2}\n' +
      '{"atIso":"b","model":"m","promptToke\n' +
      '{"atIso":"c","model":"m","promptTokens":3,"completionTokens":4}\n',
  );
  assert.equal(recs.length, 2);
  assert.deepEqual(
    recs.map((r) => r.atIso),
    ["a", "c"],
  );
});

test("readSessionRecords: the session window starts at THIS launch, the day window does not", () => {
  const home = tmp();
  const sh = sharedTmp();
  const startedMs = Date.parse("2026-08-12T12:00:00Z");
  appendSpendRecord(
    home,
    {
      atIso: "2026-08-12T02:00:00Z", // an earlier launch, same day
      model: "gpt-x",
      promptTokens: 1,
      completionTokens: 1,
      estimated: false,
    },
    sh,
  );
  appendSpendRecord(
    home,
    {
      atIso: NOW, // this launch
      model: "gpt-x",
      promptTokens: 2,
      completionTokens: 2,
      estimated: false,
    },
    sh,
  );
  assert.equal(readDayRecords(home, NOW, sh).length, 2, "the day sees both");
  assert.equal(
    readSessionRecords(home, NOW, startedMs).length,
    1,
    "the session sees only this run",
  );
});

/* ── config resolution ──────────────────────────────────────────────────────*/

test("budgetConfigFromSettings: reads the windows, ignores junk", () => {
  assert.deepEqual(
    budgetConfigFromSettings({
      "budget.sessionUsd": 5,
      "budget.dailyUsd": 20,
      "budget.warnAtPercent": 90,
      "budget.unpricedPolicy": "warn",
    }),
    { sessionUsd: 5, dailyUsd: 20, warnAtPercent: 90, unpricedPolicy: "warn" },
  );
  // A zero/negative/NaN cap is not a cap; letting one through would enforce a limit nobody set.
  assert.deepEqual(budgetConfigFromSettings({ "budget.sessionUsd": 0 }), {});
  assert.deepEqual(budgetConfigFromSettings({ "budget.sessionUsd": -1 }), {});
  assert.deepEqual(budgetConfigFromSettings(undefined), {});
});

test("isLocalModelId: narrow on purpose — a false positive would DISABLE the cap", () => {
  for (const m of ["ollama:qwen3", "local:foo", "lmstudio/bar", "mlx:x"]) {
    assert.equal(isLocalModelId(m), true, m);
  }
  for (const m of ["gpt-4o", "claude-opus-4", "anthropic:claude", "locally-hosted-gpt"]) {
    assert.equal(isLocalModelId(m), false, m);
  }
});

/* ── the gate: what actually stops a turn ───────────────────────────────────*/

function gateWith(
  home: string,
  settings: Record<string, unknown>,
  sharedDir: string = sharedTmp(),
): DesktopBudgetGate {
  const g = new DesktopBudgetGate(home, {
    startedMs: Date.parse("2026-08-12T00:00:00Z"),
    sharedDir,
  });
  g.setPricing(PRICED);
  g.setSettings(settings);
  return g;
}

test("gate: a LOCAL endpoint bypasses entirely — it never even reads the store", () => {
  // Proven by pointing it at a directory that would throw if read: a free turn must never be
  // blocked by a corrupt accounting file.
  const g = gateWith("/nonexistent/\x00bad", { "budget.sessionUsd": 0.01 });
  assert.equal(g.check({ locality: "local" }).action, "ok");
});

test("gate: NO configured cap bypasses entirely (the zero-config path is unchanged)", () => {
  const g = gateWith("/nonexistent/\x00bad", {});
  assert.equal(g.check({ locality: "cloud" }).action, "ok");
});

test("gate: spend over the session cap BLOCKS the next cloud turn", () => {
  const home = tmp();
  const g = gateWith(home, { "budget.sessionUsd": 1 });
  g.record({
    locality: "cloud",
    model: "gpt-x",
    promptTokens: 100_000,
    completionTokens: 100_000, // $2.00 against a $1 cap
    nowIso: NOW,
  });
  const d = g.check({ locality: "cloud", nowIso: NOW });
  assert.equal(d.action, "block");
  assert.match(d.message ?? "", /budget hard-stop/);
});

test("gate: a local call is NOT recorded — it can never move a USD cap", () => {
  const home = tmp();
  const sh = sharedTmp();
  const g = gateWith(home, { "budget.sessionUsd": 1 }, sh);
  g.record({
    locality: "local",
    model: "ollama:qwen3",
    promptTokens: 10_000_000,
    completionTokens: 10_000_000,
    nowIso: NOW,
  });
  // neither ledger: a free turn must not appear in the SHARED daily window either.
  assert.deepEqual(readDayRecords(home, NOW, sh), []);
  assert.equal(g.check({ locality: "cloud", nowIso: NOW }).action, "ok");
});

test("gate: an unreadable store BLOCKS the cloud turn (fail-closed, no GUI override)", () => {
  const home = tmp();
  const dir = accountingDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, dayFileName(NOW));
  writeFileSync(file, "{}\n");
  chmodSync(file, 0o000);
  const g = gateWith(home, { "budget.sessionUsd": 1 });
  const d = g.check({ locality: "cloud", nowIso: NOW });
  if (process.getuid?.() === 0) return; // root reads anything; the assertion would be vacuous
  assert.equal(d.action, "block");
  assert.match(d.message ?? "", /fail-closed/);
});

test("gate: the warn latches — once per window, not once per turn", () => {
  const home = tmp();
  const g = gateWith(home, { "budget.sessionUsd": 2.2, "budget.warnAtPercent": 80 });
  g.record({
    locality: "cloud",
    model: "gpt-x",
    promptTokens: 100_000,
    completionTokens: 100_000, // $2 of $2.20 → 90%
    nowIso: NOW,
  });
  assert.equal(g.check({ locality: "cloud", nowIso: NOW }).action, "warn");
  assert.equal(g.check({ locality: "cloud", nowIso: NOW }).action, "ok");
});

/* ── status(): the read-only snapshot the Settings ▸ Budget & Spend page renders ────────── */

test("status: no configured cap reports capped:false, never a crash or a fake number", () => {
  const g = gateWith(tmp(), {});
  const s = g.status(NOW);
  assert.equal(s.capped, false);
  assert.equal(s.sessionSpentUsd, 0);
  assert.equal(s.dailySpentUsd, 0);
});

test("status: reflects a real recorded spend against the configured caps", () => {
  const home = tmp();
  const g = gateWith(home, { "budget.sessionUsd": 5, "budget.dailyUsd": 10 });
  g.record({
    locality: "cloud",
    model: "gpt-x",
    promptTokens: 100_000,
    completionTokens: 100_000, // $2.00
    nowIso: NOW,
  });
  const s = g.status(NOW);
  assert.equal(s.capped, true);
  assert.equal(s.sessionSpentUsd, 2);
  assert.equal(s.dailySpentUsd, 2);
  assert.deepEqual(s.config, { sessionUsd: 5, dailyUsd: 10 });
});

test("status: a local call never moves the spend total (matches the real gate's own rule)", () => {
  const home = tmp();
  const g = gateWith(home, { "budget.sessionUsd": 5 });
  g.record({
    locality: "local",
    model: "ollama:qwen3",
    promptTokens: 10_000_000,
    completionTokens: 10_000_000,
    nowIso: NOW,
  });
  assert.equal(g.status(NOW).sessionSpentUsd, 0);
});

test("status: an unreadable store reports an honest empty snapshot rather than throwing", () => {
  const home = tmp();
  const dir = accountingDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, dayFileName(NOW));
  writeFileSync(file, "{}\n");
  chmodSync(file, 0o000);
  const g = gateWith(home, { "budget.sessionUsd": 1 });
  if (process.getuid?.() === 0) return; // root reads anything; the assertion would be vacuous
  const s = g.status(NOW);
  assert.equal(s.sessionSpentUsd, 0);
  assert.equal(s.dailySpentUsd, 0);
});

test("status: an unpriced model is surfaced, excluded from the totals", () => {
  const home = tmp();
  const g = gateWith(home, { "budget.sessionUsd": 5 });
  g.record({
    locality: "cloud",
    model: "totally-unpriced-model",
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
    nowIso: NOW,
  });
  const s = g.status(NOW);
  assert.deepEqual(s.unpriced, ["totally-unpriced-model"]);
  assert.equal(s.sessionSpentUsd, 0);
});
