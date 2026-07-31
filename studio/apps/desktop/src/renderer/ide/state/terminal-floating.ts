/**
 * ide/state/terminal-floating.ts — the PURE tear-out (dock/undock) reducer (APP-090).
 *
 * A terminal session can be TORN OUT into a secondary window (FloatingTerminalWindow). While
 * torn out, the main window HIDES that session's tab — but the <Terminal> stays mounted and
 * its PTY keeps streaming (the PTY outlives the window; tear-out/re-dock NEVER kill it). This
 * owns only the view-state: which session ids are currently floating, plus helpers to filter
 * the visible tab strip and pick a fallback active tab. No react/DOM/IPC — node:test-able.
 */

/** The set of session ids currently torn out into a float (ordered, deduped). */
export interface FloatingState {
  tornOut: string[];
}

export function initialFloatingState(): FloatingState {
  return { tornOut: [] };
}

/** Mark a session torn out (idempotent — a session is never floated twice). */
export function tearOut(state: FloatingState, id: string): FloatingState {
  if (!id || state.tornOut.includes(id)) return state;
  return { tornOut: [...state.tornOut, id] };
}

/** Re-dock a session (remove it from the torn-out set; no-op for an unknown id). */
export function redock(state: FloatingState, id: string): FloatingState {
  if (!state.tornOut.includes(id)) return state;
  return { tornOut: state.tornOut.filter((t) => t !== id) };
}

/** True when a session is currently torn out. */
export function isTornOut(state: FloatingState, id: string): boolean {
  return state.tornOut.includes(id);
}

/** The sessions still shown in the main-window tab strip (torn-out ones hidden). */
export function visibleSessions<T extends { id: string }>(
  sessions: readonly T[],
  state: FloatingState,
): T[] {
  return sessions.filter((s) => !state.tornOut.includes(s.id));
}

/**
 * Pick the active tab AFTER a state change: keep `activeId` if it is still visible; else
 * fall back to the first visible session (or null when every session is torn out). Keeps the
 * main window from "showing" a torn-out (hidden) session when its tab was the active one.
 */
export function pickActive(
  sessions: readonly { id: string }[],
  activeId: string | null,
  state: FloatingState,
): string | null {
  const visible = visibleSessions(sessions, state);
  if (activeId && visible.some((s) => s.id === activeId)) return activeId;
  return visible[0]?.id ?? null;
}
