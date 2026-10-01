// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * StatusMark.tsx — the install-presence glyph shared by the catalog row, the install panel,
 * and (via the same tri-state) the CLI `/invoke` picker.
 *
 *   present → green ✓ (the engine confirms it is on this machine)
 *   absent  → red ✗  (the engine confirms it is NOT)
 *   unknown → neutral · (the engine cannot statically determine it — never a false ✗)
 *
 * Color is token-driven (var(--ok)/var(--danger)/var(--text-secondary)) — no raw hex (§6) —
 * and is NEVER the only signal: the glyph shape + the title/aria-label carry the meaning too
 * (08 §7 accessibility). Pure presentational; the caller supplies the reconciled presence.
 */

import type { ReactElement } from "react";

export type Presence = "present" | "absent" | "unknown";

const MARK: Record<Presence, { glyph: string; color: string; label: string }> = {
  present: { glyph: "✓", color: "var(--ok)", label: "installed on this machine" },
  absent: { glyph: "✗", color: "var(--danger)", label: "not installed" },
  unknown: {
    glyph: "•",
    color: "var(--text-secondary)",
    label: "install status unknown",
  },
};

export interface StatusMarkProps {
  presence: Presence;
  /** also render the text label next to the glyph (default false — glyph only). */
  withLabel?: boolean;
}

export function StatusMark({ presence, withLabel = false }: StatusMarkProps): ReactElement {
  const m = MARK[presence];
  return (
    <span
      title={m.label}
      aria-label={m.label}
      style={{
        color: m.color,
        fontFamily: "var(--font-mono)",
        fontWeight: 700,
        display: "inline-flex",
        gap: "0.3rem",
        alignItems: "center",
      }}
    >
      <span aria-hidden="true">{m.glyph}</span>
      {withLabel && (
        <span style={{ fontSize: "var(--text-small-size, 0.8125rem)", fontWeight: 500 }}>
          {presence === "present"
            ? "Installed"
            : presence === "absent"
              ? "Not installed"
              : "Unknown"}
        </span>
      )}
    </span>
  );
}
