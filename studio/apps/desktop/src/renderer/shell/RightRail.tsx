/**
 * shell/RightRail.tsx — the agent rail (handoff §2.5, file 08 §4.2).
 *
 * "The right rail = the AI". It is ALWAYS one of exactly two things and NEVER absent:
 *   - OPEN      a 330px island: header (agent glyph · session chip · ＋ new · ⇥ minimise)
 *               over the agent body (or the Inspector's raw engine JSON).
 *   - MINIMISED a 42px tray strip: the agent icon (click restores) + a status dot.
 * The choice persists (App.tsx's `prometheus.layout` blob), so the rail comes back the
 * way you left it.
 *
 * The two modes still exist (agent / inspector) — the Inspector is where a power user
 * reads the selected entity's raw `--json` payload (08 §4.2).
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui only (the body is injected).
 */

import type { CSSProperties, ReactElement, ReactNode } from "react";

import { ResizeHandle, useResizable } from "./Resizable.js";
import { paneMaxWidth, readPaneWidth } from "./responsive.js";
import { safeInspectorJson } from "./rightrail-view.js";

/** §2.5: 330px open. */
const RAIL_DEFAULT = 330;
const RAIL_MIN = 280;
/** §2.5: a 42px tray strip when minimised — never an unmount. */
const RAIL_TRAY_WIDTH = 42;

export type RightRailMode = "agent" | "inspector";

/** What the tray dot / header dot says about the agent right now. */
export type AgentActivity = "idle" | "running" | "attention";

const ACTIVITY_VAR: Record<AgentActivity, string> = {
  idle: "--ok",
  running: "--accent",
  attention: "--warn",
};

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  idle: "agent idle",
  running: "agent running",
  attention: "agent awaiting approval",
};

export interface RightRailProps {
  collapsed: boolean;
  mode: RightRailMode;
  onModeChange(mode: RightRailMode): void;
  onToggle(): void;
  /** the agent/chat body (the route mounts file 07's AgentPane here). */
  agent?: ReactNode;
  /** the inspector payload — the selected entity's raw engine JSON. */
  inspectorJson?: unknown;
  /** the active chat session's title — the header's session chip (§2.5). */
  sessionLabel?: string;
  /** start a new chat (the header's ＋). */
  onNewSession?(): void;
  /** what the status dot reports, in both the header and the tray. */
  activity?: AgentActivity;
}

/** Icon-button style for the collapsed tray + the header actions. */
function iconButtonStyle(activeItem: boolean): CSSProperties {
  return {
    width: 30,
    height: 30,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: activeItem ? "var(--bg-active)" : "transparent",
    border: "none",
    borderRadius: 9,
    color: activeItem ? "var(--accent)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
  };
}

function headerActionStyle(): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "var(--text-disabled)",
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
    padding: "0 2px",
  };
}

function tabStyle(activeTab: boolean): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    borderBottom: `2px solid ${activeTab ? "var(--accent)" : "transparent"}`,
    color: activeTab ? "var(--text-primary)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: activeTab ? 600 : 400,
    padding: "2px 1px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  };
}

/** The agent spark, in the brand-2 tint the prototype uses for "the AI is here". */
function AgentGlyph({ size = 13 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7L12 3Z"
        fill="var(--brand-2)"
      />
    </svg>
  );
}

export function RightRail({
  collapsed,
  mode,
  onModeChange,
  onToggle,
  agent,
  inspectorJson,
  sessionLabel,
  onNewSession,
  activity = "idle",
}: RightRailProps): ReactElement {
  // Drag the LEFT edge to resize (invert: dragging left grows the rail).
  const rz = useResizable({
    axis: "x",
    initial: RAIL_DEFAULT,
    min: RAIL_MIN,
    // 0.42 so rail_max + sidebar_max (0.35) + the 46px activity bar + the 8px island gaps
    // can never exceed the viewport at the 1100px window minimum.
    // Budgeted against the SIDEBAR — see Sidebar.tsx and responsive.ts WORKBENCH_MIN.
    max: () =>
      paneMaxWidth({
        viewportWidth: window.innerWidth,
        ownMin: RAIL_MIN,
        fraction: 0.42,
        siblingWidth: readPaneWidth("prometheus.layout.sidebarWidth", 240),
      }),
    invert: true,
    storageKey: "prometheus.layout.rightRailWidth",
  });

  if (collapsed) {
    // MINIMISED: a 42px tray strip. Kept AFTER the useResizable call so hook order stays
    // stable across the two branches.
    return (
      <aside
        aria-label="Agent (minimised)"
        data-shell-region="rail"
        tabIndex={-1}
        style={{
          width: RAIL_TRAY_WIDTH,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          paddingBlock: 12,
          borderLeft: "1px solid var(--border-header)",
        }}
      >
        <button
          type="button"
          aria-label="Expand right rail"
          aria-expanded={false}
          title="Open agent chat (⌥⌘B)"
          onClick={onToggle}
          style={iconButtonStyle(true)}
        >
          <AgentGlyph size={14} />
        </button>
        <span
          title={ACTIVITY_LABEL[activity]}
          aria-label={ACTIVITY_LABEL[activity]}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: `var(${ACTIVITY_VAR[activity]})`,
            animation: activity === "running" ? "prom-pulse 1.6s ease-in-out infinite" : undefined,
          }}
        />
        <div style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="Open Inspector"
          title="Inspector"
          onClick={() => {
            onModeChange("inspector");
            onToggle();
          }}
          style={iconButtonStyle(false)}
        >
          {"{}"}
        </button>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Agent"
      data-shell-region="rail"
      tabIndex={-1}
      style={{
        // §2.5: an ISLAND, not a bordered slab bolted to the window edge.
        position: "relative",
        width: rz.size,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-island)",
        overflow: "hidden",
      }}
    >
      <ResizeHandle axis="x" edge="left" rz={rz} label="Resize AI rail" min={RAIL_MIN} />
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: "none",
          padding: "9px 12px",
          borderBottom: "1px solid var(--border-header)",
        }}
      >
        <AgentGlyph />
        <button
          type="button"
          onClick={() => onModeChange("agent")}
          style={{
            ...tabStyle(mode === "agent"),
            fontSize: 12.5,
            fontWeight: 600,
            textTransform: "none",
            letterSpacing: 0,
            color: mode === "agent" ? "var(--text-title)" : "var(--text-muted)",
          }}
        >
          Agent
        </button>
        {mode === "agent" && sessionLabel && (
          <span
            title={sessionLabel}
            style={{
              fontSize: 11,
              padding: "1px 8px",
              borderRadius: "var(--radius-md)",
              background: "var(--bg-active)",
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              maxWidth: 110,
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
              whiteSpace: "nowrap",
            }}
          >
            {sessionLabel}
          </span>
        )}
        <button
          type="button"
          onClick={() => onModeChange("inspector")}
          style={tabStyle(mode === "inspector")}
        >
          Inspector
        </button>
        <div style={{ flex: 1 }} />
        {onNewSession && (
          <button
            type="button"
            aria-label="New chat"
            title="New chat"
            onClick={onNewSession}
            style={headerActionStyle()}
          >
            ＋
          </button>
        )}
        <button
          type="button"
          aria-label="Minimise right rail to tray"
          title="Minimise to tray (⌥⌘B)"
          onClick={onToggle}
          style={headerActionStyle()}
        >
          ⇥
        </button>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: mode === "agent" ? 10 : 0 }}>
        {mode === "agent" ? (
          (agent ?? <RailEmpty />)
        ) : (
          <pre
            style={{
              margin: 0,
              padding: 12,
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              color: "var(--text-muted)",
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

function RailEmpty(): ReactElement {
  return (
    <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12.5, lineHeight: 1.5 }}>
      The agent pane is mounted by the Editor workbench on this route.
    </div>
  );
}

export default RightRail;
