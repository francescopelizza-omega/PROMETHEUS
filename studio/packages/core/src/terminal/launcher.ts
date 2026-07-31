/**
 * terminal/launcher.ts — the terminal-panel session model (file 13 §1.2/§1.7).
 *
 * A pure, framework-free reducer over the launcher's state: the session list (grouped
 * project / AI agents / floating), the active session, open-as tab|split|float, the
 * broadcast banner, and maximize. Plus the §1.7 persistence snapshot — honest
 * "session, not process": we restore the TERMINAL (re-spawn from its profile + replay
 * the scrollback tail read-only above a fresh prompt), never a live in-flight process.
 *
 * The renderer binds this to React + xterm.js (07 §6.1); spawning is 07's pty-host.
 * Ids are supplied by the caller (so the reducer stays deterministic + testable).
 */
import type { TerminalProfile } from "./profiles.js";
import { isAiPreset } from "./profiles.js";

export type TerminalStatus = "running" | "idle" | "exited";

/** How a session is opened/displayed (§1.2). */
export type OpenTarget = "tab" | "split-right" | "split-down" | "float";

/** The session-list group a session belongs to (§1.2 left list). */
export type SessionGroup = "project" | "ai" | "floating";

/** One live (or restored) terminal session. */
export interface TerminalSession {
  id: string;
  profileId: string;
  title: string;
  status: TerminalStatus;
  openAs: OpenTarget;
  group: SessionGroup;
  cwd?: string;
  /** true ⇒ recreated from a snapshot on launch; its scrollback is replayed read-only. */
  restored?: boolean;
  /** snapshot this session across restarts (§1.7); default from the profile. */
  persist?: boolean;
}

/** Compute the session group from its profile + open target (§1.2). */
export function groupFor(profile: TerminalProfile, openAs: OpenTarget): SessionGroup {
  if (openAs === "float") return "floating";
  return isAiPreset(profile) ? "ai" : "project";
}

/** The launcher panel state (§1.2/§1.7). */
export interface LauncherState {
  sessions: TerminalSession[];
  activeId: string | null;
  maximized: boolean;
  /** broadcast mode mirrors keystrokes to every session in the active group (§1.7). */
  broadcast: boolean;
}

export function initialLauncherState(): LauncherState {
  return { sessions: [], activeId: null, maximized: false, broadcast: false };
}

/** Launcher events (the reducer's vocabulary). */
export type LauncherEvent =
  | { type: "open"; session: TerminalSession }
  | { type: "close"; id: string }
  | { type: "rename"; id: string; title: string }
  | { type: "status"; id: string; status: TerminalStatus }
  | { type: "focus"; id: string }
  | { type: "next" }
  | { type: "prev" }
  | { type: "toggle-maximize" }
  | { type: "set-broadcast"; on: boolean }
  | { type: "to-float"; id: string };

function withActiveAfterRemoval(
  sessions: TerminalSession[],
  removedId: string,
  prevActive: string | null,
): string | null {
  if (prevActive !== removedId) return prevActive;
  return sessions.length > 0 ? (sessions[sessions.length - 1]?.id ?? null) : null;
}

/** The pure launcher reducer (§1.2/§1.7). Returns a NEW state; never mutates. */
export function launcherReducer(state: LauncherState, event: LauncherEvent): LauncherState {
  switch (event.type) {
    case "open": {
      // ignore a duplicate id (idempotent open)
      if (state.sessions.some((s) => s.id === event.session.id)) {
        return { ...state, activeId: event.session.id };
      }
      return { ...state, sessions: [...state.sessions, event.session], activeId: event.session.id };
    }
    case "close": {
      const sessions = state.sessions.filter((s) => s.id !== event.id);
      return {
        ...state,
        sessions,
        activeId: withActiveAfterRemoval(sessions, event.id, state.activeId),
      };
    }
    case "rename":
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.id === event.id ? { ...s, title: event.title } : s)),
      };
    case "status":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === event.id ? { ...s, status: event.status } : s,
        ),
      };
    case "focus":
      return state.sessions.some((s) => s.id === event.id)
        ? { ...state, activeId: event.id }
        : state;
    case "next":
    case "prev": {
      if (state.sessions.length === 0) return state;
      const idx = state.sessions.findIndex((s) => s.id === state.activeId);
      const start = idx === -1 ? 0 : idx;
      const delta = event.type === "next" ? 1 : -1;
      const nextIdx = (start + delta + state.sessions.length) % state.sessions.length;
      return { ...state, activeId: state.sessions[nextIdx]?.id ?? null };
    }
    case "toggle-maximize":
      return { ...state, maximized: !state.maximized };
    case "set-broadcast":
      return { ...state, broadcast: event.on };
    case "to-float":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === event.id ? { ...s, openAs: "float", group: "floating" } : s,
        ),
      };
  }
}

/* ── selectors ─────────────────────────────────────────────────────────────── */

/** Sessions grouped for the §1.2 left list, in display order (project → ai → floating). */
export function sessionsByGroup(
  state: LauncherState,
): { group: SessionGroup; sessions: TerminalSession[] }[] {
  const order: SessionGroup[] = ["project", "ai", "floating"];
  return order
    .map((group) => ({ group, sessions: state.sessions.filter((s) => s.group === group) }))
    .filter((g) => g.sessions.length > 0);
}

/** The active session, or null. */
export function activeSession(state: LauncherState): TerminalSession | null {
  return state.sessions.find((s) => s.id === state.activeId) ?? null;
}

/**
 * Broadcast targets (§1.7): when broadcast is on, a keystroke in the active session is
 * mirrored to every OTHER session in the SAME group. Returns the recipient ids
 * (excluding the source). Empty when broadcast is off.
 */
export function broadcastTargets(state: LauncherState, sourceId: string): string[] {
  if (!state.broadcast) return [];
  const src = state.sessions.find((s) => s.id === sourceId);
  if (!src) return [];
  return state.sessions.filter((s) => s.group === src.group && s.id !== sourceId).map((s) => s.id);
}

/* ── persistence (§1.7) — "session, not process" ───────────────────────────── */

/** One persisted session record (workspace `.prometheus/state/terminals.json`). */
export interface TerminalSnapshot {
  profileId: string;
  title: string;
  cwd?: string;
  /** the tail of scrollback, replayed READ-ONLY above a fresh prompt on restore. */
  scrollbackTail: string;
  group: SessionGroup;
  openAs: OpenTarget;
}

/** Snapshot only the `persist:true` sessions (§1.7). `tailFor` returns scrollback per id. */
export function snapshotSessions(
  state: LauncherState,
  tailFor: (id: string) => string,
): TerminalSnapshot[] {
  return state.sessions
    .filter((s) => s.persist)
    .map((s) => ({
      profileId: s.profileId,
      title: s.title,
      ...(s.cwd ? { cwd: s.cwd } : {}),
      scrollbackTail: tailFor(s.id),
      group: s.group,
      openAs: s.openAs,
    }));
}

/** The honest "restored" label prepended above a re-spawned session's prompt (§1.7). */
export const SESSION_RESTORED_BANNER = "── session restored ──";

/**
 * Rebuild sessions from snapshots on relaunch (§1.7). Each becomes an `idle`, `restored`
 * session with a fresh id (from `mkId`); the live process is NOT restored (honestly
 * labeled). The caller re-spawns from `profileId` and replays `scrollbackTail` read-only.
 */
export function restoreSessions(
  snapshots: readonly TerminalSnapshot[],
  mkId: (snapshot: TerminalSnapshot, index: number) => string,
): TerminalSession[] {
  return snapshots.map((snap, i) => ({
    id: mkId(snap, i),
    profileId: snap.profileId,
    title: snap.title,
    status: "idle" as const,
    openAs: snap.openAs,
    group: snap.group,
    ...(snap.cwd ? { cwd: snap.cwd } : {}),
    restored: true,
    persist: true,
  }));
}
