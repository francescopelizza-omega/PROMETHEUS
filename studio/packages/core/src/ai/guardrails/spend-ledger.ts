// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/guardrails/spend-ledger.ts — THE shared daily spend ledger.
 *
 * `budget.dailyUsd` was enforced against two disjoint sets of rows. The desktop appended to
 * `<electron userData>/accounting/<YYYY-MM-DD>.jsonl` and read only that; the CLI appended to
 * `$PROMETHEUS_HOME/sessions/<id>.acct.jsonl` and scanned only that directory. Neither reader
 * ever saw the other's rows, so a user running both surfaces on the same day got the cap
 * TWICE — and the one control whose entire job is to stop runaway spend was the control that
 * quietly doubled it.
 *
 * Relocating the desktop directory alone would not have fixed it: the two sides also disagree
 * on the FILE SHAPE (one file per day vs one file per session), so they would still have been
 * reading different windows in the same folder. This is the one file both append to and both
 * read for the DAILY window.
 *
 * What is deliberately NOT changed:
 *   - the per-SESSION windows. The CLI's `<id>.acct.jsonl` still backs `/cost` and the session
 *     cap, and the desktop still derives its session window from process start. A session is
 *     genuinely per-surface; a calendar day is not.
 *   - the fail-closed read. An existing-but-unreadable ledger THROWS, because both callers
 *     (`decideBudget`) depend on that to refuse the turn rather than to wave it through.
 *
 * Still split after this, and worth saying plainly: the CAP is read from two places — the
 * profile TOML under `$PROMETHEUS_HOME/config/profiles/` for the CLI and the `budget.*`
 * settings key for the desktop. One ledger means one number is being counted; it does not yet
 * mean one number is being enforced.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { prometheusHome } from "../../agent/system/host/home.js";

/**
 * One metered call. The union of what both surfaces record: the desktop's five fields plus
 * the CLI's `endpointId` and prompt-cache counts, all of which are optional so either side can
 * write a row the other can read.
 */
export interface SpendLedgerRecord {
  atIso: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** true ⇒ counts were inferred, not reported. A conservative spend FLOOR. */
  estimated: boolean;
  endpointId?: string;
  cacheRead?: number;
  cacheCreate?: number;
}

/**
 * `$PROMETHEUS_HOME/accounting` — the product-wide root, not an app-private one.
 *
 * Every function below takes the directory EXPLICITLY rather than calling this itself. A
 * hidden default here would mean any test that exercises budgeting reads and appends to the
 * developer's real spend log — which is exactly what happened the first time this was wired,
 * and `budget-gate.test.ts` caught it by asserting a fresh store is empty. The two production
 * call sites pass this; the CLI passes `join(home, "accounting")`, so it is isolated by the
 * temp home its tests already use.
 */
export function sharedAccountingDir(): string {
  return join(prometheusHome(), "accounting");
}

/** One file per LOCAL calendar day, so the daily window is a single file read. */
export function dayFileName(atIso: string): string {
  const d = new Date(atIso);
  if (Number.isNaN(d.getTime())) return "invalid.jsonl";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
}

/** The day file containing `atIso`, under an explicit accounting directory. */
export function sharedDayFile(dir: string, atIso: string): string {
  return join(dir, dayFileName(atIso));
}

/**
 * Parse a JSONL ledger into records.
 *
 * A malformed LINE is skipped rather than fatal: one truncated append (a crash mid-write)
 * must not permanently block every future turn. An unreadable FILE is a different thing and
 * is the caller's to throw on.
 */
export function parseLedger(text: string): SpendLedgerRecord[] {
  const out: SpendLedgerRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r: unknown = JSON.parse(t);
      if (!r || typeof r !== "object") continue;
      const rec = r as Partial<SpendLedgerRecord>;
      if (
        typeof rec.atIso !== "string" ||
        typeof rec.model !== "string" ||
        typeof rec.promptTokens !== "number" ||
        typeof rec.completionTokens !== "number"
      ) {
        continue;
      }
      out.push({ ...(rec as SpendLedgerRecord), estimated: rec.estimated === true });
    } catch {
      /* one bad line is skipped — see above */
    }
  }
  return out;
}

/**
 * Append one metered call. BEST EFFORT and never throws: failing to record a turn must not
 * fail the turn. Under-recording is the safe direction — it can only let spend through, and
 * the gate re-reads the file on the next call anyway.
 */
export function appendSharedSpend(dir: string, rec: SpendLedgerRecord): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(sharedDayFile(dir, rec.atIso), `${JSON.stringify(rec)}\n`, "utf8");
  } catch {
    /* best effort — see above */
  }
}

/**
 * Every record written on the local day containing `nowIso`.
 *
 * A missing file is `[]` — the normal first run of the day, not an error. An existing file
 * that cannot be READ throws, so `decideBudget` fails closed rather than treating an
 * unreadable ledger as "nothing spent".
 */
export function readSharedDay(dir: string, nowIso: string): SpendLedgerRecord[] {
  const file = sharedDayFile(dir, nowIso);
  try {
    statSync(file);
  } catch {
    return [];
  }
  return parseLedger(readFileSync(file, "utf8"));
}
