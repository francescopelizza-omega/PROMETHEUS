/**
 * main/budget-ipc.ts — the `budget:status` ipcMain handler for the Settings ▸ Budget & Spend
 * page (roadmap point 4, RELAY-ONLY).
 *
 * ONE read-only channel: `DesktopBudgetGate.status()` already computes the whole snapshot
 * (spend/caps/unpriced) from the live gate's own store + settings + pricing — this file only
 * relays it. SETTING a cap does NOT get a new channel here: `budget.sessionUsd`/`budget.dailyUsd`/
 * `budget.warnAtPercent`/`budget.unpricedPolicy` already exist as ordinary keys in the generic
 * settings tree (`packages/core/src/settings/schema.ts`), already validated, already wired
 * through the EXISTING `settings:set`/`settings:get` IPC — building a second, parallel write path
 * here would just be two ways to do the same thing.
 *
 * A null gate (`initBudgetGate` has not run yet — should not happen after app startup, but the
 * disposer/re-registration lifecycle makes "not yet" a real, testable state) reports the same
 * safe "no cap configured" snapshot a fresh gate with no settings would — never a thrown error,
 * matching this module's own "null gate ALLOWS" default-safe convention.
 */
import { ipcMain } from "electron";

import type { BudgetStatusResult } from "../shared/ipc-contract.js";
import { IPC } from "../shared/ipc-contract.js";
import { getBudgetGate } from "./budget-gate.js";

const EMPTY_STATUS: BudgetStatusResult = {
  ok: true,
  capped: false,
  config: {},
  sessionSpentUsd: 0,
  dailySpentUsd: 0,
  unpriced: [],
};

function errString(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Register the `budget:status` handler. Returns a disposer (mirrors sibling IPC modules). */
export function registerBudgetIpcHandlers(): () => void {
  ipcMain.handle(IPC.budgetStatus, async (): Promise<BudgetStatusResult> => {
    try {
      const gate = getBudgetGate();
      if (!gate) return EMPTY_STATUS;
      const s = gate.status();
      return {
        ok: true,
        capped: s.capped,
        config: s.config,
        sessionSpentUsd: s.sessionSpentUsd,
        dailySpentUsd: s.dailySpentUsd,
        unpriced: s.unpriced,
      };
    } catch (e) {
      return { ok: false, error: errString(e) };
    }
  });

  return () => {
    ipcMain.removeHandler(IPC.budgetStatus);
  };
}
