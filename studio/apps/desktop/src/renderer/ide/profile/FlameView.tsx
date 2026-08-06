/**
 * FlameView.tsx — the Profiler tool window (file 14 §3.28).
 *
 * A flame graph + call-tree over a folded sample tree. Presentational + controlled: the
 * profile comes from the profile.py sidecar (cProfile/py-spy → tree) over
 * window.prometheus (runtime seam; profiling executes the target → run-gate). The bars'
 * width = hit ratio vs the CURRENT root; color intensity = self-heaviness. No raw hex.
 *
 * Zoom/search STATE lives in ProfilePanel (APP-047) — FlameView only takes rendering
 * hooks: `onZoom(path)` to re-root, `highlightNames` to dim non-matches, and a controlled
 * hover overlay for the name·total·self·% tooltip (native title has a fixed OS delay).
 */
import { Panel } from "@prometheus/ui";
import { type ReactElement, useMemo, useState } from "react";

import {
  type FlameNode,
  flameRowsWithPath,
  formatProfileValue,
  hottestPath,
  sortByAbsValue,
  sortHotFirst,
} from "./profile-view.js";

export interface FlameViewProps {
  root?: FlameNode;
  selectedName?: string;
  onSelect?: (name: string) => void;
  /** re-root the flame at the clicked frame (path = child names from root). */
  onZoom?: (path: string[]) => void;
  /** names to keep BRIGHT during a search; others dim. Empty/undefined = no dimming. */
  highlightNames?: Set<string>;
  /** APP-089: the value unit ("us" | "bytes" | "samples") for tooltips + labels. */
  unit?: string;
  /** APP-089: a DELTA/compare tree — bars color by SIGN (regression danger / improvement
   *  ok), rows sort by |value|, and the (meaningless) hot-path line is hidden. */
  signed?: boolean;
}

interface Hover {
  x: number;
  y: number;
  name: string;
  value: number;
  self: number;
  ratio: number;
}

/** The §3.28 flame graph + call tree. */
export function FlameView({
  root,
  selectedName,
  onSelect,
  onZoom,
  highlightNames,
  unit = "us",
  signed = false,
}: FlameViewProps): ReactElement {
  const sorted = useMemo(
    () => (root ? (signed ? sortByAbsValue(root) : sortHotFirst(root)) : undefined),
    [root, signed],
  );
  const rows = useMemo(() => (sorted ? flameRowsWithPath(sorted) : []), [sorted]);
  // a hot-path over signed deltas is meaningless — only compute it for a normal profile.
  const hot = useMemo(() => (sorted && !signed ? hottestPath(sorted) : []), [sorted, signed]);
  const [hover, setHover] = useState<Hover | null>(null);
  const total = sorted?.value ?? 0;
  const dimming = !!highlightNames && highlightNames.size > 0;

  if (!root) {
    return (
      <Panel title="Profiler" elevation="e1">
        <div
          style={{
            color: "var(--text-secondary)",
            fontSize: "var(--text-small-size, 0.8125rem)",
            padding: "var(--space-3, 6px)",
          }}
        >
          no profile — run a config with profiling
        </div>
      </Panel>
    );
  }

  // in signed (compare) mode the bar width scales by |value| vs the largest |value| shown.
  const maxAbs = signed ? Math.max(1, ...rows.map((r) => Math.abs(r.value))) : 0;
  return (
    <Panel title="Profiler" elevation="e1">
      {hot.length > 0 && (
        <div
          style={{
            fontSize: "var(--text-small-size, 0.8125rem)",
            color: "var(--text-secondary)",
            marginBottom: "var(--space-2, 4px)",
          }}
        >
          hot path:{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--danger)" }}>
            {hot.join(" › ")}
          </span>
        </div>
      )}
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 1,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-small-size, 0.8125rem)",
        }}
      >
        {rows.map((r, i) => {
          const dim = dimming && !highlightNames?.has(r.name);
          const barRatio = signed ? Math.abs(r.value) / maxAbs : r.ratio;
          const label = signed
            ? formatProfileValue(r.value, unit)
            : `${(total > 0 ? (r.value / total) * 100 : 0).toFixed(1)}%`;
          return (
            <button
              // depth+name collides for a function that recurs at the same depth under
              // different parents; the flat row index disambiguates (rows are a stable
              // pre-order flatten, regenerated each render).
              key={`${i}-${r.depth}-${r.name}`}
              type="button"
              onClick={() => onSelect?.(r.name)}
              onDoubleClick={() => onZoom?.(r.path)}
              onMouseMove={(e) =>
                setHover({
                  x: e.clientX,
                  y: e.clientY,
                  name: r.name,
                  value: r.value,
                  self: r.self,
                  ratio: r.ratio,
                })
              }
              onMouseLeave={() => setHover(null)}
              aria-label={`${r.name} ${(r.ratio * 100).toFixed(1)}%`}
              title="double-click to zoom"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2, 4px)",
                textAlign: "left",
                border: "none",
                cursor: "pointer",
                opacity: dim ? 0.35 : 1,
                paddingLeft: `calc(var(--space-2, 4px) + ${r.depth * 12}px)`,
                background: r.name === selectedName ? "var(--bg-inset)" : "transparent",
                color: "var(--text-primary)",
              }}
            >
              {/* the bar: width = |value| ratio; in compare mode color by SIGN (regression
                  danger / improvement ok), else by the warn/danger self-heaviness band. */}
              <span
                aria-hidden="true"
                style={{
                  display: "inline-block",
                  width: `${Math.max(2, Math.round(barRatio * 120))}px`,
                  height: "0.7em",
                  borderRadius: "var(--radius-sm, 4px)",
                  background: signed
                    ? r.value >= 0
                      ? "var(--danger)"
                      : "var(--ok)"
                    : r.ratio >= 0.5
                      ? "var(--danger)"
                      : r.ratio >= 0.2
                        ? "var(--warn)"
                        : "var(--accent)",
                }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.name}
              </span>
              <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                {label}
              </span>
            </button>
          );
        })}
        {hover && (
          <div
            role="tooltip"
            style={{
              position: "fixed",
              // clamp into the viewport so an edge-of-window hover isn't painted off-screen
              left: Math.min(
                hover.x + 12,
                (typeof window !== "undefined" ? window.innerWidth : 9999) - 300,
              ),
              top: Math.min(
                hover.y + 12,
                (typeof window !== "undefined" ? window.innerHeight : 9999) - 64,
              ),
              maxWidth: "min(300px, 90vw)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              zIndex: 50,
              pointerEvents: "none",
              padding: "var(--space-2, 4px) var(--space-3, 6px)",
              borderRadius: "var(--radius-sm, 4px)",
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-strong)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              whiteSpace: "nowrap",
            }}
          >
            <div style={{ color: "var(--accent)" }}>{hover.name}</div>
            <div style={{ color: "var(--text-secondary)" }}>
              total {formatProfileValue(hover.value, unit)} · self{" "}
              {formatProfileValue(hover.self, unit)}
              {signed ? "" : ` · ${(hover.ratio * 100).toFixed(1)}%`}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default FlameView;
