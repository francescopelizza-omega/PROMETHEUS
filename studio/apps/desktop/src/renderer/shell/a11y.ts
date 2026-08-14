/**
 * shell/a11y.ts — accessibility primitives for the workbench (APP-100).
 *
 * The PURE half (id derivation, ARIA prop objects, index math for focus/arrow cycling) is
 * DOM-free so it unit-tests under plain node:test — the repo has no jsdom. The DOM half is
 * `useFocusTrap`, which now lives in @prometheus/ui and is re-exported at the bottom of this
 * file; it is verified in the offscreen-Electron render, not in a jsdom test.
 */

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
 * The workbench focus trap — re-exported, not reimplemented.
 *
 * This module used to carry its OWN `useFocusTrap`, subtly different from the one in
 * @prometheus/ui: node-level listener instead of document-capture, no Escape, no initial
 * focus. Whether Escape closed a surface therefore depended on which of the two its author
 * happened to import. They are merged; the survivor lives in
 * `packages/ui/src/components/primitives/overlay.ts` and took this one's two better
 * behaviours with it (the `offsetParent` visibility filter, the `contains` guard on focus
 * restore) plus this one's INPUT/TEXTAREA Tab deferral as the opt-in
 * `deferTabToTextFields` — a palette needs it, a modal dialog must not have it.
 *
 * Re-exported here so the workbench keeps ONE a11y import surface.
 */
export { useFocusTrap } from "@prometheus/ui";
export type { FocusTrapOptions } from "@prometheus/ui";
