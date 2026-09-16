/**
 * marketplace/McpServerList.tsx — the MCP Servers tab body (file 09 §2/§6).
 *
 * Host server rows: health dot + label + source + transport + verdict chip + an
 * enable toggle (DISABLED when health="blocked" — a nemesis-blocked server cannot be
 * spawned; §2.2). "Add" runs the §2.2 gate then registers a connection; "Import"
 * surfaces servers discovered from other agents (§2.3). All actions are callbacks —
 * the gating runs in the container. Engine strings are inert().
 */
import type { CSSProperties, ReactElement } from "react";
import { inert, roleVar } from "../patterns/util.js";
import { VerdictChip } from "./VerdictChip.js";
import { type McpServerRow, healthDot } from "./types.js";

export interface McpServerListProps {
  servers: readonly McpServerRow[];
  /** current enabled state by id (the manager's source of truth). */
  enabled?: Record<string, boolean>;
  onToggle(id: string, next: boolean): void;
  onAdd(): void;
  onImport(): void;
}

export function McpServerList(props: McpServerListProps): ReactElement {
  const { servers, enabled = {} } = props;
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          gap: "var(--space-4, 8px)",
          padding: "var(--space-4, 8px) var(--space-6, 12px)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <button type="button" onClick={props.onAdd} style={ctaStyle()}>
          + Add server
        </button>
        <button type="button" onClick={props.onImport} style={ghostStyle()}>
          Import from agents…
        </button>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {servers.map((srv) => {
          const dot = healthDot(srv.health);
          const blocked = srv.health === "blocked";
          const on = enabled[srv.id] === true;
          return (
            <li
              key={srv.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-4, 8px)",
                padding: "var(--space-4, 8px) var(--space-6, 12px)",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              <span aria-label={`health: ${dot.label}`} style={{ color: roleVar(dot.role) }}>
                {dot.glyph}
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                  whiteSpace: "nowrap",
                }}
              >
                <strong>{inert(srv.label)}</strong>
                <span
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "var(--text-small-size, 0.8125rem)",
                  }}
                >
                  {" "}
                  · {srv.source} · {srv.transportKind}
                </span>
              </span>
              {srv.worstVerdict && <VerdictChip verdict={srv.worstVerdict} compact />}
              <button
                type="button"
                disabled={blocked}
                aria-pressed={on}
                onClick={() => props.onToggle(srv.id, !on)}
                title={blocked ? "blocked by nemesis — cannot enable" : on ? "disable" : "enable"}
                style={{
                  background: on ? "var(--ok)" : "transparent",
                  // `--on-ok` is the computed label colour for the `--ok` FILL (tokens/contrast.ts `onFill`).
                  // The old `--brand-fg` here was WHITE on the dark scheme over a saturated light fill (~2:1),
                  // and a plain `--bg-app` would be near-white over the same fill on the LIGHT scheme.
                  color: on ? "var(--on-ok)" : "var(--text-secondary)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-full, 9999px)",
                  padding: "var(--space-1, 2px) var(--space-4, 8px)",
                  cursor: blocked ? "not-allowed" : "pointer",
                  opacity: blocked ? 0.5 : 1,
                  fontSize: "var(--text-small-size, 0.8125rem)",
                }}
              >
                {blocked ? "blocked" : on ? "on" : "off"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ctaStyle(): CSSProperties {
  return {
    background: "var(--brand)",
    // The label sits ON the `--brand` fill, so it needs the computed `--on-brand`.
    // `--brand-fg` is #ffffff on the dark scheme and measures 3.96:1 over `--brand` —
    // under the 4.5:1 a label carries. It stays in use where it is a FILL, not a label
    // (the Toggle knob), which is why this is a call-site change and not a token change.
    color: "var(--on-brand)",
    border: "none",
    borderRadius: "var(--radius-md, 6px)",
    padding: "var(--space-2, 4px) var(--space-6, 12px)",
    cursor: "pointer",
    fontSize: "var(--text-small-size, 0.8125rem)",
    fontWeight: 600,
  };
}
function ghostStyle(): CSSProperties {
  return {
    background: "transparent",
    color: "var(--text-secondary)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md, 6px)",
    padding: "var(--space-2, 4px) var(--space-6, 12px)",
    cursor: "pointer",
    fontSize: "var(--text-small-size, 0.8125rem)",
  };
}
