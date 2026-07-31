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

import { type KeyboardEvent, type RefObject, useEffect } from "react";

/** The focusable selector used to find trap boundaries (Radix's set). */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab focus inside `containerRef` while `active`, and call `onClose` on Escape.
 * Restores focus to the previously-focused element on unmount/deactivate (08 §7).
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const doc = container?.ownerDocument;
    if (!container || !doc) return;

    const previouslyFocused = doc.activeElement as HTMLElement | null;
    // Move focus into the dialog (first focusable, else the container itself).
    const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusables[0] ?? container).focus?.();

    function onKeyDown(e: globalThis.KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(container!.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeEl = doc!.activeElement;
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
      previouslyFocused?.focus?.();
    };
  }, [active, containerRef, onClose]);
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
