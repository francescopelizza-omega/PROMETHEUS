// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * DownloadQueue.tsx — the §5 download queue: progress bars + nemesis-status
 * badges. Each row paints the §5 security flow — green admit / yellow confirm /
 * red block+quarantine — exactly mirroring the file-03 verdict UX (the shared
 * <VerdictSheet/> is opened by the route when a row needs confirm/inspect).
 *
 * SANDBOXED + C5: imports only react + this package. It NEVER decides "safe" — a
 * row's color/label is a pure projection of the §5 state the core store set from
 * the REAL nemesis verdict (the sidecar's gate). `blocked`/`quarantined` rows are
 * deep-red and offer Inspect (stage dir kept) — the bytes are never auto-deleted.
 * Actions are PROPS (onConfirm / onCancel / onInspect / onRetry) — no IPC here.
 */

import type { ReactElement } from "react";

import type { DownloadRowData, DownloadRowState } from "./types.js";
import {
  type DownloadState,
  type GateTier,
  downloadGlyph,
  downloadLabel,
  downloadRole,
  gateGlyph,
  gateLabel,
  gateRole,
  inert,
  isDownloadBlocked,
  isDownloadTerminal,
  roleVar,
} from "./util.js";

export interface DownloadQueueProps {
  rows: DownloadRowData[];
  /** confirm a `confirm` (nemesis WARN) row → re-run admit. */
  onConfirm?: (id: string) => void;
  /** cancel / dismiss a row (drops it from the queue). */
  onCancel?: (id: string) => void;
  /** inspect a quarantined stage dir (kept for inspection; never auto-deleted). */
  onInspect?: (id: string) => void;
  /** retry a blocked / quarantined download from scratch. */
  onRetry?: (id: string) => void;
}

/** The inline nemesis status badge a download row carries (the §5 admit/confirm/red chip). */
function NemesisBadge({ tier }: { tier: GateTier | undefined }): ReactElement {
  const role = gateRole(tier);
  return (
    <span
      data-verdict={tier ?? "scanning"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2, 4px)",
        color: roleVar(role),
        fontFamily: "var(--font-mono)",
        fontSize: "0.78rem",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">{gateGlyph(tier)}</span>
      <span>nemesis: {gateLabel(tier)}</span>
    </span>
  );
}

/**
 * The progress bar for a `staging` row (filled track). Purely VISUAL (aria-hidden)
 * — the accessible progress value is the "{pct}%" text rendered alongside it, so
 * we don't add a focusable "progressbar" role to a non-interactive indicator.
 */
function ProgressBar({ pct }: { pct: number }): ReactElement {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div
      aria-hidden="true"
      style={{
        height: "6px",
        borderRadius: "9999px",
        background: "var(--bg-surface-2)",
        overflow: "hidden",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <div
        style={{
          width: `${p}%`,
          height: "100%",
          background: "var(--accent)",
          transition: "width var(--motion-hover, 120ms) linear",
        }}
      />
    </div>
  );
}

function Row({
  row,
  onConfirm,
  onCancel,
  onInspect,
  onRetry,
}: {
  row: DownloadRowData;
  onConfirm?: (id: string) => void;
  onCancel?: (id: string) => void;
  onInspect?: (id: string) => void;
  onRetry?: (id: string) => void;
}): ReactElement {
  const state = row.state as DownloadState;
  const role = downloadRole(state);
  const blocked = isDownloadBlocked(state);
  const terminal = isDownloadTerminal(state);
  return (
    <li
      data-state={row.state}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "8px 10px",
        borderRadius: "var(--radius-md, 6px)",
        border: `1px solid ${blocked ? "var(--danger)" : "var(--border-subtle)"}`,
        background: blocked ? "color-mix(in srgb, var(--danger) 8%, transparent)" : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3, 6px)" }}>
        <span aria-hidden="true" style={{ color: roleVar(role) }}>
          {downloadGlyph(state)}
        </span>
        <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{inert(row.modelId)}</span>
        <span
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.78rem",
          }}
        >
          {inert(row.quant)}
        </span>
        <span style={{ marginLeft: "auto", color: roleVar(role), fontSize: "0.78rem" }}>
          {downloadLabel(state)}
        </span>
      </div>

      {state === "staging" && typeof row.pct === "number" && (
        <>
          <ProgressBar pct={row.pct} />
          <div
            style={{
              display: "flex",
              gap: "var(--space-3, 6px)",
              color: "var(--text-secondary)",
              fontSize: "0.72rem",
            }}
          >
            <span>{Math.round(row.pct)}%</span>
            {row.rate && <span>· {inert(row.rate)}</span>}
          </div>
        </>
      )}

      {/* nemesis badge once scanning/scanned (the §5 verdict) */}
      {(state === "scanning" || row.gate) && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4, 8px)" }}>
          <NemesisBadge tier={row.gate?.verdict} />
          {row.gate?.reasons && row.gate.reasons.length > 0 && (
            <span style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
              {inert(row.gate.reasons[0])}
            </span>
          )}
        </div>
      )}

      {row.quarantineDir && (
        <span
          style={{
            color: "var(--text-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
            whiteSpace: "nowrap",
          }}
        >
          staged: {inert(row.quarantineDir)} (kept for inspection)
        </span>
      )}

      {/* §5 row actions (PROPS only) */}
      <div style={{ display: "flex", gap: "var(--space-3, 6px)", flexWrap: "wrap" }}>
        {state === "confirm" && onConfirm && (
          <button type="button" onClick={() => onConfirm(row.id)} style={warnBtn}>
            Confirm &amp; admit
          </button>
        )}
        {blocked && onInspect && (
          <button type="button" onClick={() => onInspect(row.id)} style={ghostBtn}>
            Inspect stage
          </button>
        )}
        {blocked && onRetry && (
          <button type="button" onClick={() => onRetry(row.id)} style={ghostBtn}>
            Retry
          </button>
        )}
        {onCancel && (
          <button type="button" onClick={() => onCancel(row.id)} style={ghostBtn}>
            {terminal ? "Dismiss" : "Cancel"}
          </button>
        )}
      </div>
    </li>
  );
}

export function DownloadQueue({
  rows,
  onConfirm,
  onCancel,
  onInspect,
  onRetry,
}: DownloadQueueProps): ReactElement {
  if (rows.length === 0) {
    return (
      <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>
        No downloads queued.
      </p>
    );
  }
  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gap: "var(--space-3, 6px)",
      }}
    >
      {rows.map((r) => (
        <Row
          key={r.id}
          row={r}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onInspect={onInspect}
          onRetry={onRetry}
        />
      ))}
    </ul>
  );
}

const warnBtn: React.CSSProperties = {
  border: "1px solid var(--warn)",
  background: "transparent",
  color: "var(--warn)",
  borderRadius: "var(--radius-md, 6px)",
  padding: "4px 9px",
  fontSize: "0.8rem",
  cursor: "pointer",
};

const ghostBtn: React.CSSProperties = {
  border: "1px solid var(--border-subtle)",
  background: "transparent",
  color: "var(--text-primary)",
  borderRadius: "var(--radius-md, 6px)",
  padding: "4px 9px",
  fontSize: "0.8rem",
  cursor: "pointer",
};

// re-exported for the route's row-state typing convenience.
export type { DownloadRowState };

export default DownloadQueue;
