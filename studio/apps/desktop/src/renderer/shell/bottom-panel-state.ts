// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/bottom-panel-state.ts — PURE height/badge math for BottomPanel (APP-072).
 *
 * Extracted from BottomPanel.tsx (JSX) so it is node:test-able: the run-tests dev-register
 * strips TS types but NOT JSX, so importing the component into a test fails to parse. The
 * maximize/restore + badge-visibility logic lives here as plain functions.
 */

/** Resize bounds for the expanded panel height (px). */
export const BOTTOM_MIN_HEIGHT = 120;
/** leave room for the rail/sidebar header + status bar so the panel can't eat the editor. */
export const BOTTOM_MAX_INSET = 160;

/** The window-relative maximum panel height (recomputed on maximize / window resize). */
export function panelMaxHeight(winH: number): number {
  return Math.max(BOTTOM_MIN_HEIGHT, winH - BOTTOM_MAX_INSET);
}

/**
 * The resolved `<section>` height: the collapsed row var when collapsed, the window-max when
 * maximized, else the user's dragged `size`. Maximize does NOT mutate `size`, so un-maximize
 * restores the prior height for free. The restored size is clamped to the current max so a
 * shrunk window can't restore the panel off-screen.
 */
export function resolvePanelHeight(o: {
  collapsed: boolean;
  maximized: boolean;
  size: number;
  maxHeight: number;
  rowVar: string;
}): number | string {
  if (o.collapsed) return o.rowVar;
  if (o.maximized) return o.maxHeight;
  return Math.min(o.size, o.maxHeight);
}

/** A per-tab badge shows only for a numeric, positive count (0 / undefined → no badge). */
export function shouldShowBadge(n: number | undefined): boolean {
  return typeof n === "number" && n > 0;
}
