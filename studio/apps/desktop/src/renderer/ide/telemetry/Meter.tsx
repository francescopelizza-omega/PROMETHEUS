// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/telemetry/Meter.tsx — a labeled horizontal occupancy bar (token colors only).
 *
 * Draws "used / free" for one resource: a track with a tone-colored fill sized to
 * usedPct. A `measured:false` meter renders a dashed, greyed track ("n/a").
 */
import type { ReactElement } from "react";

import { type MeterTone, meterTone, toneVar } from "./telemetry-view.js";

export interface MeterProps {
  /** the resource name, e.g. "RAM", "CPU", "Disk". */
  label: string;
  /** 0-100 percent occupied. */
  usedPct: number;
  /** right-aligned detail, e.g. "12.4 GB / 32 GB" or "n/a". */
  detail?: string;
  /** false ⇒ the figure is not exposed (dashed grey track). */
  measured?: boolean;
  /** override the auto severity tone (else derived from usedPct). */
  tone?: MeterTone;
  /** a secondary note under the bar (e.g. "unified memory"). */
  note?: string;
  /** compact mode: thinner bar, smaller type (used by the status-bar strip). */
  compact?: boolean;
}

export function Meter({
  label,
  usedPct,
  detail,
  measured = true,
  tone,
  note,
  compact = false,
}: MeterProps): ReactElement {
  const t = tone ?? meterTone(usedPct);
  const fill = Math.max(0, Math.min(100, usedPct));
  const height = compact ? 5 : 9;
  const fontSize = compact ? "0.66rem" : "var(--text-small-size, 0.8125rem)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: compact ? 1 : 3, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize }}>
        <span
          style={{
            color: "var(--text-primary)",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <span style={{ color: measured ? toneVar(t) : "var(--text-secondary)", fontWeight: 600 }}>
          {measured ? `${Math.round(usedPct)}%` : "n/a"}
        </span>
        <span style={{ flex: 1 }} />
        {detail && (
          <span
            style={{
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
            }}
          >
            {detail}
          </span>
        )}
      </div>
      <div
        aria-hidden="true"
        style={{
          height,
          borderRadius: "var(--radius-sm, 4px)",
          background: "var(--bg-inset)",
          border: measured ? "1px solid var(--border-subtle)" : "1px dashed var(--border-subtle)",
          overflow: "hidden",
        }}
      >
        {measured && (
          <div
            style={{
              width: `${fill}%`,
              height: "100%",
              background: toneVar(t),
              transition: "width 400ms ease",
            }}
          />
        )}
      </div>
      {note && !compact && (
        <span style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>{note}</span>
      )}
    </div>
  );
}

export default Meter;
