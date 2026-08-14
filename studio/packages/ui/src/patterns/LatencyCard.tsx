/**
 * patterns/LatencyCard.tsx — "where the time went" (handoff §3, closes C3.11).
 *
 * After every run: the total, a stacked bar, and a legend naming the four legs —
 * model / load / tools / wrapper. The point is attribution: a 22-second answer that
 * was 5s of model load reads completely differently from one that was 20s of model.
 *
 * The numbers come from real instrumentation (the renderer's chat client + agent
 * loop measure each leg); this component only draws them. A leg the caller could not
 * measure is passed as 0 and simply contributes no width — the card never invents a
 * segment to make the bar look full.
 */

import type { ReactElement } from "react";

/** Per-phase milliseconds for one run. */
export interface LatencyPhases {
  /** time the model spent generating (first token → last byte). */
  model: number;
  /** time before the first byte — connect, queue, weights load. */
  load: number;
  /** wall time inside tool calls (reads, greps, edits). */
  tools: number;
  /** everything else the wrapper itself spent. */
  wrapper: number;
}

export interface LatencyCardProps {
  phases: LatencyPhases;
  className?: string;
}

const LEGS: readonly { key: keyof LatencyPhases; label: string; tone: string }[] = [
  { key: "model", label: "model", tone: "--brand" },
  { key: "load", label: "load", tone: "--accent" },
  { key: "tools", label: "tools", tone: "--ok" },
  { key: "wrapper", label: "wrapper", tone: "--text-disabled" },
];

/** Seconds with one decimal, or `NNNms` under a second — a bare "0.0s" reads as broken. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function LatencyCard({ phases, className }: LatencyCardProps): ReactElement | null {
  const total = LEGS.reduce((sum, l) => sum + Math.max(0, phases[l.key] || 0), 0);
  // Nothing measured → render nothing. A zero-width bar is worse than no card.
  if (total <= 0) return null;
  return (
    <div
      className={className}
      aria-label={`Where the time went — ${formatMs(total)} total`}
      style={{
        padding: "7px 10px",
        borderRadius: 9,
        background: "var(--bg-inset)",
        border: "1px solid var(--border-row)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)", letterSpacing: "0.04em" }}>
          WHERE THE TIME WENT
        </span>
        <span
          style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-secondary)" }}
        >
          {formatMs(total)}
        </span>
      </div>
      <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", gap: 1 }}>
        {LEGS.map((l) => {
          const v = Math.max(0, phases[l.key] || 0);
          if (v <= 0) return null;
          return (
            <span
              key={l.key}
              title={`${l.label} ${formatMs(v)}`}
              style={{ width: `${(v / total) * 100}%`, background: `var(${l.tone})` }}
            />
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 5,
          flexWrap: "wrap",
          fontSize: 10.5,
          color: "var(--text-muted)",
        }}
      >
        {LEGS.map((l) => {
          const v = Math.max(0, phases[l.key] || 0);
          if (v <= 0) return null;
          return (
            <span key={l.key}>
              <span aria-hidden="true" style={{ color: `var(${l.tone})` }}>
                ■
              </span>{" "}
              {l.label} {formatMs(v)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default LatencyCard;
