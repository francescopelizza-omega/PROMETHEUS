/**
 * RiskGauge.tsx — the §5.2 risk meter (08 §3.2). A linear gauge 0–100 banded by the
 * nemesis verdict thresholds (block ≥ 70, warn ≥ 30): the one place a number becomes
 * a feeling. Renders the §5.2 "████████░░  82  (block ≥ 70)" bar.
 *
 * GOLDEN RULE (C5): NEVER recomputes risk — it renders the `risk_score` the engine
 * produced, bucketed by `riskBand` (a pure projection). A NaN/garbage score fails
 * CLOSED to the danger band. Color is paired with the numeric score + the threshold
 * caption (08 §7, never color alone).
 */

import type { ReactElement } from "react";
import { RISK_BLOCK_THRESHOLD, clampRisk, riskBand, riskFraction, riskVar } from "./util.js";

export interface RiskGaugeProps {
  /** nemesis risk_score 0–100. */
  score: number;
  /** Hide the trailing "(block ≥ 70)" threshold caption (default shown). */
  hideThreshold?: boolean;
  /** A compact single-line variant (status-bar / inline). */
  compact?: boolean;
  className?: string;
  "aria-label"?: string;
}

export function RiskGauge({
  score,
  hideThreshold = false,
  compact = false,
  className,
  "aria-label": ariaLabel,
}: RiskGaugeProps): ReactElement {
  const value = clampRisk(score);
  const band = riskBand(score);
  const color = riskVar(score);
  const pct = Math.round(riskFraction(score) * 100);
  const spoken = ariaLabel ?? `risk ${value} of 100, ${band}`;

  return (
    <div
      className={className}
      data-band={band}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-4, 8px)",
        fontFamily: "var(--font-ui)",
        width: "100%",
      }}
    >
      <div
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={spoken}
        style={{
          position: "relative",
          flex: 1,
          height: compact ? "6px" : "10px",
          borderRadius: "var(--radius-full, 9999px)",
          background: "var(--border-subtle)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: "var(--radius-full, 9999px)",
            background: color,
            transition: "width var(--motion-panel, 180ms) ease-out",
          }}
        />
      </div>
      <span
        style={{
          color,
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: compact
            ? "var(--text-small-size, 0.8125rem)"
            : "var(--text-code-size, 0.78125rem)",
          minWidth: "2.4em",
          textAlign: "right",
        }}
      >
        {value}
      </span>
      {!hideThreshold && !compact && (
        <span
          aria-hidden="true"
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            whiteSpace: "nowrap",
          }}
        >
          (block ≥ {RISK_BLOCK_THRESHOLD})
        </span>
      )}
    </div>
  );
}

export default RiskGauge;
