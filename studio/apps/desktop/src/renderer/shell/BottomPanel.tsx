/**
 * shell/BottomPanel.tsx — the §4.2 "telemetry of the moment" panel (file 08 §4.2).
 *
 * The bottom panel hosts the live telemetry tabs: Terminal (real PTY, file 07/11),
 * Problems (LSP + nemesis findings), Security (live scan/gate stream), Output
 * (sidecar logs), Tasks. Collapsible (⌃`). The shell owns the tab CHROME + which
 * tab is active; the bodies are injected by the workbench (the Editor route mounts
 * its real Terminal/Problems here).
 *
 * The top edge is a DRAG-TO-RESIZE handle (shared `useResizable`): the panel keeps
 * its expanded height across collapses, double-click resets it, and ↑/↓ nudge it
 * from the keyboard. The ▴/▾ button still collapses to a single tab row (⌃`) —
 * collapse and resize are orthogonal.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui only (the bodies are injected).
 */

import { type CSSProperties, type ReactElement, type ReactNode, useEffect, useState } from "react";

import { ResizeHandle, useResizable } from "./Resizable.js";
import { arrowMove, rovingTabIndex } from "./a11y.js";
import {
  BOTTOM_MAX_INSET,
  BOTTOM_MIN_HEIGHT,
  panelMaxHeight,
  resolvePanelHeight,
  shouldShowBadge,
} from "./bottom-panel-state.js";

export type BottomTab =
  | "terminal"
  | "problems"
  | "security"
  | "output"
  | "tasks"
  | "health"
  | "metadata"
  | "tokens"
  | "system"
  // APP-072: the editor workbench also hosts the DB console + profiler in the bottom panel.
  | "database"
  | "profiler"
  // handoff §2.4: the terminal island's "✳ Claude Code" tab — a terminal session running
  // the Claude Code CLI, not a second chat surface.
  | "claude";

export const BOTTOM_TABS: readonly { id: BottomTab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "problems", label: "Problems" },
  { id: "security", label: "Security" },
  { id: "output", label: "Output" },
  { id: "tasks", label: "Tasks" },
  { id: "health", label: "Health" },
  { id: "metadata", label: "Metadata" },
  { id: "tokens", label: "Save tokens" },
  { id: "system", label: "System" },
];

/** Default expanded panel height (px) — handoff §2.4's 212px terminal island; MIN/INSET are
 *  the single-sourced pure consts. Heights FLEX from here (drag + maximize), never hardcoded
 *  anywhere else. */
const DEFAULT_HEIGHT = 212;
const MIN_HEIGHT = BOTTOM_MIN_HEIGHT;
const MAX_HEIGHT_INSET = BOTTOM_MAX_INSET;

export interface BottomPanelProps {
  collapsed: boolean;
  active: BottomTab;
  onSelect(tab: BottomTab): void;
  onToggle(): void;
  /** which tabs to show (default ALL); a host that can't render every body passes a
   *  subset so it never opens a blank pane. */
  tabs?: readonly { id: BottomTab; label: string }[];
  /** optional per-tab badge counts (e.g. Problems(1), Security(0)). */
  counts?: Partial<Record<BottomTab, number>>;
  /** always-visible content pinned to the RIGHT of the tab row (the live PC-telemetry
   *  strip) — shown even while collapsed, so the readout is never hidden. */
  rightSlot?: ReactNode;
  /** the active tab's body (the workbench injects the real Terminal/Problems/…). */
  children?: ReactNode;
  /** APP-072: optional controlled maximize (expand to window-max). Omitted → internal state;
   *  App.tsx's mount passes neither, so its behavior is unchanged. */
  maximized?: boolean;
  onMaximize?(next: boolean): void;
}

/** §2.4: pill tabs — active gets the --bg-active tint, not an uppercase weight change. */
function tabStyle(activeTab: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: activeTab ? "var(--bg-active)" : "transparent",
    border: "none",
    borderRadius: 7,
    color: activeTab ? "var(--text-primary)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: activeTab ? 600 : 400,
    padding: "4px 12px",
    whiteSpace: "nowrap",
  };
}

export function BottomPanel({
  collapsed,
  active,
  onSelect,
  onToggle,
  tabs = BOTTOM_TABS,
  counts,
  rightSlot,
  children,
  maximized: maximizedProp,
  onMaximize,
}: BottomPanelProps): ReactElement {
  // Height persists across collapse/expand (collapse just overrides it with the
  // single tab row). Grip on the TOP edge → drag up grows the panel (invert).
  const rz = useResizable({
    axis: "y",
    initial: DEFAULT_HEIGHT,
    min: MIN_HEIGHT,
    max: () => Math.max(MIN_HEIGHT, window.innerHeight - MAX_HEIGHT_INSET),
    invert: true,
  });

  // APP-072: maximize. Uncontrolled internal state unless the host controls it (additive).
  const [maximizedState, setMaximizedState] = useState(false);
  const maximized = maximizedProp ?? maximizedState;
  const toggleMax = (): void => {
    const next = !maximized;
    onMaximize?.(next);
    if (maximizedProp === undefined) setMaximizedState(next);
    if (next && collapsed) onToggle(); // maximizing a collapsed panel expands it first
  };
  // recompute the window-relative max on resize (a shrunk window must not maximize off-screen).
  const [winH, setWinH] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 800,
  );
  useEffect(() => {
    const onResize = (): void => setWinH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const height = resolvePanelHeight({
    collapsed,
    maximized,
    size: rz.size,
    maxHeight: panelMaxHeight(winH),
    rowVar: "var(--row-h, 36px)",
  });

  return (
    <section
      aria-label="Bottom panel"
      data-shell-region="bottom"
      tabIndex={-1}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        // APP-100: minWidth:0 lets the panel shrink with a narrow window instead of forcing the
        // whole shell wider than the viewport (the tab row below clips gracefully).
        minWidth: 0,
        // §2/§2.4: an ISLAND — its own radius + border on the app ground, not a slab
        // welded to the window edge by a top hairline.
        borderRadius: "var(--radius-island)",
        border: "1px solid var(--border-subtle)",
        background: "var(--bg-inset)",
        overflow: "hidden",
        height,
      }}
    >
      {/* drag-to-resize grip straddling the top border (hidden while collapsed / maximized). */}
      {!collapsed && !maximized && (
        <ResizeHandle axis="y" edge="top" rz={rz} label="Resize bottom panel" min={MIN_HEIGHT} />
      )}
      <div
        role="tablist"
        aria-label="Bottom panel tabs"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          height: 32,
          flex: "none",
          background: "var(--bg-surface)",
          paddingInline: 8,
          // APP-100: clip (not overflow) when the window is too narrow for every tab + the strip.
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {tabs.map((t, i) => {
          const n = counts?.[t.id];
          // selection is independent of collapse — a collapsed panel still marks which
          // tab is active (else it reads as "nothing selected").
          const selected = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              // APP-100: roving tabindex (only the active tab is a tab stop) + Left/Right/Home/End
              // movement (ARIA APG tab pattern — aria-selected alone is not enough). Fallback: if
              // `active` isn't among the rendered tabs, the first tab is the stop (else the whole
              // tablist would be unreachable by Tab).
              tabIndex={rovingTabIndex(selected || (i === 0 && !tabs.some((t) => t.id === active)))}
              onKeyDown={(e) => {
                const ni = arrowMove(tabs.length, i, e.key);
                if (ni === null) return;
                e.preventDefault();
                onSelect(tabs[ni]!.id);
                const rail = e.currentTarget.parentElement;
                rail?.querySelectorAll<HTMLElement>('[role="tab"]')[ni]?.focus();
              }}
              onClick={() => {
                if (collapsed) onToggle();
                onSelect(t.id);
              }}
              style={tabStyle(selected)}
            >
              {t.label}
              {shouldShowBadge(n) && (
                // §2.4: a warn-tinted mono chip, not a parenthesised number.
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    padding: "0 5px",
                    borderRadius: 6,
                    background: "color-mix(in srgb, var(--warn) 15%, transparent)",
                    color: "var(--warn)",
                  }}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        {rightSlot && <div style={{ display: "flex", alignItems: "center" }}>{rightSlot}</div>}
        {/* APP-072: maximize toggle — expand the body to the window-max, restore on 2nd click.
            Hidden while collapsed (nothing to maximize). */}
        {!collapsed && (
          <button
            type="button"
            aria-label={maximized ? "Restore bottom panel" : "Maximize bottom panel"}
            title={maximized ? "Restore" : "Maximize"}
            onClick={toggleMax}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "0.9rem",
            }}
          >
            {maximized ? "⤡" : "⤢"}
          </button>
        )}
        <button
          type="button"
          aria-label={collapsed ? "Expand bottom panel" : "Collapse bottom panel"}
          title="Toggle (⌃`)"
          onClick={onToggle}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: "0.9rem",
          }}
        >
          {collapsed ? "▴" : "▾"}
        </button>
      </div>
      {!collapsed && <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>{children}</div>}
    </section>
  );
}

export default BottomPanel;
