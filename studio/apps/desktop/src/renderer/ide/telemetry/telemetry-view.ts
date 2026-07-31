/**
 * ide/telemetry/telemetry-view.ts — PURE presentation helpers for the telemetry UI.
 *
 * No React, no DOM — unit-testable with node:test. Formats bytes and maps a 0-100
 * percent to a SEVERITY TONE (ok/warn/danger) whose color the bars resolve from
 * design tokens (never a raw hex — the no-raw-hex guard).
 */

/** Human bytes: 0 → "0 B", 1536 → "1.5 KB", … up to TB. */
export function formatBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export type MeterTone = "ok" | "warn" | "danger";

/** Severity tone by occupancy: <70 ok · <90 warn · ≥90 danger (the guard ceiling). */
export function meterTone(usedPct: number): MeterTone {
  if (usedPct >= 90) return "danger";
  if (usedPct >= 70) return "warn";
  return "ok";
}

/** The design-token color var for a tone (bar fill / dot). */
export function toneVar(tone: MeterTone): string {
  return tone === "danger"
    ? "var(--danger, #ef5a5a)"
    : tone === "warn"
      ? "var(--warn, #e0a63a)"
      : "var(--ok, #36c46a)";
}

/** "used / total" label, e.g. "12.4 GB / 32 GB" (omits total when unknown). */
export function usedOfTotal(used?: number, total?: number): string {
  if (total === undefined) return formatBytes(used);
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}

/** "updated 3s ago" style relative label from a sample timestamp. */
export function sampledAgo(sampledAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - sampledAt) / 1000));
  if (s < 1) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}
