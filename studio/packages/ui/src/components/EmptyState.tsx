// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * EmptyState.tsx — a polished empty/placeholder block (Reliability & Polish pack).
 *
 * The "nice empty" for any pane with no data yet (no tests, no sessions, no results):
 * a centered glyph + title + hint + optional call-to-action. Pure presentational; token
 * colors only (no hex). Raises the product's perceived completeness + appeal.
 */
import type { ReactElement, ReactNode } from "react";

import { Button } from "./Button.js";

export interface EmptyStateProps {
  /** a glyph or icon node shown above the title. */
  icon?: ReactNode;
  title: string;
  hint?: string;
  /** an optional primary action. */
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

/** <EmptyState> — centered icon + title + hint + optional CTA. */
export function EmptyState({
  icon,
  title,
  hint,
  actionLabel,
  onAction,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div
      className={className}
      role="note"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: "var(--space-3, 6px)",
        padding: "var(--space-12, 24px)",
        color: "var(--text-secondary)",
        fontFamily: "var(--font-ui)",
      }}
    >
      {icon != null && (
        <div
          aria-hidden="true"
          style={{ fontSize: "1.75rem", opacity: 0.8, color: "var(--text-disabled)" }}
        >
          {icon}
        </div>
      )}
      <strong style={{ color: "var(--text-primary)", fontSize: "var(--text-body-size, 0.875rem)" }}>
        {title}
      </strong>
      {hint && (
        <span style={{ maxWidth: "42ch", fontSize: "var(--text-small-size, 0.8125rem)" }}>
          {hint}
        </span>
      )}
      {actionLabel && onAction && (
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

export default EmptyState;
