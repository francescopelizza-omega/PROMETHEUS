/**
 * Toast.tsx — transient notifications (file 08 §3.1).
 *
 * A `ToastViewport` (a fixed, aria-live region — assertive for verdict/gate
 * outcomes per 08 §7) renders a stack of toasts the host pushes via `useToasts`.
 * Tone tints the left rail by a semantic role + carries a glyph (color never alone).
 * @radix-ui/react-toast is DECLARED in package.json and swaps in 1:1.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";
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
  useEffect(() => {
    const ms = toast.duration ?? 5000;
    if (ms <= 0) return;
    const handle = setTimeout(() => onDismiss(toast.id), ms);
    return () => clearTimeout(handle);
  }, [toast.id, toast.duration, onDismiss]);
  return (
    <div
      role="status"
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
}

export function ToastViewport({ toasts, onDismiss }: ToastViewportProps): ReactNode {
  return (
    <div
      aria-live="assertive"
      aria-atomic="false"
      style={{
        position: "fixed",
        bottom: sp(8),
        right: sp(8),
        zIndex: 1500,
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
