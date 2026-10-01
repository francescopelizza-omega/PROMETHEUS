// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * Resizable.tsx — a two-pane split with a draggable handle (file 08 §3.1, the §4
 * panel splits: sidebar | workbench, editor | right rail). Keyboard-resizable
 * (Left/Right or Up/Down on the separator, 08 §7). Controlled or self-managed size.
 *
 * The split math (clamp + step) is a pure exported helper for tests. react-resizable-
 * panels / @radix-ui equivalents are DECLARED in package.json; this renders + is
 * keyboard-operable today.
 */

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { v } from "./styles.js";

/** Clamp a primary-pane size (px) to [min, total-min] (pure, testable). */
export function clampSplit(sizePx: number, totalPx: number, minPx: number): number {
  const lo = minPx;
  const hi = Math.max(minPx, totalPx - minPx);
  return Math.max(lo, Math.min(hi, sizePx));
}

export interface ResizableProps {
  orientation?: "horizontal" | "vertical";
  /** Initial primary-pane size in px. */
  defaultSize?: number;
  minSize?: number;
  /** Keyboard step in px (default 16). */
  step?: number;
  first: ReactNode;
  second: ReactNode;
  "aria-label"?: string;
  className?: string;
}

export function Resizable({
  orientation = "horizontal",
  defaultSize = 280,
  minSize = 120,
  step = 16,
  first,
  second,
  "aria-label": ariaLabel,
  className,
}: ResizableProps): ReactNode {
  const horizontal = orientation === "horizontal";
  const [size, setSize] = useState(defaultSize);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  /**
   * Tears down the CURRENT drag's document listeners.
   *
   * `onPointerDown` attaches `mousemove`/`mouseup` to the DOCUMENT and only `up()` removes
   * them. If the component unmounts mid-drag — a pane closed, a route changed, a window torn
   * out — `mouseup` lands somewhere else and those two listeners stay attached to the
   * document forever, one pair per drag, each still calling `setSize` on an unmounted tree.
   * Held in a ref so both `up()` and the unmount effect can run the same teardown.
   */
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onPointerDown = useCallback(
    (e: { clientX: number; clientY: number }) => {
      // a drag that never saw its mouseup must not leave its listeners behind
      cleanup.current?.();
      dragging.current = true;
      const container = containerRef.current;
      const doc = container?.ownerDocument;
      if (!doc) return;
      function move(ev: globalThis.MouseEvent): void {
        if (!dragging.current || !container) return;
        const rect = container.getBoundingClientRect();
        const raw = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
        const total = horizontal ? rect.width : rect.height;
        setSize(clampSplit(raw, total, minSize));
      }
      function up(): void {
        cleanup.current?.();
        cleanup.current = null;
      }
      doc.addEventListener("mousemove", move);
      doc.addEventListener("mouseup", up);
      cleanup.current = () => {
        dragging.current = false;
        doc.removeEventListener("mousemove", move);
        doc.removeEventListener("mouseup", up);
      };
    },
    [horizontal, minSize],
  );

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const total = horizontal
      ? (containerRef.current?.clientWidth ?? 0)
      : (containerRef.current?.clientHeight ?? 0);
    const dec = horizontal ? "ArrowLeft" : "ArrowUp";
    const inc = horizontal ? "ArrowRight" : "ArrowDown";
    if (e.key === dec) {
      e.preventDefault();
      setSize((s) => clampSplit(s - step, total, minSize));
    } else if (e.key === inc) {
      e.preventDefault();
      setSize((s) => clampSplit(s + step, total, minSize));
    }
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        width: "100%",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <div
        style={{
          [horizontal ? "width" : "height"]: `${size}px`,
          flex: "0 0 auto",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {first}
      </div>
      <div
        role="separator"
        aria-label={ariaLabel ?? "Resize panels"}
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        tabIndex={0}
        onMouseDown={onPointerDown}
        onKeyDown={onKeyDown}
        style={{
          flex: "0 0 auto",
          [horizontal ? "width" : "height"]: "5px",
          cursor: horizontal ? "col-resize" : "row-resize",
          background: v("border-subtle"),
          outline: "none",
        }}
      />
      <div style={{ flex: "1 1 0", minWidth: 0, minHeight: 0, overflow: "hidden" }}>{second}</div>
    </div>
  );
}

export default Resizable;
