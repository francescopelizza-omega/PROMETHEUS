// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/activities.ts — the §4.1 activity-rail model (file 08 §4).
 *
 * The activity rail is "where am I": an ordered icon list, each mapping to a
 * default workbench route + a contextual sidebar. This is PURE DATA + PURE
 * routing helpers (no React, no DOM) so it is unit-testable from TS source AND
 * shared with the `prometheus` TUI (file 08 §8: the activity nouns ARE the CLI's
 * top-level command groups). The desktop ActivityBar renders this list; the CLI
 * reads the same ids.
 *
 * Glyphs are the §4.1 ASCII marks (lucide icons render in the GUI; the glyph is
 * the accessible/CLI fallback that carries meaning without an icon font).
 */

/** The stable id of a workbench activity — the route key the shell mounts. */
export type ActivityId =
  | "home"
  | "editor"
  | "catalog"
  | "chat"
  | "models"
  | "security"
  | "workspace";

/**
 * Ids that USED to be activities and are now segments inside a merged route (handoff_3 §1).
 *
 * They are not `ActivityId`s any more — nothing may navigate to them — but they still exist
 * in the wild: `prometheus.layout` persists the last-open activity, so an operator who quit
 * while on Repos has `"repos"` sitting in localStorage. `ACTIVITY_REDIRECTS` is what turns
 * that into "Workspace, Repos tab" instead of a blank frame.
 */
export type LegacyActivityId = "environments" | "repos" | "docs" | "extensions";

/** Where a retired activity now lives: the merged route + the segment inside it. */
export interface ActivityRedirect {
  activity: ActivityId;
  /** the segmented-tab id within `activity` (CatalogTab | WorkspaceTab). */
  tab: string;
}

/**
 * handoff_3 §1: the rail drops from nine nouns to six, and these four fold in.
 *
 * Keep this table forever. Deleting a redirect does not remove the persisted value from
 * anyone's disk — it only turns a working migration back into the blank-frame bug.
 */
export const ACTIVITY_REDIRECTS: Readonly<Record<LegacyActivityId, ActivityRedirect>> =
  Object.freeze({
    repos: { activity: "workspace", tab: "repos" },
    environments: { activity: "workspace", tab: "environments" },
    docs: { activity: "workspace", tab: "docs" },
    extensions: { activity: "catalog", tab: "extensions" },
  });

/** A pinned-bottom rail item (engine status + settings) — not a route per se. */
export type PinnedId = "engine" | "settings";

/** One activity-rail entry (§4.1). */
export interface Activity {
  id: ActivityId;
  /** the §4.1 glyph (accessible + CLI fallback; the GUI overlays a lucide icon). */
  glyph: string;
  /** lucide-react icon name the GUI renders (resolved lazily so the dep stays optional). */
  icon: string;
  /** the human label (the sidebar header + the CLI command-group name, §8). */
  label: string;
  /** the related feature-file pointer, for tooltips/dev (§4.1). */
  doc: string;
  /**
   * `false` = a real route that does NOT get a rail icon (handoff §2.2). `chat` is the
   * only one: the agent moved into the ALWAYS-PRESENT RightRail, so a rail icon that
   * opens a second, full-width copy of the same session is a duplicate door. The id
   * stays a first-class ActivityId — deep links, the palette and `renderActivity`
   * still resolve it — it simply isn't one of the nine rail nouns.
   */
  rail?: false;
}

/**
 * The activity rail, ordered per handoff_3 §1: Home, Editor, Catalog, Model Hub, Security,
 * Workspace. Six nouns, each doing more — Catalog absorbed Extensions and Skills, Workspace
 * absorbed Repos, Environments and Docs. Engine-status + Settings are pinned separately
 * (PINNED below). `chat` keeps its entry (so getActivity/sidebarTitle/isActivityId stay
 * total for the route) but is marked `rail: false` — render RAIL_ACTIVITIES, not this.
 */
export const ACTIVITIES: readonly Activity[] = Object.freeze([
  { id: "home", glyph: "⌂", icon: "Home", label: "Home", doc: "05.1" },
  { id: "editor", glyph: "⌨", icon: "Code2", label: "Editor", doc: "07" },
  { id: "catalog", glyph: "⬚", icon: "LayoutGrid", label: "Catalog", doc: "06" },
  { id: "models", glyph: "◴", icon: "Boxes", label: "Model Hub", doc: "05" },
  { id: "security", glyph: "🛡", icon: "ShieldCheck", label: "Security", doc: "03" },
  { id: "workspace", glyph: "▤", icon: "FolderOpen", label: "Workspace", doc: "06" },
  { id: "chat", glyph: "💬", icon: "MessageSquare", label: "Chat", doc: "12", rail: false },
]);

/** The SIX icons the §1 rail paints, in order. The ActivityBar renders this. */
export const RAIL_ACTIVITIES: readonly Activity[] = Object.freeze(
  ACTIVITIES.filter((a) => a.rail !== false),
);

/** The pinned-bottom rail items (§4.1): engine status + settings. */
export const PINNED: readonly { id: PinnedId; glyph: string; icon: string; label: string }[] =
  Object.freeze([
    { id: "engine", glyph: "◐", icon: "Activity", label: "Engine status" },
    { id: "settings", glyph: "⚙", icon: "Settings", label: "Settings" },
  ]);

/** The default activity the shell opens on (Mission Control, §5.1). */
export const DEFAULT_ACTIVITY: ActivityId = "home";

const BY_ID = new Map<ActivityId, Activity>(ACTIVITIES.map((a) => [a.id, a]));
const ID_SET = new Set<string>(ACTIVITIES.map((a) => a.id));

/** Whether a string is a known activity id (a total type guard). */
export function isActivityId(value: string): value is ActivityId {
  return ID_SET.has(value);
}

/** Look up an activity by id; undefined for an unknown id. */
export function getActivity(id: string): Activity | undefined {
  return isActivityId(id) ? BY_ID.get(id) : undefined;
}

/**
 * Resolve the activity to show for a requested id — falls back to the default
 * (Home) for an unknown/empty id, so the workbench NEVER renders an empty frame
 * (a bad deep-link degrades to Mission Control, not a blank screen).
 */
export function routeActivity(requested: string | null | undefined): ActivityId {
  return resolveActivity(requested).activity;
}

/**
 * Resolve a requested id to the activity that should mount AND the tab it should open on.
 *
 * Three cases, in order: a live activity id passes through; one of the four retired ids
 * (handoff_3 §1) redirects to its merged route with the right segment; anything else — an
 * unknown or empty id — degrades to Home rather than a blank frame.
 *
 * This is the function every entry point must go through. `App.tsx`'s `loadLayout` used to
 * cast the persisted string straight to `ActivityId`, so a stale `"repos"` survived
 * rehydration and fell through `renderActivity`'s `default:` onto an unrelated route.
 */
export function resolveActivity(requested: string | null | undefined): {
  activity: ActivityId;
  tab?: string;
} {
  if (!requested) return { activity: DEFAULT_ACTIVITY };
  if (isActivityId(requested)) return { activity: requested };
  const redirect = (ACTIVITY_REDIRECTS as Record<string, ActivityRedirect | undefined>)[requested];
  if (redirect) return { activity: redirect.activity, tab: redirect.tab };
  return { activity: DEFAULT_ACTIVITY };
}

/**
 * The sidebar header label for an activity (the §4 contextual sidebar title).
 * Total: an unknown id resolves through routeActivity → Home's label.
 */
export function sidebarTitle(id: string): string {
  return (getActivity(id) ?? BY_ID.get(DEFAULT_ACTIVITY)!).label;
}
