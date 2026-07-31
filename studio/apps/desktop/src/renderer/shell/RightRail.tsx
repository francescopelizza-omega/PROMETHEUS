/**
 * shell/RightRail.tsx — the right AI/agent/inspector rail (file 08 §4.2).
 *
 * "The right rail = the AI" (mirrors Cursor's right-side AI + Odysseus's agent
 * presence). Collapsible (⌥⌘B). Two modes: the agent/chat surface, and an
 * INSPECTOR that shows the selected entity's raw engine JSON (the --json payload)
 * for power users (08 §4.2). The shell mounts the real AgentPane (file 07) for the
 * chat mode; the inspector renders whatever JSON the workbench hands it.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui only (the body is injected).
 */

import type { CSSProperties, ReactElement, ReactNode } from "react";

import { ResizeHandle, useResizable } from "./Resizable.js";
import { safeInspectorJson } from "./rightrail-view.js";

const RAIL_DEFAULT = 320;
const RAIL_MIN = 260;

export type RightRailMode = "agent" | "inspector";

export interface RightRailProps {
  collapsed: boolean;
  mode: RightRailMode;
  onModeChange(mode: RightRailMode): void;
  onToggle(): void;
  /** the agent/chat body (the route mounts file 07's AgentPane here). */
  agent?: ReactNode;
  /** the inspector payload — the selected entity's raw engine JSON. */
  inspectorJson?: unknown;
}

function tabStyle(activeTab: boolean): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    borderBottom: `2px solid ${activeTab ? "var(--accent)" : "transparent"}`,
    color: activeTab ? "var(--text-primary)" : "var(--text-secondary)",
    cursor: "pointer",
    fontSize: "0.78rem",
    fontWeight: activeTab ? 600 : 400,
    padding: "4px 2px",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  };
}

export function RightRail({
  collapsed,
  mode,
  onModeChange,
  onToggle,
  agent,
  inspectorJson,
}: RightRailProps): ReactElement | null {
  // Drag the LEFT edge to resize (invert: dragging left grows the rail).
  const rz = useResizable({
    axis: "x",
    initial: RAIL_DEFAULT,
    min: RAIL_MIN,
    max: () => Math.max(RAIL_MIN, Math.round(window.innerWidth * 0.6)),
    invert: true,
  });
  if (collapsed) return null;
  return (
    <aside
      aria-label="AI and inspector"
      data-shell-region="rail"
      tabIndex={-1}
      style={{
        position: "relative",
        width: rz.size,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        borderLeft: "1px solid var(--border-subtle)",
        overflow: "hidden",
      }}
    >
      <ResizeHandle axis="x" edge="left" rz={rz} label="Resize AI rail" min={RAIL_MIN} />
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-6, 12px)",
          height: "var(--row-h, 36px)",
          paddingInline: "var(--space-6, 12px)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <button
          type="button"
          style={tabStyle(mode === "agent")}
          onClick={() => onModeChange("agent")}
        >
          AI
        </button>
        <button
          type="button"
          style={tabStyle(mode === "inspector")}
          onClick={() => onModeChange("inspector")}
        >
          Inspector
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="Collapse right rail"
          title="Collapse (⌥⌘B)"
          onClick={onToggle}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
            fontSize: "0.9rem",
          }}
        >
          ⟩
        </button>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {mode === "agent" ? (
          (agent ?? <RailEmpty label="Agent pane" />)
        ) : (
          <pre
            style={{
              margin: 0,
              padding: "var(--space-6, 12px)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {inspectorJson === undefined
              ? "Nothing selected — open a route or select an item to inspect."
              : safeInspectorJson(inspectorJson)}
          </pre>
        )}
      </div>
    </aside>
  );
}

function RailEmpty({ label }: { label: string }): ReactElement {
  return (
    <div
      style={{
        padding: "var(--space-8, 16px)",
        color: "var(--text-secondary)",
        fontSize: "0.85rem",
      }}
    >
      {label} is available in the Editor workbench.
    </div>
  );
}

export default RightRail;
