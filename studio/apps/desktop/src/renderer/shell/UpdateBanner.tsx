/**
 * shell/UpdateBanner.tsx — the non-modal update strip (file 10 §5, APP-005).
 *
 * Pure UX over MAIN's updater gates: ask-before-download, never-auto-install.
 * Renders nothing while idle; the ONLY apply path is the explicit
 * "Restart to update" click, offered strictly in the "ready" phase (the state
 * machine in update-view.ts is node:test-pinned). Token-styled, no overlay.
 *
 * Renderer-SANDBOXED (C5): react + tokens only (state arrives via props).
 */

import type { CSSProperties, ReactElement } from "react";

import { type UpdateState, updateActionLabel } from "./update-view.js";

export interface UpdateBannerProps {
  state: UpdateState;
  /** the user's explicit consent to download (main has autoDownload=false). */
  onDownload(): void;
  /** the user's explicit "Restart to update" — the only install path. */
  onInstall(): void;
  onDismiss(): void;
}

const buttonStyle: CSSProperties = {
  background: "color-mix(in srgb, var(--accent) 18%, transparent)",
  border: "1px solid var(--accent)",
  borderRadius: "var(--radius-md, 6px)",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: "var(--text-small-size, 0.8125rem)",
  padding: "2px 10px",
};

export function UpdateBanner({
  state,
  onDownload,
  onInstall,
  onDismiss,
}: UpdateBannerProps): ReactElement | null {
  if (state.phase === "idle") return null;
  const action = updateActionLabel(state);
  return (
    <output
      aria-label="Application update"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-6, 12px)",
        paddingInline: "var(--space-6, 12px)",
        height: "var(--row-h, 32px)",
        background: "color-mix(in srgb, var(--accent) 10%, var(--bg-surface))",
        borderTop: "1px solid var(--border-subtle)",
        fontSize: "var(--text-small-size, 0.8125rem)",
        color: "var(--text-primary)",
      }}
    >
      <span aria-hidden="true">⭳</span>
      <span>
        Update {state.version ?? ""}{" "}
        {state.phase === "downloading"
          ? "downloading…"
          : state.phase === "ready"
            ? "ready — restart to apply"
            : "available"}
      </span>
      {state.error ? (
        <span style={{ color: "var(--warn)" }} title={state.error}>
          {state.error}
        </span>
      ) : null}
      <div style={{ flex: 1 }} />
      {state.phase === "available" ? (
        <button type="button" style={buttonStyle} onClick={onDownload}>
          {action}
        </button>
      ) : state.phase === "downloading" ? (
        <span style={{ color: "var(--text-secondary)" }}>{action}</span>
      ) : (
        <button type="button" style={buttonStyle} onClick={onInstall}>
          {action}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss update notice"
        onClick={onDismiss}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </output>
  );
}

export default UpdateBanner;
