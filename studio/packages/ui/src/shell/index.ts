/**
 * shell/ barrel (file 08 §4). The PURE, framework-free shell model shared by the
 * desktop IDE frame AND the `prom` TUI (file 08 §8): the activity-rail routing,
 * the ⌘K palette fuzzy filter, the nemesis-shield state machine, and the §6
 * theme-resolution brain. No React, no DOM — every export is unit-testable from
 * TS source. The desktop renderer's shell/ components BIND these to React + the
 * DOM; the CLI binds the same ids to its renderer.
 */
export type { ActivityId, PinnedId, Activity } from "./activities.js";
export {
  ACTIVITIES,
  PINNED,
  DEFAULT_ACTIVITY,
  isActivityId,
  getActivity,
  routeActivity,
  sidebarTitle,
} from "./activities.js";

export type {
  PaletteKind,
  PaletteVerdict,
  PaletteItem,
  ScoredPaletteItem,
  ParsedQuery,
} from "./palette.js";
export { fuzzyScore, filterPalette, parsePaletteQuery, scopedFilterPalette } from "./palette.js";

export type { ShieldState, ShieldView } from "./shield.js";
export { deriveShield } from "./shield.js";

export type {
  ThemeBaseMode,
  ThemePreference,
  OsScheme,
  AppearancePrefs,
} from "./theme-resolve.js";
export {
  DEFAULT_APPEARANCE,
  resolveThemeBase,
  parseAppearance,
  appearanceAttributes,
} from "./theme-resolve.js";
