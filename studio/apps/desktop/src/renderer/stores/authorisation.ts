// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
 * Persistence is the SHARED file `~/.prometheus/config/authorisation.json`, reached over
 * `main/auth-level-ipc.ts`; localStorage is only this window's synchronous mirror for the
 * first paint. The GUI and the `prometheus` CLI therefore read and write the same level.
 * (This paragraph used to say the two were independent and that unifying them "needs a
 * main-process handler over that file" — that handler has existed for some time.)
 *
 * Two values, deliberately: `level` is what this SESSION is operating at, and `savedLevel`
 * is what is on disk. They differ whenever the coarse posture dial is used — `plan` drives
 * the session to 0 without writing the file, because mode→level is lossy and persisting it
 * would overwrite an explicit `/authorisation 7`. Anything that must agree with what MAIN
 * enforces reads `effectiveAuthLevel()`, the min of the two.
 *
 * Renderer-SANDBOXED (C5): zustand + a pure core subpath only. No node:*, no engine-bridge.
 */

import {
  AUTH_LEVELS,
  type AuthLevelMeta,
  DEFAULT_AUTH_LEVEL,
  authLevelMeta,
  authLevelToMode,
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
 * The §5 colour ladder as SEMANTIC TOKEN names (never hex). Returns a CSS var NAME so callers
 * write `var(${authLevelVar(n)})`.
 *
 *   0–1 text-muted · 2–3 accent · 4–5 warn · 6–7 autonomy
 *
 * ── WHY THE TOP IS NO LONGER RED ────────────────────────────────────────────────────────────
 *
 * It was `--danger-fg` at 6 and `--danger` at 7, which made the ladder a severity scale:
 * green, blue, amber, red is the vocabulary of fine/info/warning/error. A6 and A7 are not
 * errors — they are the setting an operator chose so work finishes without being asked — and a
 * red pill held for a whole session stops carrying information and starts carrying pressure.
 * `--autonomy` is the accent pushed further from the ground (ice on dark, deepened on light;
 * see the token's own comment in `packages/ui/src/tokens.ts`), so full autonomy reads as a dial
 * turned up rather than a fault raised.
 *
 * Red is still on this bar and is now unambiguous: `StatusBar` keeps `--danger` for a failed
 * scan, which genuinely is one.
 *
 * ── AND WHY 0–1 IS NO LONGER GREEN ──────────────────────────────────────────────────────────
 *
 * The CLI's own ladder (`apps/cli/src/tui/status.ts`, `authRole`) starts at `muted`, and the
 * two had silently drifted: the same A0 was grey in the terminal and green in Studio. Green is
 * this product's "ok / enabled / clean" colour everywhere else, and spending it on "asks before
 * everything" claims a verdict the level is not making — A0 is the most CAUTIOUS rung, not the
 * healthiest one. Muted matches the CLI and says the honest thing: nothing notable is on.
 *
 * The two ladders are now the same shape. They are still two functions in two packages, which
 * is a real duplication — but `core` cannot reach a CSS variable and the renderer cannot reach
 * a terminal Role, so the shared thing would have to be an abstract rung enum. Worth doing if a
 * third surface ever grows one; not worth it for two.
 */
export function authLevelVar(level: number): string {
  const l = clampAuthLevel(level);
  if (l <= 1) return "--text-muted";
  if (l <= 3) return "--accent";
  if (l <= 5) return "--warn";
  return "--autonomy";
}

/** The GUI wording for a level ("accept edits"), from core's `uiLabel`. */
export function authLevelUiLabel(level: number): string {
  return authLevelMeta(clampAuthLevel(level)).uiLabel;
}

/** Every level, for the picker. */
export function authLevels(): readonly AuthLevelMeta[] {
  return AUTH_LEVELS;
}

/**
 * The SYNCHRONOUS seed for the very first paint.
 *
 * The authoritative copy is the shared file (`~/.prometheus/config/authorisation.json`), reached
 * over IPC — and IPC is async while a zustand initializer is not. So the store opens on the last
 * value this window saw (a localStorage MIRROR, not the source of truth) and `hydrateAuthLevel`
 * replaces it a tick later. Seeding from the mirror rather than from the default matters: a
 * one-frame flash of "A1 · read freely" over a machine set to A6 reads as a silent downgrade.
 *
 * With no mirror yet, the safe default wins — never a higher level than the operator chose.
 */
function load(): number {
  if (typeof window === "undefined") return DEFAULT_AUTH_LEVEL;
  try {
    const raw = window.localStorage.getItem(AUTH_LEVEL_KEY);
    if (raw == null) return DEFAULT_AUTH_LEVEL;
    const parsed: unknown = JSON.parse(raw);
    // accept both the bare number and the CLI's `{ level: n }` shape
    if (typeof parsed === "number") return clampAuthLevel(parsed);
    if (parsed && typeof parsed === "object" && "level" in parsed)
      return clampAuthLevel((parsed as { level: unknown }).level);
    return DEFAULT_AUTH_LEVEL;
  } catch {
    return DEFAULT_AUTH_LEVEL;
  }
}

/** Update the local mirror. Never the only write — see `persist`. */
function mirror(level: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_LEVEL_KEY, JSON.stringify({ level }));
  } catch {
    /* private mode / quota — the mirror is an optimisation, the file is the truth. */
  }
}

/**
 * Persist an EXPLICIT choice: the shared file first, the local mirror alongside it.
 *
 * localStorage used to be the ONLY store, which had two consequences the app never admitted to:
 * a level set in the terminal was invisible here (and the reverse), and clearing the app's data
 * reset the posture with nothing on disk to recover it from.
 */
function persist(level: number): void {
  mirror(level);
  // an explicit pick IS the stored preference — record it so `effectiveAuthLevel` does not
  // wait for a re-hydrate to agree with what main will read.
  useAuthorisationStore.setState({ savedLevel: level });
  // `typeof window` guard, not `window?.` — in a node test context the identifier itself is
  // undeclared, so reaching for it at all is a ReferenceError rather than an undefined value.
  if (typeof window === "undefined") return;
  const api = window.prometheus?.authLevel;
  if (!api?.set) return;
  /**
   * RECONCILE, rather than assume the optimistic value held.
   *
   * `savedLevel` is a claim about the FILE — `effectiveAuthLevel` mins against it to decide what
   * main will allow — so asserting it before the write lands can advertise access main refuses.
   * The channel cannot signal this by rejecting: core's `saveAuthLevel` is deliberately fail-soft
   * (an unwritable home must not refuse a session), so `authLevel:set` answers `ok:true` with the
   * level it re-read from disk. A level that differs from the one requested IS the failure signal.
   *
   * On failure we adopt DEFAULT_AUTH_LEVEL rather than `null`, because null means "the read has
   * not answered" and would re-assert the very level that was never saved.
   */
  void api
    .set(level)
    .then((res) => {
      const saved = typeof res?.level === "number" ? clampAuthLevel(res.level) : null;
      if (res?.ok && saved === level) return; // the write landed; the optimistic value was right
      useAuthorisationStore.setState({ savedLevel: saved ?? DEFAULT_AUTH_LEVEL });
    })
    .catch(() => {
      useAuthorisationStore.setState({ savedLevel: DEFAULT_AUTH_LEVEL });
    });
}

/**
 * Adopt the shared file's value once the window is up.
 *
 * Called from the app shell's boot. A file that has never been written returns `null` — that is
 * "never chosen", not "chosen to be the default", so the seeded value is kept rather than being
 * overwritten with a lower one.
 */
export async function hydrateAuthLevel(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const res = await window.prometheus?.authLevel?.get();
    if (res?.ok && res.level !== null && res.level !== undefined) {
      const level = clampAuthLevel(res.level);
      mirror(level);
      useAuthorisationStore.setState({
        level,
        savedLevel: level,
        permissionMode: authLevelToMode(level),
      });
      return;
    }
    /**
     * The read ANSWERED and there is nothing on disk (never written, corrupt, unreadable).
     *
     * That is not "no ceiling". Main resolves the same absence to DEFAULT_AUTH_LEVEL
     * (`readSavedAuthLevel() ?? DEFAULT_AUTH_LEVEL`, ai-ipc.ts), so record what main will
     * enforce. Leaving `savedLevel` at the "unknown" sentinel made `effectiveAuthLevel` fall
     * back to the bare session level — and the session level is seeded from the localStorage
     * mirror, i.e. exactly the state every user upgrading from the mirror-only build is in. The
     * Model Hub then advertised cloud endpoints main refuses.
     *
     * The session `level` and the posture dial are deliberately left as seeded: the pill still
     * reports the dial's position, only the "what will be ALLOWED" figure is clamped.
     */
    useAuthorisationStore.setState({ savedLevel: DEFAULT_AUTH_LEVEL });
  } catch {
    /* no bridge at all (a browser-only render, a test) — nothing was learned, leave null */
  }
}

/**
 * The level that MAIN will enforce: the min of this session's level and the stored one.
 *
 * `min`, because main takes the same min (ai-ipc.ts) — a session posture may tighten the
 * ceiling and may never raise it. Any surface that tells the user what will be ALLOWED must
 * use this; a surface that merely reports the dial's position may use `level`.
 */
export function effectiveAuthLevel(level: number, savedLevel: number | null): number {
  return savedLevel === null ? level : Math.min(level, savedLevel);
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
  /** the active level for THIS SESSION, 0..7. */
  level: number;
  /**
   * The level on disk, once hydrated — what `main` actually enforces against.
   *
   * `null` means THE READ HAS NOT ANSWERED YET — not "nothing is stored". Once it answers with
   * no stored level, this becomes `DEFAULT_AUTH_LEVEL`, because that is what main resolves the
   * same absence to; only a missing bridge leaves it null. Surfaces that describe what main WILL
   * do (the Model Hub's "A5+ only" note) must not render the session level alone: with a `plan`
   * posture the two disagree, and the label then contradicts the refusal the user is about to get.
   */
  savedLevel: number | null;
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
  savedLevel: null,
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
  /**
   * Set the posture. SESSION-SCOPED, exactly like the CLI's Shift-Tab.
   *
   * The live level still follows the mode — every approval decision reads it — but the derived
   * value is NOT written to the shared file. mode→level is lossy (five modes, eight levels), so
   * persisting it overwrote the operator's explicit pick: on the CLI side, `/authorisation 7`
   * plus one mode change came back from the next session as 2, and a cycle back to `default` as 1.
   */
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
      const derived = clampAuthLevel(modeToAuthLevel(next));
      set({ level: derived });
      mirror(derived); // this window's own last-seen value, not the stored preference
    } finally {
      syncingFromMode = false;
    }
  },
}));
