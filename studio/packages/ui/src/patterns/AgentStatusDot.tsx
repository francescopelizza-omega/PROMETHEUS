/**
 * AgentStatusDot.tsx — a superscan agent's presence + counts (08 §3.2). The TUI
 * ScanView dot grammar promoted to a GUI molecule: `● ◐ ○` + the counts string
 * `Np Ss Mm Xx Rr Cc` (plugins/skills/mcp/external/rules/commands).
 *
 * Binds an `AgentPresence` + `AgentCounts` (mirror of superscan agent counts) via a
 * TYPE-ONLY import (C5). The renderer passes a real scan result straight in.
 *
 * GOLDEN RULE (C5): pure projection — the dot glyph/color is `presence`, the counts
 * are the engine's. The presence dot carries an aria-label (color never alone, 08 §7).
 */

import type { ReactElement } from "react";
import type { AgentCounts, AgentPresence } from "./types.js";
import { countsLabel, countsTotal, inert, presenceGlyph, presenceVar } from "./util.js";

export interface AgentStatusDotProps {
  /** The agent's display name (e.g. "claude", "cursor"); rendered inert. */
  name?: string;
  presence: AgentPresence;
  counts?: AgentCounts;
  /** Dot + counts inline (default), vs. dot-only (compact status-bar use). */
  compact?: boolean;
  className?: string;
}

export function AgentStatusDot({
  name,
  presence,
  counts,
  compact = false,
  className,
}: AgentStatusDotProps): ReactElement {
  const color = presenceVar(presence);
  const glyph = presenceGlyph(presence);
  const label = countsLabel(counts);
  const total = countsTotal(counts);
  const safeName = inert(name ?? "");
  const spoken = `${safeName ? `${safeName}, ` : ""}${presence}${total > 0 ? `, ${total} items` : ""}`;

  return (
    <span
      className={className}
      data-presence={presence}
      aria-label={spoken}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2, 4px)",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      <span aria-hidden="true" style={{ color, fontFamily: "var(--font-mono)", lineHeight: 1 }}>
        {glyph}
      </span>
      {!compact && safeName.length > 0 && (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{safeName}</span>
      )}
      {!compact && label.length > 0 && (
        <span
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

export default AgentStatusDot;
