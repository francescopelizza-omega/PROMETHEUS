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
  | "environments"
  | "security"
  | "repos"
  | "docs"
  | "extensions";

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
}

/**
 * The activity rail, ordered by daily frequency (file 08 §4.1). Home first
 * (Mission Control), then the daily-driver surfaces, then the broader workspace
 * apps. Engine-status + Settings are pinned separately (PINNED below).
 */
export const ACTIVITIES: readonly Activity[] = Object.freeze([
  { id: "home", glyph: "⌂", icon: "Home", label: "Home", doc: "05.1" },
  { id: "editor", glyph: "⌨", icon: "Code2", label: "Editor", doc: "07" },
  { id: "catalog", glyph: "⬚", icon: "LayoutGrid", label: "Catalog", doc: "06" },
  { id: "chat", glyph: "💬", icon: "MessageSquare", label: "Chat", doc: "12" },
  { id: "models", glyph: "◴", icon: "Boxes", label: "Model Hub", doc: "05" },
  { id: "environments", glyph: "⬢", icon: "Container", label: "Environments", doc: "04" },
  { id: "security", glyph: "🛡", icon: "ShieldCheck", label: "Security", doc: "03" },
  { id: "repos", glyph: "⤳", icon: "GitBranch", label: "Repos", doc: "06" },
  { id: "docs", glyph: "📖", icon: "BookOpen", label: "Docs", doc: "01" },
  { id: "extensions", glyph: "⚙", icon: "Puzzle", label: "Extensions", doc: "09" },
]);

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
  if (requested && isActivityId(requested)) return requested;
  return DEFAULT_ACTIVITY;
}

/**
 * The sidebar header label for an activity (the §4 contextual sidebar title).
 * Total: an unknown id resolves through routeActivity → Home's label.
 */
export function sidebarTitle(id: string): string {
  return (getActivity(id) ?? BY_ID.get(DEFAULT_ACTIVITY)!).label;
}
