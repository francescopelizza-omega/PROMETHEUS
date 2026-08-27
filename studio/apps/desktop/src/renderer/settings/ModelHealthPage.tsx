/**
 * ModelHealthPage.tsx — Settings ▸ Model Health.
 *
 * Prometheus has always MEASURED a lot about each endpoint it talks to — whether it can
 * really function-call or has fallen back to a text protocol, whether a circuit breaker has
 * tripped, whether its context window was actually probed or is just an assumed default —
 * but none of it ever reached the user; it only ever showed up in logs. This page is the
 * first place any of that surfaces: a live (4s-polled, via `useModelHealth`) table of every
 * endpoint this install has recorded a turn against.
 *
 * Matches HooksPage.tsx's conventions: `Panel` from "@prometheus/ui" as the outer container,
 * plain inline `CSSProperties` objects (no CSS-in-JS/Tailwind), `var(--...)` tokens for every
 * color/space, and an explicit loading/error/empty state rather than a blank screen.
 *
 * The context-window "unmeasured" cue is the single most important thing this page exists to
 * show (a silently-guessed default context window has been known to under- or over-fill a
 * model's real window with no visible warning until now), so it renders as its own
 * `StatusPill` right next to the number, not a footnote.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + @prometheus/core's plain `ai/model-health`
 * exports + the local `useModelHealth` hook (window.prometheus.modelHealth) only.
 */
import {
  type EndpointHealthRecord,
  describeBreaker,
  describeContextWindow,
  describeTransport,
} from "@prometheus/core/ai-model-health";
import { EmptyState, Panel, StatusPill } from "@prometheus/ui";
import type { CSSProperties, ReactElement } from "react";

import { useModelHealth } from "../shared/model-health/useModelHealth.js";
import { breakerPillStatus, formatRelativeTime, transportPillStatus } from "./model-health-view.js";

export function ModelHealthPage(): ReactElement {
  const { records, loading, error, refresh } = useModelHealth();
  const nowMs = Date.now();

  return (
    <Panel
      title="Model Health"
      elevation="e1"
      actions={
        <button type="button" style={refreshBtn} onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
        <p style={hintStyle}>
          Prometheus learns how each model actually behaves — whether it can call tools natively,
          whether its connection is healthy, and how big its real context window is — and remembers
          it here, for every endpoint it has talked to this install.
        </p>

        {error && (
          <div style={{ color: "var(--danger)", padding: "var(--space-2, 4px) 0" }}>{error}</div>
        )}

        {!error && loading && records.length === 0 && (
          <div style={{ color: "var(--text-secondary)", padding: "var(--space-4, 8px) 0" }}>
            loading…
          </div>
        )}

        {!error && !loading && records.length === 0 && (
          <EmptyState
            title="No endpoints used yet"
            hint="Prometheus hasn't talked to a model endpoint in this session yet. Health appears here the moment one completes a turn."
          />
        )}

        {records.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Endpoint</th>
                  <th style={thStyle}>Transport</th>
                  <th style={thStyle}>Breaker</th>
                  <th style={thStyle}>Context window</th>
                  <th style={thStyle}>Last used</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <ModelHealthRow key={record.endpointId} record={record} nowMs={nowMs} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

function ModelHealthRow({
  record,
  nowMs,
}: {
  record: EndpointHealthRecord;
  nowMs: number;
}): ReactElement {
  return (
    <tr style={rowStyle}>
      <td style={tdStyle}>
        <div style={{ fontWeight: 600 }}>{record.model}</div>
        <div style={{ color: "var(--text-secondary)", fontSize: "0.68rem" }}>
          {record.endpointId} · {record.locality}
        </div>
      </td>
      <td style={tdStyle}>
        <StatusPill
          status={transportPillStatus(record)}
          label={record.transport === "native" ? "Native" : "Text fallback"}
          title={describeTransport(record)}
        />
      </td>
      <td style={tdStyle}>
        <StatusPill
          status={breakerPillStatus(record.breakerState)}
          label={record.breakerState}
          title={describeBreaker(record, nowMs)}
        />
      </td>
      <td style={tdStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2, 4px)" }}>
          {/* Defense-in-depth: the IPC boundary validates the full record shape before it ever
              reaches disk, but a record written before that validation existed (or read from a
              store some other tool touched directly) could still have a missing/wrong-typed
              `contextWindow` — degrade to "0" rather than crashing this whole render. */}
          <span>{(record.contextWindow ?? 0).toLocaleString()} tokens</span>
          {record.contextWindowSource === "default" && (
            <StatusPill
              status="degraded"
              label="unmeasured"
              title={`${describeContextWindow(record)} — this is a guessed floor, not a measured value: the probe that would confirm this endpoint's real context window failed or never ran.`}
            />
          )}
        </div>
      </td>
      <td style={tdStyle} title={record.lastUsedIso}>
        {formatRelativeTime(record.lastUsedIso, nowMs)}
      </td>
    </tr>
  );
}

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.8125rem",
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontFamily: "var(--font-ui)",
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "var(--space-2, 4px) var(--space-3, 6px)",
  color: "var(--text-secondary)",
  fontWeight: 500,
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  borderBottom: "1px solid var(--border-strong)",
  whiteSpace: "nowrap",
};

const tdStyle: CSSProperties = {
  padding: "var(--space-2, 4px) var(--space-3, 6px)",
  borderBottom: "1px solid var(--border-subtle, var(--border-strong))",
  verticalAlign: "middle",
};

const rowStyle: CSSProperties = {
  fontSize: "var(--text-small-size, 0.8125rem)",
};

const refreshBtn: CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm, 4px)",
  padding: "var(--space-2, 4px) var(--space-4, 8px)",
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
  fontSize: "0.75rem",
};

export default ModelHealthPage;
