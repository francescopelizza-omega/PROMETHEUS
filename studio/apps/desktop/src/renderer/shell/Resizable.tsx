/**
 * shell/Resizable.tsx — the shared drag-to-resize primitive (file 08 §4).
 *
 * One hook + one handle, used by every resizable surface (the contextual Sidebar,
 * the right AI rail, the bottom panel, and the editor workbench's split panes) so
 * the drag math, the keyboard parity (↑/↓ · ←/→), the double-click reset, and the
 * cursor/selection bookkeeping live in ONE place instead of being re-derived (and
 * subtly mis-signed) per surface.
 *
 * `invert` flips the sign so a handle on the LEADING edge (the right rail's left
 * border, the bottom panel's top border) still grows the surface when you drag
 * away from it. Sizes are clamped to [min, max] where max may be a viewport-aware
 * thunk so a panel can never eat the whole window.
 *
 * Renderer-SANDBOXED (C5): react only, pure DOM events. No node/electron/bridge.
 */

import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type ResizeAxis = "x" | "y";

export interface UseResizableOptions {
  axis: ResizeAxis;
  initial: number;
  min: number;
  /** upper bound in px, or a thunk (re-read each drag tick) for viewport-relative caps. */
  max?: number | (() => number);
  /** handle sits on the leading edge → dragging toward the origin grows the surface. */
  invert?: boolean;
  /** ↑/↓ · ←/→ keyboard nudge step (px). */
  step?: number;
  /** localStorage key — when set, the size is persisted + rehydrated across reloads (#13). */
  storageKey?: string;
}

export interface Resizable {
  size: number;
  dragging: boolean;
  setSize(n: number): void;
  reset(): void;
  startDrag(e: React.MouseEvent): void;
  onKeyDown(e: React.KeyboardEvent): void;
}

export function useResizable({
  axis,
  initial,
  min,
  max,
  invert = false,
  step = 24,
  storageKey,
}: UseResizableOptions): Resizable {
  // rehydrate the persisted size (#13) — fall back to `initial` for a missing/bad value.
  const [size, setSizeState] = useState(() => {
    if (storageKey) {
      try {
        const raw = window.localStorage.getItem(storageKey);
        if (raw != null) {
          const n = Number(raw);
          if (Number.isFinite(n) && n >= min) return n;
        }
      } catch {
        /* private mode / quota — fall through to the default. */
      }
    }
    return initial;
  });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ start: number; base: number } | null>(null);

  // persist the size whenever it settles to a new value (best-effort).
  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(Math.round(size)));
    } catch {
      /* fail-soft: a resize must never break on a storage error. */
    }
  }, [storageKey, size]);

  const clamp = useCallback(
    (v: number): number => {
      const hi = typeof max === "function" ? max() : (max ?? Number.POSITIVE_INFINITY);
      return Math.min(Math.max(v, min), Math.max(min, hi));
    },
    [min, max],
  );

  const setSize = useCallback((n: number): void => setSizeState(clamp(n)), [clamp]);
  const reset = useCallback((): void => setSizeState(clamp(initial)), [clamp, initial]);

  const onMove = useCallback(
    (e: MouseEvent): void => {
      const d = drag.current;
      if (!d) return;
      const cur = axis === "x" ? e.clientX : e.clientY;
      const delta = (cur - d.start) * (invert ? -1 : 1);
      setSizeState(clamp(d.base + delta));
    },
    [axis, invert, clamp],
  );

  const endDrag = useCallback((): void => {
    drag.current = null;
    setDragging(false);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", endDrag);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, [onMove]);

  const startDrag = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      drag.current = { start: axis === "x" ? e.clientX : e.clientY, base: size };
      setDragging(true);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", endDrag);
      document.body.style.userSelect = "none";
      document.body.style.cursor = axis === "x" ? "col-resize" : "ns-resize";
    },
    [axis, size, onMove, endDrag],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      // + always means "bigger" regardless of which edge the handle is on.
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        e.preventDefault();
        setSizeState((s) => clamp(s + step));
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        e.preventDefault();
        setSizeState((s) => clamp(s - step));
      }
    },
    [clamp, step],
  );

  return { size, dragging, setSize, reset, startDrag, onKeyDown };
}

export interface ResizeHandleProps {
  /** "x" → a vertical bar that resizes WIDTH; "y" → a horizontal bar that resizes HEIGHT. */
  axis: ResizeAxis;
  /** which edge of the parent the grip straddles. */
  edge: "left" | "right" | "top" | "bottom";
  rz: Resizable;
  label: string;
  min: number;
}

/**
 * The visible grip. The parent MUST be `position: relative`. Invisible until
 * hovered/dragged (then a brand hairline) so it never adds visual noise, but it
 * always has a generous 6px hit area + a focusable separator role for keyboard use.
 */
export function ResizeHandle({ axis, edge, rz, label, min }: ResizeHandleProps): ReactElement {
  const [hover, setHover] = useState(false);
  const vertical = axis === "x"; // a vertical bar
  const place: CSSProperties =
    edge === "right"
      ? { top: 0, bottom: 0, right: -3, width: 6, cursor: "col-resize" }
      : edge === "left"
        ? { top: 0, bottom: 0, left: -3, width: 6, cursor: "col-resize" }
        : edge === "top"
          ? { left: 0, right: 0, top: -3, height: 6, cursor: "ns-resize" }
          : { left: 0, right: 0, bottom: -3, height: 6, cursor: "ns-resize" };
  const active = hover || rz.dragging;
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(rz.size)}
      aria-valuemin={min}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onMouseDown={rz.startDrag}
      onDoubleClick={rz.reset}
      onKeyDown={rz.onKeyDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute",
        zIndex: 6,
        background: active ? "var(--brand)" : "transparent",
        opacity: rz.dragging ? 1 : hover ? 0.6 : 0,
        transition: "opacity 120ms ease, background 120ms ease",
        ...place,
      }}
    />
  );
}
