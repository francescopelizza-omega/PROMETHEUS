// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tokens/chart-palette.ts — the categorical chart slots, one set per surface lightness.
 *
 * The dataviz reference palette: eight hues in a FIXED order plus `chart-other`, validated with
 * its palette validator (lightness band, chroma floor, adjacent-pair CVD ΔE ≥ 8, normal-vision
 * ΔE ≥ 15, contrast) on the built-in themes' surfaces — dark #0c1728 and #000000, light
 * #ffffff. A derived colour scheme takes the set that matches its own surface's lightness.
 * Kept in one place so the built-in themes and derived schemes cannot drift apart.
 */
export type ChartSlots = Readonly<{
  "chart-1": string;
  "chart-2": string;
  "chart-3": string;
  "chart-4": string;
  "chart-5": string;
  "chart-6": string;
  "chart-7": string;
  "chart-8": string;
  "chart-other": string;
}>;

/** Dark surfaces: every slot ≥ 3:1; worst adjacent CVD ΔE 8.4, normal-vision ΔE 19.3. */
export const CHART_SLOTS_DARK: ChartSlots = Object.freeze({
  "chart-1": "#3987e5",
  "chart-2": "#d95926",
  "chart-3": "#199e70",
  "chart-4": "#c98500",
  "chart-5": "#d55181",
  "chart-6": "#008300",
  "chart-7": "#9085e9",
  "chart-8": "#e66767",
  "chart-other": "#6b7280",
});

/**
 * Light surfaces: worst adjacent CVD ΔE 9.1, normal-vision ΔE 19.6. Slots 3/4/5 sit below 3:1
 * on white, so every chart that uses them carries visible labels or a table view.
 */
export const CHART_SLOTS_LIGHT: ChartSlots = Object.freeze({
  "chart-1": "#2a78d6",
  "chart-2": "#eb6834",
  "chart-3": "#1baf7a",
  "chart-4": "#eda100",
  "chart-5": "#e87ba4",
  "chart-6": "#008300",
  "chart-7": "#4a3aa7",
  "chart-8": "#e34948",
  "chart-other": "#9ca3af",
});
