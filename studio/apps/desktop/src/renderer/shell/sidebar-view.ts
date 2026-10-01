// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/sidebar-view.ts — PURE helpers for the shell Sidebar (APP-002).
 *
 * JSX-free (settings-view.ts / rightrail-view.ts convention) so node:test can
 * import it. Owns: which activities have a registered sidebar body, the per-route
 * default collapse policy, the persisted per-activity collapse map (with migration
 * from the old single-boolean layout), and the git-status → compact view model.
 *
 * NOTE the spec's "explorer/search/vcs" are the EDITOR's internal tool-window ids
 * (routes/editor.tsx), not shell ActivityIds — the shell bodies map to the real
 * ActivityId union instead: home=explorer, repos=vcs, editor=open-editors summary.
 */

import type { ActivityId } from "@prometheus/ui";

import type { IdeGitChange, IdeGitStatus } from "../../shared/ipc-contract.js";

/** Activities with a registered shell-sidebar body (single source — the JSX
 *  registry in renderer/sidebar-bodies.tsx is typed against this exact tuple). */
// handoff_3 §1: the contextual sidebar follows the ROUTE, and Repos is now a Workspace
// segment — so the repo tree belongs to `workspace`.
export const SIDEBAR_BODY_ACTIVITIES = ["home", "editor", "workspace"] as const;
export type SidebarBodyActivity = (typeof SIDEBAR_BODY_ACTIVITIES)[number];

const BODY_SET: ReadonlySet<string> = new Set(SIDEBAR_BODY_ACTIVITIES);

/** Truthful body predicate — APP-003 (⌘B toggle + rail re-click) gates on this. */
export function hasSidebarBody(activity: ActivityId): boolean {
  return BODY_SET.has(activity);
}

/**
 * Default collapse per route: open only where a body exists, EXCEPT the editor —
 * it owns its own explorer/search/git tool-windows, so a second open column by
 * default would read as a duplicate. The user can still open it (persisted).
 */
export function defaultSidebarCollapsed(activity: ActivityId): boolean {
  return activity === "editor" || !hasSidebarBody(activity);
}

/** Persisted per-activity collapse overrides (absent key = route default). */
export type SidebarCollapsedMap = Partial<Record<ActivityId, boolean>>;

/** The user's effective collapse preference for a route. */
export function effectiveSidebarCollapsed(map: SidebarCollapsedMap, activity: ActivityId): boolean {
  return map[activity] ?? defaultSidebarCollapsed(activity);
}

/**
 * Parse the per-activity collapse map out of a persisted-layout blob, migrating
 * the v1 shape (one global `sidebarCollapsed` boolean) by seeding every
 * body-bearing activity with it. Returns undefined when neither shape is present
 * (caller falls back to route defaults).
 */
export function parseSidebarCollapsed(o: Record<string, unknown>): SidebarCollapsedMap | undefined {
  const v2 = o.sidebarCollapsedByActivity;
  if (v2 !== null && typeof v2 === "object" && !Array.isArray(v2)) {
    const out: SidebarCollapsedMap = {};
    for (const [k, v] of Object.entries(v2 as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k as ActivityId] = v;
    }
    return out;
  }
  if (typeof o.sidebarCollapsed === "boolean") {
    const out: SidebarCollapsedMap = {};
    for (const a of SIDEBAR_BODY_ACTIVITIES) out[a] = o.sidebarCollapsed;
    return out;
  }
  return undefined;
}

/**
 * Flip `activity`'s collapse entry — the ⌘B / rail-re-click primitive (APP-003).
 * On a BODY-LESS activity this returns the map UNCHANGED (same reference): there is
 * nothing to show, so no state flips, no re-render, no invisible toggle region —
 * the documented no-op (see registry.ts `view.toggleSidebar`).
 */
export function toggleSidebarMap(
  map: SidebarCollapsedMap,
  activity: ActivityId,
): SidebarCollapsedMap {
  if (!hasSidebarBody(activity)) return map;
  return { ...map, [activity]: !effectiveSidebarCollapsed(map, activity) };
}

/* ── vcs body view model ────────────────────────────────────────────────────*/

/** Rows shown per change group in the compact vcs body. */
export const GIT_GROUP_ROW_CAP = 20;

export interface GitSidebarRow {
  path: string;
  kind: string;
}

export interface GitSidebarGroup {
  label: string;
  count: number;
  /** first GIT_GROUP_ROW_CAP rows only — `count` still carries the true total. */
  rows: GitSidebarRow[];
}

export interface GitSidebarSummary {
  ok: boolean;
  error?: string;
  branch: string | null;
  ahead: number;
  behind: number;
  /** only non-empty groups, in staged/unstaged/untracked/conflicted order. */
  groups: GitSidebarGroup[];
  totalChanges: number;
}

function toRows(list: unknown, fallbackKind: string, staged: boolean): GitSidebarRow[] {
  if (!Array.isArray(list)) return [];
  const rows: GitSidebarRow[] = [];
  for (const c of list as Partial<IdeGitChange>[]) {
    if (!c || typeof c.path !== "string") continue;
    rows.push({ path: c.path, kind: (staged ? c.staged : c.unstaged) ?? fallbackKind });
  }
  return rows;
}

/**
 * Fold a (possibly partial — IPC payloads are not trusted, the known shell-crash
 * pattern is a missing array) IdeGitStatus into the compact sidebar view model.
 * Never throws; a nullish/failed status comes back as ok:false.
 */
export function summarizeGitStatus(s: IdeGitStatus | null | undefined): GitSidebarSummary {
  if (!s || typeof s !== "object" || s.ok !== true) {
    return {
      ok: false,
      error: (s?.error ?? "git status unavailable") || "git status unavailable",
      branch: null,
      ahead: 0,
      behind: 0,
      groups: [],
      totalChanges: 0,
    };
  }
  const all: [string, GitSidebarRow[]][] = [
    ["Staged", toRows(s.staged, "modified", true)],
    ["Changes", toRows(s.unstaged, "modified", false)],
    ["Untracked", toRows(s.untracked, "untracked", false)],
    ["Conflicted", toRows(s.conflicted, "conflicted", false)],
  ];
  const groups: GitSidebarGroup[] = [];
  let total = 0;
  for (const [label, rows] of all) {
    if (rows.length === 0) continue;
    total += rows.length;
    groups.push({ label, count: rows.length, rows: rows.slice(0, GIT_GROUP_ROW_CAP) });
  }
  return {
    ok: true,
    branch: typeof s.branch === "string" ? s.branch : null,
    ahead: typeof s.ahead === "number" ? s.ahead : 0,
    behind: typeof s.behind === "number" ? s.behind : 0,
    groups,
    totalChanges: total,
  };
}
