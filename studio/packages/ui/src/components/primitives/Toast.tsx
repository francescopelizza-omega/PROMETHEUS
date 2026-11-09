// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * Toast.tsx — transient notifications (file 08 §3.1).
 *
 * A `ToastViewport` (a fixed, aria-live region — assertive for verdict/gate
 * outcomes per 08 §7) renders a stack of toasts the host pushes via `useToasts`.
 * Tone tints the left rail by a semantic role + carries a glyph (color never alone).
 * @radix-ui/react-toast is DECLARED in package.json and swaps in 1:1.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Z } from "../../tokens/layers.js";
import { fs, rad, sp, v } from "./styles.js";

export type ToastTone = "info" | "ok" | "warn" | "danger";

export interface ToastData {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** auto-dismiss after ms (default 5000); 0 = sticky. */
  duration?: number;
}

const TONE_GLYPH: Record<ToastTone, string> = { info: "ℹ", ok: "✓", warn: "▲", danger: "⚠" };
const TONE_TOKEN: Record<ToastTone, string> = {
  info: "info",
  ok: "ok",
  warn: "warn",
  danger: "danger",
};

/** A tiny toast store hook: the host calls `push` to enqueue, renders the viewport. */
export function useToasts(): {
  toasts: ToastData[];
  push: (t: Omit<ToastData, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
} {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);
  const push = useCallback((t: Omit<ToastData, "id"> & { id?: string }) => {
    const id = t.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((list) => [...list, { ...t, id }]);
    return id;
  }, []);
  return { toasts, push, dismiss };
}

function ToastCard({
  toast,
  onDismiss,
}: { toast: ToastData; onDismiss: (id: string) => void }): ReactNode {
  const tone = toast.tone ?? "info";
  const color = v(TONE_TOKEN[tone]);
  // the timer PAUSES while the pointer is over the card (or a control in it has focus), so a
  // toast someone is reading does not vanish under them
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const ms = toast.duration ?? 5000;
    if (ms <= 0 || held) return;
    const handle = setTimeout(() => onDismiss(toast.id), ms);
    return () => clearTimeout(handle);
  }, [toast.id, toast.duration, onDismiss, held]);
  return (
    <div
      // only a danger toast interrupts a screen reader; the rest are announced politely
      role={tone === "danger" ? "alert" : "status"}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: sp(3),
        minWidth: "260px",
        maxWidth: "380px",
        padding: sp(4),
        background: v("bg-surface-2"),
        border: `1px solid ${v("border-strong")}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: rad("md"),
        boxShadow: "0 8px 24px rgba(0,0,0,.35)",
        color: v("text-primary"),
        fontFamily: v("font-ui"),
      }}
    >
      <span aria-hidden="true" style={{ color, fontSize: fs("body"), lineHeight: 1.4 }}>
        {TONE_GLYPH[tone]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: fs("body"), fontWeight: 600 }}>{toast.title}</div>
        {toast.description != null && (
          <div style={{ marginTop: sp(1), color: v("text-secondary"), fontSize: fs("small") }}>
            {toast.description}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        style={{
          background: "transparent",
          border: "none",
          color: v("text-secondary"),
          cursor: "pointer",
          lineHeight: 1,
        }}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}

export interface ToastViewportProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
  /**
   * Where the stack sits. `bottom-right` (the default) suits a page with nothing in that corner;
   * a host with a status bar and a right-hand rail there passes `top-right` plus `offsetTop` so
   * toasts never cover its controls.
   */
  placement?: "bottom-right" | "top-right";
  /** px below the top edge for `top-right` (clears a title/top bar) */
  offsetTop?: number;
}

export function ToastViewport({
  toasts,
  onDismiss,
  placement = "bottom-right",
  offsetTop = 0,
}: ToastViewportProps): ReactNode {
  const edge =
    placement === "top-right" ? { top: `calc(${offsetTop}px + ${sp(4)})` } : { bottom: sp(8) };
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: "fixed",
        ...edge,
        right: sp(8),
        zIndex: Z.toast,
        display: "flex",
        flexDirection: "column",
        gap: sp(3),
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <div key={t.id} style={{ pointerEvents: "auto" }}>
          <ToastCard toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}

export default ToastViewport;
