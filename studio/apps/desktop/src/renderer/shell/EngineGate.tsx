/**
 * shell/EngineGate.tsx — the §6 DEGRADED state, applied per route.
 *
 * Every route that reads the engine gets the same treatment when the engine is
 * unreachable: the §6 message, the REAL error in the engine's own words, a "Run doctor"
 * action, and the route's own last-known content still visible underneath, greyed.
 *
 * Two things this deliberately does NOT do:
 *   - it does not blank the route. `useEngineStore` never clears `health` on a failed
 *     probe, so the last good data is still in the caches the children read.
 *   - it does not replace the ErrorBoundary. Degraded means "the engine is down";
 *     error means "this panel threw". They are different states with different fixes.
 *
 * "Run doctor" refreshes the health probe and opens the Health panel. It deliberately
 * does NOT promise a structured doctor report — the engine's `doctor` prints human text,
 * not JSON (engine-bridge/types/doctor.ts), so there is nothing structured to show.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the renderer stores only.
 */

import { DegradedState } from "@prometheus/ui";
import type { ReactElement, ReactNode } from "react";

import { useEngineStore } from "../stores/engine.js";

export interface EngineGateProps {
  children: ReactNode;
  /** override the headline for a route where "engine" is not the user's word. */
  title?: string;
}

export function EngineGate({ children, title }: EngineGateProps): ReactElement {
  const pill = useEngineStore((s) => s.pill);
  const health = useEngineStore((s) => s.health);
  const error = useEngineStore((s) => s.error);
  const refreshHealth = useEngineStore((s) => s.refreshHealth);

  if (pill !== "down") return <>{children}</>;

  return (
    <DegradedState
      {...(title ? { title } : {})}
      error={error ?? health?.error ?? "the engine did not answer the health probe"}
      onAction={() => {
        void refreshHealth();
        // the zero-IPC path to the Health panel: the shell's command registry owns it.
        window.dispatchEvent(new CustomEvent("ide:run-shell-command", { detail: "panel.health" }));
      }}
    >
      {children}
    </DegradedState>
  );
}

export default EngineGate;
