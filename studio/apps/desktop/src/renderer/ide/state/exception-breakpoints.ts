/**
 * ide/state/exception-breakpoints.ts — the PURE exception-breakpoint filter model
 * (APP-079).
 *
 * DAP exception breakpoints are ADAPTER-defined: the `initialize` response's
 * `exceptionBreakpointFilters` lists the toggleable filters (debugpy: `raised` +
 * `uncaught`), each with a `default` state. The user arms a SUBSET of their IDs; we
 * send `setExceptionBreakpoints { filters }` — at the host's `initialized` phase AND
 * on every live toggle (`{ filters: [] }` clears; OMITTING the request would leave
 * the adapter's prior filters active, so a toggle-off must still send the survivors).
 *
 * The enabled set is a SORTED, de-duped list of filter IDs. Reducers are PURE +
 * same-ref no-ops (node:test-able without zustand). The zustand facade at the bottom
 * seeds the adapter's `default:true` filters ONCE per session (the first time
 * capabilities are seen) so "uncaught" is armed out of the box without clobbering a
 * user's later choice.
 *
 * Imports: zustand only. NO monaco / electron / node:* (renderer sandbox, C5).
 */

import { create } from "zustand";

import type { IdeDapExceptionFilter } from "../../../shared/ipc-contract.js";

/** The adapter filters whose `default` state is on — the initial armed set. */
export function defaultExceptionFilters(filters: IdeDapExceptionFilter[]): string[] {
  return filters
    .filter((f) => f.default === true)
    .map((f) => f.filter)
    .sort();
}

/** Arm/disarm one filter id (sorted + de-duped; same-ref no-op when unchanged). */
export function toggleExceptionFilter(enabled: string[], id: string, on: boolean): string[] {
  const has = enabled.includes(id);
  if (on === has) return enabled;
  const next = on ? [...enabled, id] : enabled.filter((x) => x !== id);
  return next.sort();
}

/** Is this filter id currently armed? */
export function isExceptionFilterEnabled(enabled: string[], id: string): boolean {
  return enabled.includes(id);
}

/** Drop armed ids the adapter no longer advertises (a different adapter's filter set). */
export function pruneExceptionFilters(
  enabled: string[],
  filters: IdeDapExceptionFilter[],
): string[] {
  const known = new Set(filters.map((f) => f.filter));
  const next = enabled.filter((id) => known.has(id));
  return next.length === enabled.length ? enabled : next;
}

/* ── the zustand facade ────────────────────────────────────────────────────────*/

export interface ExceptionFilterStore {
  /** the armed filter ids (sorted, de-duped). */
  enabled: string[];
  /** whether the adapter defaults have been seeded this session (once). */
  seeded: boolean;
  /** seed the adapter's `default:true` filters the FIRST time capabilities are seen. */
  seed(filters: IdeDapExceptionFilter[]): void;
  toggle(id: string, on: boolean): void;
  /** drop ids the adapter no longer advertises (adapter/type switch). */
  prune(filters: IdeDapExceptionFilter[]): void;
}

export const useExceptionFilterStore = create<ExceptionFilterStore>((set) => ({
  enabled: [],
  seeded: false,
  seed: (filters): void =>
    set((s) => (s.seeded ? s : { ...s, enabled: defaultExceptionFilters(filters), seeded: true })),
  toggle: (id, on): void =>
    set((s) => {
      const next = toggleExceptionFilter(s.enabled, id, on);
      return next === s.enabled ? s : { ...s, enabled: next };
    }),
  prune: (filters): void =>
    set((s) => {
      const next = pruneExceptionFilters(s.enabled, filters);
      return next === s.enabled ? s : { ...s, enabled: next };
    }),
}));
