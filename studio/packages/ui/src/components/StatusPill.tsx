// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * StatusPill.tsx — a compact role-tinted status chip (Reliability & Polish pack).
 *
 * For a per-component health row / inline status (distinct from VerdictBadge = nemesis
 * tier, Badge = generic role): renders a glyph + label tinted by a health status, on a
 * subtle tint of its own role. Pure presentational; token colors only (no hex).
 */
import type { ReactElement } from "react";

import { type HealthViewStatus, statusGlyph, statusRole } from "./health-view.js";

export interface StatusPillProps {
  status: HealthViewStatus;
  label: string;
  className?: string;
  title?: string;
}

/** <StatusPill status label> — glyph + label on a 14%-tint of the status role. */
export function StatusPill({ status, label, className, title }: StatusPillProps): ReactElement {
  const role = statusRole(status); // "ok" | "warn" | "danger" | "text-secondary"
  const color = `var(--${role})`;
  return (
    <span
      className={className}
      title={title}
      data-status={status}
      aria-label={`${label}: ${status}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1, 2px)",
        padding: "0 var(--space-2, 4px)",
        borderRadius: "var(--radius-full, 9999px)",
        // a soft tint of the role behind the chip (color-mix is no-raw-hex allowed).
        background: `color-mix(in srgb, ${color} 14%, var(--bg-surface))`,
        color,
        fontFamily: "var(--font-ui)",
        fontSize: "var(--text-small-size, 0.8125rem)",
        lineHeight: 1.6,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">{statusGlyph(status)}</span>
      {label}
    </span>
  );
}

export default StatusPill;
