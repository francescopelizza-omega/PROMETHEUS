// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/** theme.ts — colors + glyphs shared across views. */
export const COLOR = {
  brand: "magenta",
  accent: "cyan",
  ok: "green",
  warn: "yellow",
  err: "red",
  dim: "gray",
} as const;

export const VERDICT_COLOR: Record<string, string> = {
  allow: "green",
  clean: "green",
  low: "green",
  warn: "yellow",
  medium: "yellow",
  high: "red",
  block: "red",
  critical: "red",
  error: "red",
};

export const DOT = { present: "●", forgotten: "◐", absent: "○" };
