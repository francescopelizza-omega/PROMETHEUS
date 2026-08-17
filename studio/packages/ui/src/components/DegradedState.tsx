/**
 * DegradedState.tsx — the §6 "degraded" panel state.
 *
 * The five states are empty / loading / DEGRADED / error / populated, and this is the
 * one that did not exist anywhere in the app. It is not an error state: an error means
 * *this panel broke*; degraded means *the engine is unreachable, so what you are looking
 * at is the last thing we knew, and here is why*.
 *
 * The rule §6 states, and the reason this component takes `error` as a REQUIRED prop:
 * stale data stays visible and greyed — never blank, never a crash — and the real error
 * is shown rather than paraphrased. A panel that says "something went wrong" teaches the
 * user nothing; "prometheus.py not found at /Users/…" tells them exactly what to fix.
 */

import type { ReactElement, ReactNode } from "react";

export interface DegradedStateProps {
  /** headline — defaults to the §6 wording. */
  title?: string;
  /** the REAL error, in the engine's own words. Never a paraphrase. */
  error: string;
  /** the action that can fix it (§6: "Run doctor"). */
  actionLabel?: string;
  onAction?(): void;
  /**
   * The last known data, rendered GREYED beneath the message. §6: "stale data greyed,
   * never blank" — a panel that had rows before an outage keeps showing them.
   */
  children?: ReactNode;
  className?: string;
}

export function DegradedState({
  title = "Engine unreachable — showing last known state.",
  error,
  actionLabel = "Run doctor",
  onAction,
  children,
  className,
}: DegradedStateProps): ReactElement {
  return (
    <div className={className} role="status" style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          padding: "22px 16px",
          textAlign: "center",
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 20, opacity: 0.5 }}>
          ◔
        </span>
        <span style={{ color: "var(--text-body)", fontSize: 12.5 }}>{title}</span>
        <span
          style={{
            color: "var(--text-disabled)",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            maxWidth: "100%",
            // engine errors carry absolute paths — wrap them inside the panel.
            overflowWrap: "break-word",
            wordBreak: "break-word",
          }}
        >
          {error}
        </span>
        {onAction && (
          <button
            type="button"
            onClick={onAction}
            style={{
              marginTop: 2,
              padding: "6px 14px",
              borderRadius: 8,
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-strong)",
              color: "var(--text-title)",
              fontFamily: "var(--font-ui)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {actionLabel}
          </button>
        )}
      </div>
      {children && (
        // stale, but still yours: dimmed and non-interactive so nothing here is mistaken
        // for live state or acted on by accident.
        <div style={{ opacity: 0.45, pointerEvents: "none" }} aria-label="last known state">
          {children}
        </div>
      )}
    </div>
  );
}

export default DegradedState;
