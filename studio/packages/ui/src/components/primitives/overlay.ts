/**
 * primitives/overlay.ts — the shared overlay behaviour the Dialog/AlertDialog/Sheet/
 * Popover/DropdownMenu/ContextMenu primitives compose (file 08 §3.1 / §7).
 *
 * Radix gives modals a focus trap, Esc-to-close, and an inert background for free
 * (08 §7 "focus trap in modals; Esc closes"). @radix-ui/react-* are DECLARED in
 * package.json; until installed, these hooks supply the same guarantees with the DOM
 * API (same env discipline as cn.ts). Pure-ish: the DOM access is guarded so the
 * module still imports under tsc/node without a window.
 */

import { type KeyboardEvent, type RefObject, useEffect, useRef } from "react";

/** The focusable selector used to find trap boundaries (Radix's set). */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Options for `useFocusTrap`. */
export interface FocusTrapOptions {
  /**
   * Let a focused INPUT/TEXTAREA inside the trap own Tab instead of the trap.
   *
   * The command palettes use Tab INSIDE their query field (tab-cycling completions), so
   * for them the trap stealing Tab is the bug. For a modal DIALOG the opposite is true —
   * Tab must not walk out of it — which is why this is opt-in and defaults to off.
   */
  deferTabToTextFields?: boolean;
  /**
   * Skip moving focus into the container on activate. For a surface that focuses a
   * specific element itself (not merely the first in DOM order).
   */
  skipInitialFocus?: boolean;
}

/**
 * Trap Tab focus inside `containerRef` while `active`, and call `onClose` on Escape.
 * Restores focus to the previously-focused element on unmount/deactivate (08 §7).
 *
 * This is the ONE focus trap. `renderer/shell/a11y.ts` used to carry a second, subtly
 * different one — node-level listener, no Escape, no initial focus — so whether Escape
 * closed a surface depended on which trap its author happened to import. The two were
 * merged here: this keeps the document-capture listener, Escape, initial focus and focus
 * restore, and gained a11y.ts's two genuinely better behaviours — the visibility filter
 * (never hand focus to a display:none control) and the `contains` guard on restore (never
 * focus a node that has since been unmounted). a11y.ts's INPUT/TEXTAREA Tab deferral
 * survives as `deferTabToTextFields`, opt-in rather than universal.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
  options: FocusTrapOptions = {},
): void {
  const { deferTabToTextFields = false, skipInitialFocus = false } = options;
  /**
   * `onClose` is held in a REF, not listed as an effect dependency.
   *
   * Every caller in this file passes a freshly created `() => onOpenChange(false)`, so a
   * dependency on its identity re-ran the whole effect on EVERY render of the surface. Teardown
   * restores focus to `previouslyFocused` — the element behind the modal — and the re-run then
   * focuses the panel's first focusable. So any state update in the dialog's owner, which means
   * every keystroke in a controlled field inside it, yanked focus out of that field. The one
   * shipped consumer, CostWarningModal, owns the "ENABLE METERED" text state itself: typing the
   * first character moved the caret out of the input, so the typed-consent gate could not be
   * completed by typing at all.
   *
   * A ref keeps the latest handler without making the trap's lifetime depend on it — the trap
   * must live as long as the overlay is open, not as long as one render's closure.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const doc = container?.ownerDocument;
    if (!container || !doc) return;

    const previouslyFocused = doc.activeElement as HTMLElement | null;
    /**
     * Focusables that are actually REACHABLE. `offsetParent === null` means the element
     * is display:none (or in a display:none subtree) — a collapsed section's buttons still
     * match the selector, and focusing one silently moves focus nowhere.
     */
    const reachable = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === doc.activeElement,
      );

    // Move focus into the dialog (first focusable, else the container itself).
    if (!skipInitialFocus) (reachable()[0] ?? container).focus?.();

    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const activeEl = doc!.activeElement;
      if (deferTabToTextFields) {
        // let a focused text field own Tab (e.g. the palette's tab-cycling input).
        const tag = activeEl?.tagName;
        if ((tag === "INPUT" || tag === "TEXTAREA") && container!.contains(activeEl)) return;
      }
      const items = reachable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }

    doc.addEventListener("keydown", onKeyDown, true);
    return () => {
      doc.removeEventListener("keydown", onKeyDown, true);
      // Only if it is still IN the document — restoring focus to a node that unmounted
      // while the overlay was open throws focus to <body> and loses the user's place.
      if (previouslyFocused && doc.contains(previouslyFocused)) previouslyFocused.focus?.();
    };
    // NOTE: `onClose` is deliberately absent — see `onCloseRef` above.
  }, [active, containerRef, deferTabToTextFields, skipInitialFocus]);
}

/**
 * Keep a floating layer inside the viewport (08 §3.1).
 *
 * Four hand-rolled copies of this maths existed — with three different SSR fallbacks
 * (none, `1024×768`, `9999`), three different paddings (`4`, `8`, none) and two of them
 * missing the lower bound entirely, so a right-click near the top-left could place a menu
 * at a negative offset and a right-click near the bottom could push a destructive item
 * (`Delete`, `Reset (hard)`) off-window where it was unreachable. One implementation, one
 * behaviour.
 *
 * `w`/`h` are the layer's EXPECTED size. Nothing here measures the DOM: the clamp has to
 * run before paint (it decides where to paint), and an estimate that is slightly large
 * simply keeps the layer a little further from the edge — which is the safe direction.
 *
 * Returns integer CSS pixels. Under SSR (no `window`) the input is returned clamped only
 * by `pad`, since there is no viewport to clamp against.
 */
export function clampToViewport(
  x: number,
  y: number,
  w: number,
  h: number,
  pad = 8,
): { x: number; y: number } {
  const hasWindow = typeof window !== "undefined";
  const vw = hasWindow ? window.innerWidth : Number.POSITIVE_INFINITY;
  const vh = hasWindow ? window.innerHeight : Number.POSITIVE_INFINITY;
  // Math.max LAST so that on a viewport smaller than the layer the top-left edge wins:
  // a clipped bottom is recoverable (scroll/resize), a negative offset is not.
  return {
    x: Math.round(Math.max(pad, Math.min(x, vw - w - pad))),
    y: Math.round(Math.max(pad, Math.min(y, vh - h - pad))),
  };
}

/**
 * Close a non-modal layer (popover/menu/tooltip) on Escape or an outside click.
 * `triggerRef` is excluded from "outside" so clicking the trigger toggles, not closes.
 */
export function useDismiss(
  layerRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    // Fall back to the global document when the layer ref isn't populated yet on the
    // effect run that matches `open` flipping true (conditional mount / ref-assign
    // timing) — otherwise NO listener attaches and the menu won't close on an outside
    // click the first time it opens.
    const doc =
      layerRef.current?.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
    if (!doc) return;

    function onPointer(e: globalThis.MouseEvent): void {
      const target = e.target as Node | null;
      if (!target) return;
      if (layerRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    }
    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    doc.addEventListener("mousedown", onPointer, true);
    doc.addEventListener("keydown", onKeyDown, true);
    return () => {
      doc.removeEventListener("mousedown", onPointer, true);
      doc.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, layerRef, triggerRef, onClose]);
}

/** Arrow-key roving over a menu's items (Down/Up/Home/End), Enter/Space activate. */
export function menuKeyHandler(
  e: KeyboardEvent<HTMLElement>,
  count: number,
  active: number,
  setActive: (i: number) => void,
  onActivate: (i: number) => void,
  onClose: () => void,
): void {
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      setActive(count === 0 ? -1 : (active + 1) % count);
      break;
    case "ArrowUp":
      e.preventDefault();
      setActive(count === 0 ? -1 : (active - 1 + count) % count);
      break;
    case "Home":
      e.preventDefault();
      setActive(0);
      break;
    case "End":
      e.preventDefault();
      setActive(count - 1);
      break;
    case "Enter":
    case " ":
      if (active >= 0) {
        e.preventDefault();
        onActivate(active);
      }
      break;
    case "Escape":
      e.preventDefault();
      onClose();
      break;
    default:
      break;
  }
}
