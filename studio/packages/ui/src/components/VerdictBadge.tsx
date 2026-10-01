// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * VerdictBadge.tsx — the load-bearing atom (08 §3.2). Renders a nemesis
 * VerdictTier as a pill: glyph + UPPERCASE label + (optional) risk score in
 * mono. Tokenized exactly like the TUI's VerdictBadge so green/amber/red mean
 * the same thing everywhere (08 rule #1).
 *
 * GOLDEN RULE (C5): this component NEVER decides safe — it only renders a tier
 * the engine/nemesis already returned. The `error` tier carries the distinct
 * ⚠ glyph + "SCAN FAILED" copy (fail-closed; 08 §2.2/§5.2).
 *
 * Color comes from the role token (VERDICT_ROLE → --ok/--warn/--danger), never
 * a raw hex. The glyph carries meaning WITHOUT color for accessibility (08 §7).
 */

import type { ReactElement } from "react";
import { t } from "../i18n/index.js";
import {
  type RoleToken,
  VERDICT_GLYPH,
  VERDICT_LABEL,
  VERDICT_ROLE,
  type VerdictTier,
} from "../tokens.js";

/** Map a role token to its CSS-var color (08 §2.2). */
function roleVar(role: RoleToken): string {
  return role === "text-secondary" ? "var(--text-secondary)" : `var(--${role})`;
}

export interface VerdictBadgeProps {
  /** The decision axis — the only thing that drives color + glyph (C3). */
  verdict: VerdictTier;
  /** nemesis risk_score 0–100; rendered in mono when present. */
  risk_score?: number;
  /** Compact = glyph only (status-bar shield); default shows the label. */
  compact?: boolean;
  /**
   * Live-region behaviour (08 §7). Default "off" — the badge is an inert label.
   * The GATE verdict surface announces via its own assertive header region; the
   * permanent status-bar shield must NOT re-announce on every re-render. Set
   * "assertive"/"polite" only when this badge IS the announcement channel.
   */
  live?: "off" | "polite" | "assertive";
  className?: string;
  /** aria-label override; defaults to a spoken sentence (08 §7 screen readers). */
  "aria-label"?: string;
}

/**
 * <VerdictBadge verdict risk_score>. Inline styles read role CSS vars so the
 * badge re-tones with the active theme without any hardcoded color.
 */
export function VerdictBadge({
  verdict,
  risk_score,
  compact = false,
  live = "off",
  className,
  "aria-label": ariaLabel,
}: VerdictBadgeProps): ReactElement {
  const role = VERDICT_ROLE[verdict];
  const color = roleVar(role);
  const glyph = VERDICT_GLYPH[verdict];
  const label = VERDICT_LABEL[verdict];
  const spoken =
    ariaLabel ??
    (typeof risk_score === "number"
      ? t("verdictBadge.spokenRisk", { label, risk: risk_score })
      : t("verdictBadge.spoken", { label }));
  // Live region is opt-in (08 §7): off = inert label (no chatty re-announce).
  const liveProps = live === "off" ? {} : ({ role: "status", "aria-live": live } as const);

  return (
    <span
      {...liveProps}
      aria-label={spoken}
      className={className}
      data-verdict={verdict}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2, 4px)",
        paddingInline: compact ? "var(--space-2, 4px)" : "var(--space-4, 8px)",
        paddingBlock: "var(--space-1, 2px)",
        borderRadius: "var(--radius-full, 9999px)",
        border: `1px solid ${color}`,
        color,
        // 14% tint of the role color behind the pill (color-mix keeps it tokenized).
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-code-size, 0.78125rem)",
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: "1em" }}>
        {glyph}
      </span>
      {!compact && <span>{label}</span>}
      {!compact && typeof risk_score === "number" && (
        <span aria-hidden="true" style={{ opacity: 0.85 }}>
          {risk_score}
        </span>
      )}
    </span>
  );
}

export default VerdictBadge;
