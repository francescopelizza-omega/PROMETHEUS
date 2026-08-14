/**
 * stores/recents.ts — the recently-opened PROJECT list (handoff §2.3.4).
 *
 * Home's "Recent projects" island used to show only repos CLONED through Studio
 * (`repo.list()`), so a folder opened with the picker — the most common way anyone
 * opens a project — never appeared. That made the island quietly wrong rather than
 * empty. This is the missing MRU: every workspace root the app actually opens is
 * recorded here, newest first, with the timestamp the island renders as an age.
 *
 * Cloned repos still show: Home merges this list with `repo.list()` so a fresh
 * install with no history is not an empty island.
 *
 * Renderer-SANDBOXED (C5): zustand + localStorage only. No node:*, no engine-bridge.
 */

import { create } from "zustand";

export const RECENTS_KEY = "prometheus.recentProjects.v1";

/** How many projects the MRU keeps. Beyond this the island stops being scannable. */
export const RECENTS_MAX = 8;

export interface RecentProject {
  /** the absolute workspace root. */
  path: string;
  /** the folder basename — what the row shows as the title. */
  name: string;
  /** epoch ms of the most recent open (the island renders this as an age). */
  openedAt: number;
}

function basename(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() ?? path
  );
}

function isRecent(v: unknown): v is RecentProject {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.path === "string" && typeof o.name === "string" && typeof o.openedAt === "number";
}

function load(): RecentProject[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // guard the ARRAY, not just the parse — a hand-edited/corrupt blob must degrade to
    // "no recents", never to a render crash on `.map` of a non-array.
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecent).slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function persist(list: readonly RecentProject[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* private mode / quota — recents just won't survive this session. */
  }
}

export interface RecentsStore {
  recents: RecentProject[];
  /** record an opened workspace root (moves an existing entry to the front). */
  record(path: string, now?: number): void;
  /** drop one entry (a project the user moved or deleted). */
  forget(path: string): void;
}

export const useRecentsStore = create<RecentsStore>((set, get) => ({
  recents: load(),
  record: (path: string, now = Date.now()): void => {
    const clean = path.replace(/[/\\]+$/, "");
    if (!clean) return;
    const next = [
      { path: clean, name: basename(clean), openedAt: now },
      ...get().recents.filter((r) => r.path !== clean),
    ].slice(0, RECENTS_MAX);
    set({ recents: next });
    persist(next);
  },
  forget: (path: string): void => {
    const next = get().recents.filter((r) => r.path !== path);
    set({ recents: next });
    persist(next);
  },
}));

/** "now" · "5 m" · "2 h" · "3 d" — the island's right-aligned age column. */
export function ageLabel(openedAt: number, now = Date.now()): string {
  const ms = Math.max(0, now - openedAt);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min} m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
