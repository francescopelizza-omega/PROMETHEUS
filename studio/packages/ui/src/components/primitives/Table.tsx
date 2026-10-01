// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * Table.tsx — a token-styled data table (file 08 §3.1; the §5.3 package table, §5.4
 * serving list). Column-driven so callers declare headers + cell renderers. Density-
 * aware row height (--row-h). Semantic `<table>` markup (SR + keyboard for free).
 */

import { type ReactNode, useState } from "react";
import { fs, sp, v } from "./styles.js";

export interface TableColumn<T> {
  id: string;
  header: ReactNode;
  /** Cell renderer for a row. */
  cell: (row: T) => ReactNode;
  /** Right-align (numbers/sizes). */
  align?: "left" | "right";
  /** A sort key extractor; when present, the header becomes a sort toggle. */
  sortValue?: (row: T) => string | number;
  width?: string;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Row click (e.g. select a package / open a model). */
  onRowClick?: (row: T) => void;
  /** Compact rows regardless of density (tables default to compact, 08 §2.4). */
  empty?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty = "No rows.",
  className,
  "aria-label": ariaLabel,
}: TableProps<T>): ReactNode {
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);

  const sortedRows = (() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.col);
    if (!col?.sortValue) return rows;
    const extractor = col.sortValue;
    return [...rows].sort((a, b) => {
      const av = extractor(a);
      const bv = extractor(b);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === "asc" ? cmp : -cmp;
    });
  })();

  function toggleSort(colId: string): void {
    setSort((prev) =>
      prev?.col === colId
        ? { col: colId, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col: colId, dir: "asc" },
    );
  }

  return (
    <table
      aria-label={ariaLabel}
      className={className}
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontFamily: v("font-ui"),
        fontSize: fs("body"),
        color: v("text-primary"),
      }}
    >
      <thead>
        <tr>
          {columns.map((col) => {
            const sortable = typeof col.sortValue === "function";
            const isSorted = sort?.col === col.id;
            return (
              <th
                key={col.id}
                aria-sort={isSorted ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                style={{
                  textAlign: col.align ?? "left",
                  width: col.width,
                  paddingInline: sp(4),
                  paddingBlock: sp(3),
                  borderBottom: `1px solid ${v("border-subtle")}`,
                  color: v("text-secondary"),
                  fontSize: fs("small"),
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                {sortable ? (
                  <button
                    type="button"
                    onClick={() => toggleSort(col.id)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: sp(2),
                      background: "transparent",
                      border: "none",
                      color: "inherit",
                      cursor: "pointer",
                      font: "inherit",
                      padding: 0,
                    }}
                  >
                    {col.header}
                    <span aria-hidden="true">
                      {isSorted ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </button>
                ) : (
                  col.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sortedRows.length === 0 ? (
          <tr>
            <td
              colSpan={columns.length}
              style={{ padding: sp(6), color: v("text-secondary"), textAlign: "center" }}
            >
              {empty}
            </td>
          </tr>
        ) : (
          sortedRows.map((row) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: whole-row onClick is a pointer convenience; the row's actionable affordances live in focusable cell content (buttons/links the caller renders), which carry the keyboard path.
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={{
                height: "var(--row-h, 36px)",
                cursor: onRowClick ? "pointer" : "default",
                borderBottom: `1px solid ${v("border-subtle")}`,
              }}
            >
              {columns.map((col) => (
                <td
                  key={col.id}
                  style={{
                    textAlign: col.align ?? "left",
                    paddingInline: sp(4),
                    paddingBlock: sp(2),
                    whiteSpace: "nowrap",
                  }}
                >
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

export default Table;
