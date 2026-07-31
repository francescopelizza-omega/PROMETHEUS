/**
 * marketplace/VerdictChip.tsx — the compact worst_verdict chip (file 09 §6).
 *
 * A token-only pill: glyph + label tinted by the verdict ROLE (--ok/--warn/--danger),
 * never a raw hex. The color is a pure projection of the engine's worst_verdict — the
 * chip never computes safety. A screen-reader label always carries the tier (§7 a11y).
 */
import type { ReactElement } from "react";
import { roleVar } from "../patterns/util.js";
import { type WorstVerdict, verdictChip } from "./types.js";

export interface VerdictChipProps {
  verdict?: WorstVerdict;
  /** glyph-only (no text label) — still announces the tier via aria-label. */
  compact?: boolean;
}

export function VerdictChip({ verdict, compact }: VerdictChipProps): ReactElement {
  const { glyph, label, role } = verdictChip(verdict);
  const color = roleVar(role);
  return (
    <span
      role="status"
      aria-label={`security verdict: ${label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2, 4px)",
        color,
        border: `1px solid ${color}`,
        borderRadius: "var(--radius-full, 9999px)",
        padding: "var(--space-1, 2px) var(--space-3, 6px)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-small-size, 0.8125rem)",
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">{glyph}</span>
      {!compact && <span>{label}</span>}
    </span>
  );
}
