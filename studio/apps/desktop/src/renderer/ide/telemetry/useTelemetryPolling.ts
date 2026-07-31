/**
 * ide/telemetry/useTelemetryPolling.ts — the single telemetry poll loop.
 *
 * Mounted ONCE (App), it refreshes the telemetry store on an interval (default 2s)
 * and on window focus. Every telemetry view reads the store, so there is exactly one
 * poll loop regardless of how many views are open.
 */
import { useEffect } from "react";

import { useTelemetryStore } from "../../stores/telemetry.js";

export function useTelemetryPolling(intervalMs = 2000): void {
  const refresh = useTelemetryStore((s) => s.refresh);
  useEffect(() => {
    let alive = true;
    void refresh();
    const id = setInterval(() => {
      if (alive) void refresh();
    }, intervalMs);
    const onFocus = (): void => {
      if (alive) void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, intervalMs]);
}
