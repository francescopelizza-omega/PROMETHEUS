// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * TrustedSourcesView.tsx — the trust-store list (file 03 §8).
 *
 * Lists the `TrustedSource` entries the user has approved: the source name + the
 * agent it belongs to, the cryptographic identity (ident/key), who approved it,
 * and (when present) the verdict it was approved against. Each row has a Revoke
 * action — the renderer drops the entry from the store via window.prometheus.*.
 *
 * Presentational only: it renders engine-stored strings as inert text and emits
 * the chosen revoke. It never decides trust (C5) — the trust decision was the
 * user's, recorded by the engine; this surfaces and lets them undo it.
 */

import type { ReactElement } from "react";
import { Button } from "../components/Button.js";
import type { SecTrustedSource } from "./types.js";
import { inertText } from "./util.js";

export interface TrustedSourcesViewProps {
  sources: SecTrustedSource[];
  /** Revoke a trusted source (by its store key). */
  onRevoke?: (key: string) => void;
  className?: string;
}

const cellStyle = {
  paddingBlock: "var(--space-3, 6px)",
  paddingInline: "var(--space-4, 8px)",
  textAlign: "left" as const,
  fontWeight: 400,
};

export function TrustedSourcesView({
  sources,
  onRevoke,
  className,
}: TrustedSourcesViewProps): ReactElement {
  return (
    <div
      className={className}
      style={{ fontFamily: "var(--font-ui)", color: "var(--text-primary)" }}
    >
      {sources.length === 0 ? (
        <p
          style={{ color: "var(--text-secondary)", fontSize: "var(--text-small-size, 0.8125rem)" }}
        >
          No trusted sources.
        </p>
      ) : (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <thead>
            <tr
              style={{
                color: "var(--text-secondary)",
                borderBottom: "1px solid var(--border-strong)",
              }}
            >
              <th style={cellStyle}>Source</th>
              <th style={cellStyle}>Agent</th>
              <th style={cellStyle}>Identity</th>
              <th style={cellStyle}>Approved by</th>
              <th style={{ ...cellStyle, textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((src) => (
              <tr key={src.key} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                <td style={cellStyle}>{inertText(src.name)}</td>
                <td style={{ ...cellStyle, color: "var(--text-secondary)" }}>
                  {inertText(src.agent)}
                </td>
                <td
                  style={{
                    ...cellStyle,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-secondary)",
                  }}
                  title={inertText(src.ident)}
                >
                  {inertText(src.ident)}
                </td>
                <td style={{ ...cellStyle, color: "var(--text-secondary)" }}>
                  {src.approvedBy ? inertText(src.approvedBy) : "—"}
                </td>
                <td style={{ ...cellStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                  <Button size="sm" variant="danger" onClick={() => onRevoke?.(src.key)}>
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default TrustedSourcesView;
