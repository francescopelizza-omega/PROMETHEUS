/**
 * shell/ActivityBar.tsx — the 46px left icon rail (handoff §2.2), in TWO parts.
 *
 * ## One column, not two
 *
 * The shell used to paint this rail and then, immediately to its right, a SECOND identical-
 * looking icon strip owned by the editor route (its twelve tool panels). Two adjacent columns
 * of same-sized icons meaning two unrelated things: you had to work out which strip was which
 * before you could read either, and together they spent roughly 100px of width saying it.
 *
 * Now it is one column split into two adaptive parts, separated by a visible rule: the six
 * NOUNS on top (fixed — this list never changes), and underneath them the tool panels belonging
 * to whichever noun is active. The relationship — these tools are inside that panel — is stated
 * by the layout instead of being something you infer from adjacency.
 *
 * The rule appears ONLY when the active activity actually has tool panels, so a divider always
 * means "there is a second part here" and never reads as decoration.
 *
 * Both parts scroll independently and both may shrink, so a short window degrades by scrolling
 * rather than by clipping the lower half off the bottom.
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
  type SubPanel,
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
  /** the ACTIVE activity's tool panels — the rail's lower part. Empty ⇒ no lower part,
   *  and no divider. */
  subPanels?: readonly SubPanel[];
  /** which tool panel is open. */
  activeSubPanel?: string | undefined;
  onSelectSubPanel?(id: string): void;
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

/** Where a hovered rail button sits on screen — the anchor for its flyout label. */
interface TipAnchor {
  label: string;
  /** viewport coords of the button's right edge / vertical centre. */
  x: number;
  y: number;
}

/**
 * A flyout label pinned to the right of a rail icon — the instant, styled hover
 * affordance the icon-only rail needs (native `title` lags ~1s and looks foreign).
 *
 * FIXED positioning, anchored to the hovered button's measured rect.
 *
 * It used to be `position: absolute` inside the button, which worked only while no ancestor
 * clipped. The rail's two parts are scroll containers (they have to be — twenty buttons do not
 * fit a short window), and a scroll container clips BOTH axes: CSS will not let `overflow-y`
 * be `auto` while `overflow-x` stays `visible`. So the absolute tooltip was cut off at the 46px
 * rail edge AND its overhang pushed a stray horizontal scrollbar into the column. `fixed`
 * escapes every ancestor, which is the only version of this that cannot be re-broken by
 * someone adding an `overflow` two levels up.
 */
function RailTooltip({ tip }: { tip: TipAnchor | null }): ReactElement | null {
  if (!tip) return null;
  return (
    <span
      role="tooltip"
      aria-hidden="true"
      style={{
        position: "fixed",
        left: tip.x + 10,
        top: tip.y,
        transform: "translateY(-50%)",
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
        zIndex: Z.dropdown,
      }}
    >
      {tip.label}
    </span>
  );
}

/** Measure a hovered rail button and turn it into a tooltip anchor. */
function anchorOf(el: HTMLElement, label: string): TipAnchor {
  const r = el.getBoundingClientRect();
  return { label, x: r.right, y: r.top + r.height / 2 };
}

export function ActivityBar({
  active,
  sidebarOpen,
  onSelect,
  aiOpen,
  aiRunningCount = 0,
  onToggleAI,
  onSettings,
  subPanels = [],
  activeSubPanel,
  onSelectSubPanel,
}: ActivityBarProps): ReactElement {
  const [hovered, setHovered] = useState<string | null>(null);
  // ONE tooltip for the whole rail, measured from whichever button is hovered. Rendering one
  // per button was fine while they were absolutely positioned inside it; a fixed tooltip has to
  // be anchored, and twenty always-mounted fixed spans would each be a layer.
  const [tip, setTip] = useState<TipAnchor | null>(null);
  /** Hover/focus handlers shared by every rail button: track the id AND measure the anchor. */
  const hoverProps = (key: string, label: string) => ({
    onMouseEnter: (e: { currentTarget: HTMLElement }) => {
      setHovered(key);
      setTip(anchorOf(e.currentTarget, label));
    },
    onMouseLeave: () => {
      setHovered((h) => (h === key ? null : h));
      setTip((t) => (t?.label === label ? null : t));
    },
    onFocus: (e: { currentTarget: HTMLElement }) => {
      setHovered(key);
      setTip(anchorOf(e.currentTarget, label));
    },
    onBlur: () => {
      setHovered((h) => (h === key ? null : h));
      setTip((t) => (t?.label === label ? null : t));
    },
  });
  const hasLower = subPanels.length > 0 && !!onSelectSubPanel;
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
      {/* ── upper part: the six NOUNS. This list never changes. ────────────────── */}
      <div
        className="prom-rail-scroll"
        data-rail-section="activities"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          // `0 1 auto` — natural height, but ALLOWED to shrink. On a short window the six
          // nouns scroll inside their own part rather than pushing the tool panels off the
          // bottom of the rail, where nothing would reveal that they exist.
          flex: "0 1 auto",
          minHeight: 0,
          overflowY: "auto",
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
              {...hoverProps(a.id, a.label)}
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
            </button>
          );
        })}
      </div>

      {/* ── the divider: present ONLY when there is a lower part to divide off ──── */}
      {hasLower && (
        <div
          role="separator"
          aria-orientation="horizontal"
          style={{
            flex: "0 0 auto",
            height: 1,
            margin: "7px 9px",
            // `--border-strong`, not `--border-subtle`: this rule carries MEANING (everything
            // under it belongs to the panel selected above it), so it has to be legible rather
            // than tasteful. A hairline nobody can see is the same as no divider at all, and
            // then the lower icons read as more top-level nouns.
            background: "var(--border-strong)",
            borderRadius: 1,
          }}
        />
      )}

      {/* ── lower part: the ACTIVE activity's tool panels ───────────────────────── */}
      {hasLower && (
        <div
          className="prom-rail-scroll"
          data-rail-section="subpanels"
          aria-label="Panel tools"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            // `1 1 auto` — this part takes the leftover height and scrolls inside it. The
            // editor ships twelve tool panels, which is taller than the six nouns and taller
            // than a short window; scrolling here keeps the AI toggle and Settings pinned
            // where they always are instead of being pushed out of reach.
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
          }}
        >
          {subPanels.map((p) => {
            const isActive = p.id === activeSubPanel;
            const isHover = hovered === `__sub:${p.id}`;
            return (
              <button
                key={p.id}
                type="button"
                aria-label={p.label}
                aria-pressed={isActive}
                onClick={() => onSelectSubPanel?.(p.id)}
                {...hoverProps(`__sub:${p.id}`, p.label)}
                style={railButtonStyle(isActive, isHover)}
              >
                <ActivityIcon name={p.icon} size={19} active={isActive} />
              </button>
            );
          })}
        </div>
      )}

      {/* pushes the AI toggle + Settings to the bottom when there is no lower part to do it */}
      {!hasLower && <div style={{ flex: 1 }} />}

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
          {...hoverProps("__ai", "AI assistant")}
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
            {...hoverProps(p.id, p.label)}
            style={railButtonStyle(false, isHover)}
          >
            <ActivityIcon name={p.icon} size={19} />
          </button>
        );
      })}
      {/* ONE flyout label for the rail, positioned from the hovered button's measured rect.
          Rendered last so it is a sibling of the scroll sections rather than a descendant. */}
      <RailTooltip tip={tip} />
    </nav>
  );
}

/** A tiny re-export so the shell has one place to read verdict glyphs if needed. */
export { VERDICT_GLYPH };
