/**
 * SpendMeter.tsx — the live metered-spend widget (file 12 §4.3).
 *
 * Visible ONLY when a Tier-C connector is active (Tier A has nothing to spend; Tier B
 * is bounded by the subscription). Shows `spentThisMonthUsd / monthlyCapUsd` with an
 * amber/red fill that turns at `warnAtPct`, plus the next call's `lastEstimateUsd`.
 * Pure presentational: the honest token counts are computed in core (§4.3) and passed
 * in. Color rides a semantic role token (never hex); a glyph + label keep it non-color.
 */
import type { ReactElement } from "react";
import { fs, rad, sp, v } from "../components/primitives/styles.js";
import { type SpendMeterModel, spendMeterModel } from "./types.js";

export interface SpendMeterProps {
  providerLabel: string;
  spentUsd: number;
  capUsd: number;
  warnAtPct?: number;
  /** the estimate shown for the NEXT call (§4.3 lastEstimateUsd). */
  lastEstimateUsd?: number;
  /** the onCap policy, surfaced as a caption ("auto-disable at cap"). */
  onCapNote?: string;
  /** compact single-line variant for the status bar. */
  compact?: boolean;
}

const BAND_GLYPH: Record<SpendMeterModel["band"], string> = { ok: "●", warn: "▲", over: "⛔" };

/** The §4.3 spend meter — fill bar + the "$spent / $cap" line, banded by spend. */
export function SpendMeter({
  providerLabel,
  spentUsd,
  capUsd,
  warnAtPct = 0.8,
  lastEstimateUsd,
  onCapNote,
  compact = false,
}: SpendMeterProps): ReactElement {
  const m = spendMeterModel(spentUsd, capUsd, warnAtPct);
  const color = v(m.role);
  const label = `${providerLabel} · ${m.line}${onCapNote ? ` · ${onCapNote}` : ""}`;

  return (
    <div
      data-spend-band={m.band}
      aria-label={`Spend for ${providerLabel}: ${m.line}${m.band === "over" ? " — over cap" : m.band === "warn" ? " — nearing cap" : ""}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: sp(3),
        fontFamily: v("font-ui"),
        fontSize: fs("small"),
        color: v("text-secondary"),
        ...(compact
          ? {}
          : {
              padding: sp(3),
              background: v("bg-inset"),
              borderRadius: rad("md"),
              border: `1px solid ${v("border-subtle")}`,
            }),
      }}
    >
      <span aria-hidden="true" style={{ color }}>
        {BAND_GLYPH[m.band]}
      </span>
      <span style={{ minWidth: 0, color: v("text-primary") }}>{providerLabel}</span>
      <div
        aria-hidden="true"
        style={{
          position: "relative",
          flex: compact ? "0 0 80px" : 1,
          height: "0.5rem",
          background: v("bg-app"),
          borderRadius: rad("full"),
          overflow: "hidden",
          border: `1px solid ${v("border-subtle")}`,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${Math.round(m.fraction * 100)}%`,
            background: color,
            transition: "width var(--motion-hover, 120ms) ease-out",
          }}
        />
      </div>
      <span style={{ color, fontVariantNumeric: "tabular-nums" }}>{m.line}</span>
      {!compact && lastEstimateUsd != null && (
        <span style={{ color: v("text-secondary") }}>· next ~${lastEstimateUsd.toFixed(2)}</span>
      )}
      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

export default SpendMeter;
