/**
 * ScienceWindows.tsx — the APP-088 scientific-mode windows (Variables / DataFrame / SciView).
 *
 * PRESENTATIONAL + CONTROLLED siblings of NotebookView (never fetch): all kernel data
 * arrives via props from the notebook store, and every affordance is a callback the
 * container wires to a store action. This preserves NotebookView's presentational contract
 * — the new windows do not reach into the kernel, they render what the store already routed.
 *
 * Security: variable reprs are attacker-controllable (user code) — rendered as TEXT only.
 * Plot images are base64 PNGs rendered through a `data:` URI <img>, NEVER innerHTML of
 * kernel-produced markup (same sandbox rule as the notebook output path). No raw hex.
 */
import { Button, Panel } from "@prometheus/ui";
import { type ReactElement, useState } from "react";

import type { IdeKernelDataFrameEvent, IdeKernelVar } from "../../../shared/ipc-contract.js";
import { dataframePageMeta, formatBytes, isViewableFrame } from "./science-view.js";

const CELL_STYLE = {
  padding: "var(--space-1, 2px) var(--space-2, 4px)",
  borderBottom: "1px solid var(--border-subtle)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-small-size, 0.8125rem)",
  verticalAlign: "top" as const,
};

/** Variables window: name/type/repr/size table; click a row to expand its full repr; a
 *  tabular var offers a "view" button that opens it in the DataFrame grid. */
export function VariablesWindow({
  vars,
  onView,
}: {
  vars?: readonly IdeKernelVar[];
  onView?: (name: string) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const list = vars ?? [];
  return (
    <Panel title="Variables" elevation="e1">
      {list.length === 0 ? (
        <p
          style={{
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            padding: "var(--space-2, 4px)",
            margin: 0,
          }}
        >
          run a cell to inspect kernel variables
        </p>
      ) : (
        <div style={{ overflow: "auto", maxHeight: 260 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["name", "type", "value", "size", ""].map((h) => (
                  <th
                    key={h || "act"}
                    style={{
                      textAlign: "left",
                      padding: "var(--space-1, 2px) var(--space-2, 4px)",
                      color: "var(--text-secondary)",
                      borderBottom: "1px solid var(--border-subtle)",
                      fontSize: "var(--text-small-size, 0.8125rem)",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((v) => {
                const open = expanded === v.name;
                return (
                  <tr key={v.name}>
                    <td style={{ ...CELL_STYLE, color: "var(--text-primary)" }}>{v.name}</td>
                    <td style={{ ...CELL_STYLE, color: "var(--accent)" }}>{v.type}</td>
                    <td style={{ ...CELL_STYLE, maxWidth: 200 }}>
                      <button
                        type="button"
                        title="expand / collapse the value"
                        aria-expanded={open}
                        onClick={() => setExpanded(open ? undefined : v.name)}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          color: "var(--text-secondary)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "var(--text-small-size, 0.8125rem)",
                          whiteSpace: open ? "pre-wrap" : "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                        }}
                      >
                        {v.repr}
                      </button>
                    </td>
                    <td style={{ ...CELL_STYLE, color: "var(--text-disabled)" }}>
                      {formatBytes(v.size)}
                    </td>
                    <td style={CELL_STYLE}>
                      {isViewableFrame(v.type) && onView && (
                        <button
                          type="button"
                          onClick={() => onView(v.name)}
                          title={`view ${v.name} as a grid`}
                          style={{
                            background: "transparent",
                            border: "1px solid var(--border-subtle)",
                            borderRadius: "var(--radius-sm, 4px)",
                            color: "var(--accent)",
                            cursor: "pointer",
                            fontSize: "var(--text-small-size, 0.8125rem)",
                            padding: "0 var(--space-2, 4px)",
                          }}
                        >
                          view
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** DataFrame viewer: a paged read-only grid over a server-paged frame (kernel offset/limit).
 *  Column headers + row-count summary; pager re-requests the next/prev page via `onPage`. */
export function DataFrameWindow({
  name,
  frame,
  offset,
  limit,
  onPage,
  onClose,
}: {
  name?: string;
  frame?: IdeKernelDataFrameEvent;
  offset: number;
  limit: number;
  onPage?: (nextOffset: number) => void;
  onClose?: () => void;
}): ReactElement | null {
  if (!name) return null;
  const columns = frame?.columns ?? [];
  const rows = frame?.rows ?? [];
  const total = frame?.totalRows ?? rows.length;
  const meta = dataframePageMeta(offset, limit, total);
  const notFound = frame && frame.found === false;
  return (
    <Panel title={`DataFrame · ${name}`} elevation="e1">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2, 4px)",
          marginBottom: "var(--space-2, 4px)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          color: "var(--text-secondary)",
        }}
      >
        <span>
          {notFound ? "no such variable" : `rows ${meta.startRow}–${meta.endRow} of ${meta.total}`}
        </span>
        <span style={{ flex: 1 }} />
        <Button
          variant="ghost"
          disabled={meta.page <= 0}
          onClick={() => onPage?.(Math.max(0, (meta.page - 1) * meta.pageSize))}
        >
          ‹
        </Button>
        <span>
          {meta.page + 1} / {meta.maxPage + 1}
        </span>
        <Button
          variant="ghost"
          disabled={meta.page >= meta.maxPage}
          onClick={() => onPage?.((meta.page + 1) * meta.pageSize)}
        >
          ›
        </Button>
        {onClose && (
          <Button variant="ghost" onClick={() => onClose()} title="close the DataFrame view">
            ✕
          </Button>
        )}
      </div>
      {!notFound && (
        <div
          style={{
            overflow: "auto",
            maxHeight: 320,
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md, 6px)",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c}
                    style={{
                      textAlign: "left",
                      padding: "var(--space-1, 2px) var(--space-2, 4px)",
                      color: "var(--text-secondary)",
                      borderBottom: "1px solid var(--border-subtle)",
                      position: "sticky",
                      top: 0,
                      background: "var(--bg-surface-2)",
                    }}
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: frame rows have no stable id; index is the row identity within a page
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={`${ri}-${columns[ci] ?? ci}`}
                      style={{
                        padding: "var(--space-1, 2px) var(--space-2, 4px)",
                        color: cell === null ? "var(--text-disabled)" : "var(--text-primary)",
                        borderBottom: "1px solid var(--border-subtle)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {cell === null ? "None" : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** SciView: a vertical stack of captured plot images (newest first), clearable. Images are
 *  sandboxed base64-PNG data URIs — never innerHTML of kernel-produced markup. */
export function SciView({
  plots,
  onClear,
}: {
  plots?: readonly string[];
  onClear?: () => void;
}): ReactElement {
  const list = plots ?? [];
  return (
    <Panel title="SciView" elevation="e1">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: "var(--space-2, 4px)",
          fontSize: "var(--text-small-size, 0.8125rem)",
          color: "var(--text-secondary)",
        }}
      >
        <span>{list.length === 0 ? "no plots captured" : `${list.length} figure(s)`}</span>
        <span style={{ flex: 1 }} />
        {onClear && list.length > 0 && (
          <Button variant="ghost" onClick={() => onClear()} title="clear captured plots">
            clear
          </Button>
        )}
      </div>
      <div style={{ overflow: "auto", maxHeight: 360 }}>
        {list.map((b64, i) => (
          <img
            // biome-ignore lint/suspicious/noArrayIndexKey: base64 figures have no stable id; newest-first index is their identity
            key={i}
            src={`data:image/png;base64,${b64}`}
            alt="captured figure"
            style={{
              display: "block",
              maxWidth: "100%",
              marginBottom: "var(--space-2, 4px)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm, 4px)",
              background: "var(--bg-app)",
            }}
          />
        ))}
      </div>
    </Panel>
  );
}
