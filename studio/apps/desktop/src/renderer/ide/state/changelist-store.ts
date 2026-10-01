// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/changelist-store.ts — per-workspace changelist membership + persistence
 * (APP-038).
 *
 * A thin zustand store over the pure renderer-mirror reducers (changelists.ts): it
 * holds the changelist set PER workspace root and persists membership to
 * localStorage (the same mechanism the AI-session + tab state use in stores.ts), so
 * a list assignment survives a panel remount and an app reload. The GitPanel drives
 * it: on every status refresh it `syncFiles` (sink new changes to Default, drop
 * vanished ones); the UI calls addList/rename/remove/move.
 *
 * Renderer-SANDBOXED (C5): zustand + the pure reducers + window.localStorage only.
 */

import { create } from "zustand";

import {
  type Changelist,
  assignNewFiles,
  createList,
  defaultChangelist,
  deleteList,
  moveFiles,
  reconcile,
  renameList,
  withDefault,
} from "./changelists.js";

const STORAGE_KEY = "prometheus.changelists";

/** A localStorage handle, or undefined outside a browser (node:test). */
function storage(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** Loosely validate one persisted changelist (fail-soft: drop malformed entries). */
function sanitizeList(v: unknown): Changelist | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.name !== "string") return null;
  const files = Array.isArray(o.files)
    ? o.files.filter((f): f is string => typeof f === "string")
    : [];
  return { id: o.id, name: o.name, isDefault: o.isDefault === true, files };
}

function loadAll(): Record<string, Changelist[]> {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== "object") return {};
    const out: Record<string, Changelist[]> = {};
    for (const [root, lists] of Object.entries(o)) {
      if (Array.isArray(lists)) {
        out[root] = lists.map(sanitizeList).filter((l): l is Changelist => l !== null);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveAll(byRoot: Record<string, Changelist[]>): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(byRoot));
  } catch {
    /* quota / private mode — membership just won't persist this run. */
  }
}

/** Load the persisted changelists for a workspace root ([] if none). */
export function loadChangelists(root: string): Changelist[] {
  return loadAll()[root] ?? [];
}

/** Persist the changelists for a workspace root (merges into the other roots). */
export function saveChangelists(root: string, lists: Changelist[]): void {
  saveAll({ ...loadAll(), [root]: lists });
}

/** A fresh, collision-resistant changelist id. */
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? `cl_${c.randomUUID()}` : `cl_${Date.now().toString(36)}`;
}

interface ChangelistStore {
  byRoot: Record<string, Changelist[]>;
  /** the lists for a root — always at least the Default list. */
  listsFor(root: string): Changelist[];
  setLists(root: string, lists: Changelist[]): void;
  addList(root: string, name: string): void;
  rename(root: string, id: string, name: string): void;
  remove(root: string, id: string): void;
  move(root: string, toId: string, files: string[]): void;
  /** reconcile with git status: sink new files to Default, drop vanished ones. */
  syncFiles(root: string, currentFiles: string[]): void;
}

export const useChangelistStore = create<ChangelistStore>((set, get) => ({
  byRoot: loadAll(),

  listsFor: (root) => {
    const lists = get().byRoot[root];
    return lists && lists.length > 0 ? lists : [defaultChangelist()];
  },

  setLists: (root, lists) => {
    const byRoot = { ...get().byRoot, [root]: lists };
    saveChangelists(root, lists);
    set({ byRoot });
  },

  addList: (root, name) =>
    get().setLists(root, createList(withDefault(get().listsFor(root)), name, newId())),
  rename: (root, id, name) => get().setLists(root, renameList(get().listsFor(root), id, name)),
  remove: (root, id) => get().setLists(root, deleteList(get().listsFor(root), id)),
  move: (root, toId, files) => get().setLists(root, moveFiles(get().listsFor(root), toId, files)),

  syncFiles: (root, currentFiles) => {
    const synced = reconcile(assignNewFiles(get().listsFor(root), currentFiles), currentFiles);
    get().setLists(root, synced);
  },
}));
