/**
 * tokens/layers.ts — THE z-index ladder (HANDOFF_2 §9 "one z-index ladder").
 *
 * Before this there were sixteen different z-index values across the app (6, 10, 20, 30,
 * 31, 32, 40, 41, 50, 60, 70, 80, 81, 82, 1000), each chosen by whoever wrote the
 * component and each correct only against the neighbours that existed that day. That is
 * how a force-override dialog ends up under a command palette.
 *
 * Five rungs, far apart, named for what they MEAN rather than what they must beat:
 *
 *   base     0     islands, panels, ordinary page content
 *   raise    100   in-panel chrome that must clear its own content: sticky headers,
 *                  resize handles, the activity rail's tooltips, a floating toolbar
 *   dropdown 500   popovers, menus, tooltips, autocompletes, pickers — anything anchored
 *                  to a control and dismissed by clicking away
 *   palette  1100  the ⌘K command palette (above every dropdown, below every decision)
 *   modal    1200  modals, alert dialogs, the force-override and purge confirms — any
 *                  surface the user must answer before continuing
 *   toast    1400  transient notifications. ABOVE modal on purpose: a toast reports
 *                  something that already happened and must not be hidden by a dialog
 *                  the user has not answered yet.
 *
 * The gaps are deliberate: a component that genuinely needs to sit just above a sibling
 * can use `Z.dropdown + 1` and still be nowhere near the next rung.
 *
 * RULE: never write a bare numeric z-index in app code. `scripts/check-layout-rules.mjs`
 * fails the build on one. If a surface does not fit a rung, the rung is wrong — change it
 * here, where every other surface can see it.
 */

export const Z = {
  base: 0,
  raise: 100,
  dropdown: 500,
  palette: 1100,
  modal: 1200,
  toast: 1400,
} as const;

export type LayerName = keyof typeof Z;

/** The ladder as CSS custom properties (`--z-modal`, …) for stylesheet consumers. */
export const LAYER_VARS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Object.entries(Z).map(([k, v]) => [`--z-${k}`, v])),
);
