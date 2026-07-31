/**
 * ide/state/terminal-session.ts — the PURE multi-session terminal reducer (file 07 §6.1).
 *
 * The integrated terminal is now multi-session (tabs): this owns the session LIST + the
 * active id, as a pure, deterministic reducer (no react/xterm/DOM) so the tab logic —
 * add / close-with-neighbor-activation / rename / activate — is node:test-able. Each
 * session id maps 1:1 to a mounted <Terminal> (its own pty); TerminalPanel renders them.
 */

/** One terminal tab. */
export interface TerminalSession {
  id: string;
  title: string;
  /** the cwd the pty spawns in (the workspace root, captured at creation). */
  cwd: string;
  /** an optional command auto-run after the shell starts — how an AI CLI (claude /
   *  codex / gemini / prom) is launched into a fresh terminal tab. */
  launch?: string;
  /** when true, `launch` is TYPED into the shell but NOT executed (no trailing enter)
   *  — the user reviews it and presses enter. Used for install commands. */
  prime?: boolean;
  /** a profile-resolved venv to activate (APP-048); undefined = inherit the workspace venv. */
  venv?: { root: string; platform?: "win32" | "posix" } | null;
  /** a profile-resolved shell path (APP-048); undefined = the OS default shell. */
  shell?: string;
}

/** The tab strip state: the ordered sessions + which one is shown. */
export interface TerminalSessionState {
  sessions: TerminalSession[];
  activeId: string | null;
}

/** The empty initial state (no sessions until the first is opened). */
export function initialTerminalState(): TerminalSessionState {
  return { sessions: [], activeId: null };
}

/** Append a session and make it active. */
export function addSession(
  state: TerminalSessionState,
  session: TerminalSession,
): TerminalSessionState {
  // ignore a duplicate id (idempotent — never two tabs for one pty).
  if (state.sessions.some((s) => s.id === session.id)) return state;
  return { sessions: [...state.sessions, session], activeId: session.id };
}

/**
 * Close a session. If it was active, activate its NEIGHBOR (the next tab, else the
 * previous) so focus never lands on nothing while tabs remain; null when none remain.
 */
export function closeSession(state: TerminalSessionState, id: string): TerminalSessionState {
  const idx = state.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return state;
  const sessions = state.sessions.filter((s) => s.id !== id);
  let activeId = state.activeId;
  if (state.activeId === id) {
    const neighbor = sessions[idx] ?? sessions[idx - 1]; // next, else previous
    activeId = neighbor?.id ?? null;
  }
  return { sessions, activeId };
}

/** Activate a session (no-op for an unknown id). */
export function activateSession(state: TerminalSessionState, id: string): TerminalSessionState {
  if (!state.sessions.some((s) => s.id === id) || state.activeId === id) return state;
  return { ...state, activeId: id };
}

/** Rename a session's tab title (ignores blank titles + unknown ids). */
export function renameSession(
  state: TerminalSessionState,
  id: string,
  title: string,
): TerminalSessionState {
  const trimmed = title.trim();
  if (!trimmed) return state;
  if (!state.sessions.some((s) => s.id === id)) return state; // unknown id → no change
  return {
    ...state,
    sessions: state.sessions.map((s) => (s.id === id ? { ...s, title: trimmed } : s)),
  };
}

/** A default tab title for the Nth session (1-based). */
export function defaultTitle(n: number): string {
  return `Terminal ${n}`;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Split panes (APP-049) — a FLAT list of panes in one direction, each pane being
 * an independent {sessions, activeId} sub-state driven by the reducer above (so a
 * one-pane layout behaves byte-identically to the flat reducer). Pure — no DOM.
 * ────────────────────────────────────────────────────────────────────────── */

export type SplitDirection = "row" | "column";

/** One terminal pane: its own tab strip state. */
export interface TerminalPane {
  id: string;
  sessions: TerminalSession[];
  activeId: string | null;
}

/** The full split layout: panes laid out in `direction`, one focused. */
export interface TerminalLayout {
  panes: TerminalPane[];
  focusedPaneId: string;
  direction: SplitDirection;
  /** per-pane sizes (px for the leading panes; the last flexes). Optional. */
  sizes?: number[];
}

/** A layout with ONE empty pane (the initial state). */
export function initialLayout(paneId: string): TerminalLayout {
  return {
    panes: [{ id: paneId, sessions: [], activeId: null }],
    focusedPaneId: paneId,
    direction: "row",
  };
}

/** The focused pane (never null once created). */
export function focusedPane(layout: TerminalLayout): TerminalPane | undefined {
  return layout.panes.find((p) => p.id === layout.focusedPaneId);
}

/** Focus a pane (no-op for an unknown id). */
export function focusPane(layout: TerminalLayout, paneId: string): TerminalLayout {
  if (paneId === layout.focusedPaneId || !layout.panes.some((p) => p.id === paneId)) return layout;
  return { ...layout, focusedPaneId: paneId };
}

/** Add a NEW empty pane after the focused one, set the split direction, focus it. */
export function splitPane(
  layout: TerminalLayout,
  newPaneId: string,
  direction: SplitDirection,
): TerminalLayout {
  const idx = layout.panes.findIndex((p) => p.id === layout.focusedPaneId);
  const at = idx === -1 ? layout.panes.length : idx + 1;
  const pane: TerminalPane = { id: newPaneId, sessions: [], activeId: null };
  const panes = [...layout.panes.slice(0, at), pane, ...layout.panes.slice(at)];
  return { panes, focusedPaneId: newPaneId, direction };
}

/**
 * Close a pane (its sessions are dropped → TerminalPanel unmounts them → PTYs die).
 * The LAST pane never closes. If the focused pane closed, focus a neighbor.
 */
export function closePane(layout: TerminalLayout, paneId: string): TerminalLayout {
  if (layout.panes.length <= 1) return layout; // last pane never closes
  const idx = layout.panes.findIndex((p) => p.id === paneId);
  if (idx === -1) return layout;
  const panes = layout.panes.filter((p) => p.id !== paneId);
  let focusedPaneId = layout.focusedPaneId;
  if (layout.focusedPaneId === paneId) {
    const neighbor = panes[idx] ?? panes[idx - 1];
    focusedPaneId = neighbor?.id ?? panes[0]!.id;
  }
  const next: TerminalLayout = { ...layout, panes, focusedPaneId };
  if (layout.sizes) next.sizes = layout.sizes.filter((_, i) => i !== idx);
  return next;
}

/** Apply a flat-reducer op to ONE pane (reuses add/close/activate/rename semantics). */
function mapPane(
  layout: TerminalLayout,
  paneId: string,
  fn: (state: TerminalSessionState) => TerminalSessionState,
): TerminalLayout {
  let changed = false;
  const panes = layout.panes.map((p) => {
    if (p.id !== paneId) return p;
    const next = fn({ sessions: p.sessions, activeId: p.activeId });
    if (next.sessions === p.sessions && next.activeId === p.activeId) return p;
    changed = true;
    return { ...p, sessions: next.sessions, activeId: next.activeId };
  });
  return changed ? { ...layout, panes } : layout;
}

/** Add a session to a pane (and make it active). */
export function paneAddSession(
  layout: TerminalLayout,
  paneId: string,
  session: TerminalSession,
): TerminalLayout {
  return mapPane(layout, paneId, (s) => addSession(s, session));
}

/**
 * Close a session in a pane. If it was the pane's LAST tab AND the layout has more than
 * one pane, the pane itself closes (the caller's unmount kills the PTY). The last pane
 * with its last tab stays (neighbor-activation → activeId null; the "+ to open" state).
 */
export function paneCloseSession(
  layout: TerminalLayout,
  paneId: string,
  sessionId: string,
): TerminalLayout {
  const pane = layout.panes.find((p) => p.id === paneId);
  if (!pane) return layout;
  const willBeEmpty = pane.sessions.length === 1 && pane.sessions[0]?.id === sessionId;
  if (willBeEmpty && layout.panes.length > 1) return closePane(layout, paneId);
  return mapPane(layout, paneId, (s) => closeSession(s, sessionId));
}

export function paneActivateSession(
  layout: TerminalLayout,
  paneId: string,
  sessionId: string,
): TerminalLayout {
  return mapPane(layout, paneId, (s) => activateSession(s, sessionId));
}

export function paneRenameSession(
  layout: TerminalLayout,
  paneId: string,
  sessionId: string,
  title: string,
): TerminalLayout {
  return mapPane(layout, paneId, (s) => renameSession(s, sessionId, title));
}

/** Set the per-pane sizes (from a divider drag). */
export function setPaneSizes(layout: TerminalLayout, sizes: number[]): TerminalLayout {
  return { ...layout, sizes };
}

/* ── persistence (descriptors ONLY — titles/cwd/direction/sizes; fresh shells) ── */

export const TERMINAL_LAYOUT_VERSION = 1;

interface PersistedSession {
  title: string;
  cwd: string;
}
interface PersistedPane {
  activeIndex: number;
  sessions: PersistedSession[];
}
export interface PersistedLayout {
  version: number;
  direction: SplitDirection;
  sizes?: number[];
  focusedIndex: number;
  panes: PersistedPane[];
}

/** Serialize a layout to persistable DESCRIPTORS (no pty ids, no launch/secrets). */
export function serializeLayout(layout: TerminalLayout): PersistedLayout {
  const focusedIndex = Math.max(
    0,
    layout.panes.findIndex((p) => p.id === layout.focusedPaneId),
  );
  const out: PersistedLayout = {
    version: TERMINAL_LAYOUT_VERSION,
    direction: layout.direction,
    focusedIndex,
    panes: layout.panes.map((p) => ({
      activeIndex: Math.max(
        0,
        p.sessions.findIndex((s) => s.id === p.activeId),
      ),
      // titles + cwd ONLY — never launch strings (secrets) or pty ids.
      sessions: p.sessions.map((s) => ({ title: s.title, cwd: s.cwd })),
    })),
  };
  if (layout.sizes) out.sizes = layout.sizes;
  return out;
}

/**
 * Restore a layout from descriptors with FRESH session ids (new shells; dead PTYs are
 * never resurrected). Fail-soft: bad JSON / wrong version / empty → a single fresh pane.
 * `mintId` supplies unique ids; `fallbackCwd` seeds an empty restore.
 */
export function deserializeLayout(
  raw: unknown,
  mintId: () => string,
  fallbackCwd: string,
): TerminalLayout {
  const single = (): TerminalLayout => initialLayout(mintId());
  let data: PersistedLayout;
  try {
    data = (typeof raw === "string" ? JSON.parse(raw) : raw) as PersistedLayout;
  } catch {
    return single();
  }
  if (
    !data ||
    data.version !== TERMINAL_LAYOUT_VERSION ||
    !Array.isArray(data.panes) ||
    !data.panes.length
  ) {
    return single();
  }
  const panes: TerminalPane[] = data.panes.map((pp) => {
    const sessions: TerminalSession[] = (Array.isArray(pp.sessions) ? pp.sessions : []).map(
      (ps) => ({
        id: mintId(),
        title: typeof ps.title === "string" && ps.title ? ps.title : "Terminal",
        cwd: typeof ps.cwd === "string" && ps.cwd ? ps.cwd : fallbackCwd,
      }),
    );
    const activeIndex = Math.min(
      Math.max(0, pp.activeIndex ?? 0),
      Math.max(0, sessions.length - 1),
    );
    return { id: mintId(), sessions, activeId: sessions[activeIndex]?.id ?? null };
  });
  const focusedIndex = Math.min(Math.max(0, data.focusedIndex ?? 0), panes.length - 1);
  const layout: TerminalLayout = {
    panes,
    focusedPaneId: panes[focusedIndex]!.id,
    direction: data.direction === "column" ? "column" : "row",
  };
  if (Array.isArray(data.sizes)) layout.sizes = data.sizes;
  return layout;
}
