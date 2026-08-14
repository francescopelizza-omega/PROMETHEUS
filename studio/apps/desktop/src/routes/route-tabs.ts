/**
 * routes/route-tabs.ts — the segment ids of the merged routes + the tab latch (handoff_3 §1).
 *
 * The rail dropped from nine nouns to six, so four former activities are now SEGMENTS:
 * Repos/Environments/Docs inside Workspace, Extensions inside Catalog. Anything that used to
 * navigate to one of those has to say which segment it wants, and there is no URL router in
 * this app to say it with.
 *
 * Hence the latch, generalised from the one `docs-view.ts` grew for the `help.*` commands.
 * It solves a specific ordering problem: a caller that navigates to Workspace and then asks
 * for the Repos tab is racing the mount. So a request LATCHES (for a route that is about to
 * mount) and simultaneously NOTIFIES (for one already mounted); the route reads the latch
 * once in its initial state and subscribes for the rest of its life.
 *
 * Pure pub-sub, no DOM and no React, so `commands/registry.ts` stays DOM-free and this stays
 * node-testable.
 */

/** The Catalog route's segments (handoff_3 §2 — Plugins + Extensions + Skills). */
export type CatalogTab = "plugins" | "extensions" | "skills";
export const CATALOG_TABS: readonly CatalogTab[] = ["plugins", "extensions", "skills"];

/** The Workspace route's segments (handoff_3 §5 — Repos + Environments + Docs). */
export type WorkspaceTab = "repos" | "environments" | "docs";
export const WORKSPACE_TABS: readonly WorkspaceTab[] = ["repos", "environments", "docs"];

/** Every segmented-tab id, across every merged route. */
export type RouteTab = CatalogTab | WorkspaceTab;

/** The routes that have segments. Keyed so one latch serves both without collision. */
export type TabbedRoute = "catalog" | "workspace";

const CATALOG_SET: ReadonlySet<string> = new Set(CATALOG_TABS);
const WORKSPACE_SET: ReadonlySet<string> = new Set(WORKSPACE_TABS);

/** Is `tab` a real segment of `route`? Guards a redirect against a typo'd tab id. */
export function isRouteTab(route: TabbedRoute, tab: string): boolean {
  return (route === "catalog" ? CATALOG_SET : WORKSPACE_SET).has(tab);
}

/* ── the latch ───────────────────────────────────────────────────────────────*/

const pending = new Map<TabbedRoute, string>();
const listeners = new Map<TabbedRoute, Set<(tab: string) => void>>();

/**
 * Request that `route` open on `tab`.
 *
 * Latches AND notifies, because the caller cannot know whether the route is mounted: a
 * redirect from persisted layout fires before any route exists, while a Home quick-action
 * fires while some other route is up. An unknown tab is ignored rather than latched — a bad
 * request should leave the route on its default, not wedge it on a segment that has no
 * content.
 */
export function requestRouteTab(route: TabbedRoute, tab: string): void {
  if (!isRouteTab(route, tab)) return;
  pending.set(route, tab);
  const set = listeners.get(route);
  if (set) for (const l of set) l(tab);
}

/**
 * Read AND CLEAR the latched tab for `route` — the route's initial segment.
 *
 * Clearing is the point: the latch is a one-shot handoff, so navigating away and back must
 * not silently re-select the tab a redirect asked for three navigations ago.
 */
export function takeRouteTab(route: TabbedRoute): string | null {
  const t = pending.get(route);
  if (t === undefined) return null;
  pending.delete(route);
  return t;
}

/** Subscribe to tab requests for `route` while mounted; returns an unsubscribe. */
export function onRouteTab(route: TabbedRoute, listener: (tab: string) => void): () => void {
  const set = listeners.get(route) ?? new Set<(tab: string) => void>();
  set.add(listener);
  listeners.set(route, set);
  return () => {
    set.delete(listener);
  };
}

/** Test seam: drop every latched request + listener. */
export function resetRouteTabs(): void {
  pending.clear();
  listeners.clear();
}
