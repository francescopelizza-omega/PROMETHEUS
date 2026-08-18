/**
 * shell/AuthPill.tsx — the authorisation readout + picker (handoff §5).
 *
 * §5 says the level must be visible EVERYWHERE, so this file owns the two shapes it takes
 * and nothing else re-invents them:
 *   - <AuthPill>   the TopBar chip: `A{n}` + the level's plain-English name + an
 *                  8-segment meter. Click opens the picker.
 *   - <AuthPicker> the popover list of all eight levels with their descriptions.
 *
 * Colors come from the ONE ladder in stores/authorisation.ts (`authLevelVar`), as CSS var
 * names — never literal hex, so a scheme swap re-tints the pill for free (08 §6).
 *
 * Renderer-SANDBOXED (C5): react + the renderer store only.
 */

import type { CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PERMISSION_MODES } from "@prometheus/core/agent-permission-modes";
import { Z } from "@prometheus/ui";
import {
  MAX_AUTH_LEVEL,
  authLevelUiLabel,
  authLevelVar,
  authLevels,
  useAuthorisationStore,
} from "../stores/authorisation.js";

/** The 8-segment meter: filled up to and including the active level. */
function AuthMeter({ level }: { level: number }): ReactElement {
  const color = `var(${authLevelVar(level)})`;
  return (
    <span style={{ display: "flex", gap: 2 }} aria-hidden="true">
      {Array.from({ length: MAX_AUTH_LEVEL + 1 }, (_, i) => `seg-${i}`).map((id, i) => (
        <span
          key={id}
          style={{
            width: 4,
            height: 10,
            borderRadius: 2,
            background: i <= level ? color : "var(--border-strong)",
          }}
        />
      ))}
    </span>
  );
}

export interface AuthPillProps {
  /** compact = drop the name + meter (the chat composer's right-aligned `A{n}`). */
  compact?: boolean;
  /** override the click behaviour (default: open the picker popover). */
  onClick?: () => void;
}

/**
 * The TopBar authorisation pill. Renders `A{n} · name · ▮▮▮▯▯▯▯▯` and opens the picker.
 * `compact` renders only the mono `A{n}` for the dense surfaces (composer, card headers).
 */
export function AuthPill({ compact, onClick }: AuthPillProps): ReactElement {
  const level = useAuthorisationStore((s) => s.level);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const color = `var(${authLevelVar(level)})`;
  const name = authLevelUiLabel(level);

  // click-outside + Esc close the picker (it is a popover, not a modal — no focus trap).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handle = useCallback((): void => {
    if (onClick) onClick();
    else setOpen((v) => !v);
  }, [onClick]);

  if (compact) {
    return (
      <button
        type="button"
        onClick={handle}
        title={`Authorisation A${level} — ${name}`}
        aria-label={`Authorisation level A${level}, ${name}`}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          fontWeight: 700,
          color,
        }}
      >
        A{level}
      </button>
    );
  }

  return (
    <span ref={wrapRef} style={{ position: "relative", flex: "none" }}>
      <button
        type="button"
        onClick={handle}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Authorisation level — click to change"
        aria-label={`Authorisation level A${level}, ${name}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          height: 28,
          padding: "0 10px",
          borderRadius: "var(--radius-lg)",
          background: "var(--bg-chip)",
          border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
          cursor: "pointer",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 11, color }}>
          A{level}
        </span>
        <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{name}</span>
        <AuthMeter level={level} />
      </button>
      {open && <AuthPicker onClose={() => setOpen(false)} />}
    </span>
  );
}

/**
 * The eight-level picker popover. `placement` decides which anchor it hangs from:
 * "below" for the TopBar pill, "above" for the StatusBar entry at the bottom of the
 * window (where a downward popover would open off-screen).
 */
export function AuthPicker({
  onClose,
  placement = "below",
}: {
  onClose: () => void;
  placement?: "below" | "above";
}): ReactElement {
  const level = useAuthorisationStore((s) => s.level);
  const setLevel = useAuthorisationStore((s) => s.setLevel);
  const mode = useAuthorisationStore((s) => s.permissionMode);
  const setPermissionMode = useAuthorisationStore((s) => s.setPermissionMode);
  return (
    <div
      role="listbox"
      tabIndex={-1}
      aria-label="Authorisation level"
      style={{
        position: "absolute",
        ...(placement === "below"
          ? { top: "calc(100% + 6px)", right: 0 }
          : { bottom: "calc(100% + 6px)", left: 0 }),
        width: 320,
        zIndex: Z.dropdown,
        display: "flex",
        flexDirection: "column",
        borderRadius: "var(--radius-island)",
        background: "var(--bg-surface-2)",
        border: "1px solid var(--border-strong)",
        boxShadow: "var(--elevation-e3)",
        overflow: "hidden",
      }}
    >
      {/*
       * THE POSTURE, above the ladder — the half of this control that had no UI at all.
       *
       * `setPermissionMode` exists, clamps its input, persists to localStorage, drives
       * `modeToAuthLevel`, and rides the tuning into core's loop, which enforces the plan-mode
       * DENY. Every piece worked. Nothing called it: PLAN MODE was reachable in Studio only by
       * hand-editing `prometheus.permissionMode.v1` in localStorage, while the CLI has offered
       * it on Shift-Tab all along. Same product, same words, one surface where they did nothing.
       *
       * Placed first because it is the coarser dial: the mode SETS the level (a plan-mode pick
       * drops the ladder to read-only), so choosing a level afterwards is the fine adjustment.
       * Only the `inCycle` modes are offered — bypass and YOLO stay deliberate, explicit acts,
       * exactly as they are in the TUI.
       */}
      <div
        style={{
          padding: "6px 10px 4px",
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        Mode
      </div>
      {PERMISSION_MODES.filter((m) => m.inCycle).map((m) => {
        const active = m.id === mode;
        return (
          <button
            key={m.id}
            type="button"
            role="option"
            aria-selected={active}
            onClick={() => {
              setPermissionMode(m.id);
              onClose();
            }}
            style={rowStyle(active)}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                width: 20,
                flex: "none",
                textAlign: "left",
                color: active ? "var(--text-primary)" : "var(--text-muted)",
              }}
            >
              {active ? "●" : "○"}
            </span>
            <span style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
              <span
                style={{
                  display: "block",
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 500,
                  color: active ? "var(--text-primary)" : "var(--text-title)",
                }}
              >
                {m.label}
              </span>
              <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                {m.description}
              </span>
            </span>
          </button>
        );
      })}
      <div
        style={{
          padding: "6px 10px 4px",
          borderTop: "1px solid var(--border-subtle)",
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        Level
      </div>
      {authLevels().map((meta) => {
        const active = meta.level === level;
        const color = `var(${authLevelVar(meta.level)})`;
        return (
          <button
            key={meta.level}
            type="button"
            role="option"
            aria-selected={active}
            onClick={() => {
              setLevel(meta.level);
              onClose();
            }}
            style={rowStyle(active)}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                fontSize: 11,
                color,
                width: 20,
                flex: "none",
                textAlign: "left",
              }}
            >
              A{meta.level}
            </span>
            <span style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
              <span
                style={{
                  display: "block",
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 500,
                  color: active ? "var(--text-primary)" : "var(--text-title)",
                }}
              >
                {meta.uiLabel}
              </span>
              <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                {meta.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function rowStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 9,
    padding: "8px 12px",
    background: active ? "var(--bg-active)" : "transparent",
    border: "none",
    borderBottom: "1px solid var(--border-row)",
    cursor: "pointer",
    fontFamily: "var(--font-ui)",
    textAlign: "left",
  };
}

export default AuthPill;
