/**
 * shell/ActivityBar.tsx — the 46px left icon rail (handoff §2.2).
 *
 * "Where am I": an ordered icon list, each opening a contextual sidebar + a
 * default workbench route. Renders the PURE RAIL_ACTIVITIES + PINNED model from
 * @prometheus/ui (shared with the prometheus TUI, §8). The active item gets the
 * `--bg-active` tint, an accent glyph, and a 2.5px brand→accent gradient bar on its
 * left edge; Settings stays pinned at the bottom.
 *
 * The ENGINE pill moved to the TopBar (§2.1) — it is a window-level fact, not a
 * navigation target. `PINNED` still carries its entry (the TUI reads the same model),
 * so this component filters it out rather than the shared data dropping it.
 *
 * Icons: the §4.1 glyph stays the accessible/CLI fallback (aria-label carries the
 * meaning); the GUI paints the custom bold inline-SVG set (@prometheus/ui
 * ActivityIcon) — bigger + clearer than the unicode glyph, fully ours, no icon-font.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui only.
 */

import {
  ActivityIcon,
  type ActivityId,
  PINNED,
  type PinnedId,
  RAIL_ACTIVITIES,
  VERDICT_GLYPH,
  Z,
} from "@prometheus/ui";
import type { CSSProperties, ReactElement } from "react";
import { useState } from "react";

export interface ActivityBarProps {
  active: ActivityId;
  /** whether the ACTIVE activity's contextual sidebar is open — drives the left-bar
   *  indicator variant (full = open, short = collapsed/none, APP-003). */
  sidebarOpen?: boolean;
  onSelect(id: ActivityId): void;
  /** whether the AI / right rail is currently open (tints the ✦ toggle). */
  aiOpen?: boolean;
  /** count of agent runs in flight (APP-056) — a count badge on the ✦ so background runs
   *  stay visible even when the AI pane is minimised. 0 → no badge. */
  aiRunningCount?: number;
  /** toggle the AI / right rail (the ✦) — the visible entry point besides ⌥⌘B. */
  onToggleAI?(): void;
  /** open settings (the pinned ⚙). */
  onSettings(): void;
}

/** §2.2: 34×34 buttons, radius 9, active = --bg-active + accent glyph. */
function railButtonStyle(activeItem: boolean, hovered: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 34,
    height: 34,
    margin: "0 auto",
    background: activeItem || hovered ? "var(--bg-active)" : "transparent",
    border: "none",
    borderRadius: 9,
    color: activeItem ? "var(--accent)" : hovered ? "var(--text-title)" : "var(--text-muted)",
    cursor: "pointer",
    position: "relative",
    transition: "background 120ms ease, color 120ms ease",
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
        zIndex: Z.dropdown,
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
  aiOpen,
  aiRunningCount = 0,
  onToggleAI,
  onSettings,
}: ActivityBarProps): ReactElement {
  const [hovered, setHovered] = useState<string | null>(null);
  return (
    <nav
      aria-label="Activity bar"
      style={{
        width: 46,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        paddingBlock: "var(--space-4)",
        gap: 2,
        borderRight: "1px solid var(--border-header)",
        // own a stacking context above the contextual sidebar so hover tooltips
        // overflow the 46px rail and paint over the workbench instead of clipping.
        position: "relative",
        zIndex: Z.raise,
      }}
    >
      {RAIL_ACTIVITIES.map((a) => {
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
              // §2.2: a 2.5px brand→accent gradient bar on the rail's left edge. It shortens
              // when the contextual sidebar is closed, so "active" and "active + open" stay
              // tell-apart-able at a glance (APP-003) without a second color.
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: -6,
                  top: sidebarOpen ? 4 : 10,
                  bottom: sidebarOpen ? 4 : 10,
                  width: 2.5,
                  borderRadius: 2,
                  background: "var(--gradient-brand-v)",
                  transition: "top 120ms ease, bottom 120ms ease",
                }}
              />
            )}
            <ActivityIcon name={a.icon} size={20} active={isActive} />
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
            fontSize: 15,
            lineHeight: 1,
          }}
        >
          <span aria-hidden="true">✦</span>
          {aiRunningCount > 0 && (
            // background-run count badge (APP-056): visible even while the AI pane is
            // minimised to its tray, so the user knows a run is still progressing.
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 1,
                right: 1,
                minWidth: 14,
                height: 14,
                padding: "0 3px",
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 7,
                background: "var(--accent)",
                color: "var(--bg-app)",
                border: "1.5px solid var(--bg-app)",
                fontSize: 9,
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

      {/* pinned bottom: Settings only. The ENGINE pill moved to the TopBar (§2.1) — it is
          a window-level fact, not a place you navigate to. PINNED keeps its `engine` entry
          because the TUI renders the same shared model; we filter it here. */}
      {PINNED.filter((p) => (p.id as PinnedId) !== "engine").map((p) => {
        const isHover = hovered === p.id;
        return (
          <button
            key={p.id}
            type="button"
            aria-label={p.label}
            onClick={onSettings}
            onMouseEnter={() => setHovered(p.id)}
            onMouseLeave={() => setHovered((h) => (h === p.id ? null : h))}
            onFocus={() => setHovered(p.id)}
            onBlur={() => setHovered((h) => (h === p.id ? null : h))}
            style={railButtonStyle(false, isHover)}
          >
            <ActivityIcon name={p.icon} size={19} />
            <RailTooltip label={p.label} show={isHover} />
          </button>
        );
      })}
    </nav>
  );
}

/** A tiny re-export so the shell has one place to read verdict glyphs if needed. */
export { VERDICT_GLYPH };
