/**
 * HealthGauge.tsx — a 0–100 system-health score ring (Reliability & Polish pack).
 *
 * An SVG ring filled to the score, banded by role token (ok ≥80 · warn ≥50 · danger),
 * with the number + a glyph at the center — never color-only (08 §7). Pure presentational:
 * the score/tier come from core's `aggregateHealth` (props). Token colors only (no hex).
 */
import type { ReactElement } from "react";

import {
  type HealthViewTier,
  clampScore,
  ringGeometry,
  scoreRole,
  tierGlyph,
} from "./health-view.js";
import { v } from "./primitives/styles.js";

export interface HealthGaugeProps {
  /** 0–100 health score. */
  score: number;
  /** the overall tier (drives the glyph); defaults from the score band. */
  tier?: HealthViewTier;
  /** outer diameter in px (default 96). */
  size?: number;
  label?: string;
  className?: string;
}

/** <HealthGauge score> — banded score ring + center readout. */
export function HealthGauge({
  score,
  tier,
  size = 96,
  label,
  className,
}: HealthGaugeProps): ReactElement {
  const s = clampScore(score);
  const role = scoreRole(s); // "ok" | "warn" | "danger"
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const { circumference, dashOffset } = ringGeometry(s, radius);
  const center = size / 2;
  const effectiveTier: HealthViewTier =
    tier ?? (role === "ok" ? "ok" : role === "warn" ? "degraded" : "down");

  return (
    <div
      className={className}
      role="meter"
      aria-valuenow={s}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`System health ${s} of 100${label ? ` — ${label}` : ""}`}
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--space-1, 2px)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        style={{ transform: "rotate(-90deg)" }}
      >
        <title>health score</title>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={v("border-subtle")}
          strokeWidth={stroke}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={v(role)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ transition: "stroke-dashoffset var(--motion-panel, 240ms) ease-out" }}
        />
      </svg>
      <div
        style={{
          marginTop: `-${Math.round(size * 0.62)}px`,
          marginBottom: `${Math.round(size * 0.34)}px`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          color: `var(--${role})`,
        }}
      >
        <span aria-hidden="true" style={{ fontSize: "0.9em" }}>
          {tierGlyph(effectiveTier)}
        </span>
        <strong
          style={{
            fontSize: `${Math.round(size * 0.26)}px`,
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {s}
        </strong>
      </div>
      {label && (
        <span
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          {label}
        </span>
      )}
    </div>
  );
}

export default HealthGauge;
