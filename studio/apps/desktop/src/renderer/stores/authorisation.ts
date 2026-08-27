/**
 * stores/authorisation.ts — the A0…A7 authorisation level (handoff §5).
 *
 * ONE store, persisted, changeable mid-session. Every surface that shows or acts on the
 * level reads THIS: the TopBar pill, the StatusBar entry, the chat composer readout, and
 * every permission card. Nothing re-derives the ladder locally.
 *
 * The ladder itself is NOT redefined here — it is `@prometheus/core/agent-authorization`,
 * the same module the `prometheus` CLI parses `--authorisations` into (AUTH_LEVELS /
 * authDecision / scopedWriteDecision). That module is PURE (its only import is a `type`),
 * so it is safe in the sandboxed renderer; the core ROOT barrel is not (it eagerly loads
 * node:fs), hence the dedicated subpath.
 *
 * Persistence is localStorage, like every other renderer preference (`prometheus.layout`,
 * `prometheus.editor.inlineBlame.v1`). NOTE: the CLI persists its own level to
 * `<config>/authorisation.json` — the two are independent today, so a level set in the GUI
 * does not follow you into `prometheus` on the terminal. Unifying them needs a main-process
 * handler over that file; §5's "one store" is satisfied WITHIN the GUI.
 *
 * Renderer-SANDBOXED (C5): zustand + a pure core subpath only. No node:*, no engine-bridge.
 */

import {
  AUTH_LEVELS,
  type AuthLevelMeta,
  DEFAULT_AUTH_LEVEL,
  authLevelMeta,
  modeToAuthLevel,
} from "@prometheus/core/agent-authorization";
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type PermissionModeId,
} from "@prometheus/core/agent-permission-modes";
import { create } from "zustand";

export const AUTH_LEVEL_KEY = "prometheus.authorisation.v1";

/** The highest valid level (7 — "run all"). */
export const MAX_AUTH_LEVEL = AUTH_LEVELS.length - 1;

/** Clamp anything to a real level; a non-number falls back to the safe default (1). */
export function clampAuthLevel(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_AUTH_LEVEL;
  return Math.max(0, Math.min(Math.trunc(n), MAX_AUTH_LEVEL));
}

/**
 * The §5 color ladder as SEMANTIC TOKEN names (never hex): 0–1 ok-green · 2–3 accent-cyan ·
 * 4–5 warn-amber · 6 danger-fg (the lighter red — "system-wide" is grave, not fatal) ·
 * 7 danger-red. Returns a CSS var NAME so callers write `var(${authLevelVar(n)})`.
 */
export function authLevelVar(level: number): string {
  const l = clampAuthLevel(level);
  if (l <= 1) return "--ok";
  if (l <= 3) return "--accent";
  if (l <= 5) return "--warn";
  if (l === 6) return "--danger-fg";
  return "--danger";
}

/** The GUI wording for a level ("accept edits"), from core's `uiLabel`. */
export function authLevelUiLabel(level: number): string {
  return authLevelMeta(clampAuthLevel(level)).uiLabel;
}

/** Every level, for the picker. */
export function authLevels(): readonly AuthLevelMeta[] {
  return AUTH_LEVELS;
}

function load(): number {
  if (typeof window === "undefined") return DEFAULT_AUTH_LEVEL;
  try {
    const raw = window.localStorage.getItem(AUTH_LEVEL_KEY);
    if (raw == null) return DEFAULT_AUTH_LEVEL;
    const parsed: unknown = JSON.parse(raw);
    // accept both the bare number and the CLI's `{ level: n }` shape, so a future
    // main-process bridge to authorisation.json needs no migration here.
    if (typeof parsed === "number") return clampAuthLevel(parsed);
    if (parsed && typeof parsed === "object" && "level" in parsed)
      return clampAuthLevel((parsed as { level: unknown }).level);
    return DEFAULT_AUTH_LEVEL;
  } catch {
    return DEFAULT_AUTH_LEVEL;
  }
}

function persist(level: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_LEVEL_KEY, JSON.stringify({ level }));
  } catch {
    /* private mode / quota — the level just won't survive this session. */
  }
}

/* ── the coarse permission MODE, alongside the fine level ──────────────────── */

export const PERMISSION_MODE_KEY = "prometheus.permissionMode.v1";

/** Narrow anything to a real mode id; anything else falls back to the safe `default`. */
export function clampPermissionMode(value: unknown): PermissionModeId {
  return PERMISSION_MODES.some((m) => m.id === value)
    ? (value as PermissionModeId)
    : DEFAULT_PERMISSION_MODE;
}

function loadMode(): PermissionModeId {
  if (typeof window === "undefined") return DEFAULT_PERMISSION_MODE;
  try {
    return clampPermissionMode(window.localStorage.getItem(PERMISSION_MODE_KEY));
  } catch {
    return DEFAULT_PERMISSION_MODE;
  }
}

function persistMode(mode: PermissionModeId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERMISSION_MODE_KEY, mode);
  } catch {
    /* private mode / quota — the mode just won't survive this session. */
  }
}

export interface AuthorisationStore {
  /** the active level, 0..7. */
  level: number;
  /** set it (clamped + persisted). */
  setLevel(level: number): void;
  /** step to the next level, wrapping 7 → 0 (the pill's click behaviour). */
  cycle(): void;
  /**
   * The coarse autonomy POSTURE, the GUI twin of the CLI's Shift-Tab dial.
   *
   * The pane had no posture at all before this: the editor could not be put in plan mode, so
   * "look but don't touch" was a terminal-only capability. Core's agent loop enforces the
   * DENY side of the matrix, so setting this is the whole mechanism.
   */
  permissionMode: PermissionModeId;
  /**
   * Set the posture, and keep the FINE level in sync exactly as the CLI does
   * (`modeToAuthLevel`). Two independent dials over one concept is how the TUI's indicator
   * and its actual behaviour came apart once already; `plan` pins the level to 0 so no
   * ladder rung can auto-approve underneath a read-only posture.
   */
  setPermissionMode(mode: PermissionModeId): void;
}

/** True only while `setPermissionMode` is driving the level — see its body. */
let syncingFromMode = false;

export const useAuthorisationStore = create<AuthorisationStore>((set, get) => ({
  level: load(),
  setLevel: (level: number): void => {
    const next = clampAuthLevel(level);
    set({ level: next });
    persist(next);
    /**
     * Choosing a LEVEL leaves plan mode, so the two dials cannot disagree.
     *
     * `setPermissionMode` already syncs the level (plan pins it to 0 so no ladder rung can
     * auto-approve underneath a read-only posture) — but the reverse never happened. Picking a
     * level while in plan mode left `permissionMode: "plan"` beside a level that auto-approves:
     * the indicator said read-only while the behaviour was not. That is the exact failure this
     * store's own docstring records for the TUI.
     *
     * Written directly rather than through `setPermissionMode` to avoid the mutual recursion
     * (that setter calls `setLevel`), and unconditionally rather than only when the level rises:
     * plan is a deliberate posture, so returning to level 0 must not silently re-enter it either.
     */
    if (!syncingFromMode && get().permissionMode === "plan") {
      const mode = clampPermissionMode("default");
      set({ permissionMode: mode });
      persistMode(mode);
    }
  },
  cycle: (): void => {
    get().setLevel((get().level + 1) % (MAX_AUTH_LEVEL + 1));
  },
  permissionMode: loadMode(),
  setPermissionMode: (mode: PermissionModeId): void => {
    const next = clampPermissionMode(mode);
    set({ permissionMode: next });
    persistMode(next);
    /**
     * Guarded, because `setLevel` now clears plan mode — without this, choosing `plan` would
     * set the mode, drive the level to 0, and that level change would immediately clear the mode
     * again. The flag marks "this level change IS the mode change", not a user picking a level.
     */
    syncingFromMode = true;
    try {
      get().setLevel(modeToAuthLevel(next));
    } finally {
      syncingFromMode = false;
    }
  },
}));
