/**
 * shell/TopBar.tsx — the 42px window header (handoff §2.1).
 *
 * Left → right: the macOS traffic-light inset · the pixel-art mark + gradient wordmark ·
 * the project+branch chip · a centred ⌘K search pill (opens the existing CommandPalette) ·
 * run / debug / stop · the §5 authorisation pill · the engine pill (7px dot + label).
 *
 * The bar is the window's DRAG HANDLE (`-webkit-app-region: drag`) because the native
 * title bar is hidden on macOS (`titleBarStyle: 'hiddenInset'`, main/index.ts) — every
 * interactive child opts back out with `no-drag` or it would be unclickable.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the renderer stores only.
 */

import type { CSSProperties, ReactElement } from "react";
import { useState } from "react";

import type { HealthPill } from "../stores/health-derive.js";
import { AuthPill } from "./AuthPill.js";
import { PrometheusMark } from "./PrometheusMark.js";

/** macOS hides the title bar and overlays the traffic lights on us; nobody else does. */
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent ?? "");

/** Room for the three OS buttons at trafficLightPosition {x:13,y:15} (main/index.ts). */
const TRAFFIC_LIGHT_INSET = 76;

const drag: CSSProperties = { WebkitAppRegion: "drag" } as CSSProperties;
const noDrag: CSSProperties = { WebkitAppRegion: "no-drag" } as CSSProperties;

const PILL_VAR: Record<HealthPill, string> = {
  ready: "--ok",
  degraded: "--warn",
  down: "--danger",
  unknown: "--text-disabled",
};

const PILL_LABEL: Record<HealthPill, string> = {
  ready: "engine ok",
  degraded: "engine degraded",
  down: "engine down",
  unknown: "engine …",
};

export interface TopBarProps {
  /** the open workspace's display name (the folder basename), if any. */
  project?: string;
  /** the git branch + ahead/behind, e.g. "main ↑2". */
  branch?: string;
  /** open the ⌘K command palette. */
  onCommandPalette(): void;
  /** the engine health pill — drives the dot color + label. */
  enginePill: HealthPill;
  /** click the engine pill → open the Health panel. */
  onEngineStatus(): void;
  /** run / debug / stop (each optional — an absent handler renders a disabled control). */
  onRun?(): void;
  onDebug?(): void;
  onStop?(): void;
  /** whether something is running (enables Stop, tints Run). */
  running?: boolean;
  /** click the project chip → open the Editor. */
  onOpenProject?(): void;
}

export function TopBar({
  project,
  branch,
  onCommandPalette,
  enginePill,
  onEngineStatus,
  onRun,
  onDebug,
  onStop,
  running,
  onOpenProject,
}: TopBarProps): ReactElement {
  const engineVar = PILL_VAR[enginePill];
  return (
    <header
      data-shell-region="topbar"
      tabIndex={-1}
      aria-label="Window header"
      style={{
        ...drag,
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 42,
        flex: "none",
        paddingInline: 12,
        paddingLeft: IS_MAC ? TRAFFIC_LIGHT_INSET : 12,
        borderBottom: "1px solid var(--border-header)",
      }}
    >
      {/* §8.2: the pixel-art mark + the gradient wordmark */}
      <span style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
        {/* alt="" — the wordmark beside it already says "Prometheus" to a screen reader. */}
        <PrometheusMark height={21} alt="" />
        <span className="prom-wordmark" style={{ fontSize: 14 }}>
          Prometheus
        </span>
      </span>

      {/* project + branch chip */}
      {project && (
        <button
          type="button"
          onClick={onOpenProject}
          title={branch ? `${project} · ${branch}` : project}
          // `flex: 0 1 auto` + a max width, overriding chipStyle's `flex: none`: a folder
          // basename and a branch name are both arbitrary length, and `none` (= 0 0 auto)
          // means the chip CANNOT shrink — a long branch pushed the ⌘K pill, the run
          // controls, the auth pill and the engine pill out of the 42px header entirely.
          // The full value stays on the title attribute.
          style={{ ...noDrag, ...chipStyle(), flex: "0 1 auto", maxWidth: "34%", minWidth: 0 }}
        >
          <span
            style={{
              color: "var(--text-primary)",
              fontWeight: 600,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {project}
          </span>
          {branch && (
            <>
              <span style={{ color: "var(--text-disabled)", flex: "none" }}>·</span>
              <BranchGlyph />
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {branch}
              </span>
            </>
          )}
        </button>
      )}

      {/* centred ⌘K pill */}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          justifyContent: "center",
          paddingInline: 12,
        }}
      >
        <button
          type="button"
          onClick={onCommandPalette}
          aria-label="Search or run a command"
          style={{
            ...noDrag,
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "min(480px, 100%)",
            height: 28,
            paddingInline: 12,
            borderRadius: "var(--radius-lg)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-chip)",
            color: "var(--text-disabled)",
            cursor: "pointer",
            fontFamily: "var(--font-ui)",
            fontSize: 12.5,
          }}
        >
          <SearchGlyph />
          <span style={{ flex: 1, textAlign: "left" }}>Search or run a command…</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-active)",
              color: "var(--text-muted)",
            }}
          >
            ⌘K
          </span>
        </button>
      </span>

      {/* run / debug / stop */}
      <span style={{ display: "flex", alignItems: "center", gap: 2, flex: "none", ...noDrag }}>
        <RunControl label="Run" tokenVar="--ok" onClick={onRun} disabled={!onRun}>
          <path d="M4 2.5v11l9-5.5-9-5.5Z" fill="currentColor" />
        </RunControl>
        <RunControl label="Debug" tokenVar="--warn" onClick={onDebug} disabled={!onDebug}>
          <g fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="8" cy="9" r="4" />
            <path d="M8 5V3M4.5 6 3 4.5M11.5 6 13 4.5M4 9H2m12 0h-2M4.5 12 3 13.5m8.5-1.5 1.5 1.5" />
          </g>
        </RunControl>
        <RunControl
          label="Stop"
          tokenVar="--danger"
          onClick={onStop}
          disabled={!onStop || !running}
        >
          <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
        </RunControl>
      </span>

      {/* §5 authorisation pill */}
      <span style={noDrag}>
        <AuthPill />
      </span>

      {/* engine pill */}
      <button
        type="button"
        onClick={onEngineStatus}
        title={`Engine: ${enginePill} — click for details`}
        aria-label={`Engine ${enginePill}`}
        style={{ ...noDrag, ...chipStyle(), cursor: "pointer" }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: `var(${engineVar})`,
            // a DOWN engine pulses — the one animated thing in the chrome, because it is
            // the one fact that invalidates every other panel on screen.
            animation: enginePill === "down" ? "prom-pulse 1.6s ease-in-out infinite" : undefined,
          }}
        />
        <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
          {PILL_LABEL[enginePill]}
        </span>
      </button>
    </header>
  );
}

/* ── local chrome ─────────────────────────────────────────────────────────────── */

function chipStyle(): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    padding: "0 10px",
    borderRadius: "var(--radius-lg)",
    background: "var(--bg-chip)",
    border: "1px solid var(--border-chip)",
    color: "var(--text-secondary)",
    cursor: "pointer",
    flex: "none",
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    whiteSpace: "nowrap",
  };
}

function RunControl({
  label,
  tokenVar,
  onClick,
  disabled,
  children,
}: {
  label: string;
  tokenVar: string;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactElement | ReactElement[];
}): ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: "var(--radius-md)",
        border: "none",
        background: hover && !disabled ? "var(--bg-active)" : "transparent",
        color: disabled ? "var(--text-disabled)" : `var(${tokenVar})`,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "background 120ms ease",
      }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {children}
      </svg>
    </button>
  );
}

function BranchGlyph(): ReactElement {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ color: "var(--accent)" }}
    >
      <path
        d="M5 3a2 2 0 1 0 0 .01M5 13a2 2 0 1 0 0 .01M11 5a2 2 0 1 0 0 .01M5 5v6M11 7c0 3-6 2-6 4"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function SearchGlyph(): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="m11 11 3 3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export default TopBar;
