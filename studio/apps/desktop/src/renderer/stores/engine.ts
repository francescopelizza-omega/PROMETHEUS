/**
 * renderer/stores/engine.ts — the Zustand engine slice (§5).
 *
 * Zustand owns UI/SESSION state; TanStack Query owns fetching/caching (query/).
 * This slice holds the engine/scanner HEALTH the title-bar pill renders, plus a
 * `refreshHealth()` action that pulls a fresh probe through the contextBridge
 * (`window.prometheus.health`). The renderer reaches the engine ONLY through that
 * seam — it imports ZERO engine-bridge runtime and never sees a Python path (C5).
 *
 * The pill COLOUR derivation (green/amber/red) is a PURE function exported so it
 * is unit-testable with node:test WITHOUT zustand, react, or a DOM. The store is
 * a thin shell around it.
 *
 * Imports: zustand + the PLAIN-DATA types from the shared contract only.
 */

import { create } from "zustand";

import type { HealthResult } from "../../shared/ipc-contract.js";
import { type HealthPill, deriveHealthPill } from "./health-derive.js";

// Re-export the pure derivation so callers can keep importing it from the store.
export { deriveHealthPill, type HealthPill } from "./health-derive.js";

/** The minimal slice of `window.prometheus` this store calls (testable seam). */
export interface EngineApiLike {
  health(): Promise<HealthResult>;
}

/** Resolve the contextBridge API at call time (undefined in non-renderer tests). */
function resolveApi(): EngineApiLike | undefined {
  const w = globalThis as { prometheus?: EngineApiLike };
  return w.prometheus;
}

/** The engine slice shape. */
export interface EngineStore {
  /** the latest health probe, or null before the first refresh. */
  health: HealthResult | null;
  /** derived pill colour for the title bar (kept in sync with `health`). */
  pill: HealthPill;
  /** true while a refresh is in flight (the pill can show a spinner). */
  refreshing: boolean;
  /** the last refresh error message, if any (cleared on success). */
  error: string | null;
  /** Pull a fresh health probe through the contextBridge seam. */
  refreshHealth(): Promise<void>;
  /** Directly set a health value (used by tests / Query-side prefetch). */
  setHealth(health: HealthResult): void;
}

// monotonic request id: only the LATEST refreshHealth response is applied, so spamming
// the refresh button can't let a slow stale response overwrite a newer one.
let healthReqId = 0;

export const useEngineStore = create<EngineStore>((set) => ({
  health: null,
  pill: "unknown",
  refreshing: false,
  error: null,

  setHealth: (health: HealthResult): void =>
    set({ health, pill: deriveHealthPill(health), error: null }),

  refreshHealth: async (): Promise<void> => {
    const api = resolveApi();
    if (!api) {
      // No bridge (e.g. SSR/test): record the condition without throwing.
      set({ error: "engine bridge unavailable", pill: "down", refreshing: false });
      return;
    }
    const myReq = ++healthReqId;
    set({ refreshing: true });
    try {
      const health = await api.health();
      if (myReq !== healthReqId) return; // a newer refresh superseded this one
      set({ health, pill: deriveHealthPill(health), error: null, refreshing: false });
    } catch (e) {
      if (myReq !== healthReqId) return;
      set({
        error: e instanceof Error ? e.message : String(e),
        pill: "down",
        refreshing: false,
      });
    }
  },
}));
