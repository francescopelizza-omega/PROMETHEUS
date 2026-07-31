/**
 * ProgressRing.tsx — a circular progress / spinner (Reliability & Polish pack).
 *
 * Determinate (a 0–1 `value` fills the arc) OR indeterminate (omit `value` → a spinning
 * ring, the dedicated Spinner). Complements the existing linear <Progress>. Pure
 * presentational; token colors only (no hex). Honors reduced-motion via the global CSS
 * (the .prom-spin class is disabled under prefers-reduced-motion).
 */
import type { ReactElement } from "react";

import { ringGeometry } from "./health-view.js";

export interface ProgressRingProps {
  /** 0–1 determinate progress; omit for an indeterminate spinner. */
  value?: number;
  /** outer diameter in px (default 20). */
  size?: number;
  /** the role token for the arc color (default "accent"). */
  role?: "accent" | "brand" | "ok" | "warn" | "danger";
  label?: string;
  className?: string;
}

/** <ProgressRing> — determinate arc or indeterminate spinner. */
export function ProgressRing({
  value,
  size = 20,
  role = "accent",
  label,
  className,
}: ProgressRingProps): ReactElement {
  const stroke = Math.max(2, Math.round(size * 0.12));
  const radius = (size - stroke) / 2;
  const center = size / 2;
  const indeterminate = value === undefined;
  const pct = indeterminate ? 25 : Math.max(0, Math.min(100, value * 100));
  const { circumference, dashOffset } = ringGeometry(pct, radius);

  return (
    <span
      className={className}
      // determinate → role=meter + value props (non-interactive, like <HealthGauge>);
      // indeterminate → role=status live region (no value props, not a widget).
      {...(indeterminate
        ? { role: "status", "aria-live": "polite" as const }
        : {
            role: "meter",
            "aria-valuenow": Math.round(pct),
            "aria-valuemin": 0,
            "aria-valuemax": 100,
          })}
      aria-label={label ?? (indeterminate ? "loading" : `${Math.round(pct)}%`)}
      style={{ display: "inline-flex" }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        className={indeterminate ? "prom-spin" : undefined}
        style={{ transform: "rotate(-90deg)" }}
      >
        <title>{indeterminate ? "loading" : "progress"}</title>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--border-subtle)"
          strokeWidth={stroke}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={`var(--${role})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={
            indeterminate
              ? undefined
              : { transition: "stroke-dashoffset var(--motion-hover, 120ms) ease-out" }
          }
        />
      </svg>
    </span>
  );
}

/** A bare indeterminate <Spinner> (ProgressRing with no value). */
export function Spinner({
  size = 16,
  role = "accent",
  label = "loading",
}: { size?: number; role?: ProgressRingProps["role"]; label?: string }): ReactElement {
  return <ProgressRing size={size} role={role} label={label} />;
}

export default ProgressRing;
