/**
 * shell/ActivityBar.tsx — the 56px left icon rail (file 08 §4.1).
 *
 * "Where am I": an ordered icon list, each opening a contextual sidebar + a
 * default workbench route. Renders the PURE ACTIVITIES + PINNED model from
 * @prometheus/ui (shared with the prometheus TUI, §8). The active item is brand-tinted
 * (rounded pill + glowing left bar + brand→accent gradient glyph); the
 * pinned-bottom group is the engine status pulse (+ glowing health dot) + Settings.
 *
 * Icons: the §4.1 glyph stays the accessible/CLI fallback (aria-label carries the
 * meaning); the GUI paints the custom bold inline-SVG set (@prometheus/ui
 * ActivityIcon) — bigger + clearer than the unicode glyph, fully ours, no icon-font.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui only.
 */

import {
  ACTIVITIES,
  ActivityIcon,
  type ActivityId,
  PINNED,
  type PinnedId,
  VERDICT_GLYPH,
} from "@prometheus/ui";
import type { CSSProperties, ReactElement } from "react";
import { useState } from "react";

import type { HealthPill } from "../stores/health-derive.js";

export interface ActivityBarProps {
  active: ActivityId;
  /** whether the ACTIVE activity's contextual sidebar is open — drives the left-bar
   *  indicator variant (full+glow = open, short+dim = collapsed/none, APP-003). */
  sidebarOpen?: boolean;
  onSelect(id: ActivityId): void;
  /** the engine pill state → tints the pinned engine glyph (◐ ready/degraded/down). */
  enginePill: HealthPill;
  /** whether the AI / right rail is currently open (tints the pinned ✦ toggle). */
  aiOpen?: boolean;
  /** count of agent runs in flight (APP-056) — a count badge on the ✦ so background runs
   *  stay visible even when the AI pane is collapsed (unmounted). 0 → no badge. */
  aiRunningCount?: number;
  /** toggle the AI / right rail (the pinned ✦) — the visible entry point besides ⌥⌘B. */
  onToggleAI?(): void;
  /** open settings (the pinned ⚙). */
  onSettings(): void;
  /** open the engine status (the pinned ◐). */
  onEngineStatus(): void;
}

const PILL_ROLE: Record<HealthPill, string> = {
  ready: "var(--ok)",
  degraded: "var(--warn)",
  down: "var(--danger)",
  unknown: "var(--text-secondary)",
};

function railButtonStyle(activeItem: boolean, hovered: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 46,
    height: 46,
    margin: "0 auto",
    background: activeItem
      ? "color-mix(in srgb, var(--brand) 16%, transparent)"
      : hovered
        ? "color-mix(in srgb, var(--text-secondary) 12%, transparent)"
        : "transparent",
    border: "none",
    borderRadius: "var(--radius-lg, 12px)",
    color: activeItem ? "var(--brand)" : hovered ? "var(--text-primary)" : "var(--text-secondary)",
    cursor: "pointer",
    position: "relative",
    transition: "background 120ms ease, color 120ms ease, transform 120ms ease",
    transform: hovered && !activeItem ? "scale(1.06)" : "scale(1)",
  };
}

/**
 * A flyout label pinned to the right of a rail icon — the instant, styled hover
 * affordance the icon-only rail needs (native `title` lags ~1s and looks foreign).
 * `pointer-events:none` so it never eats the hover; the rail paints above the
 * sidebar (nav z-index) so the pill overflows cleanly into the workbench.
 */
function RailTooltip({ label, show }: { label: string; show: boolean }): ReactElement {
  return (
    <span
      role="tooltip"
      aria-hidden="true"
      style={{
        position: "absolute",
        left: "calc(100% + 10px)",
        top: "50%",
        transform: show ? "translateY(-50%) translateX(0)" : "translateY(-50%) translateX(-4px)",
        padding: "4px 9px",
        background: "var(--bg-surface-2)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-md, 6px)",
        boxShadow: "var(--elevation-e2)",
        fontSize: "var(--text-small-size, 0.8125rem)",
        fontWeight: 500,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        pointerEvents: "none",
        opacity: show ? 1 : 0,
        transition: "opacity 90ms ease, transform 90ms ease",
        zIndex: 40,
      }}
    >
      {label}
    </span>
  );
}

export function ActivityBar({
  active,
  sidebarOpen,
  onSelect,
  enginePill,
  aiOpen,
  aiRunningCount = 0,
  onToggleAI,
  onSettings,
  onEngineStatus,
}: ActivityBarProps): ReactElement {
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <nav
      aria-label="Activity bar"
      style={{
        width: 56,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        paddingBlock: "var(--space-4, 8px)",
        gap: "var(--space-2, 5px)",
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--border-subtle)",
        // own a stacking context above the contextual sidebar so hover tooltips
        // overflow the 56px rail and paint over the workbench instead of clipping.
        position: "relative",
        zIndex: 30,
      }}
    >
      {ACTIVITIES.map((a) => {
        const isActive = a.id === active;
        const isHover = hovered === a.id;
        return (
          <button
            key={a.id}
            type="button"
            aria-label={a.label}
            aria-current={isActive ? "page" : undefined}
            aria-expanded={isActive ? !!sidebarOpen : undefined}
            onClick={() => onSelect(a.id as ActivityId)}
            onMouseEnter={() => setHovered(a.id)}
            onMouseLeave={() => setHovered((h) => (h === a.id ? null : h))}
            onFocus={() => setHovered(a.id)}
            onBlur={() => setHovered((h) => (h === a.id ? null : h))}
            style={railButtonStyle(isActive, isHover)}
          >
            {isActive && (
              // active-AND-open: full brand bar + glow · active-but-collapsed: short,
              // dimmed bar (APP-003 — the two states must be tell-apart-able at a glance).
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 0,
                  top: sidebarOpen ? 8 : 16,
                  bottom: sidebarOpen ? 8 : 16,
                  width: 3,
                  borderRadius: 3,
                  background: sidebarOpen
                    ? "var(--brand)"
                    : "color-mix(in srgb, var(--brand) 45%, transparent)",
                  boxShadow: sidebarOpen ? "0 0 8px var(--brand)" : "none",
                  transition: "top 120ms ease, bottom 120ms ease, background 120ms ease",
                }}
              />
            )}
            <ActivityIcon name={a.icon} size={25} active={isActive} />
            <RailTooltip label={a.label} show={isHover} />
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      {/* AI / right-rail toggle — the visible entry point to "the right rail = the AI"
          (the ⌥⌘B chord alone is undiscoverable). Brand-tinted while the rail is open. */}
      {onToggleAI && (
        <button
          type="button"
          aria-label={
            aiRunningCount > 0 ? `AI assistant (${aiRunningCount} running)` : "AI assistant"
          }
          aria-pressed={aiOpen}
          onClick={onToggleAI}
          onMouseEnter={() => setHovered("__ai")}
          onMouseLeave={() => setHovered((h) => (h === "__ai" ? null : h))}
          onFocus={() => setHovered("__ai")}
          onBlur={() => setHovered((h) => (h === "__ai" ? null : h))}
          style={{
            ...railButtonStyle(!!aiOpen, hovered === "__ai"),
            fontSize: "1.25rem",
            lineHeight: 1,
          }}
        >
          <span aria-hidden="true">✦</span>
          {aiRunningCount > 0 && (
            // background-run count badge (APP-056): visible even while the AI pane is
            // collapsed/unmounted, so the user knows a run is still progressing.
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 5,
                right: 5,
                minWidth: 15,
                height: 15,
                padding: "0 3px",
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 8,
                background: "var(--accent)",
                color: "var(--on-accent, var(--bg-app))",
                border: "1.5px solid var(--bg-surface)",
                fontSize: "0.6rem",
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              {aiRunningCount > 9 ? "9+" : aiRunningCount}
            </span>
          )}
          <RailTooltip label="AI assistant" show={hovered === "__ai"} />
        </button>
      )}

      {/* pinned bottom: engine status + settings (§4.1) */}
      {PINNED.map((p) => {
        const id = p.id as PinnedId;
        const onClick = id === "settings" ? onSettings : onEngineStatus;
        const isHover = hovered === p.id;
        const color = id === "engine" ? PILL_ROLE[enginePill] : undefined;
        const tip = id === "engine" ? `Engine: ${enginePill}` : p.label;
        return (
          <button
            key={p.id}
            type="button"
            aria-label={p.label}
            onClick={onClick}
            onMouseEnter={() => setHovered(p.id)}
            onMouseLeave={() => setHovered((h) => (h === p.id ? null : h))}
            onFocus={() => setHovered(p.id)}
            onBlur={() => setHovered((h) => (h === p.id ? null : h))}
            style={{ ...railButtonStyle(false, isHover), ...(color ? { color } : {}) }}
          >
            <ActivityIcon name={p.icon} size={id === "engine" ? 23 : 24} />
            {id === "engine" && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  right: 7,
                  bottom: 7,
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: color,
                  boxShadow: `0 0 6px ${color}`,
                  border: "1.5px solid var(--bg-surface)",
                }}
              />
            )}
            <RailTooltip label={tip} show={isHover} />
          </button>
        );
      })}
    </nav>
  );
}

/** A tiny re-export so the shell has one place to read verdict glyphs if needed. */
export { VERDICT_GLYPH };
