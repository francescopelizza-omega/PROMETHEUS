// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * science-view.ts — pure helpers for the APP-088 scientific-mode windows.
 *
 * Kept separate from the React components (which are presentational) so the paging math,
 * the "is this variable viewable as a frame" predicate, and byte formatting are unit-
 * testable without a DOM. The DataFrame viewer is SERVER-paged (the kernel returns one
 * offset/limit page + a total), mirroring the SQL console's server-paging pattern
 * (ide/db/sql-view.ts) rather than slicing a whole frame in the renderer.
 */

/** Derived pager state for a server-paged frame (offset/limit → page indices + row span). */
export interface DataFramePageMeta {
  page: number;
  pageSize: number;
  maxPage: number;
  total: number;
  /** 1-based index of the first row on this page (0 when the frame is empty). */
  startRow: number;
  /** 1-based index of the last row on this page (0 when the frame is empty). */
  endRow: number;
}

/** Compute pager state from a server offset/limit + the frame's total row count. */
export function dataframePageMeta(offset: number, limit: number, total: number): DataFramePageMeta {
  const pageSize = Math.max(1, Math.floor(limit) || 1);
  const total0 = Math.max(0, Math.floor(total) || 0);
  const maxPage = total0 === 0 ? 0 : Math.max(0, Math.ceil(total0 / pageSize) - 1);
  const rawPage = Math.floor(Math.max(0, offset) / pageSize);
  const page = Math.max(0, Math.min(rawPage, maxPage));
  const startRow = total0 === 0 ? 0 : page * pageSize + 1;
  const endRow = Math.min(total0, page * pageSize + pageSize);
  return { page, pageSize, maxPage, total: total0, startRow, endRow };
}

/** The container/tabular types whose Variables row offers a "view" (open in the grid). */
const VIEWABLE_TYPES = new Set(["list", "dict", "tuple", "ndarray", "DataFrame", "Series"]);

/** True when a variable of `type` can be opened in the DataFrame grid (pandas or fallback). */
export function isViewableFrame(type: string): boolean {
  if (VIEWABLE_TYPES.has(type)) return true;
  // subclasses / namespaced names (e.g. "GeoDataFrame", "pandas.core.frame.DataFrame")
  return type.endsWith("DataFrame") || type.endsWith("Series");
}

/** Human-readable byte size for the Variables window (bounded, no external dep). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val >= 10 ? Math.round(val) : Math.round(val * 10) / 10} ${units[i]}`;
}
