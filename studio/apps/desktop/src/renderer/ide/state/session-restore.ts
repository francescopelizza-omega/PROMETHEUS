/**
 * ide/state/session-restore.ts — crash-safe workbench persistence (APP-067).
 *
 * PURE + DOM-free (node:test-able): all the localStorage read/write goes through an
 * injected `StorageLike` seam (defaults to `globalThis.localStorage`), and every
 * persisted blob is a `Versioned` object run through core's `runMigrations` on load, so
 * shapes upgrade cleanly across releases (idempotent + fail-soft — a throwing step keeps
 * the last good state, never a half-migrated corruption).
 *
 * Three blobs live here:
 *   - TABS: open editor tabs + active/focused group + workspace root, so a crash/restart
 *     reopens the same tabs (content is re-read from disk; dirty content is overlaid).
 *   - DIRTY: unsaved buffer contents keyed by uri, byte-capped with oldest-first eviction,
 *     cleared on a successful save — so a crash never loses typed work.
 *   - AI single→multi FOLD: the old ad-hoc migration (stores.ts) expressed as a real
 *     `Migration` step so the ai-session blob rides the same versioned runner.
 *
 * Writes are debounced by the CALLERS (store subscriptions) — NOT tied to beforeunload,
 * which Electron does not guarantee on a hard crash / SIGKILL.
 *
 * Renderer-SANDBOXED (C5): imports only the PURE `@prometheus/core/migrations` subpath.
 */

import { type Migration, type Versioned, runMigrations } from "@prometheus/core/migrations";

import type { TabDoc, TabsState } from "./tabs-reducer.js";

/* ── injectable storage seam (no DOM in tests) ──────────────────────────────── */

/** The minimal localStorage surface persistence needs (Map-backed in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The ambient localStorage, or null when absent/unreachable. Private-mode Safari throws
 * on ACCESS (not just write), so the probe itself is guarded — callers then no-op.
 */
export function defaultStorage(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls ?? null;
  } catch {
    return null; // private mode / access denied
  }
}

/* ── generic versioned load / save (fail-soft; runs core runMigrations) ──────── */

/**
 * Persist a versioned blob. Returns false (never throws) on quota / private-mode — the
 * try/catch wraps `setItem` itself because Safari private mode throws there even at 0 bytes.
 */
export function saveVersioned(storage: StorageLike | null, key: string, state: Versioned): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    return false; // QuotaExceededError / SecurityError — swallow (persistence is best-effort)
  }
}

/** The outcome of loading + migrating one blob. */
export interface LoadResult<T> {
  /** the validated state, or null when absent / unparseable / invalid. */
  state: T | null;
  /** the migration toVersions actually applied (empty on a fresh / already-current blob). */
  migrated: number[];
  /** false only when a migration step threw (fail-soft: last-good is still returned). */
  ok: boolean;
}

/**
 * Load a versioned blob: read → parse → `runMigrations` to `targetVersion` → validate.
 * Absent/garbage yields `{state:null}` (the caller falls back to a fresh default). A parse
 * error is fail-soft (null), never a throw. Idempotent: re-loading an already-current blob
 * applies nothing (`migrated: []`).
 */
export function loadVersioned<T extends Versioned>(
  storage: StorageLike | null,
  key: string,
  targetVersion: number,
  migrations: readonly Migration[],
  validate: (state: Versioned) => T | null,
): LoadResult<T> {
  if (!storage) return { state: null, migrated: [], ok: true };
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { state: null, migrated: [], ok: true };
  }
  if (!raw) return { state: null, migrated: [], ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: null, migrated: [], ok: false }; // corrupt blob → fresh default
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: null, migrated: [], ok: false };
  }
  const res = runMigrations(parsed as Versioned, targetVersion, migrations);
  return { state: validate(res.state), migrated: res.applied, ok: res.ok };
}

/* ── TABS blob ──────────────────────────────────────────────────────────────── */

export const TABS_KEY = "prometheus.workbench.tabs";
export const TABS_VERSION = 1;

export interface PersistedTabs extends Versioned {
  version: number;
  tabs: TabsState;
  workspaceRoot: string | null;
}

/** v1 is the first persisted shape — no prior versions to upgrade from. */
export const tabsMigrations: readonly Migration[] = [];

/** Is this a plausible restorable tab doc? (a uri + a name is the minimum to reopen). */
function isValidDoc(d: unknown): d is TabDoc {
  if (!d || typeof d !== "object") return false;
  const o = d as Record<string, unknown>;
  return typeof o.uri === "string" && o.uri.length > 0 && typeof o.name === "string";
}

/** Serialize the tabs store for persistence — restored tabs are PINNED (never preview). */
export function serializeTabs(tabs: TabsState, workspaceRoot: string | null): PersistedTabs {
  const docs = tabs.docs
    .filter((d) => !!d.uri)
    .map((d) => ({ ...d, preview: false, dirty: false }));
  return {
    version: TABS_VERSION,
    tabs: { docs, activeByGroup: { ...tabs.activeByGroup }, focusedGroup: tabs.focusedGroup },
    workspaceRoot: workspaceRoot ?? null,
  };
}

/** Validate a persisted tabs blob → a clean TabsState (drops junk docs; fixes dangling active). */
export function validatePersistedTabs(state: Versioned): PersistedTabs | null {
  const t = (state as { tabs?: unknown }).tabs as Partial<TabsState> | undefined;
  if (!t || !Array.isArray(t.docs)) return null;
  const docs = t.docs.filter(isValidDoc).map((d) => ({
    uri: d.uri,
    name: d.name,
    languageId: typeof d.languageId === "string" ? d.languageId : "plaintext",
    dirty: false,
    preview: false,
    group: typeof d.group === "number" && Number.isFinite(d.group) ? d.group : 0,
    large: d.large === true,
  }));
  if (docs.length === 0) return null;
  const groups = new Set(docs.map((d) => d.group));
  // keep only active entries that still point at an open doc in that group.
  const activeByGroup: Record<number, string> = {};
  const rawActive = (t.activeByGroup ?? {}) as Record<string, unknown>;
  for (const g of groups) {
    const want = rawActive[g];
    const inGroup = docs.filter((d) => d.group === g);
    const active =
      typeof want === "string" && inGroup.some((d) => d.uri === want) ? want : inGroup[0]?.uri;
    if (active) activeByGroup[g] = active;
  }
  const focusedGroup =
    typeof t.focusedGroup === "number" && groups.has(t.focusedGroup)
      ? t.focusedGroup
      : ([...groups][0] ?? 0);
  const workspaceRoot =
    typeof (state as { workspaceRoot?: unknown }).workspaceRoot === "string"
      ? (state as { workspaceRoot: string }).workspaceRoot
      : null;
  return { version: TABS_VERSION, tabs: { docs, activeByGroup, focusedGroup }, workspaceRoot };
}

/* ── DIRTY buffer recovery blob ───────────────────────────────────────────────── */

export const DIRTY_KEY = "prometheus.workbench.dirty";
export const DIRTY_VERSION = 1;

/** One recovered unsaved buffer. `savedAt` orders eviction (newest kept). */
export interface DirtyRecord {
  uri: string;
  text: string;
  savedAt: number;
}

export interface PersistedDirty extends Versioned {
  version: number;
  buffers: DirtyRecord[];
}

export const dirtyMigrations: readonly Migration[] = [];

/**
 * Total recovery budget in CHARS (UTF-16 → ~2× bytes; well under the ~5MB origin quota).
 * A single huge unsaved file must not blow the quota and drop ALL recovery — so we cap +
 * evict oldest.
 */
export const DIRTY_MAX_CHARS = 1_500_000;

/** Approx serialized size of one record (uri + text dominate). */
function recordSize(r: DirtyRecord): number {
  return r.uri.length + r.text.length;
}

/**
 * Enforce the byte budget: newest-first, keep while under budget, drop the oldest overflow.
 * Always keeps at least the single newest record (typed work you just did wins).
 */
export function capDirtyBuffers(
  buffers: readonly DirtyRecord[],
  maxChars = DIRTY_MAX_CHARS,
): DirtyRecord[] {
  const sorted = [...buffers].sort((a, b) => b.savedAt - a.savedAt);
  const kept: DirtyRecord[] = [];
  let used = 0;
  for (const r of sorted) {
    const size = recordSize(r);
    if (used + size > maxChars && kept.length > 0) continue; // evict (skip) this older record
    used += size;
    kept.push(r);
  }
  return kept;
}

/** Upsert one buffer's recovered text (immutable, re-capped, newest recency). */
export function upsertDirty(
  buffers: readonly DirtyRecord[],
  uri: string,
  text: string,
  now: number,
): DirtyRecord[] {
  const rest = buffers.filter((b) => b.uri !== uri);
  return capDirtyBuffers([{ uri, text, savedAt: now }, ...rest]);
}

/** Drop one buffer (called on a successful save — the recovery copy is no longer needed). */
export function removeDirty(buffers: readonly DirtyRecord[], uri: string): DirtyRecord[] {
  return buffers.filter((b) => b.uri !== uri);
}

/** Validate a persisted dirty blob → clean, capped records. */
export function validatePersistedDirty(state: Versioned): PersistedDirty | null {
  const raw = (state as { buffers?: unknown }).buffers;
  if (!Array.isArray(raw)) return null;
  const buffers: DirtyRecord[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const o = b as Record<string, unknown>;
    if (typeof o.uri !== "string" || typeof o.text !== "string") continue;
    buffers.push({
      uri: o.uri,
      text: o.text,
      savedAt: typeof o.savedAt === "number" && Number.isFinite(o.savedAt) ? o.savedAt : 0,
    });
  }
  return { version: DIRTY_VERSION, buffers: capDirtyBuffers(buffers) };
}

/* ── AI-session single→multi FOLD (deliverable 4) ─────────────────────────────── */

export const AI_VERSION = 1;

/**
 * The OLD ad-hoc migration (stores.ts) as a real `Migration`: a legacy single-session blob
 * `{turns,…}` (no `order`/`sessions`) → the multi-tab `{sessions,order,activeId}` shape.
 * IDEMPOTENT — an already-multi blob is returned untouched, so re-running the chain on a v1
 * blob applies nothing (the version stamp + this guard both prevent a double-fold).
 */
export const aiMigrations: readonly Migration[] = [
  {
    toVersion: 1,
    description: "ai-session: single-session blob → multi-tab {sessions,order,activeId}",
    migrate: (state) => {
      // already multi-shaped → no-op (idempotent).
      if (Array.isArray(state.order) && state.sessions && typeof state.sessions === "object") {
        return state;
      }
      const sid = "s-migrated";
      const turns = Array.isArray(state.turns) ? state.turns : [];
      return {
        ...state,
        sessions: { [sid]: { id: sid, title: "Chat 1", turns } },
        order: [sid],
        activeId: sid,
      };
    },
  },
];

/**
 * Run the ai-session fold on a raw parsed blob → the migrated blob (still needs the
 * store's field-level validation). Fail-soft: on a throwing step returns the last-good state.
 */
export function migrateAiBlob(parsed: Versioned): Versioned {
  return runMigrations(parsed, AI_VERSION, aiMigrations).state;
}
