/**
 * ide/telemetry/TelemetryStrip.tsx — the compact live readout on the RIGHT of the
 * bottom-panel tab row. Always-visible CPU + RAM mini-meters + a guard dot; clicking
 * opens the full System panel. Reads the shared telemetry store (App owns the poll).
 */
import type { ReactElement } from "react";

import { useTelemetryStore } from "../../stores/telemetry.js";
import { Meter } from "./Meter.js";
import { toneVar } from "./telemetry-view.js";

export interface TelemetryStripProps {
  /** open the full System panel (the strip is a shortcut to it). */
  onOpen?: () => void;
}

export function TelemetryStrip({ onOpen }: TelemetryStripProps): ReactElement | null {
  const t = useTelemetryStore((s) => s.telemetry);
  if (!t) return null;
  const blocked = !t.guard.allow;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={
        blocked
          ? (t.guard.reason ?? "System under heavy load")
          : `CPU ${t.cpu.usedPct}% · RAM ${t.ram.usedPct}% — open System telemetry`
      }
      aria-label="System telemetry"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "transparent",
        border: "none",
        cursor: "pointer",
        padding: "0 2px",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          flexShrink: 0,
          background: blocked ? "var(--danger)" : toneVar("ok"),
          boxShadow: blocked ? "0 0 4px var(--danger)" : "none",
        }}
      />
      <div style={{ width: 74 }}>
        <Meter label="CPU" usedPct={t.cpu.usedPct} measured={t.cpu.measured} compact />
      </div>
      <div style={{ width: 74 }}>
        <Meter label="RAM" usedPct={t.ram.usedPct} measured={t.ram.measured} compact />
      </div>
    </button>
  );
}

export default TelemetryStrip;
