// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/responsive.ts — the §2 collapse order, as a pure function of viewport width.
 *
 * handoff §2, verbatim: "Min window 1100×680. Collapse order below 1100px: chat rail →
 * tray, file tree → overlay."
 *
 * Nothing implemented this. There was no `matchMedia`, no breakpoint and no width listener
 * anywhere in the shell — the only `window.innerWidth` reads were drag-resize MAX CAPS,
 * which bound a pane the user is dragging and never flip a panel into another mode. So on a
 * narrow window the 330px rail and the 200px tree simply took their width out of the
 * editor, which is the surface the whole layout exists to serve.
 *
 * ## Order is the specification, not an implementation detail
 *
 * The rail goes first and the tree second, because they cost different amounts to lose.
 * Traying the rail leaves the agent one click away with its state intact; overlaying the
 * tree changes how you navigate files. So the first step buys 288px (330 → 42) and the
 * second only starts once that was not enough.
 *
 * ## What this does NOT do
 *
 * It never writes the user's preference. `rightCollapsed` stays whatever they last chose,
 * and the narrow-window tray is layered on top when rendering — the same request-vs-applied
 * split the authorisation level and the effort tier both use. A width-driven collapse that
 * persisted itself would silently rewrite a preference the user never touched, and widening
 * the window again would not bring the rail back.
 *
 * Pure: no DOM, no React. The width comes from the caller.
 */

/** The minimum window §2 specifies. Below this, the collapse order starts. */
export const SHELL_MIN_WIDTH = 1100;

/**
 * The width below which the file tree also gives up its column.
 *
 * Derived from the layout §2 describes rather than picked: the shell's fixed chrome is the
 * 46px activity rail plus the 42px rail tray, the tree is 200px, and the islands sit in 8px
 * gutters. Under roughly this width the editor island — the thing being edited — is down to
 * a few hundred px even with the rail already trayed, which is the point at which the tree
 * costs more than it gives.
 */
export const TREE_OVERLAY_WIDTH = 900;

export interface ShellCollapse {
  /** the chat rail: its full island, or the 42px tray strip. */
  rail: "open" | "tray";
  /** the editor's file tree: in the flex row, or floated over the editor. */
  tree: "inline" | "overlay";
  /** true when the viewport is under the §2 minimum at all (chrome may want to know). */
  narrow: boolean;
}

/**
 * Resolve the collapse state for a viewport width.
 *
 * A non-finite width (jsdom before layout, a detached window) resolves to the ROOMY state:
 * "we do not know how wide we are" must not collapse a user's panels.
 */
export function shellCollapse(width: number): ShellCollapse {
  if (!Number.isFinite(width) || width <= 0) {
    return { rail: "open", tree: "inline", narrow: false };
  }
  return {
    rail: width < SHELL_MIN_WIDTH ? "tray" : "open",
    tree: width < TREE_OVERLAY_WIDTH ? "overlay" : "inline",
    narrow: width < SHELL_MIN_WIDTH,
  };
}

/**
 * The rail's EFFECTIVE collapsed state: the user's own choice, OR the narrow-window tray.
 *
 * Union, not override — a user who collapsed the rail on a wide window keeps it collapsed,
 * and a user who opened it on a narrow one is trayed until they have the room. Neither
 * writes to the other.
 */
export function railCollapsed(userCollapsed: boolean, width: number): boolean {
  return userCollapsed || shellCollapse(width).rail === "tray";
}

/**
 * The rail's two-part state: what the user chose, and whether they overrode the narrow tray.
 *
 * The override exists because the first version of §2-j had no escape hatch. Below 1100px the
 * tray won unconditionally, so ⌥⌘B, the ActivityBar's ✦, the tray's own Expand button and
 * "new session" all kept flipping `userCollapsed` with NO VISIBLE EFFECT — four controls that
 * looked broken. Worse, the tray does not render the agent at all, so the pane was unmounted
 * and a prompt typed into Home's ask bar was dispatched at a listener that did not exist and
 * vanished without an error.
 */
export interface RailState {
  /** the user's own collapse preference — this is the value that gets persisted. */
  userCollapsed: boolean;
  /** set when the user opened the rail WHILE narrow; cleared when the window gets roomy. */
  narrowOverride: boolean;
}

/** Is the rail collapsed right now, given the user's state and the viewport? */
export function railCollapsedNow(state: RailState, width: number): boolean {
  if (state.userCollapsed) return true;
  return shellCollapse(width).rail === "tray" && !state.narrowOverride;
}

/**
 * What a toggle should produce. Opening while narrow sets the override; closing clears it.
 *
 * The override is only ever set when the window is ACTUALLY narrow, so a rail opened on a
 * wide window does not carry a standing exemption into the next narrow episode — §2-j's
 * default has to survive a resize.
 */
export function toggleRail(state: RailState, width: number): RailState {
  if (!railCollapsedNow(state, width)) return { userCollapsed: true, narrowOverride: false };
  return { userCollapsed: false, narrowOverride: shellCollapse(width).rail === "tray" };
}

/** Force the rail open — a caller that is about to hand the agent something to do. */
export function openRail(width: number): RailState {
  return { userCollapsed: false, narrowOverride: shellCollapse(width).rail === "tray" };
}

/** Widening past the breakpoint retires the override, so the next narrow episode trays again. */
export function clearOverrideIfRoomy(state: RailState, width: number): RailState {
  if (!state.narrowOverride || shellCollapse(width).rail === "tray") return state;
  return { ...state, narrowOverride: false };
}

/* ── the workbench floor (APP-100 follow-up) ──────────────────────────────────── */

/**
 * The narrowest the CENTER column may be squeezed to by its two neighbours.
 *
 * The sidebar and the rail each capped themselves at a fraction of the viewport — 35% and
 * 42% — and neither knew the other existed. At the 1100px minimum window that is 385 + 462,
 * plus the fixed chrome, leaving about 175px for the editor: the surface the entire layout
 * exists to serve, reduced to a sliver by two panes that were each individually "reasonable".
 * A fraction cannot express "not at the expense of the middle"; a floor can.
 */
export const WORKBENCH_MIN = 360;

/** Activity rail (46) + the three 8px island gaps + the 8px right padding. */
export const SHELL_FIXED_CHROME = 78;

/**
 * A pane's persisted width, for budgeting against its SIBLING.
 *
 * Read from storage rather than from React state because the two panes are separate
 * components with no shared parent state, and a resize needs the other's CURRENT width, not
 * one captured at mount. Fail-soft: any unreadable/absent/garbage value falls back, because a
 * storage failure must not make a pane unresizable.
 */
export function readPaneWidth(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The largest this pane may become: its own fraction cap, but never so large that the
 * workbench drops below `WORKBENCH_MIN` given what the sibling currently occupies.
 *
 * `ownMin` is the floor — the result is never below it, so the pane stays resizable even on a
 * viewport too small to satisfy everyone. That case is the collapse order's job, not this
 * function's.
 */
export function paneMaxWidth(opts: {
  viewportWidth: number;
  ownMin: number;
  fraction: number;
  siblingWidth: number;
}): number {
  const { viewportWidth, ownMin, fraction, siblingWidth } = opts;
  const budget = viewportWidth - SHELL_FIXED_CHROME - WORKBENCH_MIN - siblingWidth;
  return Math.max(ownMin, Math.min(Math.round(viewportWidth * fraction), budget));
}
