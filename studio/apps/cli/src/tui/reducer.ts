/**
 * tui/reducer.ts — the PURE composer state machine (the UX heart).
 *
 * `reduce(state, key, ctx)` maps one decoded KeyEvent to the next state + a list of
 * EFFECTS (submit / exit / interrupt / mode-changed / …) the app executes. It owns:
 * text editing on CODE POINTS (astral-safe), the autocomplete dropdown's mode-scoped
 * keymap (arrows drive the list while open), multi-line + history navigation, the
 * Shift-Tab permission-mode cycle, and the two-press Ctrl-C exit. No IO — fully tested.
 */
import { repl, agent } from "@prometheus/core";
import { type TraitCell, type TraitCellId, moveTraitFocus } from "@prometheus/core/ai-effort";

import {
  type AcItem,
  type AcState,
  acceptAc,
  isOpen,
  moveAc,
  requiresArg,
  submitLine,
  syncAutocomplete,
} from "./autocomplete.js";
import { type InvokeOverlayState, onInvokeKey } from "./invoke-overlay.js";
import { type KeyEvent, type KeymapResolution, remapKey } from "./keys.js";
import { type ListOverlayState, onListKey } from "./list-overlay.js";
import {
  EMPTY_PATH_AC,
  type PathAcState,
  type PathCompletionCtx,
  acceptPathAc,
  isPathOpen,
  movePathAc,
  syncPathAutocomplete,
} from "./path-mentions.js";
import { splitGraphemes } from "./width.js";

type PermissionModeId = agent.PermissionModeId;
const { cyclePermissionMode, permissionModeMeta } = agent;
/** The pane focus id — the SAME enum the readline/tmux host uses (core repl/panes.ts); no fork. */
type PaneId = repl.PaneId;

/** The live composer state. */
export interface TuiState {
  /** the input buffer. */
  input: string;
  /** caret position as a CODE-POINT index into `input`. */
  cursor: number;
  /** submitted lines (oldest → newest) for ↑/↓ recall. */
  history: string[];
  /** null = editing live; else the index being browsed in `history`. */
  histIndex: number | null;
  /** the live draft stashed while browsing history. */
  stash: string;
  /** sticky target column for vertical motion (null = follow the caret). */
  goalCol: number | null;
  /** the autocomplete dropdown. */
  ac: AcState;
  /** the "@"-path completion dropdown. Never open at the same time as `ac` — see `commit()`. */
  pathAc: PathAcState;
  /** the active permission mode. */
  permMode: PermissionModeId;
  /** when true, the user may not switch into bypassPermissions (declined-sudo lock). */
  bypassLocked: boolean;
  /** Ctrl-C armed once (press again on an empty line to exit). */
  pendingExit: boolean;
  /** reverse-i-search over history (Ctrl-R, CLI-019); null = inactive. */
  search: SearchState | null;
  /** the `/invoke` arrow-nav overlay (CLI-059); null = inactive. Modal: owns the key pipeline. */
  invokeOverlay: InvokeOverlayState | null;
  /** the generic pick-one overlay (CLI-1xx: `/agents`, `/think`, `/commands`, `/model` bare) —
   *  never open at the same time as `invokeOverlay` (the app opens at most one at a time). */
  listOverlay: ListOverlayState | null;
  /** the focused pane (CLI-060). Defaults to the composer/transcript pane so single-pane behavior
   *  is unchanged; Ctrl+G (CLI-067) cycles it via `cycleActivePane`. Shared enum with the host. */
  activePane: PaneId;
  /** large-paste stash (CLI-063): each collapsed paste's id → full text; the buffer holds a
   *  `[Pasted text #N, L lines]` placeholder, expanded back at submit. Reset per turn. */
  pastes: { id: number; text: string }[];
  /** monotonic paste id counter (CLI-063); reset to 0 with the stash. */
  pasteSeq: number;
  /** the live draft's paste stash, parked while browsing history (paired with `stash`). A recalled
   *  history line holds only placeholders whose content was never stored, so `pastes` is emptied
   *  during browse — else a fresh paste #N would splice into a recalled `[Pasted text #N]` (wrong). */
  pasteStash: { id: number; text: string }[];
  /**
   * ⌃T trait-rail focus: which cell the arrows are pointed at, or null when the rail is just a
   * readout. A contained mode on purpose — while it is open the arrows drive the RAIL and every
   * other key is ignored, so a user exploring it cannot wander into editing their draft. Esc
   * (or ⌃T again) leaves.
   */
  traitFocus: { index: number } | null;
}

/** Reverse-i-search state: the query, the candidate history index, and the stashed buffer. */
export interface SearchState {
  query: string;
  /** index into `history` of the current candidate, or -1 (no match). */
  matchIndex: number;
  /** the composer buffer stashed on entry (restored on Esc). */
  savedBuffer: string;
  /** the caret (code-point index) stashed on entry. */
  savedCaret: number;
  /** true when the current query has no (older) match — shows `(failed reverse-i-search)`. */
  failing: boolean;
}

/** Side effects the app performs (the reducer never does IO). */
export type TuiEffect =
  | { type: "submit"; text: string }
  | { type: "exit"; code: number }
  | { type: "interrupt" }
  | { type: "redraw-full" }
  | { type: "mode-changed"; mode: PermissionModeId; note: string }
  | { type: "notice"; text: string }
  | { type: "tools-toggle" }
  /** the /invoke overlay picked an entry + args → run the nemesis-gated install (CLI-059). */
  | { type: "invoke-dispatch"; name: string; args: string }
  /** the generic list-overlay picked an item — the app resubmits `text` through the normal
   *  composer submit path, exactly as if the user had typed it (CLI-1xx). */
  | { type: "list-pick"; text: string }
  /** the focused pane changed (CLI-060) — the app repaints / flashes the new pane name. */
  | { type: "pane-changed"; pane: PaneId }
  /** Ctrl+S (CLI-067) — the app exports the transcript + flashes the written path. */
  | { type: "save-transcript" }
  /** Ctrl+Y (CLI-068) — the app copies the last assistant reply to the clipboard (OSC 52). */
  | { type: "copy-reply" }
  /** an "@"-path completion resolved to a FILE — the app records the frecency hit (IO). */
  | { type: "path-completed"; path: string }
  /**
   * The trait rail's ↑/↓ on the focused cell (⌃T mode). `delta` is +1 for "on"/raise and -1 for
   * "off"/lower; the app maps that onto the real switch (tools, thinking, or the effort ladder)
   * because the reducer owns no session tuning.
   */
  | { type: "trait-adjust"; id: TraitCellId; delta: 1 | -1 };

/** Per-reduce context (the slash registry for autocomplete + whether an op is running). */
export interface ReduceCtx {
  items: readonly AcItem[];
  running: boolean;
  /** the effective keymap (CLI-096) — a rebound physical key is translated to its action's default
   *  key BEFORE the switches, so both the dropdown + composer contexts honor it. Absent ⇒ defaults. */
  keymap?: KeymapResolution;
  /** "@"-path completion wiring; omitted ⇒ the feature is off (pathAc stays closed). */
  pathCompletion?: PathCompletionCtx;
  /**
   * The model's trait rail for THIS frame (core's `traitRail`), so ⌃T can focus a real cell and
   * ↑/↓ know whether the cell under the cursor has a switch at all. Omitted ⇒ no rail is being
   * painted, and ⌃T falls back to its historical blind tools flip.
   */
  traitCells?: readonly TraitCell[];
}

export interface ReduceResult {
  state: TuiState;
  effects: TuiEffect[];
}

export function initialTuiState(over: Partial<TuiState> = {}): TuiState {
  return {
    input: "",
    cursor: 0,
    history: [],
    histIndex: null,
    stash: "",
    goalCol: null,
    ac: { items: [], index: 0, query: "" },
    pathAc: EMPTY_PATH_AC,
    permMode: "default",
    bypassLocked: false,
    pendingExit: false,
    search: null,
    invokeOverlay: null,
    listOverlay: null,
    activePane: "transcript", // core repl default = the composer/transcript pane (CLI-060)
    pastes: [],
    pasteSeq: 0,
    pasteStash: [],
    traitFocus: null,
    ...over,
  };
}

/** Newest history index ≤ `startIdx` whose entry contains `query` (case-insensitive); -1 if none. */
export function searchHistory(history: readonly string[], query: string, startIdx: number): number {
  const q = query.toLowerCase();
  for (let i = Math.min(startIdx, history.length - 1); i >= 0; i--) {
    if ((history[i] ?? "").toLowerCase().includes(q)) return i;
  }
  return -1;
}

/** Enter reverse-i-search, stashing the current buffer + caret; empty query recalls newest. */
function enterSearch(state: TuiState): TuiState {
  const matchIndex = searchHistory(state.history, "", state.history.length - 1);
  return {
    ...state,
    search: {
      query: "",
      matchIndex,
      savedBuffer: state.input,
      savedCaret: state.cursor,
      failing: matchIndex === -1,
    },
  };
}

const cps = (s: string): string[] => [...s];
const join = (a: string[]): string => a.join("");
const NONE: TuiEffect[] = [];

/* ── grapheme-cluster boundaries (CLI-070) ─────────────────────────────────────
 * The caret stays a CODE-POINT index (input-box.ts's wrap/caret map + CLI-069's clickToOffset are
 * code-point-indexed), but Backspace/Delete/Left/Right STEP by grapheme cluster so a ZWJ emoji /
 * flag / skin-tone / combining base+diacritic is ONE unit. The segmenter is shared with CLI-065's
 * modal editors (width.ts `splitGraphemes`) — one implementation, not a duplicate. */

/** Code-point indices at grapheme-cluster boundaries of `input`, incl 0 and the length. */
function graphemeBounds(input: string): number[] {
  const out = [0];
  let cp = 0;
  for (const cl of splitGraphemes(input)) {
    cp += [...cl].length;
    out.push(cp);
  }
  return out;
}

/** The grapheme boundary strictly BEFORE `cursor` (Backspace / Left). */
function prevGraphemeBoundary(input: string, cursor: number): number {
  let prev = 0;
  for (const x of graphemeBounds(input)) {
    if (x < cursor) prev = x;
    else break;
  }
  return prev;
}

/** The grapheme boundary strictly AFTER `cursor` (Delete / Right). */
function nextGraphemeBoundary(input: string, cursor: number): number {
  for (const x of graphemeBounds(input)) if (x > cursor) return x;
  return cps(input).length;
}

/** Snap a code-point `offset` DOWN to the nearest grapheme boundary — up/down nav never lands
 *  mid-cluster (keeps goalCol on a cluster edge, deliverable 3). */
function snapToGrapheme(input: string, offset: number): number {
  let snapped = 0;
  for (const x of graphemeBounds(input)) {
    if (x <= offset) snapped = x;
    else break;
  }
  return snapped;
}

/* ── editing primitives (code-point indexed) ───────────────────────────────── */

/** Replace the buffer + caret, resync autocomplete, reset history browse + goalCol. */
function commit(
  state: TuiState,
  input: string,
  cursor: number,
  ctx: ReduceCtx,
  keepGoal = false,
): TuiState {
  const cur = Math.max(0, Math.min(cursor, cps(input).length));
  const ac = syncAutocomplete(input, cur, ctx.items, state.ac);
  // `ac` is checked FIRST, so it always wins a pathological buffer where both could trigger
  // (e.g. "/@"): not because a following space closes it — no space is needed at all — but
  // because rankSlash scores every real command -1 for a query containing "@" (no command
  // name/alias contains one), so `ac` simply never opens for such a query in the first
  // place, and `isOpen(ac)` is false, letting pathAc open instead. The two are still never
  // open together — `ac` just doesn't happen to claim the "/@" case the way this comment
  // used to (wrongly) describe.
  const pathAc = isOpen(ac)
    ? EMPTY_PATH_AC
    : syncPathAutocomplete(input, cur, ctx.pathCompletion, state.pathAc);
  return {
    ...state,
    input,
    cursor: cur,
    histIndex: null,
    pendingExit: false,
    goalCol: keepGoal ? state.goalCol : null,
    ac,
    pathAc,
  };
}

function insert(state: TuiState, text: string, ctx: ReduceCtx): TuiState {
  const a = cps(state.input);
  const next = [...a.slice(0, state.cursor), ...cps(text), ...a.slice(state.cursor)];
  return commit(state, join(next), state.cursor + cps(text).length, ctx);
}

/** Clear the composer buffer AND the paste stash (CLI-063) — ids never leak across a cleared turn. */
function clearBuffer(state: TuiState, ctx: ReduceCtx): TuiState {
  return { ...commit(state, "", 0, ctx), pastes: [], pasteSeq: 0, pasteStash: [] };
}

function delBack(state: TuiState, ctx: ReduceCtx): TuiState {
  if (state.cursor === 0) return state;
  // CLI-063: caret just after a live placeholder → delete the WHOLE token atomically + drop its
  // stash entry (the caret can never land inside the chip).
  const ph = placeholderBeforeCaret(state);
  if (ph) {
    const a = cps(state.input);
    const next = [...a.slice(0, ph.start), ...a.slice(ph.end)];
    const pastes = state.pastes.filter((p) => p.id !== ph.id);
    return commit({ ...state, pastes }, join(next), ph.start, ctx);
  }
  // CLI-070: delete back to the previous GRAPHEME boundary (a multi-codepoint emoji is one press).
  const a = cps(state.input);
  const start = prevGraphemeBoundary(state.input, state.cursor);
  const next = [...a.slice(0, start), ...a.slice(state.cursor)];
  return commit(state, join(next), start, ctx);
}

function delFwd(state: TuiState, ctx: ReduceCtx): TuiState {
  const a = cps(state.input);
  if (state.cursor >= a.length) return state;
  // CLI-070: delete forward to the next GRAPHEME boundary.
  const end = nextGraphemeBoundary(state.input, state.cursor);
  const next = [...a.slice(0, state.cursor), ...a.slice(end)];
  return commit(state, join(next), state.cursor, ctx);
}

/* ── word + line geometry ──────────────────────────────────────────────────── */

const isWord = (ch: string | undefined): boolean => !!ch && /\w/.test(ch);

function prevWord(a: string[], i: number): number {
  let j = i;
  while (j > 0 && !isWord(a[j - 1])) j -= 1;
  while (j > 0 && isWord(a[j - 1])) j -= 1;
  return j;
}
function nextWord(a: string[], i: number): number {
  let j = i;
  while (j < a.length && !isWord(a[j])) j += 1;
  while (j < a.length && isWord(a[j])) j += 1;
  return j;
}
/** Start index of the logical line (after the previous "\n") containing `i`. */
function lineStart(a: string[], i: number): number {
  let j = i;
  while (j > 0 && a[j - 1] !== "\n") j -= 1;
  return j;
}
/** End index of the logical line (before the next "\n") containing `i`. */
function lineEnd(a: string[], i: number): number {
  let j = i;
  while (j < a.length && a[j] !== "\n") j += 1;
  return j;
}

/** Move the caret across logical lines (↑/↓ within a multi-line buffer). null = none. */
function verticalMove(state: TuiState, dir: -1 | 1): { cursor: number; goalCol: number } | null {
  const a = cps(state.input);
  const ls = lineStart(a, state.cursor);
  const le = lineEnd(a, state.cursor);
  const col = state.goalCol ?? state.cursor - ls;
  if (dir === -1) {
    if (ls === 0) return null; // already on the first line → caller does history
    const prevEnd = ls - 1; // the "\n" before this line
    const prevStart = lineStart(a, prevEnd);
    // CLI-070: snap the landing to a grapheme boundary so ↑/↓ never splits a cluster.
    return {
      cursor: snapToGrapheme(state.input, prevStart + Math.min(col, prevEnd - prevStart)),
      goalCol: col,
    };
  }
  if (le >= a.length) return null; // last line → history
  const nextStart = le + 1;
  const nextEnd = lineEnd(a, nextStart);
  return {
    cursor: snapToGrapheme(state.input, nextStart + Math.min(col, nextEnd - nextStart)),
    goalCol: col,
  };
}

/* ── history recall ────────────────────────────────────────────────────────── */

function historyPrev(state: TuiState, ctx: ReduceCtx): TuiState {
  if (state.history.length === 0) return state;
  const entering = state.histIndex === null;
  const idx =
    state.histIndex === null ? state.history.length - 1 : Math.max(0, state.histIndex - 1);
  const stash = entering ? state.input : state.stash;
  // park the live draft's paste stash on first entry; a recalled line's placeholders are inert.
  const pasteStash = entering ? state.pastes : state.pasteStash;
  const input = state.history[idx] ?? "";
  return {
    ...commit(state, input, cps(input).length, ctx),
    histIndex: idx,
    stash,
    pasteStash,
    pastes: [],
  };
}

function historyNext(state: TuiState, ctx: ReduceCtx): TuiState {
  if (state.histIndex === null) return state;
  const idx = state.histIndex + 1;
  if (idx >= state.history.length) {
    // back to the live draft — restore its parked paste stash.
    return {
      ...commit(state, state.stash, cps(state.stash).length, ctx),
      histIndex: null,
      pastes: state.pasteStash,
      pasteStash: [],
    };
  }
  const input = state.history[idx] ?? "";
  return { ...commit(state, input, cps(input).length, ctx), histIndex: idx };
}

/* ── the reducer ───────────────────────────────────────────────────────────── */

function result(state: TuiState, effects: TuiEffect[] = NONE): ReduceResult {
  return { state, effects };
}

/**
 * The /invoke overlay key pipeline (CLI-059): route the decoded key through the pure overlay
 * machine, then translate its action — `none` updates the overlay, `close` clears it (composer
 * repaints), `dispatch` clears it AND emits the gated-install effect the app runs.
 */
function reduceInvokeOverlay(state: TuiState, key: KeyEvent): ReduceResult {
  const overlay = state.invokeOverlay;
  if (!overlay) return result(state);
  const { state: next, action } = onInvokeKey(overlay, key);
  if (action.type === "close") return result({ ...state, invokeOverlay: null });
  if (action.type === "dispatch") {
    return result({ ...state, invokeOverlay: null }, [
      { type: "invoke-dispatch", name: action.name, args: action.args },
    ]);
  }
  return result({ ...state, invokeOverlay: next });
}

/**
 * The generic list-overlay's key pipeline (CLI-1xx: `/agents`, `/think`, `/commands`, `/model`
 * bare) — same shape as `reduceInvokeOverlay`, minus an args stage: a pick already carries the
 * full line to resubmit, so `close`/`pick` are the only two outcomes besides "still open".
 */
function reduceListOverlay(state: TuiState, key: KeyEvent): ReduceResult {
  const overlay = state.listOverlay;
  if (!overlay) return result(state);
  const { state: next, action } = onListKey(overlay, key);
  if (action.type === "close") return result({ ...state, listOverlay: null });
  if (action.type === "pick") {
    return result({ ...state, listOverlay: null }, [{ type: "list-pick", text: action.text }]);
  }
  return result({ ...state, listOverlay: next });
}

/**
 * Advance the focused pane through the shared PANE_CYCLE (CLI-060) and emit a `pane-changed`
 * effect so the app repaints + flashes the new pane. Pure: no IO, input buffer untouched. CLI-067's
 * Ctrl+G binds to this. Exactly ONE `pane-changed` effect per call.
 */
export function cycleActivePane(state: TuiState): ReduceResult {
  const pane = repl.cyclePane(state.activePane);
  return result({ ...state, activePane: pane }, [{ type: "pane-changed", pane }]);
}

/** Move the caret to a code-point `offset` (CLI-069 click-to-position); clamps + resyncs. The app
 *  computes `offset` via input-box's `clickToOffset` from a mouse click's (row,col). */
export function moveCaretTo(state: TuiState, offset: number, ctx: ReduceCtx): ReduceResult {
  const len = cps(state.input).length;
  return result(commit(state, state.input, Math.max(0, Math.min(offset, len)), ctx));
}

/** Cycle the permission mode (Shift-Tab). Bypass joins the cycle unless it's locked. */
function cycleMode(state: TuiState): ReduceResult {
  const next = cyclePermissionMode(state.permMode, { allowBypass: !state.bypassLocked });
  const meta = permissionModeMeta(next);
  return result({ ...state, permMode: next, pendingExit: false }, [
    { type: "mode-changed", mode: next, note: meta.description },
  ]);
}

/** Set the permission mode explicitly (the app's /permissions path; respects the lock). */
export function setMode(state: TuiState, mode: PermissionModeId): ReduceResult {
  // yolo is bypass+run-to-done — the SAME elevated-privilege lock caps it (never past a declined sudo).
  if ((mode === "bypassPermissions" || mode === "yolo") && state.bypassLocked) {
    return result(state, [
      { type: "notice", text: `${mode} is locked this session (elevated-privilege decline).` },
    ]);
  }
  const meta = permissionModeMeta(mode);
  return result({ ...state, permMode: mode }, [
    { type: "mode-changed", mode, note: meta.description },
  ]);
}

/** Sanitize pasted text: strip control bytes except \n/\t, normalize CRLF→LF. */
export function sanitizePaste(text: string): string {
  // Normalize CRLF *and* a bare CR (macOS/iTerm paste) to \n — a surviving \r carriage-returns the
  // render over prior text (a spoof vector) and breaks \n-based line counting/navigation.
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/* ── large-paste placeholders (CLI-063) ────────────────────────────────────── */

/** Collapse a paste when it exceeds either threshold (multi-line OR long). */
const PASTE_MAX_LINES = 3;
const PASTE_MAX_CHARS = 200;

/** Line count on the sanitized text: `\n` occurrences (+1 only when there's no trailing newline),
 *  so a 200-line paste with a final newline is still 200 lines. */
export function countPasteLines(text: string): number {
  if (text === "") return 0;
  const nl = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? nl : nl + 1;
}

/** The single-line placeholder token substituted into the buffer. */
export function pastePlaceholder(id: number, lines: number): string {
  return `[Pasted text #${id}, ${lines} line${lines === 1 ? "" : "s"}]`;
}

/** Should this paste collapse to a placeholder (vs insert verbatim)? */
export function shouldCollapsePaste(text: string): boolean {
  return countPasteLines(text) > PASTE_MAX_LINES || text.length > PASTE_MAX_CHARS;
}

/** Matches a placeholder token shape; the `#N` is only EXPANDED if `N` is a live stash id. */
const PASTE_TOKEN_RX = /\[Pasted text #(\d+), \d+ lines?\]/g;

/**
 * Expand every placeholder whose id is in the stash back to its full text (CLI-063). A hand-TYPED
 * lookalike (no matching stash id) passes through untouched — forgery guard.
 */
export function expandPastes(
  text: string,
  pastes: readonly { id: number; text: string }[],
): string {
  return text.replace(PASTE_TOKEN_RX, (match, idStr: string) => {
    const p = pastes.find((x) => x.id === Number(idStr));
    return p ? p.text : match;
  });
}

/** If the caret sits just after a LIVE placeholder token, return its [start,end) span + id. */
function placeholderBeforeCaret(
  state: TuiState,
): { start: number; end: number; id: number } | null {
  const before = cps(state.input).slice(0, state.cursor).join("");
  const m = before.match(/\[Pasted text #(\d+), \d+ lines?\]$/);
  if (!m) return null;
  const id = Number(m[1]);
  if (!state.pastes.some((p) => p.id === id)) return null; // typed lookalike → normal backspace
  return { start: state.cursor - cps(m[0]).length, end: state.cursor, id };
}

/**
 * Reverse-i-search key handling (CLI-019). PREEMPTS the whole pipeline: printable keys
 * grow the query, backspace shrinks it (re-scanning from the newest entry), Ctrl-R
 * cycles strictly OLDER, Enter accepts into the buffer (NOT submitted), Esc restores the
 * exact prior buffer + caret; every OTHER key is swallowed so nothing leaks in.
 */
function reduceSearch(state: TuiState, key: KeyEvent, ctx: ReduceCtx): ReduceResult {
  const s = state.search as SearchState;
  const rescan = (query: string): ReduceResult => {
    const matchIndex = searchHistory(state.history, query, state.history.length - 1);
    return result({ ...state, search: { ...s, query, matchIndex, failing: matchIndex === -1 } });
  };
  switch (key.name) {
    case "char":
      return rescan(s.query + (key.ch ?? ""));
    case "backspace":
      return rescan(s.query.slice(0, -1));
    case "ctrl-r": {
      // cycle strictly OLDER; at the end show `failing` and DON'T move the candidate (bash).
      const next = searchHistory(state.history, s.query, s.matchIndex - 1);
      return result({
        ...state,
        search: next === -1 ? { ...s, failing: true } : { ...s, matchIndex: next, failing: false },
      });
    }
    case "enter": {
      // accept the candidate into the composer WITHOUT submitting.
      const candidate = s.matchIndex >= 0 ? (state.history[s.matchIndex] as string) : s.savedBuffer;
      return result({ ...commit(state, candidate, cps(candidate).length, ctx), search: null });
    }
    case "esc":
    case "ctrl-c":
      // cancel: restore the exact prior buffer + caret.
      return result({ ...commit(state, s.savedBuffer, s.savedCaret, ctx), search: null });
    default:
      return result(state); // swallow arrows/tab/`/`-popup/etc. while searching
  }
}

/**
 * ⌃T trait-rail focus (CLI-1xx). MODAL like reverse-i-search: ←/→ walk the rail, ↑/↓ throw the
 * focused cell's switch, Esc (or ⌃T again) leaves, and every other key is SWALLOWED.
 *
 * Swallowed rather than passed through on purpose. The rail is a settings surface reached by a
 * chord, and a mode where stray keystrokes silently edit the draft underneath is exactly the
 * "messing around" this containment exists to prevent — the user can always leave with the key
 * that leaves everything else in this TUI.
 *
 * A cell with no switch (`completion`/`vision`/`audio`, or a capability the model lacks) answers
 * ↑/↓ with its REASON rather than nothing at all: a key that appears to do nothing is
 * indistinguishable from a broken one.
 */
function reduceTraitFocus(state: TuiState, key: KeyEvent, ctx: ReduceCtx): ReduceResult {
  const focus = state.traitFocus as { index: number };
  const cells = ctx.traitCells ?? [];
  const close = (effects: TuiEffect[] = []): ReduceResult =>
    result({ ...state, traitFocus: null }, effects);
  if (cells.length === 0) return close(); // the rail vanished under us (model swap) — don't strand
  switch (key.name) {
    case "left":
      return result({ ...state, traitFocus: { index: moveTraitFocus(cells, focus.index, -1) } });
    case "right":
      return result({ ...state, traitFocus: { index: moveTraitFocus(cells, focus.index, 1) } });
    case "up":
    case "down": {
      const cell = cells[Math.min(focus.index, cells.length - 1)];
      if (!cell) return result(state);
      if (!cell.actionable) {
        return result(state, [
          { type: "notice", text: `${cell.label}: ${cell.reason ?? "no switch here"}` },
        ]);
      }
      return result(state, [
        { type: "trait-adjust", id: cell.id, delta: key.name === "up" ? 1 : -1 },
      ]);
    }
    case "esc":
      return close();
    case "ctrl-t":
      return close(); // the chord that opened it also closes it
    case "ctrl-c":
      // leaving the mode must never cost the user an interrupt they meant for a running turn.
      return close(ctx.running ? [{ type: "interrupt" }] : []);
    default:
      return result(state);
  }
}

/** Reduce one key into (next state, effects). */
export function reduce(state: TuiState, rawKey: KeyEvent, ctx: ReduceCtx): ReduceResult {
  // the /invoke overlay is MODAL — it owns the whole key pipeline while open (CLI-059).
  if (state.invokeOverlay) return reduceInvokeOverlay(state, rawKey);
  // the generic list-overlay is likewise MODAL while open (CLI-1xx); the app never opens both.
  if (state.listOverlay) return reduceListOverlay(state, rawKey);
  // reverse-i-search owns the whole key pipeline while active (CLI-019).
  if (state.search) return reduceSearch(state, rawKey, ctx);
  // CLI-096: translate a rebound physical key → its action's canonical default key BEFORE any
  // dispatch (covers both the dropdown-open switch AND the composer switch). Text/mouse are never
  // rebindable; identity when no user rebind applies.
  const key: KeyEvent =
    ctx.keymap && rawKey.name !== "char" && rawKey.name !== "paste" && rawKey.name !== "mouse"
      ? { ...rawKey, name: remapKey(ctx.keymap, rawKey.name) }
      : rawKey;
  // ⌃T trait-rail focus is modal too, but it sits AFTER the remap above so a user who rebound
  // the arrows still drives the rail with them.
  if (state.traitFocus) return reduceTraitFocus(state, key, ctx);
  if (key.name === "ctrl-r") return result(enterSearch(state));
  // mouse (CLI-069): wheel over an OPEN dropdown moves the highlight (mirrors ↑/↓); clicks +
  // wheel-elsewhere are NOT intercepted here (clicks need layout → the app maps them via
  // clickToOffset + moveCaretTo; wheel elsewhere leaves the state untouched).
  if (key.name === "mouse") {
    const m = key.mouse;
    if (m?.wheel && isOpen(state.ac)) {
      return result({ ...state, ac: moveAc(state.ac, m.wheel === "down" ? 1 : -1) });
    }
    return result(state);
  }
  // Shift-Tab cycles the permission mode in EVERY context.
  if (key.name === "backtab") return cycleMode(state);

  // ── dropdown-open keymap (overrides the composer keymap) ────────────────── //
  if (isOpen(state.ac)) {
    switch (key.name) {
      case "up":
        return result({ ...state, ac: moveAc(state.ac, -1) });
      case "down":
        return result({ ...state, ac: moveAc(state.ac, 1) });
      case "tab": {
        const line = acceptAc(state.ac);
        return line ? result(commit(state, line, cps(line).length, ctx)) : result(state);
      }
      case "enter": {
        const sel = state.ac.items[state.ac.index];
        const line = submitLine(state.ac, state.input);
        if (!sel || !line) return result(state);
        // Hold for args ONLY when the command REQUIRES one ("<name>") and none is typed yet.
        // Testing `sel.args` at all held ~40 commands with merely OPTIONAL args ("[action]")
        // on the first Enter, so `/faq` needed two presses and the next command was glued on
        // as its argument. Everything else submits what the user actually typed — which keeps
        // the alias (`/effort` stays `/effort`) and any already-typed remainder.
        const completed = acceptAc(state.ac);
        if (requiresArg(sel) && line.slice(1).trim().split(/\s+/).length < 2) {
          return completed
            ? result(commit(state, completed, cps(completed).length, ctx))
            : result(state);
        }
        return submit(state, line, ctx);
      }
      case "esc":
        return result({ ...state, ac: { items: [], index: 0, query: "" } });
      case "ctrl-c":
        return result({ ...state, ac: { items: [], index: 0, query: "" }, pendingExit: false });
      case "backspace":
        return result(delBack(state, ctx));
      case "char":
        return result(insert(state, key.ch ?? "", ctx));
      case "left":
        // CLI-070: grapheme-cluster step (same unit as Backspace), even with the dropdown open.
        return result(
          commit(state, state.input, prevGraphemeBoundary(state.input, state.cursor), ctx),
        );
      case "right":
        return result(
          commit(state, state.input, nextGraphemeBoundary(state.input, state.cursor), ctx),
        );
      default:
        break; // fall through to the composer keymap for everything else
    }
  }

  // ── "@"-path dropdown keymap (mirrors the slash dropdown above; see `commit()` for why
  //    the two are never open together) ────────────────────────────────────── //
  if (isPathOpen(state.pathAc)) {
    switch (key.name) {
      case "up":
        return result({ ...state, pathAc: movePathAc(state.pathAc, -1) });
      case "down":
        return result({ ...state, pathAc: movePathAc(state.pathAc, 1) });
      case "tab":
      case "enter": {
        // A slash-command path argument is the WHOLE line, so Enter RUNS the command and Tab is
        // what completes it — the shell behaviour every user already has in their fingers, and
        // the only way `/cd <dir>` can ever be submitted while the dropdown is still listing the
        // directory that was just drilled into. Breaking out of the switch hands "enter" to the
        // composer keymap below, which submits.
        //
        // An "@" mention is the opposite case: it sits mid-sentence, so Enter accepts the
        // highlighted entry rather than sending a half-typed message.
        if (key.name === "enter" && state.pathAc.trigger?.kind === "slash-arg") break;
        const accepted = acceptPathAc(state.input, state.pathAc);
        if (!accepted) return result(state);
        const next = commit(state, accepted.input, accepted.cursor, ctx);
        return accepted.acceptedPath
          ? result(next, [{ type: "path-completed", path: accepted.acceptedPath }])
          : result(next);
      }
      case "esc":
        return result({ ...state, pathAc: EMPTY_PATH_AC });
      case "ctrl-c":
        return result({ ...state, pathAc: EMPTY_PATH_AC, pendingExit: false });
      case "backspace":
        return result(delBack(state, ctx));
      case "char":
        return result(insert(state, key.ch ?? "", ctx));
      case "left":
        return result(
          commit(state, state.input, prevGraphemeBoundary(state.input, state.cursor), ctx),
        );
      case "right":
        return result(
          commit(state, state.input, nextGraphemeBoundary(state.input, state.cursor), ctx),
        );
      default:
        break; // fall through to the composer keymap for everything else
    }
  }

  // ── composer keymap ─────────────────────────────────────────────────────── //
  const a = cps(state.input);
  switch (key.name) {
    case "char":
      return result(insert(state, key.ch ?? "", ctx));
    case "paste": {
      const text = sanitizePaste(key.ch ?? "");
      // CLI-063: a multi-line / oversized paste collapses to a `[Pasted text #N, L lines]` chip,
      // its full content stashed for expansion at submit; small pastes insert verbatim (as before).
      if (shouldCollapsePaste(text)) {
        const id = state.pasteSeq + 1;
        const stashed: TuiState = {
          ...state,
          pastes: [...state.pastes, { id, text }],
          pasteSeq: id,
        };
        return result(insert(stashed, pastePlaceholder(id, countPasteLines(text)), ctx));
      }
      return result(insert(state, text, ctx));
    }
    case "newline":
      return result(insert(state, "\n", ctx));
    case "enter":
      return state.input.trim() ? submit(state, state.input, ctx) : result(state);
    case "backspace":
      return result(delBack(state, ctx));
    case "delete":
      return result(delFwd(state, ctx));
    case "left":
      // CLI-070: step by grapheme cluster (matches Backspace's unit).
      return result(
        commit(state, state.input, prevGraphemeBoundary(state.input, state.cursor), ctx),
      );
    case "right":
      return result(
        commit(state, state.input, nextGraphemeBoundary(state.input, state.cursor), ctx),
      );
    case "word-left":
      return result(commit(state, state.input, prevWord(a, state.cursor), ctx));
    case "word-right":
      return result(commit(state, state.input, nextWord(a, state.cursor), ctx));
    case "home":
    case "ctrl-a":
    case "line-home": // ⌘←
      return result(commit(state, state.input, lineStart(a, state.cursor), ctx));
    case "end":
    case "ctrl-e":
    case "line-end": // ⌘→
      return result(commit(state, state.input, lineEnd(a, state.cursor), ctx));
    case "up": {
      const mv = verticalMove(state, -1);
      if (mv)
        return result({ ...commit(state, state.input, mv.cursor, ctx, true), goalCol: mv.goalCol });
      return result(historyPrev(state, ctx));
    }
    case "down": {
      const mv = verticalMove(state, 1);
      if (mv)
        return result({ ...commit(state, state.input, mv.cursor, ctx, true), goalCol: mv.goalCol });
      return result(historyNext(state, ctx));
    }
    // ⌘↑ / ⌘↓: jump directly between WHOLE history prompts, regardless of the cursor's line
    // in a multi-line draft (⌘↓ walks back toward newer entries and finally the empty draft).
    case "history-entry-prev":
      return result(historyPrev(state, ctx));
    case "history-entry-next":
      return result(historyNext(state, ctx));
    case "ctrl-u": {
      const ls = lineStart(a, state.cursor);
      return result(commit(state, join([...a.slice(0, ls), ...a.slice(state.cursor)]), ls, ctx));
    }
    case "ctrl-k": {
      const le = lineEnd(a, state.cursor);
      return result(
        commit(state, join([...a.slice(0, state.cursor), ...a.slice(le)]), state.cursor, ctx),
      );
    }
    case "ctrl-w": {
      const pw = prevWord(a, state.cursor);
      return result(commit(state, join([...a.slice(0, pw), ...a.slice(state.cursor)]), pw, ctx));
    }
    case "ctrl-l":
      return result(state, [{ type: "redraw-full" }]);
    case "tab":
      // empty buffer → open the full command menu; a slash buffer → open filtered by
      // the ACTUAL query under the caret (not a hard-coded cursor=1, which listed all).
      if (state.input === "") {
        return result({ ...state, ac: syncAutocomplete("/", 1, ctx.items, state.ac) });
      }
      if (state.input.startsWith("/")) {
        return result({
          ...state,
          ac: syncAutocomplete(state.input, state.cursor, ctx.items, state.ac),
        });
      }
      return result(state);
    case "esc":
      return state.input ? result(clearBuffer(state, ctx)) : result(state);
    case "ctrl-c":
      if (ctx.running) return result(state, [{ type: "interrupt" }]);
      if (state.input) return result(clearBuffer(state, ctx));
      if (state.pendingExit) return result(state, [{ type: "exit", code: 130 }]);
      return result({ ...state, pendingExit: true }, [
        { type: "notice", text: "(Ctrl+C again to exit)" },
      ]);
    case "ctrl-d":
      return state.input ? result(state) : result(state, [{ type: "exit", code: 0 }]);
    case "ctrl-t": {
      /**
       * ⌃T opens the trait rail's focus mode, starting on the `tool` cell.
       *
       * It used to be a blind global tools flip (CLI-018), with no indication of what it had
       * done beyond a one-line flash. Starting on `tool` keeps that muscle memory intact — ⌃T
       * then ↓ is the same gesture — while putting the switch, its current state, and the rest
       * of the model's facts on screen at the moment it is thrown. With no rail to show (a
       * surface that feeds no cells, or a model that was never probed) it still falls back to
       * the old flip rather than becoming a dead key.
       */
      const cells = ctx.traitCells ?? [];
      if (cells.length === 0) return result(state, [{ type: "tools-toggle" }]);
      const tools = cells.findIndex((c) => c.id === "tools");
      const first = cells.findIndex((c) => c.actionable);
      return result({ ...state, traitFocus: { index: tools >= 0 ? tools : Math.max(0, first) } });
    }
    case "ctrl-g":
      // plan §7 (CLI-067): cycle the focused pane. Reuses CLI-060's cycleActivePane (advances
      // activePane + emits `pane-changed`); the input buffer is untouched (pure).
      return cycleActivePane(state);
    case "ctrl-s":
      // plan §7 (CLI-067): save the transcript. The app calls exportTranscript() + flashes the
      // path (an EFFECT — the reducer never does IO); buffer untouched.
      return result(state, [{ type: "save-transcript" }]);
    case "ctrl-y":
      // CLI-068: copy the last assistant reply to the system clipboard (OSC 52). Effect — the app
      // writes the raw sequence; buffer untouched.
      return result(state, [{ type: "copy-reply" }]);
    default:
      return result(state);
  }
}

/** Submit a line: push to history, clear the buffer, emit the submit effect. */
function submit(state: TuiState, text: string, ctx: ReduceCtx): ReduceResult {
  const trimmed = text.trim();
  // CLI-063: history keeps the PLACEHOLDER form (keeps the CLI-062 file small); the agent gets the
  // FULL expanded text. Unreferenced stash entries are dropped by the reset below.
  const emitted = expandPastes(trimmed, state.pastes);
  const history =
    trimmed && state.history[state.history.length - 1] !== trimmed
      ? [...state.history, trimmed]
      : state.history;
  const cleared = commit({ ...state, history }, "", 0, ctx);
  return result(
    { ...cleared, histIndex: null, stash: "", pastes: [], pasteSeq: 0, pasteStash: [] },
    [{ type: "submit", text: emitted }],
  );
}
