/**
 * tui/list-overlay.ts — a generic arrow-nav "pick one" overlay (CLI-1xx).
 *
 * Generalizes invoke-overlay.ts's proven pattern (↑/↓ move, type-to-filter, Enter selects, Esc
 * cancels) for every OTHER bare-invocation picker command: `/agents`, `/think`, `/commands`,
 * `/model`. `/invoke` keeps its own overlay (it has a second ARGS stage this one doesn't need).
 *
 * Each item already carries the exact command LINE picking it should run (`submitText`) — the
 * overlay's only output is "submit this text", so completion re-enters the SAME `/command <arg>`
 * code path the user would have typed by hand. The overlay never re-implements what a picked
 * item does; it is purely a nicer way to choose the argument.
 */
import type { KeyEvent } from "./keys.js";
import { type ColorCaps, painter, selectionBar } from "./palette.js";
import { clipToWidth, stringWidth } from "./width.js";

export interface ListOverlayItem {
  /** shown as the row's label (e.g. a model name, an effort tier, "/help"). */
  label: string;
  /** shown dim after the label (e.g. "local · ollama", a command's one-line summary). */
  detail?: string;
  /** marks the item matching today's value — shown with a trailing "← current" and used to
   *  pre-highlight the overlay so Enter with no navigation re-confirms today's value. */
  current?: boolean;
  /** the full composer line to resubmit when this item is picked. */
  submitText: string;
  /**
   * Extra lines shown BELOW the list, for the highlighted row only.
   *
   * Added for the model browser, where one line cannot carry what a person needs to choose: the
   * size, the quantisation, the licence, whether it fits this machine's RAM. Optional, so every
   * existing picker (`/agents`, `/think`, `/commands`, `/model`) renders exactly as before.
   *
   * Pre-formatted by the caller — the overlay clips each line to width but never reflows, in
   * keeping with the rest of this renderer.
   */
  body?: readonly string[];
  /**
   * Blocks selection, with the reason shown in place of the body.
   *
   * A model too large for this machine stays VISIBLE — hiding it invites "why isn't X listed?"
   * — but Enter on it does nothing and says why. Offering a choice that cannot work, and failing
   * only after a 20 GB download, is the outcome this exists to prevent.
   */
  disabled?: string;
}

export type ListOverlayAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "pick"; text: string };

export interface ListOverlayState {
  title: string;
  all: readonly ListOverlayItem[];
  filtered: readonly ListOverlayItem[];
  index: number;
  query: string;
  /**
   * A line under the title: where the rows came from, or why there are none.
   *
   * The model browser needs it because "no matches" and "HuggingFace was unreachable" look
   * identical in an empty list, and only one of them is the user's filter being too narrow.
   */
  status?: string;
}

/**
 * Simple, dependency-free ranking: exact label match, then prefix, then substring (label OR
 * detail) — good enough for the short, human-curated lists this overlay is built for (the
 * largest, `/commands`, is ~170 rows of short names, not free text to fuzzy-search).
 */
function rank(query: string, items: readonly ListOverlayItem[]): ListOverlayItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const score = (it: ListOverlayItem): number => {
    const label = it.label.toLowerCase();
    if (label === q) return 0;
    if (label.startsWith(q)) return 1;
    if (label.includes(q)) return 2;
    if ((it.detail ?? "").toLowerCase().includes(q)) return 3;
    return -1;
  };
  return items
    .map((it) => ({ it, s: score(it) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s)
    .map((x) => x.it);
}

/** Open the overlay over an item set (empty filter, highlighted on the CURRENT item when one is
 *  marked — falling back to the first row when none is). */
export function openListOverlay(
  title: string,
  items: readonly ListOverlayItem[],
  status?: string,
): ListOverlayState {
  const filtered = rank("", items);
  const currentIdx = filtered.findIndex((it) => it.current);
  return {
    title,
    all: items,
    filtered,
    index: currentIdx >= 0 ? currentIdx : 0,
    query: "",
    ...(status ? { status } : {}),
  };
}

function move(state: ListOverlayState, delta: number): ListOverlayState {
  const n = state.filtered.length;
  if (n === 0) return state;
  return { ...state, index: (((state.index + delta) % n) + n) % n };
}

function reQuery(state: ListOverlayState, query: string): ListOverlayState {
  const filtered = rank(query, state.all);
  const index = filtered.length === 0 ? 0 : Math.min(state.index, filtered.length - 1);
  return { ...state, query, filtered, index };
}

/** Advance the overlay by one decoded key. Esc/Ctrl-C always closes with no action. */
export function onListKey(
  state: ListOverlayState,
  key: KeyEvent,
): { state: ListOverlayState; action: ListOverlayAction } {
  const none = (s: ListOverlayState): { state: ListOverlayState; action: ListOverlayAction } => ({
    state: s,
    action: { type: "none" },
  });
  switch (key.name) {
    case "esc":
    case "ctrl-c":
      return { state, action: { type: "close" } };
    case "up":
      return none(move(state, -1));
    case "down":
      return none(move(state, 1));
    case "enter": {
      const sel = state.filtered[state.index];
      // A disabled row stays selectable so its reason can be read, but picking it does nothing.
      // Silently submitting a model that cannot run here would fail only after the download.
      if (!sel || sel.disabled) return none(state);
      return { state, action: { type: "pick", text: sel.submitText } };
    }
    case "backspace":
      return none(reQuery(state, state.query.slice(0, -1)));
    case "char":
      return key.ch ? none(reQuery(state, state.query + key.ch)) : none(state);
    default:
      return none(state);
  }
}

/**
 * Render the overlay to painted lines, clamped to `cols`×`rows` (truncate with `…`, never wrap —
 * mirrors invoke-overlay.ts's renderer exactly, including its scroll-window centering on the
 * highlighted row).
 */
export function renderListOverlay(
  state: ListOverlayState,
  cols: number,
  rows: number,
  caps: ColorCaps,
): string[] {
  const p = painter(caps);
  const w = Math.max(20, cols);
  const lines: string[] = [];
  lines.push(p.accent(clipToWidth(state.title, w)));
  lines.push(p.muted(clipToWidth(`  filter: ${state.query || "(type to filter)"}`, w)));
  if (state.status) lines.push(p.muted(clipToWidth(`  ${state.status}`, w)));

  /**
   * The detail pane competes with the LIST for the same rows, so it is budgeted before either is
   * drawn — and capped, because an item with fifteen body lines must not squeeze the list to one
   * row and make the overlay unnavigable. The list keeps at least three rows whatever happens.
   */
  const selected = state.filtered[state.index];
  const detail = selected?.disabled ? [selected.disabled] : (selected?.body ?? []);
  const reserved = 3 + (state.status ? 1 : 0); // title + filter + hint (+ status)
  const detailRows = Math.min(detail.length, Math.max(0, rows - reserved - 3), 6);
  const bodyRows = Math.max(1, rows - reserved - detailRows);
  const n = state.filtered.length;
  let top = 0;
  if (n > bodyRows) top = Math.min(Math.max(0, state.index - (bodyRows >> 1)), n - bodyRows);
  const view = state.filtered.slice(top, top + bodyRows);
  const labelW = Math.min(24, Math.max(1, ...view.map((i) => stringWidth(i.label))));
  view.forEach((item, idx) => {
    const real = top + idx;
    const mark = item.current ? "  ← current" : "";
    if (real === state.index) {
      const label = clipToWidth(
        `${item.label}${item.detail ? `  ${item.detail}` : ""}${mark}`,
        w - 4,
      );
      lines.push(`${p.accent("▌")}${selectionBar(` ${label}`, w - 1, caps)}`);
    } else {
      const labelCut = clipToWidth(item.label, labelW);
      const restBudget = Math.max(0, w - 5 - stringWidth(labelCut));
      const rest = clipToWidth(`${item.detail ?? ""}${mark}`, restBudget);
      lines.push(`  ${p.accent(labelCut)} ${p.muted(rest)}`);
    }
  });
  if (n === 0) lines.push(p.muted(clipToWidth("  (no matches)", w)));
  for (const line of detail.slice(0, detailRows)) {
    // A blocked row's reason is painted as a warning, not as ordinary detail — it is the reason
    // Enter will do nothing, and it has to look different from the description above it.
    const paint = selected?.disabled ? p.warn : p.muted;
    lines.push(paint(clipToWidth(`  ${line}`, w)));
  }
  lines.push(p.muted(clipToWidth("  ↑↓ move · Enter select · Esc cancel", w)));
  return lines;
}
