// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/subpanels.ts — the SECOND half of the one activity rail.
 *
 * The shell used to paint two vertical icon strips side by side: the 46px activity rail (six
 * nouns — where am I) and, immediately to its right, a route-owned strip of the editor's twelve
 * tool panels (explorer, search, git, debug…). Two columns of icons, adjacent, identical in
 * size and styling, meaning two completely different things — you had to learn which strip was
 * which before either one could be read, and they cost ~100px of horizontal space between them.
 *
 * They are now ONE column with two parts: the nouns on top, the active noun's tools underneath,
 * separated by a visible rule. Same information, half the chrome, and the relationship between
 * the two — these tools belong to that panel — is finally something the layout states rather
 * than something you have to infer.
 *
 * This module is the data behind the lower half. PURE (no React, no DOM) so it is node-testable
 * from source and so the CLI can read the same model, exactly like `activities.ts` beside it.
 */

import type { ActivityId } from "./activities.js";
import type { ActivityIconName } from "./icon-names.js";

/** One tool panel belonging to an activity — the lower rail's buttons. */
export interface SubPanel {
  /** stable id; the route switches its body on this. */
  id: string;
  /** an `ActivityIconName` with real geometry. Typed, so a typo is a build error rather than
   *  a silently blank rail button (`ActivityIcon` falls back to a dot). */
  icon: ActivityIconName;
  label: string;
}

/**
 * The Editor's tool panels.
 *
 * Every entry has its OWN glyph. Two of them did not: Method Hierarchy borrowed
 * `CallHierarchy` and Coverage borrowed `FlaskConical`, so the rail drew the same shape twice
 * in two places. An icon-only rail is a by-shape index — a repeated shape means one of the two
 * entries can only be found by hovering every button, which is the whole affordance gone.
 */
export const EDITOR_SUBPANELS: readonly SubPanel[] = Object.freeze([
  { id: "explorer", icon: "Files", label: "Explorer" },
  { id: "search", icon: "Search", label: "Search" },
  { id: "git", icon: "GitBranch", label: "Source Control" },
  { id: "debug", icon: "Bug", label: "Run & Debug" },
  { id: "test", icon: "FlaskConical", label: "Tests" },
  { id: "todo", icon: "ListChecks", label: "TODO" },
  { id: "outline", icon: "ListTree", label: "Structure" },
  { id: "callhierarchy", icon: "CallHierarchy", label: "Call Hierarchy" },
  { id: "typehierarchy", icon: "TypeHierarchy", label: "Type Hierarchy" },
  { id: "methodhierarchy", icon: "MethodHierarchy", label: "Method Hierarchy" },
  { id: "blame", icon: "History", label: "Blame" },
  { id: "coverage", icon: "Coverage", label: "Coverage" },
]);

/**
 * Which activities have a lower rail at all.
 *
 * Most do not, and that is the point: an activity with no tool panels shows NO divider and no
 * empty lower section, so the rule below the nouns means "there is a second part here", never
 * "this app has a decorative line in it".
 */
export const SUBPANELS: Readonly<Partial<Record<ActivityId, readonly SubPanel[]>>> = Object.freeze({
  editor: EDITOR_SUBPANELS,
});

/** The tool panels for an activity — empty when it has none. */
export function subPanelsFor(activity: ActivityId): readonly SubPanel[] {
  return SUBPANELS[activity] ?? [];
}

/** Does `activity` paint a lower rail? */
export function hasSubPanels(activity: ActivityId): boolean {
  return subPanelsFor(activity).length > 0;
}

/** The panel an activity opens on — its first, or undefined when it has none. */
export function defaultSubPanel(activity: ActivityId): string | undefined {
  return subPanelsFor(activity)[0]?.id;
}

/** Is `id` a real panel of `activity`? Guards a persisted id against a renamed panel. */
export function isSubPanel(activity: ActivityId, id: string): boolean {
  return subPanelsFor(activity).some((p) => p.id === id);
}

/**
 * Resolve the panel to show: the requested one when it is real, else the activity's default.
 *
 * A persisted selection outlives the panel it names. Without this, an operator who quit on
 * "Coverage" after that panel was renamed reopens to a rail with nothing selected and a blank
 * side pane — the same class of bug `ACTIVITY_REDIRECTS` exists to prevent one level up.
 */
export function resolveSubPanel(
  activity: ActivityId,
  requested: string | undefined,
): string | undefined {
  if (requested !== undefined && isSubPanel(activity, requested)) return requested;
  return defaultSubPanel(activity);
}
