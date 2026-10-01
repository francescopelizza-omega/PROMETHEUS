// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * components/health-view.ts — PURE math + view types for the health visuals (Reliability
 * & Polish pack). The gauge ring geometry, score banding, and status glyphs/roles —
 * dependency-free + node:test-tested, shared by <HealthGauge>/<StatusPill> and the
 * renderer's System Health panel. Color is always a semantic ROLE token (never hex).
 */

/** The visual band a 0–100 health score falls into. */
export type HealthBand = "ok" | "warn" | "danger";

/** The whole-system tier (mirrors core SystemHealth.tier). */
export type HealthViewTier = "ok" | "degraded" | "down";

/** A per-component status (mirrors core HealthComponent.status). */
export type HealthViewStatus = "ok" | "degraded" | "down" | "unknown";

/** One health row the panel renders (mirrors core HealthComponent, props-only). */
export interface HealthRow {
  id: string;
  label: string;
  status: HealthViewStatus;
  detail?: string;
  remediation?: string;
}

/** The whole-system view the panel renders (mirrors core SystemHealth, props-only). */
export interface SystemHealthView {
  tier: HealthViewTier;
  score: number;
  components: HealthRow[];
  summary: string;
}

/** Clamp a score into 0–100. */
export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Band a score: ≥80 ok · ≥50 warn · else danger. */
export function scoreBand(score: number): HealthBand {
  const s = clampScore(score);
  return s >= 80 ? "ok" : s >= 50 ? "warn" : "danger";
}

/** The role-token name for a score (drives `var(--<role>)`). */
export function scoreRole(score: number): HealthBand {
  return scoreBand(score);
}

/** The tier glyph (never color-only, 08 §7): ● ok · ▲ degraded · ⛔ down. */
export function tierGlyph(tier: HealthViewTier): string {
  return tier === "ok" ? "●" : tier === "degraded" ? "▲" : "⛔";
}

/** The role token for a tier. */
export function tierRole(tier: HealthViewTier): HealthBand {
  return tier === "ok" ? "ok" : tier === "degraded" ? "warn" : "danger";
}

/** A per-component status glyph + role. */
const STATUS_GLYPH: Record<HealthViewStatus, string> = {
  ok: "✓",
  degraded: "▲",
  down: "⛔",
  unknown: "•",
};
export function statusGlyph(status: HealthViewStatus): string {
  return STATUS_GLYPH[status];
}
export function statusRole(status: HealthViewStatus): HealthBand | "text-secondary" {
  return status === "ok"
    ? "ok"
    : status === "degraded"
      ? "warn"
      : status === "down"
        ? "danger"
        : "text-secondary";
}

/** The SVG arc geometry for a score ring (stroke-dasharray + dashoffset). */
export function ringGeometry(
  score: number,
  radius: number,
): { circumference: number; dashOffset: number } {
  const circumference = 2 * Math.PI * radius;
  const filled = clampScore(score) / 100;
  return { circumference, dashOffset: circumference * (1 - filled) };
}
