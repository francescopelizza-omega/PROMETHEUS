// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * SystemHealthPanel.tsx — the System Health bottom-panel surface (Reliability & Polish pack).
 *
 * The graphical health dashboard: a banded score gauge + a per-component status list with
 * remediation hints. Presentational + controlled: the `SystemHealthView` is derived from
 * the engine probe (health-panel-view.ts) and passed in. Uses @prometheus/ui atoms
 * (HealthGauge / StatusPill / EmptyState). Token colors only (no raw hex).
 */
import { EmptyState, HealthGauge, StatusPill, type SystemHealthView } from "@prometheus/ui";
import type { ReactElement } from "react";

export interface SystemHealthPanelProps {
  view: SystemHealthView;
  /** re-probe the engine (window.prometheus.health). */
  onRefresh?: () => void;
}

/** The System Health panel. */
export function SystemHealthPanel({ view, onRefresh }: SystemHealthPanelProps): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: "var(--space-8, 16px)",
        padding: "var(--space-4, 8px)",
        height: "100%",
        boxSizing: "border-box",
        overflow: "auto",
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "var(--space-2, 4px)",
        }}
      >
        <HealthGauge score={view.score} tier={view.tier} size={104} />
        <span
          style={{
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            maxWidth: "16ch",
            textAlign: "center",
          }}
        >
          {view.summary}
        </span>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            style={{
              background: "transparent",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-sm, 4px)",
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: "var(--space-1, 2px) var(--space-3, 6px)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            ⟲ Re-check
          </button>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {view.components.length === 0 ? (
          <EmptyState
            icon="🩺"
            title="No health data"
            hint="Run a check to probe the engine, scanner, and services."
          />
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2, 4px)",
            }}
          >
            {view.components.map((c) => (
              <li
                key={c.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3, 6px)",
                  padding: "var(--space-2, 4px) var(--space-3, 6px)",
                  background: "var(--bg-inset)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius-md, 6px)",
                }}
              >
                <StatusPill status={c.status} label={c.label} />
                {c.detail && (
                  <span
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: "var(--text-small-size, 0.8125rem)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {c.detail}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                {c.remediation && (
                  <span
                    style={{ color: "var(--warn)", fontSize: "var(--text-small-size, 0.8125rem)" }}
                  >
                    ↳ {c.remediation}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default SystemHealthPanel;
