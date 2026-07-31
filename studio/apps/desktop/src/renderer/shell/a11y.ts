/**
 * shell/a11y.ts — accessibility primitives for the workbench (APP-100).
 *
 * The PURE half (id derivation, ARIA prop objects, index math for focus/arrow cycling) is
 * DOM-free so it unit-tests under plain node:test — the repo has no jsdom. The HOOK half
 * (`useFocusTrap`) does the real DOM work (capture + restore focus, trap Tab inside a dialog);
 * it's verified in the offscreen-Electron render, not in a jsdom test.
 */

import { type RefObject, useEffect } from "react";

/** The elements a focus trap may cycle through (ARIA APG). */
export const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** A stable option DOM id for a listbox row (aria-activedescendant target). */
export function optionId(listboxId: string, index: number): string {
  return `${listboxId}-opt-${index}`;
}

/** The ARIA props for an ARIA-1.2 combobox input driving a listbox by activedescendant.
 *  `aria-activedescendant` is omitted when the list is empty (nothing to point at). */
export function activeDescendantProps(
  listboxId: string,
  activeIndex: number,
  count: number,
): {
  role: "combobox";
  "aria-autocomplete": "list";
  "aria-expanded": true;
  "aria-controls": string;
  "aria-activedescendant"?: string;
} {
  return {
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": true,
    "aria-controls": listboxId,
    "aria-activedescendant": count > 0 ? optionId(listboxId, activeIndex) : undefined,
  };
}

/** The ARIA props for one listbox option row. */
export function optionProps(
  listboxId: string,
  index: number,
  selected: boolean,
): { role: "option"; id: string; "aria-selected": boolean } {
  return { role: "option", id: optionId(listboxId, index), "aria-selected": selected };
}

/** Roving-tabindex value for a tablist item: the selected tab is the single tab stop. */
export function rovingTabIndex(selected: boolean): 0 | -1 {
  return selected ? 0 : -1;
}

/** Wrapping next index for a Tab focus trap (shift = backwards). Empty list → 0. */
export function nextFocusIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/** Wrapping next region index for F6/⇧F6 panel cycling (dir = +1 / -1). */
export function nextRegion(count: number, current: number, dir: 1 | -1): number {
  if (count <= 0) return 0;
  // a current of -1 (focus not in any region) enters the first (dir 1) / last (dir -1).
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/**
 * Resolve an arrow/Home/End key to the next index in a tablist (ARIA APG tab pattern), or null
 * if the key isn't a navigation key. Left/Up = previous (wrap), Right/Down = next (wrap).
 */
export function arrowMove(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Focus trap for a dialog overlay: while `active`, remembers the element that had focus, and on
 * deactivate/unmount restores focus to it (if still in the document). Tab/Shift-Tab wrap within
 * the container's focusables — BUT a text input/textarea inside the container keeps its own Tab
 * handling (the command palette hijacks Tab to cycle its source tabs), so the trap defers to it.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = ref.current;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Tab" || !node) return;
      // let a focused text field own Tab (e.g. the palette's tab-cycling input).
      const ae = document.activeElement;
      const tag = ae?.tagName;
      if ((tag === "INPUT" || tag === "TEXTAREA") && node.contains(ae)) return;
      const focusables = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === ae,
      );
      if (focusables.length === 0) return;
      const idx = ae instanceof HTMLElement ? focusables.indexOf(ae) : -1;
      e.preventDefault();
      focusables[nextFocusIndex(focusables.length, idx < 0 ? 0 : idx, e.shiftKey)]?.focus();
    };

    node?.addEventListener("keydown", onKeyDown);
    return () => {
      node?.removeEventListener("keydown", onKeyDown);
      // restore focus to the opener, if it's still attached.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [ref, active]);
}
