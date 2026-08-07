/**
 * commands/flaky-detect.ts — PURE flaky-test classification for `prometheus test run --retry-failed` (CLI-094).
 *
 * A test's truth isn't one pass/fail — it's the SEQUENCE across repeated runs. This file owns the
 * pure decision logic (no subprocess, no fs, no clock); test-cmd.ts drives the actual re-runs and
 * the fs persistence. Retry policy (documented, deliberate): each retry re-runs the SAME command
 * (reproducible; may miss order/seed-dependent flakes) — the honest, deterministic choice over
 * fresh-seed-per-attempt, and recorded per attempt in the history.
 */

/** Classification of a full result SEQUENCE (incl. the first run). */
export type FlakeClass = "stable-pass" | "stable-fail" | "flaky";

/** Classification of the RETRY history of an initially-FAILED test. */
export type RetryClass = "genuine-fail" | "flaky" | "confirmed-fixed";

/**
 * Classify a full pass/fail sequence (CLI-094): all-pass ⇒ `stable-pass`, all-fail ⇒ `stable-fail`,
 * any mix ⇒ `flaky`. Empty ⇒ `stable-pass` (nothing observed failing). Pure.
 */
export function classify(results: readonly boolean[]): FlakeClass {
  if (results.length === 0) return "stable-pass";
  const anyPass = results.some((r) => r);
  const anyFail = results.some((r) => !r);
  if (!anyFail) return "stable-pass";
  if (!anyPass) return "stable-fail";
  return "flaky";
}

/**
 * Classify the RETRY history of a test that FAILED on its first run (CLI-094): fails every retry ⇒
 * `genuine-fail`; passes EVERY retry ⇒ `confirmed-fixed` (the first fail was a fluke); passes at
 * least one but not all ⇒ `flaky`. Empty retries ⇒ `genuine-fail` (no evidence it recovers). Pure.
 */
export function classifyRetry(retryResults: readonly boolean[]): RetryClass {
  if (retryResults.length === 0) return "genuine-fail";
  const anyPass = retryResults.some((r) => r);
  const allPass = retryResults.every((r) => r);
  if (allPass) return "confirmed-fixed";
  if (anyPass) return "flaky";
  return "genuine-fail";
}

/** One retried test's outcome + its per-attempt history (the visible flaky evidence). */
export interface RetryOutcome {
  id: string;
  /** each retry's pass(true)/fail(false), in order. */
  attempts: boolean[];
  classification: RetryClass;
}

/** A test whose flakiness is worth persisting (inconsistent across the first run + retries). */
export function isInconsistent(cls: RetryClass): boolean {
  return cls === "flaky" || cls === "confirmed-fixed";
}

/* ── persisted per-project flaky memory (pure merge/parse; fs lives in test-cmd.ts) ── */

/** One accumulated flaky record: how many times seen, and when last. */
export interface FlakyRecord {
  count: number;
  lastSeen: string;
}

/** nodeid → accumulated flaky record. */
export type FlakyMemory = Record<string, FlakyRecord>;

/** Parse the persisted flaky memory, guarding a corrupt/partial file (⇒ {}, never a crash). */
export function parseFlakyMemory(text: string): FlakyMemory {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: FlakyMemory = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === "object" && typeof (v as FlakyRecord).count === "number") {
      const rec = v as FlakyRecord;
      out[id] = {
        count: Number.isFinite(rec.count) && rec.count > 0 ? Math.floor(rec.count) : 1,
        lastSeen: typeof rec.lastSeen === "string" ? rec.lastSeen : "",
      };
    }
  }
  return out;
}

/**
 * Accumulate the newly-observed flaky ids into the prior memory (CLI-094): each bumps its `count`
 * and stamps `lastSeen=nowIso`, so recurring flakiness in the same test is visible OVER TIME, not
 * just within one run's retries. Pure — returns a NEW object.
 */
export function mergeFlaky(
  prev: FlakyMemory,
  flakyIds: readonly string[],
  nowIso: string,
): FlakyMemory {
  const next: FlakyMemory = { ...prev };
  for (const id of flakyIds) {
    const cur = next[id];
    next[id] = { count: (cur?.count ?? 0) + 1, lastSeen: nowIso };
  }
  return next;
}
