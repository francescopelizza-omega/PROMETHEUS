/**
 * renderer/stores/telemetry.ts — the live PC-telemetry Zustand slice.
 *
 * Holds the latest whole-machine snapshot (CPU/GPU/NPU/RAM/DISK + the launch guard)
 * pulled from the MAIN process over the `system:telemetry` seam. ONE poller (App
 * mounts `useTelemetryPolling`) refreshes this store; the bottom-bar strip + the
 * System panel both read it, so there is a single poll loop, not one per view.
 *
 * The renderer reaches the machine ONLY through window.prometheus.systemTelemetry —
 * it imports zero node:os and never re-derives a reading (C5).
 */
import { create } from "zustand";

import type { SystemTelemetry } from "../../shared/ipc-contract.js";

/** The minimal slice of `window.prometheus` this store calls (testable seam). */
interface TelemetryApiLike {
  systemTelemetry(): Promise<SystemTelemetry>;
}

function resolveApi(): TelemetryApiLike | undefined {
  const w = globalThis as { prometheus?: TelemetryApiLike };
  return w.prometheus?.systemTelemetry ? w.prometheus : undefined;
}

export interface TelemetryStore {
  /** the latest snapshot, or null before the first poll. */
  telemetry: SystemTelemetry | null;
  /** the last refresh error message, if any (cleared on success). */
  error: string | null;
  /** Pull a fresh telemetry snapshot through the contextBridge seam. */
  refresh(): Promise<void>;
}

// only the LATEST refresh is applied so a slow response can't overwrite a newer one.
let reqId = 0;

export const useTelemetryStore = create<TelemetryStore>((set) => ({
  telemetry: null,
  error: null,
  refresh: async (): Promise<void> => {
    const api = resolveApi();
    if (!api) {
      set({ error: "telemetry bridge unavailable" });
      return;
    }
    const my = ++reqId;
    try {
      const t = await api.systemTelemetry();
      if (my !== reqId) return;
      set({ telemetry: t, error: t.ok ? null : (t.error ?? "telemetry read failed") });
    } catch (e) {
      if (my !== reqId) return;
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
