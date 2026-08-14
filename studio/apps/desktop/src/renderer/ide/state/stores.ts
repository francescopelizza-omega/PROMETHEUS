/**
 * ide/state/stores.ts — the IDE renderer Zustand stores (file 07 §3.1/§11).
 *
 * One slice per IDE concern (the brief: tabs / diagnostics / git / ai-session). Each
 * store holds ONLY UI/SESSION state and delegates every transition to the PURE
 * reducers in this folder (tabs-reducer / diagnostics / diff-review-state) — the
 * stores are thin so the logic stays node:test-able without zustand or a DOM. The
 * data FETCHING crosses the contextBridge (window.prometheus.ide.*); these slices
 * never reach the engine directly (C5).
 *
 * Imports: zustand + the PURE local reducers + PLAIN-DATA contract types only. NO
 * monaco / electron / engine-bridge / node:* (renderer sandbox, C5).
 */

import { type Checkpoint, CheckpointStore } from "@prometheus/core/agent-checkpoint";
import { create } from "zustand";

import { isSafeSessionId } from "../ai/session-map.js";

import type { IdeActiveVenv, IdeGitStatus } from "../../../shared/ipc-contract.js";
import type { Diagnostic, DiagnosticsByUri } from "./diagnostics.js";
import { clearDiagnostics, setDiagnostics } from "./diagnostics.js";
import type { DiffSelection, ReviewChangeSet } from "./diff-review-state.js";
import { initialSelection, toggleHunk } from "./diff-review-state.js";
import {
  AI_VERSION,
  DIRTY_KEY,
  DIRTY_VERSION,
  type DirtyRecord,
  TABS_KEY,
  TABS_VERSION,
  defaultStorage,
  dirtyMigrations,
  loadVersioned,
  migrateAiBlob,
  removeDirty,
  saveVersioned,
  serializeTabs,
  tabsMigrations,
  upsertDirty,
  validatePersistedDirty,
  validatePersistedTabs,
} from "./session-restore.js";
import type { OpenOpts, TabsState } from "./tabs-reducer.js";
import {
  activateTab,
  closeTab,
  initialTabsState,
  openTab,
  setDirty,
  splitActive,
} from "./tabs-reducer.js";

/* ── tabs slice (file 07 §3.1) ───────────────────────────────────────────────*/

export interface TabsStore {
  tabs: TabsState;
  /** the workspace root the editor is bound to (file 07 §5.2 gate scope). */
  workspaceRoot: string | null;
  setWorkspaceRoot(root: string | null): void;
  open(uri: string, opts: OpenOpts): void;
  close(uri: string): void;
  activate(uri: string): void;
  markDirty(uri: string, dirty: boolean): void;
  /** split the focused group; returns the new group id for the caller to mount. */
  split(): number;
}

/**
 * APP-067: restore the persisted tabs blob at store creation (migrated + validated), so a
 * crash/restart reopens the same tabs BEFORE first render. Fail-soft → a fresh empty state.
 */
function restoreTabs(): { tabs: TabsState; workspaceRoot: string | null } {
  const r = loadVersioned(
    defaultStorage(),
    TABS_KEY,
    TABS_VERSION,
    tabsMigrations,
    validatePersistedTabs,
  );
  if (r.state) return { tabs: r.state.tabs, workspaceRoot: r.state.workspaceRoot };
  return { tabs: initialTabsState(), workspaceRoot: null };
}
const restoredTabs = restoreTabs();

export const useTabsStore = create<TabsStore>((set, get) => ({
  tabs: restoredTabs.tabs,
  workspaceRoot: restoredTabs.workspaceRoot,
  setWorkspaceRoot: (root): void => set({ workspaceRoot: root }),
  open: (uri, opts): void => set((s) => ({ tabs: openTab(s.tabs, uri, opts) })),
  close: (uri): void => set((s) => ({ tabs: closeTab(s.tabs, uri) })),
  activate: (uri): void => set((s) => ({ tabs: activateTab(s.tabs, uri) })),
  markDirty: (uri, dirty): void => set((s) => ({ tabs: setDirty(s.tabs, uri, dirty) })),
  split: (): number => {
    const { state, group } = splitActive(get().tabs);
    set({ tabs: state });
    return group;
  },
}));

/**
 * A trailing debounce that persists on every mutation (NOT beforeunload — Electron does not
 * guarantee unload on a hard crash / SIGKILL), so state is already on disk before a crash.
 */
function debouncePersist(fn: () => void, ms = 400): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

// persist tabs (+ active/focused group + workspace root) on every change, debounced (APP-067).
const persistTabs = debouncePersist(() => {
  const s = useTabsStore.getState();
  saveVersioned(defaultStorage(), TABS_KEY, serializeTabs(s.tabs, s.workspaceRoot));
});
useTabsStore.subscribe(persistTabs);

/* ── dirty-buffer recovery (#APP-067) — unsaved content survives a crash ─────────
 * The Monaco per-tab BUFFER text lives in the editor, not this store; EditorPane pushes it
 * here on edit (`record`) and drops it on save (`clear`). Byte-capped + oldest-evicted so a
 * single huge unsaved file can't blow the ~5MB quota and lose ALL recovery. */

export interface DirtyRecoveryStore {
  /** uri → recovered unsaved text (byte-capped; newest kept). */
  buffers: DirtyRecord[];
  /** capture one buffer's current unsaved text (called debounced from the editor). */
  record(uri: string, text: string): void;
  /** drop a buffer's recovery copy — called on a successful save. */
  clear(uri: string): void;
  /** the recovered text for a uri, or undefined (consumed once on restore). */
  recovered(uri: string): string | undefined;
}

function restoreDirty(): DirtyRecord[] {
  const r = loadVersioned(
    defaultStorage(),
    DIRTY_KEY,
    DIRTY_VERSION,
    dirtyMigrations,
    validatePersistedDirty,
  );
  return r.state?.buffers ?? [];
}

export const useDirtyRecoveryStore = create<DirtyRecoveryStore>((set, get) => ({
  buffers: restoreDirty(),
  record: (uri, text): void =>
    set((s) => ({ buffers: upsertDirty(s.buffers, uri, text, dirtyClock()) })),
  clear: (uri): void => set((s) => ({ buffers: removeDirty(s.buffers, uri) })),
  recovered: (uri): string | undefined => get().buffers.find((b) => b.uri === uri)?.text,
}));

// monotonic recency clock for eviction (renderer — Date.now is fine).
let dirtySeq = 0;
function dirtyClock(): number {
  dirtySeq += 1;
  return Date.now() * 1000 + (dirtySeq % 1000);
}

const persistDirty = debouncePersist(() => {
  saveVersioned(defaultStorage(), DIRTY_KEY, {
    version: DIRTY_VERSION,
    buffers: useDirtyRecoveryStore.getState().buffers,
  });
});
useDirtyRecoveryStore.subscribe(persistDirty);

/* ── diagnostics slice (file 07 §3.3/§11) ────────────────────────────────────*/

export interface DiagnosticsStore {
  byUri: DiagnosticsByUri;
  /** replace one uri's diagnostics (LSP publishDiagnostics is authoritative per-uri). */
  publish(uri: string, diagnostics: Diagnostic[]): void;
  clear(uri: string): void;
  reset(): void;
}

export const useDiagnosticsStore = create<DiagnosticsStore>((set) => ({
  byUri: {},
  publish: (uri, diagnostics): void =>
    set((s) => ({ byUri: setDiagnostics(s.byUri, uri, diagnostics) })),
  clear: (uri): void => set((s) => ({ byUri: clearDiagnostics(s.byUri, uri) })),
  reset: (): void => set({ byUri: {} }),
}));

/* ── git slice (file 07 §6.2) ────────────────────────────────────────────────*/

export interface GitStore {
  status: IdeGitStatus | null;
  /** the file whose diff is open in the Monaco diff editor. */
  selectedFile: string | null;
  /** whether the open diff is the STAGED view (else working tree). */
  diffStaged: boolean;
  /** the active venv the terminal/LSP inherit (resolved by MAIN, §6.1). */
  venv: IdeActiveVenv | null;
  setStatus(status: IdeGitStatus | null): void;
  selectFile(file: string | null, staged?: boolean): void;
  setVenv(venv: IdeActiveVenv | null): void;
}

export const useGitStore = create<GitStore>((set) => ({
  status: null,
  selectedFile: null,
  diffStaged: false,
  venv: null,
  setStatus: (status): void => set({ status }),
  selectFile: (file, staged = false): void => set({ selectedFile: file, diffStaged: staged }),
  setVenv: (venv): void => set({ venv }),
}));

/* ── ai-session slice (file 07 §7.2/§7.4) — NOW MULTI-TAB ─────────────────────
 * The agent pane holds MANY independent chat SESSIONS (tabs). Each session owns its
 * own transcript, streaming buffer, task cards, ChangeSet + busy flag, so a run in
 * one tab is fully independent of another (a background tab keeps streaming into its
 * own session while the user works in a different tab). The model pick + privacy
 * policies stay GLOBAL (one selector drives every tab). Per-session mutators are
 * id-addressed because a run may finish after the user has switched tabs. */

/** A chat turn in the agent pane. */
export interface AiTurn {
  role: "user" | "assistant";
  content: string;
  /** APP-051: the pre-turn workspace checkpoint id (user turns only) → per-turn revert. */
  checkpointId?: string;
}

/** A pending agent run_command task card (§7.3 — confirm-gated). */
export interface AiTaskCard {
  id: string;
  command: string;
  cwd: string;
  status: "pending" | "running" | "done" | "denied";
  output: string;
  exitCode?: number;
  /**
   * Phase 6: which of core's system tools this card approves, and its arguments.
   *
   * Absent means `run_command` — every card was one before the shared tool set landed, and
   * defaulting keeps older persisted sessions rendering.
   */
  tool?: string;
  args?: Record<string, unknown>;
  /**
   * What this card ASKS. A `question` card carries a prompt and takes free text instead of a
   * Run/Deny pair — `command` holds the prompt so older persisted sessions still render it as
   * text rather than as an empty panel.
   */
  kind?: "command" | "question";
}

/** One independent chat tab. */
export interface AiSession {
  id: string;
  title: string;
  turns: AiTurn[];
  /** the assistant text currently streaming for THIS session (token-by-token, §11). */
  streaming: string;
  /**
   * The model's THINKING for the turn in flight, plus the wrapper's latest status line.
   *
   * Deliberately EPHEMERAL — never appended to `turns`, never persisted, cleared when the
   * turn settles. Reasoning tokens are the model's scratch work, not its answer; folding
   * them into the transcript would make a reload replay a chain of thought as if the agent
   * had said it, and would feed it back to the model as prior context on the next turn.
   */
  thinking: string;
  /** the wrapper's latest status line (watchdog heartbeat, round counter); ephemeral. */
  status: string;
  /** the confirm-gated task cards (§7.3) for this session. */
  taskCards: AiTaskCard[];
  /** the pending ChangeSet under review (§7.4) for this session, or null. */
  changeSet: ReviewChangeSet | null;
  /** the accepted-hunk selection for this session's open ChangeSet. */
  selection: DiffSelection;
  /** is a run in flight for this session? (per-tab, so the tab shows a spinner). */
  busy: boolean;
}

export interface AiSessionStore {
  /** the selected Model Hub endpoint id (the right-pane picker, §7.5) — GLOBAL. */
  endpointId: string | null;
  /** the per-workspace "never send to cloud" policy toggle (§7.5) — GLOBAL. */
  neverSendToCloud: boolean;
  /** opt-in AI ghost-text inline completions (#4) — OFF by default — GLOBAL. */
  ghostText: boolean;
  /** every chat tab, keyed by id. */
  sessions: Record<string, AiSession>;
  /** tab order (left→right). */
  order: string[];
  /** the active (visible) tab id. */
  activeId: string;

  selectEndpoint(id: string | null): void;
  setNeverSendToCloud(v: boolean): void;
  setGhostText(v: boolean): void;

  /** open a fresh tab and make it active; returns its id. */
  newSession(): string;
  /**
   * APP-052: open (or overwrite) a tab with a restored transcript — for resume/fork. If
   * `id` matches an existing tab it is overwritten (preserving nothing else); else a new
   * tab is created. Always selected + made active. Returns the tab id.
   */
  openSessionTab(opts: { id?: string; title: string; turns: AiTurn[] }): string;
  /** close a tab (never leaves zero tabs — recreates a blank one if needed). */
  closeSession(id: string): void;
  /** make a tab active. */
  selectSession(id: string): void;
  /** rename a tab. */
  renameSession(id: string, title: string): void;

  // per-session chat mutators (id-addressed).
  pushTurn(id: string, turn: AiTurn): void;
  /**
   * Replace a session's whole transcript.
   *
   * Used by auto-compaction, which folds the older turns into one summary. Deliberately a
   * WHOLESALE replace rather than a splice: compaction rewrites the head and keeps the tail, and
   * expressing that as a mutation would need the caller to know the store's internals.
   */
  replaceTurns(id: string, turns: AiTurn[]): void;
  appendStreaming(id: string, delta: string): void;
  commitStreaming(id: string): void;
  /** append a THINKING delta (ephemeral — see AiSession.thinking). */
  appendThinking(id: string, delta: string): void;
  /** replace the wrapper status line (ephemeral). */
  setStatus(id: string, text: string): void;
  /** drop the ephemeral thinking + status (the turn settled). */
  clearEphemeral(id: string): void;
  setBusy(id: string, busy: boolean): void;
  /** clear ONE session's transcript + in-flight streaming (per-tab "clear"). */
  clearTurns(id: string): void;
  addTaskCard(id: string, card: AiTaskCard): void;
  updateTaskCard(id: string, cardId: string, patch: Partial<AiTaskCard>): void;

  // ── APP-051: per-turn workspace checkpoints (in-memory; NOT persisted) ──────
  /** Record a pre-turn checkpoint for a session (bounded — oldest evicted). */
  takeCheckpoint(id: string, checkpoint: Checkpoint): void;
  /** Look up a recorded checkpoint (undefined if evicted / never taken). */
  getCheckpoint(id: string, checkpointId: string): Checkpoint | undefined;
  /**
   * TRANSCRIPT half of a revert: keep the first `keepCount` turns, drop the rest (the
   * reverted turn onward). The caller applies the fs restorePlan FIRST (revert ordering).
   */
  revertToTurn(id: string, keepCount: number): void;

  // synchronous review actions (toggleHunk) act on the ACTIVE session — DiffReview
  // only renders the active tab. Every action that can resolve AFTER a tab switch
  // (proposeChangeSet from a background agent, clearChangeSet/setSelection from an
  // async Apply continuation) takes the OWNING session id so it never patches
  // whichever tab happens to be active at resolution time.
  proposeChangeSet(cs: ReviewChangeSet, sessionId?: string): void;
  toggleHunk(uri: string, hunkId: string): void;
  clearChangeSet(sessionId?: string): void;
  setSelection(selection: DiffSelection, sessionId?: string): void;
}

/* ── ai-session persistence (#12): every tab + endpoint/policy survive a reload ──── */
const AI_SESSION_KEY = "prometheus.aiSession";

/**
 * APP-051: per-session checkpoint stores — held in a MODULE-LEVEL map, NOT in the zustand
 * state, so the (potentially large) snapshot bytes are NEVER serialized into the persisted
 * localStorage blob (which would blow the ~5MB quota and drop all persisted tabs). Bounded
 * at CHECKPOINT_CAP turns per session; the CheckpointStore evicts the oldest on overflow,
 * dropping its byte buffers so memory stays bounded across a long session.
 */
const CHECKPOINT_CAP = 20;
const checkpointStores = new Map<string, CheckpointStore>();
function checkpointStoreFor(sessionId: string): CheckpointStore {
  let store = checkpointStores.get(sessionId);
  if (!store) {
    store = new CheckpointStore(CHECKPOINT_CAP);
    checkpointStores.set(sessionId, store);
  }
  return store;
}

let sessionSeq = 0;
/** A collision-resistant session id (renderer — Date.now/Math.random are fine here). */
function makeSessionId(): string {
  sessionSeq += 1;
  return `s-${Date.now().toString(36)}-${sessionSeq}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A blank session with the given (or a numbered default) title. */
function emptySession(title: string): AiSession {
  return {
    id: makeSessionId(),
    title,
    turns: [],
    streaming: "",
    thinking: "",
    status: "",
    taskCards: [],
    changeSet: null,
    selection: {},
    busy: false,
  };
}

function validTurns(v: unknown): AiTurn[] {
  return Array.isArray(v)
    ? (v.filter(
        (t) =>
          t &&
          typeof t === "object" &&
          ((t as AiTurn).role === "user" || (t as AiTurn).role === "assistant") &&
          typeof (t as AiTurn).content === "string",
      ) as AiTurn[])
    : [];
}

interface LoadedAiState {
  endpointId: string | null;
  neverSendToCloud: boolean;
  ghostText: boolean;
  sessions: Record<string, AiSession>;
  order: string[];
  activeId: string;
}

/** Load the persisted ai state (validated; fail-soft). Migrates the OLD single-session
 *  blob ({turns,…}) into one tab so an upgrade never loses the last transcript. */
function loadAiSession(): LoadedAiState {
  const fresh = (): LoadedAiState => {
    const s = emptySession("Chat 1");
    return {
      endpointId: null,
      neverSendToCloud: false,
      ghostText: false,
      sessions: { [s.id]: s },
      order: [s.id],
      activeId: s.id,
    };
  };
  if (typeof window === "undefined") return fresh();
  try {
    const raw = window.localStorage.getItem(AI_SESSION_KEY);
    if (!raw) return fresh();
    // APP-067: fold the legacy single→multi migration through core's versioned runner, so
    // the ad-hoc upgrade rides the same idempotent + fail-soft chain as the other blobs.
    const o = migrateAiBlob(JSON.parse(raw) as Record<string, unknown>) as Record<string, unknown>;
    const endpointId = typeof o.endpointId === "string" ? o.endpointId : null;
    const neverSendToCloud = typeof o.neverSendToCloud === "boolean" ? o.neverSendToCloud : false;
    const ghostText = typeof o.ghostText === "boolean" ? o.ghostText : false;

    // New multi-tab shape?
    if (Array.isArray(o.order) && o.sessions && typeof o.sessions === "object") {
      const rawSessions = o.sessions as Record<string, unknown>;
      const sessions: Record<string, AiSession> = {};
      for (const id of o.order as unknown[]) {
        if (typeof id !== "string") continue;
        const rs = rawSessions[id] as Record<string, unknown> | undefined;
        if (!rs) continue;
        sessions[id] = {
          id,
          title: typeof rs.title === "string" ? rs.title : "Chat",
          turns: validTurns(rs.turns),
          streaming: "",
          thinking: "",
          status: "",
          taskCards: Array.isArray(rs.taskCards) ? (rs.taskCards as AiTaskCard[]) : [],
          changeSet: null,
          selection: {},
          busy: false,
        };
      }
      const order = (o.order as unknown[]).filter(
        (id): id is string => typeof id === "string" && id in sessions,
      );
      const first = order[0];
      if (first) {
        const activeId =
          typeof o.activeId === "string" && o.activeId in sessions ? o.activeId : first;
        return { endpointId, neverSendToCloud, ghostText, sessions, order, activeId };
      }
    }

    // OLD single-session blob → migrate its transcript into one tab.
    const turns = validTurns(o.turns);
    const s = emptySession("Chat 1");
    s.turns = turns;
    return {
      endpointId,
      neverSendToCloud,
      ghostText,
      sessions: { [s.id]: s },
      order: [s.id],
      activeId: s.id,
    };
  } catch {
    return fresh();
  }
}

/** Derive a tab title from the first user prompt (kept short). */
function titleFromPrompt(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 24 ? `${t.slice(0, 24)}…` : t || "Chat";
}

/** Immutably patch one session; a no-op if the id is unknown (a closed tab's
 *  late-arriving stream just lands nowhere instead of throwing). */
function patchSession(
  s: AiSessionStore,
  id: string,
  fn: (session: AiSession) => AiSession,
): Partial<AiSessionStore> {
  const cur = s.sessions[id];
  if (!cur) return {};
  return { sessions: { ...s.sessions, [id]: fn(cur) } };
}

export const useAiSessionStore = create<AiSessionStore>((set) => ({
  ...loadAiSession(),

  selectEndpoint: (id): void => set({ endpointId: id }),
  setNeverSendToCloud: (v): void => set({ neverSendToCloud: v }),
  setGhostText: (v): void => set({ ghostText: v }),

  newSession: (): string => {
    const s = emptySession("Chat");
    set((st) => {
      // number the new tab after the highest existing "Chat N".
      const n = st.order.length + 1;
      s.title = `Chat ${n}`;
      return {
        sessions: { ...st.sessions, [s.id]: s },
        order: [...st.order, s.id],
        activeId: s.id,
      };
    });
    return s.id;
  },

  openSessionTab: ({ id, title, turns }): string => {
    const sid = id && isSafeSessionId(id) ? id : makeSessionId();
    set((st) => {
      const base = st.sessions[sid];
      const session: AiSession = base
        ? { ...base, title, turns, streaming: "", thinking: "", status: "", busy: false }
        : {
            id: sid,
            title,
            turns,
            streaming: "",
            thinking: "",
            status: "",
            taskCards: [],
            changeSet: null,
            selection: {},
            busy: false,
          };
      const order = st.order.includes(sid) ? st.order : [...st.order, sid];
      return { sessions: { ...st.sessions, [sid]: session }, order, activeId: sid };
    });
    return sid;
  },

  closeSession: (id): void =>
    set((st) => {
      if (!(id in st.sessions)) return {};
      const nextSessions = { ...st.sessions };
      delete nextSessions[id];
      let order = st.order.filter((x) => x !== id);
      // never leave zero tabs.
      if (order.length === 0) {
        const blank = emptySession("Chat 1");
        nextSessions[blank.id] = blank;
        order = [blank.id];
        return { sessions: nextSessions, order, activeId: blank.id };
      }
      // if the active tab closed, activate the nearest neighbour (order is non-empty here).
      let activeId = st.activeId;
      if (activeId === id) {
        const idx = st.order.indexOf(id);
        activeId = order[Math.max(0, idx - 1)] ?? order[0] ?? activeId;
      }
      return { sessions: nextSessions, order, activeId };
    }),

  selectSession: (id): void => set((st) => (id in st.sessions ? { activeId: id } : {})),
  renameSession: (id, title): void =>
    set((st) => patchSession(st, id, (s) => ({ ...s, title: title || s.title }))),

  pushTurn: (id, turn): void =>
    set((st) =>
      patchSession(st, id, (s) => {
        // auto-title a still-default tab from its first user prompt.
        const retitle =
          turn.role === "user" && s.turns.length === 0 && /^Chat(\s\d+)?$/.test(s.title)
            ? titleFromPrompt(turn.content)
            : s.title;
        return { ...s, title: retitle, turns: [...s.turns, turn] };
      }),
    ),
  replaceTurns: (id, turns): void =>
    set((st) => patchSession(st, id, (s) => ({ ...s, turns: [...turns] }))),
  appendStreaming: (id, delta): void =>
    set((st) => patchSession(st, id, (s) => ({ ...s, streaming: s.streaming + delta }))),
  appendThinking: (id, delta): void =>
    set((st) => patchSession(st, id, (s) => ({ ...s, thinking: s.thinking + delta }))),
  setStatus: (id, text): void => set((st) => patchSession(st, id, (s) => ({ ...s, status: text }))),
  clearEphemeral: (id): void =>
    set((st) => patchSession(st, id, (s) => ({ ...s, thinking: "", status: "" }))),
  commitStreaming: (id): void =>
    set((st) =>
      patchSession(st, id, (s) =>
        s.streaming === ""
          ? s
          : {
              ...s,
              turns: [...s.turns, { role: "assistant", content: s.streaming }],
              streaming: "",
              thinking: "",
              status: "",
            },
      ),
    ),
  setBusy: (id, busy): void => set((st) => patchSession(st, id, (s) => ({ ...s, busy }))),
  clearTurns: (id): void =>
    set((st) =>
      patchSession(st, id, (s) => ({
        ...s,
        turns: [],
        streaming: "",
        thinking: "",
        status: "",
        taskCards: [],
      })),
    ),
  addTaskCard: (id, card): void =>
    set((st) => patchSession(st, id, (s) => ({ ...s, taskCards: [...s.taskCards, card] }))),
  updateTaskCard: (id, cardId, patch): void =>
    set((st) =>
      patchSession(st, id, (s) => ({
        ...s,
        taskCards: s.taskCards.map((c) => (c.id === cardId ? { ...c, ...patch } : c)),
      })),
    ),

  // ── APP-051: checkpoints (in-memory module map; never persisted) ────────────
  takeCheckpoint: (id, checkpoint): void => {
    checkpointStoreFor(id).record(checkpoint);
  },
  getCheckpoint: (id, checkpointId): Checkpoint | undefined =>
    checkpointStores.get(id)?.get(checkpointId),
  revertToTurn: (id, keepCount): void =>
    set((st) =>
      patchSession(st, id, (s) => ({
        ...s,
        turns: s.turns.slice(0, Math.max(0, keepCount)),
        streaming: "",
        thinking: "",
        status: "",
        // any pending cards / review from the reverted turns are abandoned.
        taskCards: [],
      })),
    ),

  proposeChangeSet: (cs, sessionId): void =>
    set((st) =>
      patchSession(st, sessionId ?? st.activeId, (s) => ({
        ...s,
        changeSet: cs,
        selection: initialSelection(cs),
      })),
    ),
  toggleHunk: (uri, hunkId): void =>
    set((st) =>
      patchSession(st, st.activeId, (s) => ({
        ...s,
        selection: toggleHunk(s.selection, uri, hunkId),
      })),
    ),
  clearChangeSet: (sessionId): void =>
    set((st) =>
      patchSession(st, sessionId ?? st.activeId, (s) => ({ ...s, changeSet: null, selection: {} })),
    ),
  setSelection: (selection, sessionId): void =>
    set((st) => patchSession(st, sessionId ?? st.activeId, (s) => ({ ...s, selection }))),
}));

// persist every tab + endpoint/policy whenever they change (#12). We DON'T persist
// transient fields (streaming/busy/changeSet/selection) — only the durable transcript.
if (typeof window !== "undefined") {
  useAiSessionStore.subscribe((s) => {
    try {
      const sessions: Record<string, unknown> = {};
      for (const id of s.order) {
        const se = s.sessions[id];
        if (se) sessions[id] = { title: se.title, turns: se.turns, taskCards: se.taskCards };
      }
      window.localStorage.setItem(
        AI_SESSION_KEY,
        JSON.stringify({
          version: AI_VERSION, // APP-067: stamp so the single→multi fold never re-runs
          endpointId: s.endpointId,
          neverSendToCloud: s.neverSendToCloud,
          ghostText: s.ghostText,
          sessions,
          order: s.order,
          activeId: s.activeId,
        }),
      );
    } catch {
      /* private mode / quota — the session just won't persist this run. */
    }
  });
}
