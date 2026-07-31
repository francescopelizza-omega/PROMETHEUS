/**
 * shell/Sidebar.tsx — the contextual sidebar (file 08 §4).
 *
 * The sidebar shows the CONTEXT of the active activity: a titled column whose
 * body is route-dependent (renderer/sidebar-bodies.tsx registers them; the Editor
 * route's body is a compact open-editors list — its full file tree lives in the
 * route's own tool-windows, file 07). Collapsible (the activity rail toggles it,
 * per-route persisted). Pure presentational chrome reading CSS-var tokens (08 §6).
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui only.
 */

import { type ActivityId, sidebarTitle } from "@prometheus/ui";
import type { ReactElement, ReactNode } from "react";

import { ResizeHandle, useResizable } from "./Resizable.js";

const SIDEBAR_DEFAULT = 240;
const SIDEBAR_MIN = 180;

export interface SidebarProps {
  activity: ActivityId;
  collapsed: boolean;
  onToggle(): void;
  /** route-specific sidebar body (a feature file may inject its own). */
  children?: ReactNode;
}

export function Sidebar({
  activity,
  collapsed,
  onToggle,
  children,
}: SidebarProps): ReactElement | null {
  // Drag the RIGHT edge to resize the contextual sidebar (handle hooks always run —
  // the early collapse return below is after, keeping hook order stable).
  const rz = useResizable({
    axis: "x",
    initial: SIDEBAR_DEFAULT,
    min: SIDEBAR_MIN,
    max: () => Math.max(SIDEBAR_MIN, Math.round(window.innerWidth * 0.5)),
    storageKey: "prometheus.layout.sidebarWidth",
  });
  if (collapsed) return null;
  return (
    <aside
      aria-label={`${sidebarTitle(activity)} sidebar`}
      data-shell-region="sidebar"
      tabIndex={-1}
      style={{
        position: "relative",
        width: rz.size,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--border-subtle)",
        overflow: "hidden",
      }}
    >
      <ResizeHandle axis="x" edge="right" rz={rz} label="Resize sidebar" min={SIDEBAR_MIN} />
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: "var(--row-h, 36px)",
          paddingInline: "var(--space-6, 12px)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <span
          style={{
            fontSize: "var(--text-small-size, 0.8125rem)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--text-secondary)",
          }}
        >
          {sidebarTitle(activity)}
        </span>
        <button
          type="button"
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          onClick={onToggle}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: "0.9rem",
            lineHeight: 1,
          }}
        >
          ⟨
        </button>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {/* nullish body → explicit empty state, an open sidebar is never a blank column.
            Lives INSIDE the returned JSX (never an early return — hook order above). */}
        {children ?? (
          <div
            style={{
              padding: "var(--space-8, 16px)",
              color: "var(--text-secondary)",
              fontSize: "0.8125rem",
              lineHeight: 1.5,
            }}
          >
            No contextual view for this activity yet.
          </div>
        )}
      </div>
    </aside>
  );
}

export default Sidebar;
