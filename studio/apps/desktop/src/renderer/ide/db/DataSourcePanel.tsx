/**
 * db/DataSourcePanel.tsx — the SQL data-source rail (file 14 §3.26, APP-043).
 *
 * Presentational: the named-source list (label + REDACTED conn + ok/error status chip),
 * click-to-select, delete, and an add form (label + connection string). All IPC (the
 * actual `sql.connect`) lives in the DatabasePanel container — this only emits intent.
 * Tokens only.
 */

import { Button } from "@prometheus/ui";
import { type ReactElement, useState } from "react";

import type { SqlSource } from "./sql-sources.js";

export interface SourceStatus {
  ok: boolean;
  error?: string;
  dialect?: string;
}

export interface DataSourcePanelProps {
  sources: SqlSource[];
  selectedId: string | null;
  statuses: Record<string, SourceStatus>;
  onSelect: (id: string) => void;
  onAdd: (label: string, connString: string) => void;
  onRemove: (id: string) => void;
}

export function DataSourcePanel({
  sources,
  selectedId,
  statuses,
  onSelect,
  onAdd,
  onRemove,
}: DataSourcePanelProps): ReactElement {
  const [label, setLabel] = useState("");
  const [conn, setConn] = useState("");
  const canAdd = conn.trim().length > 0;

  const inputStyle = {
    width: "100%",
    boxSizing: "border-box" as const,
    background: "var(--bg-inset)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-sm, 4px)",
    padding: "var(--space-1, 2px) var(--space-2, 4px)",
    fontSize: "var(--text-small-size, 0.8125rem)",
    marginBottom: "var(--space-1, 2px)",
  };

  return (
    <div style={{ fontSize: "var(--text-small-size, 0.8125rem)" }}>
      <div style={{ color: "var(--text-secondary)", padding: "var(--space-1, 2px) 0" }}>
        DATA SOURCES
      </div>
      {sources.length === 0 && (
        <p style={{ color: "var(--text-secondary)", margin: "var(--space-2, 4px) 0" }}>
          add a connection below.
        </p>
      )}
      {sources.map((s) => {
        const st = statuses[s.id];
        return (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(s.id);
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: "left",
                background: s.id === selectedId ? "var(--bg-inset)" : "transparent",
                border: "none",
                borderRadius: "var(--radius-sm, 4px)",
                color: "var(--text-primary)",
                cursor: "pointer",
                padding: "var(--space-1, 2px) var(--space-2, 4px)",
                overflow: "hidden",
              }}
              title={s.redactedConn}
            >
              <span
                aria-hidden="true"
                style={{
                  color: st ? (st.ok ? "var(--ok)" : "var(--danger)") : "var(--text-secondary)",
                }}
              >
                {st ? (st.ok ? "●" : "▲") : "○"}{" "}
              </span>
              {s.label}
              <div
                style={{
                  color: "var(--text-secondary)",
                  fontFamily: "var(--font-mono, monospace)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                  whiteSpace: "nowrap",
                }}
              >
                {s.redactedConn}
              </div>
              {st?.error && <div style={{ color: "var(--danger)" }}>{st.error}</div>}
            </div>
            <button
              type="button"
              aria-label="remove data source"
              onClick={() => onRemove(s.id)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              🗑
            </button>
          </div>
        );
      })}

      <div
        style={{ marginTop: "var(--space-2, 4px)", borderTop: "1px solid var(--border-subtle)" }}
      >
        <input
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          aria-label="data source label"
          placeholder="label (optional)"
          style={{ ...inputStyle, marginTop: "var(--space-2, 4px)" }}
        />
        <input
          value={conn}
          onChange={(e) => setConn(e.currentTarget.value)}
          aria-label="connection string"
          placeholder="sqlite:///path.db · postgresql://u:p@h/db · mysql://…"
          style={inputStyle}
        />
        <Button
          variant="secondary"
          disabled={!canAdd}
          onClick={() => {
            onAdd(label, conn.trim());
            setLabel("");
            setConn("");
          }}
        >
          + Add &amp; Connect
        </Button>
      </div>
    </div>
  );
}

export default DataSourcePanel;
