// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/verify.ts — PURE, offline, language-agnostic post-apply verification (WRAPPER Phase A).
 *
 * Runs on the candidate `after` string BEFORE anything is written, so a BLOCK is a free
 * rollback (nothing touched disk). The always-on gate is a bracket/quote BALANCE-DELTA
 * check: it fails ONLY when the edit makes structural balance strictly WORSE than the
 * original — so editing an already-unbalanced partial file, or a snippet, still passes.
 * It never spawns a formatter/linter (that would be an ungated executed action, C12); a
 * real language parse (tree-sitter) is a deferred opt-in, not the default.
 */

/** The delimiter pairs we score. Quotes are parity-scored separately. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];

export interface Balance {
  /** summed |open−close| mismatch across bracket pairs. */
  brackets: number;
  /** summed odd-parity count across the three quote kinds. */
  quotes: number;
}

/**
 * A cheap structural-imbalance score. Language-agnostic: brackets inside strings/comments
 * skew the absolute number, but the DELTA (before vs after) cancels that for any edit that
 * doesn't change the net balance — which is exactly what we gate on.
 */
export function balanceScore(s: string): Balance {
  const counts = new Map<string, number>();
  let dq = 0;
  let sq = 0;
  let bt = 0;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') dq++;
    else if (c === "'") sq++;
    else if (c === "`") bt++;
    else counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let brackets = 0;
  for (const [o, cl] of PAIRS) brackets += Math.abs((counts.get(o) ?? 0) - (counts.get(cl) ?? 0));
  const quotes = (dq % 2) + (sq % 2) + (bt % 2);
  return { brackets, quotes };
}

export interface VerifyResult {
  ok: boolean;
  /** set when ok=false — why the candidate was rejected. */
  reason?: string;
  /** non-blocking notes (blast-radius size, quote-parity change, …). */
  warnings: string[];
}

/** The count of leading + trailing IDENTICAL lines shared by two strings (blast-radius helper). */
export function changedLineRange(
  before: string,
  after: string,
): { start: number; endBefore: number; endAfter: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  return { start: pre, endBefore: a.length - suf, endAfter: b.length - suf };
}

/**
 * Verify a candidate edit. Blocks when the edit makes bracket balance strictly worse than
 * the original (a near-certain sign a delimiter was dropped mid-splice). Quote-parity
 * worsening is a WARNING not a block (apostrophes-in-prose make it noisy). Blast-radius is
 * reported as a warning; the applier owns the hard span check.
 */
export function verifyEdit(before: string, after: string): VerifyResult {
  const warnings: string[] = [];
  const b0 = balanceScore(before);
  const b1 = balanceScore(after);
  if (b1.brackets > b0.brackets) {
    return {
      ok: false,
      reason: `edit unbalances brackets (${b0.brackets}→${b1.brackets}) — a delimiter was likely dropped`,
      warnings,
    };
  }
  if (b1.quotes > b0.quotes) warnings.push(`quote parity worsened (${b0.quotes}→${b1.quotes})`);
  const r = changedLineRange(before, after);
  warnings.push(
    `changed lines ${r.start + 1}..${r.endAfter} (${Math.max(0, r.endAfter - r.start)} line(s))`,
  );
  return { ok: true, warnings };
}
