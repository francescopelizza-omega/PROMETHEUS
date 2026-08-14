/**
 * primitives/anchor.ts — position a floating layer against a trigger, in VIEWPORT space.
 *
 * The problem this exists for (HANDOFF_2 §9.2, "the rail cage"): the agent pane's pickers —
 * @-mention autocomplete, slash-command menu, model picker — were `position: absolute`
 * children of the composer. That anchors them to the composer's containing block, which is
 * inside the right rail, and the rail island is `overflow: hidden` with a default width of
 * 330px. So every one of those pickers was CAGED: it could not be wider than the rail and
 * it was clipped at the rail's edges. Nothing about a completion list wants to be 330px
 * wide.
 *
 * A layer positioned by this hook is meant to be rendered into a PORTAL (document.body) as
 * `position: fixed`, which takes it out of the rail entirely — the coordinates below are
 * already viewport coordinates, which is exactly what `fixed` wants.
 *
 * Re-measures on scroll (capture, so it catches scrolls in any ancestor) and on resize, so
 * the layer tracks its trigger instead of detaching from it.
 */

import { type RefObject, useCallback, useEffect, useState } from "react";

import { clampToViewport } from "./overlay.js";

/** Where the layer sits relative to its anchor. */
export type AnchorPlacement = "above" | "below";

export interface AnchoredLayerOptions {
  /**
   * The layer's width. A number is CSS px; `"anchor"` matches the trigger's width (what a
   * completion list under a composer wants); `"anchor-min"` is at least the trigger's width
   * but may grow to `maxWidth`.
   */
  width: number | "anchor" | "anchor-min";
  /** Upper bound for `"anchor-min"`, and the clamp width used for a plain number. */
  maxWidth?: number;
  /** The layer's expected height — used for the clamp, not applied as a style. */
  height: number;
  /** Gap between trigger and layer, px. */
  gap?: number;
  placement?: AnchorPlacement;
}

/** Viewport-space geometry for a `position: fixed` layer. */
export interface AnchoredLayerBox {
  left: number;
  top: number;
  width: number;
}

/**
 * Track `anchorRef`'s viewport rect while `open`, and return clamped `fixed` coordinates.
 *
 * Returns `null` until the anchor has been measured, which is the render the layer should
 * skip — painting at `0,0` for one frame is a visible flash in the top-left corner.
 */
export function useAnchoredLayer(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: AnchoredLayerOptions,
): AnchoredLayerBox | null {
  const { width, maxWidth, height, gap = 6, placement = "above" } = options;
  const [box, setBox] = useState<AnchoredLayerBox | null>(null);

  const measure = useCallback((): void => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w =
      width === "anchor"
        ? r.width
        : width === "anchor-min"
          ? Math.min(Math.max(r.width, 260), maxWidth ?? 420)
          : width;
    const rawTop = placement === "above" ? r.top - height - gap : r.bottom + gap;
    const { x, y } = clampToViewport(r.left, rawTop, w, height);
    setBox({ left: x, top: y, width: Math.round(w) });
  }, [anchorRef, width, maxWidth, height, gap, placement]);

  useEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    measure();
    // `true` = capture: a scroll inside the rail (or any other ancestor) does not bubble to
    // window, so a bubble-phase listener would silently never fire and the layer would drift
    // away from its trigger.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  return box;
}
