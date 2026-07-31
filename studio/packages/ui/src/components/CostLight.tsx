/**
 * CostLight.tsx — the provider cost-tier light (C11 + 13 §1.4).
 *
 * Provider promotion policy (C11): Tier A local-open-free (green, default) >
 * Tier B subscription-covers-IDE (blue) > Tier C metered (red, never promoted;
 * a Tier C light is the visual precondition for the loud cost modal + typed
 * "ENABLE METERED" confirm). This atom is ONLY the light — it renders the tier,
 * it does not gate; the cost modal lives in desktop/12.
 *
 * Like every state signal in the product, color is never the sole channel: a
 * glyph + a spoken label accompany the dot (08 §7).
 */

import type { ReactElement } from "react";

/** The three cost tiers (C11). */
export type CostTier = "A" | "B" | "C";

interface TierSpec {
  /** CSS-var color for the light. A=green, B=accent-blue, C=danger-red. */
  color: string;
  glyph: string;
  label: string;
  hint: string;
}

const TIER: Record<CostTier, TierSpec> = {
  A: {
    color: "var(--ok)",
    glyph: "●",
    label: "Local · free",
    hint: "Tier A — local, open, free. Default brain.",
  },
  B: {
    // Tier B "blue" maps to the accent role (cyan/blue family) — tokenized.
    color: "var(--accent)",
    glyph: "◆",
    label: "Subscription",
    hint: "Tier B — covered by your IDE subscription.",
  },
  C: {
    color: "var(--danger)",
    glyph: "▲",
    label: "Metered",
    hint: "Tier C — metered/paid. Cost confirm required before use.",
  },
};

export interface CostLightProps {
  tier: CostTier;
  /** Show the text label next to the dot (default true). */
  showLabel?: boolean;
  className?: string;
  title?: string;
}

/** <CostLight tier> — green/blue/red tier light with glyph + label. */
export function CostLight({
  tier,
  showLabel = true,
  className,
  title,
}: CostLightProps): ReactElement {
  const spec = TIER[tier];
  return (
    <span
      className={className}
      data-cost-tier={tier}
      title={title ?? spec.hint}
      aria-label={`Cost tier ${tier}: ${spec.label}. ${spec.hint}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2, 4px)",
        color: spec.color,
        fontFamily: "var(--font-ui)",
        fontSize: "var(--text-small-size, 0.8125rem)",
        lineHeight: 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: "0.7em",
          height: "0.7em",
          borderRadius: "var(--radius-full, 9999px)",
          background: spec.color,
          boxShadow: `0 0 6px ${spec.color}`,
        }}
      />
      {showLabel && <span style={{ color: "var(--text-secondary)" }}>{spec.label}</span>}
    </span>
  );
}

export default CostLight;
