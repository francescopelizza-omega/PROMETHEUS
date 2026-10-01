// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * NotebookView.tsx — Monaco-multicell notebook (file 14 §3.25).
 *
 * Native notebook on the Studio stack (NOT a Code-OSS fork, D1): a vertical cell list
 * (a code editor per cell + rendered outputs). Presentational + controlled: the cell
 * state comes from the notebook-view reducer; kernel exec is kernel.py via
 * window.prometheus (a supervised runtime seam, C8). Rich outputs render sandboxed.
 * The plain <textarea>/<pre> swap for Monaco/output renderers later. No raw hex.
 */
import { Button, Panel } from "@prometheus/ui";
import type { CSSProperties, ReactElement } from "react";

import { type Cell, executionSummary } from "./notebook-view.js";

export interface NotebookViewProps {
  cells: readonly Cell[];
  activeCellId?: string;
  onAdd?: (afterId?: string) => void;
  onRemove?: (id: string) => void;
  onUpdate?: (id: string, source: string) => void;
  onRun?: (id: string) => void;
  onSelect?: (id: string) => void;
  /** kernel toolbar (APP-045): interrupt/restart the live session. */
  onInterrupt?: () => void;
  onRestart?: () => void;
  /** short kernel status label (none/starting/ready/busy/error/exited). */
  kernelStatus?: string;
  /** a fail-closed banner when the notebook file could not be read. */
  loadError?: string;
}

/** Render ONE rich output: image mimes as a sandboxed data-URI img; else plain text. */
function OutputView({
  output,
  error,
}: { output: { mime: string; data: string }; error: boolean }): ReactElement {
  if (output.mime.startsWith("image/")) {
    // png/jpeg payloads are ALREADY base64; svg is raw markup rendered via a data-URI
    // img so it is NEVER injected into the DOM (sandbox / no-html rule).
    const src =
      output.mime === "image/svg+xml"
        ? `data:image/svg+xml;utf8,${encodeURIComponent(output.data)}`
        : `data:${output.mime};base64,${output.data}`;
    return (
      <img
        src={src}
        alt="cell output"
        style={{ maxWidth: "100%", display: "block", marginTop: "var(--space-1, 2px)" }}
      />
    );
  }
  return (
    <pre
      style={{
        margin: 0,
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        color: error ? "var(--danger)" : "var(--text-primary)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-small-size, 0.8125rem)",
      }}
    >
      {output.data}
    </pre>
  );
}

const STATUS_GLYPH: Record<Cell["status"], string> = {
  idle: "▷",
  running: "⧖",
  ok: "✓",
  error: "✖",
};
const STATUS_ROLE: Record<Cell["status"], string> = {
  idle: "text-secondary",
  running: "accent",
  ok: "ok",
  error: "danger",
};

function CellView({
  cell,
  active,
  onRemove,
  onUpdate,
  onRun,
  onSelect,
}: {
  cell: Cell;
  active: boolean;
  onRemove?: (id: string) => void;
  onUpdate?: (id: string, source: string) => void;
  onRun?: (id: string) => void;
  onSelect?: (id: string) => void;
}): ReactElement {
  return (
    <div
      onFocus={() => onSelect?.(cell.id)}
      style={{
        border: `1px solid ${active ? "var(--accent)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius-md, 6px)",
        marginBottom: "var(--space-2, 4px)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2, 4px)",
          padding: "var(--space-1, 2px) var(--space-2, 4px)",
          background: "var(--bg-surface-2)",
          fontSize: "var(--text-small-size, 0.8125rem)",
        }}
      >
        <span aria-hidden="true" style={{ color: `var(--${STATUS_ROLE[cell.status]})` }}>
          {STATUS_GLYPH[cell.status]}
        </span>
        <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
          [{cell.execCount ?? " "}] {cell.kind}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="Run cell"
          onClick={() => onRun?.(cell.id)}
          style={iconBtn()}
        >
          ▶
        </button>
        <button
          type="button"
          aria-label="Remove cell"
          onClick={() => onRemove?.(cell.id)}
          style={iconBtn()}
        >
          ⌫
        </button>
      </div>
      <textarea
        value={cell.source}
        onChange={(e) => onUpdate?.(cell.id, e.currentTarget.value)}
        aria-label={`${cell.kind} cell`}
        rows={Math.min(12, Math.max(2, cell.source.split("\n").length))}
        style={{
          width: "100%",
          boxSizing: "border-box",
          background: "var(--bg-app)",
          color: "var(--text-primary)",
          border: "none",
          padding: "var(--space-2, 4px)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-code-size, 0.78125rem)",
          resize: "vertical",
          outline: "none",
        }}
      />
      {cell.outputs && cell.outputs.length > 0 && (
        <div
          style={{ borderTop: "1px solid var(--border-subtle)", padding: "var(--space-2, 4px)" }}
        >
          {cell.outputs.map((o, i) => (
            <OutputView key={`${cell.id}-out-${i}`} output={o} error={cell.status === "error"} />
          ))}
        </div>
      )}
    </div>
  );
}

function iconBtn(): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
  };
}

/** The §3.25 notebook editor. */
export function NotebookView({
  cells,
  activeCellId,
  onAdd,
  onRemove,
  onUpdate,
  onRun,
  onSelect,
  onInterrupt,
  onRestart,
  kernelStatus,
  loadError,
}: NotebookViewProps): ReactElement {
  const summary = executionSummary(cells);
  return (
    <Panel title="Notebook" elevation="e1">
      {loadError && (
        <div
          role="alert"
          style={{
            marginBottom: "var(--space-2, 4px)",
            padding: "var(--space-2, 4px) var(--space-3, 6px)",
            borderRadius: "var(--radius-sm, 4px)",
            background: "var(--bg-surface-2)",
            color: "var(--danger)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          {loadError}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3, 6px)",
          marginBottom: "var(--space-2, 4px)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          color: "var(--text-secondary)",
        }}
      >
        <span>
          {summary.running ? `${summary.running} running` : "idle"} · {summary.ok} ok ·{" "}
          {summary.errors} errors
        </span>
        {kernelStatus && (
          <span
            style={{ color: kernelStatus === "error" ? "var(--danger)" : "var(--text-secondary)" }}
          >
            · kernel: {kernelStatus}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Button variant="secondary" onClick={() => onInterrupt?.()} disabled={!onInterrupt}>
          ⏹ Interrupt
        </Button>
        <Button variant="secondary" onClick={() => onRestart?.()} disabled={!onRestart}>
          ↻ Restart
        </Button>
        <Button variant="secondary" onClick={() => onAdd?.(activeCellId)}>
          + Cell
        </Button>
      </div>
      {cells.length === 0 ? (
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            padding: "var(--space-3, 6px)",
          }}
        >
          empty notebook — add a cell
        </div>
      ) : (
        cells.map((c) => (
          <CellView
            key={c.id}
            cell={c}
            active={c.id === activeCellId}
            onRemove={onRemove}
            onUpdate={onUpdate}
            onRun={onRun}
            onSelect={onSelect}
          />
        ))
      )}
    </Panel>
  );
}

export default NotebookView;
