/**
 * GateBadge.tsx — the inline per-package gate verdict chip (file 04 §3.2 column).
 *
 * A TINY presentational chip that paints the verdict tier the ENGINE produced for
 * a package's fetch (✓ clean / ⚠ warn / ⛔ BLOCK / ⚠ error / · ungated). Its
 * color + label are a pure projection of the tier via env/util — this component
 * NEVER scores, never upgrades toward allow, never decides "safe" (C5). An
 * undefined gate renders as the muted "ungated" chip (a read-only row that has
 * never been fetched). Imports only react + this package.
 */

import type { ReactElement } from "react";
import type { EnvGateBadge } from "./types.js";
import { type GateTier, gateGlyph, gateLabel, gateRole, roleVar } from "./util.js";

export interface GateBadgeProps {
  gate?: EnvGateBadge;
  /** show the score next to the label (table detail). */
  showScore?: boolean;
}

export function GateBadge({ gate, showScore = false }: GateBadgeProps): ReactElement {
  const tier: GateTier | undefined = gate?.verdict;
  const role = gateRole(tier);
  return (
    <span
      data-verdict={tier ?? "ungated"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2, 4px)",
        color: roleVar(role),
        fontSize: "var(--text-small-size, 0.8125rem)",
        fontFamily: "var(--font-mono)",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">{gateGlyph(tier)}</span>
      <span>{gateLabel(tier)}</span>
      {showScore && typeof gate?.score === "number" && (
        <span style={{ color: "var(--text-secondary)" }}>{gate.score}</span>
      )}
    </span>
  );
}

export default GateBadge;
