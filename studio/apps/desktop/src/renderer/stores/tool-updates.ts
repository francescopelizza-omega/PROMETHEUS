// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * stores/tool-updates.ts — Studio's view of the THIRD-PARTY update report.
 *
 * A thin shell around `tool-updates-derive.ts`, which holds every decision and carries no
 * dependencies. This file owns only the async lifecycle: ask the main process, remember the
 * answer, remember whether a request is in flight.
 *
 * Not to be confused with Studio's OWN updater (`main/updater.ts` + `window.prometheus.updates`),
 * which drives electron-updater and replaces the app binary. This is the report about everything
 * ELSE the machine runs: the agent CLIs, the model engines, the toolchain, the package managers,
 * the local models, and the install conflicts between them.
 *
 * Renderer-SANDBOXED (C5): zustand + the typed contextBridge only. No node:*, no engine-bridge,
 * and nothing here ever RUNS a command — the report carries copyable text and the user decides.
 */

import { create } from "zustand";

import type { UpdatesReportResult } from "../../shared/ipc-contract.js";
import {
  type UpdatesBadge,
  type UpdatesCounts,
  badgeLabel,
  copyableCommands,
  countReport,
  deriveBadge,
} from "./tool-updates-derive.js";

interface ToolUpdatesState {
  report: UpdatesReportResult | null;
  /** true while a check is in flight — a second click must not start a second sweep. */
  checking: boolean;
  /** when the last successful check ran, ISO. */
  checkedAt: string | null;
  /** the last transport-level failure, distinct from a report that says `ok: false`. */
  error: string | null;
  /**
   * Run a check. `force` skips the 6-hour throttle, which is what a "Check now" button means.
   * Never rejects — a failed update check is not a reason to break a panel.
   */
  check: (force?: boolean) => Promise<void>;
  badge: () => UpdatesBadge;
  counts: () => UpdatesCounts;
  label: () => string;
  commands: () => string[];
}

export const useToolUpdates = create<ToolUpdatesState>((set, get) => ({
  report: null,
  checking: false,
  checkedAt: null,
  error: null,

  check: async (force = false) => {
    // In flight already: a "Check now" double-click must not spawn `brew outdated` twice.
    if (get().checking) return;
    set({ checking: true, error: null });
    try {
      const api = (
        globalThis as {
          prometheus?: { toolUpdates?: { check(f?: boolean): Promise<UpdatesReportResult> } };
        }
      ).prometheus?.toolUpdates;
      if (!api) {
        // The bridge is absent in a plain-browser dev harness. Say so rather than rendering an
        // empty report, which would read as "nothing to update".
        set({ checking: false, error: "the update bridge is not available in this window" });
        return;
      }
      const report = await api.check(force);
      set({
        report,
        checking: false,
        checkedAt: report.checkedAt ?? null,
        error: report.ok ? null : (report.error ?? "the update check failed"),
      });
    } catch (e) {
      set({ checking: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  badge: () => deriveBadge(get().report),
  counts: () => countReport(get().report),
  label: () => badgeLabel(deriveBadge(get().report), countReport(get().report)),
  commands: () => copyableCommands(get().report),
}));
