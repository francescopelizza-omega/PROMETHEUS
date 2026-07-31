/**
 * tui/invoke-overlay.ts — the `/invoke` arrow-nav command overlay (CLI-059).
 *
 * A PURE overlay state machine modeled on autocomplete.ts: ↑/↓ move, printable chars filter,
 * Backspace deletes, Enter selects → an argument prompt → Enter dispatches through the SAME
 * nemesis-gated `dispatchInvoke` seam the number-pick list uses, Esc cancels. No IO, no stdin
 * bytes — it consumes DECODED `KeyEvent`s from keys.ts and returns painted lines + an action the
 * app executes. Ranking is shared with the slash dropdown (rankSlash) so both rank identically.
 */
import { type Presence, mark as presenceMark } from "../commands/invoke.js";
import { type AcItem, rankSlash } from "./autocomplete.js";
import type { KeyEvent } from "./keys.js";
import { type ColorCaps, painter, selectionBar } from "./palette.js";
import { clipToWidth, stringWidth } from "./width.js";

/** One catalog entry shown in the overlay (name + one-line summary + install presence). */
export interface InvokeItem {
  name: string;
  summary: string;
  presence: Presence;
}

/** list = pick an entry; args = type arguments for the selected entry before running. */
export type InvokeStage = "list" | "args";

export interface InvokeOverlayState {
  /** the full item set (never mutated). */
  all: InvokeItem[];
  /** `all` ranked against `query`, best-first. */
  filtered: InvokeItem[];
  /** highlighted index (valid whenever `filtered` is non-empty). */
  index: number;
  /** the type-to-filter query. */
  query: string;
  stage: InvokeStage;
  /** the selected entry name (stage === "args"). */
  selected?: string;
  /** the args being typed (stage === "args"). */
  argInput: string;
}

/** What the app must do after a key: nothing, close the overlay, or dispatch an install. */
export type InvokeAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "dispatch"; name: string; args: string };

/** Rank items with the SAME scorer as the slash dropdown (prefix > subsequence). Items are
 *  AcItem-shaped (name+summary), so the returned objects ARE the InvokeItems, mark intact. */
function rank(query: string, items: readonly InvokeItem[]): InvokeItem[] {
  return rankSlash(query, items as unknown as readonly AcItem[]) as unknown as InvokeItem[];
}

/** Open the overlay over a catalog item set (list stage, empty filter). */
export function openInvokeOverlay(items: InvokeItem[]): InvokeOverlayState {
  return {
    all: items,
    filtered: rank("", items),
    index: 0,
    query: "",
    stage: "list",
    argInput: "",
  };
}

function move(state: InvokeOverlayState, delta: number): InvokeOverlayState {
  const n = state.filtered.length;
  if (n === 0) return state;
  return { ...state, index: (((state.index + delta) % n) + n) % n };
}

function reQuery(state: InvokeOverlayState, query: string): InvokeOverlayState {
  const filtered = rank(query, state.all);
  const index = filtered.length === 0 ? 0 : Math.min(state.index, filtered.length - 1);
  return { ...state, query, filtered, index };
}

/**
 * Advance the overlay by one decoded key. Esc always closes. In the LIST stage: ↑/↓ move, a
 * printable char / Backspace edits the filter, Enter → the ARGS stage for the highlighted entry.
 * In the ARGS stage: printable/Backspace edit the args, Enter → a `dispatch` action.
 */
export function onInvokeKey(
  state: InvokeOverlayState,
  key: KeyEvent,
): { state: InvokeOverlayState; action: InvokeAction } {
  const none = (s: InvokeOverlayState): { state: InvokeOverlayState; action: InvokeAction } => ({
    state: s,
    action: { type: "none" },
  });
  if (key.name === "esc") return { state, action: { type: "close" } };

  if (state.stage === "list") {
    switch (key.name) {
      case "up":
        return none(move(state, -1));
      case "down":
        return none(move(state, 1));
      case "enter": {
        const sel = state.filtered[state.index];
        if (!sel) return none(state);
        return none({ ...state, stage: "args", selected: sel.name, argInput: "" });
      }
      case "backspace":
        return none(reQuery(state, state.query.slice(0, -1)));
      case "char":
        return key.ch ? none(reQuery(state, state.query + key.ch)) : none(state);
      default:
        return none(state);
    }
  }

  // stage === "args"
  switch (key.name) {
    case "enter":
      return {
        state,
        action: { type: "dispatch", name: state.selected ?? "", args: state.argInput.trim() },
      };
    case "backspace":
      return none({ ...state, argInput: state.argInput.slice(0, -1) });
    case "char":
      return key.ch ? none({ ...state, argInput: state.argInput + key.ch }) : none(state);
    default:
      return none(state);
  }
}

/* ── render ───────────────────────────────────────────────────────────────── */

const glyphPlain = (p: Presence): string => (p === "present" ? "✓" : p === "absent" ? "✗" : "·");

/**
 * Render the overlay to painted lines, clamped to `cols`×`rows` (truncate with `…` via the
 * width-aware clip — never wrap; a CJK glyph at the boundary is not half-sliced). Re-renders
 * purely from state so a SIGWINCH repaint at the new size is always correct.
 */
export function renderInvokeOverlay(
  state: InvokeOverlayState,
  cols: number,
  rows: number,
  caps: ColorCaps,
): string[] {
  const p = painter(caps);
  const w = Math.max(20, cols);
  const lines: string[] = [];
  lines.push(p.accent(clipToWidth("Invoke — install a repo (nemesis-gated)", w)));

  if (state.stage === "args") {
    const sel = state.selected ?? "";
    // build plain, clip to width (accurate — no embedded ANSI), then color the whole prompt cyan.
    lines.push(p.accent(clipToWidth(`  ${sel} args: ${state.argInput}▏`, w)));
    lines.push(p.muted(clipToWidth("  Enter run · Esc cancel", w)));
    return lines;
  }

  lines.push(p.muted(clipToWidth(`  filter: ${state.query || "(type to filter)"}`, w)));
  const bodyRows = Math.max(1, rows - 3); // title + filter + hint reserved
  const n = state.filtered.length;
  let top = 0;
  if (n > bodyRows) top = Math.min(Math.max(0, state.index - (bodyRows >> 1)), n - bodyRows);
  const view = state.filtered.slice(top, top + bodyRows);

  const nameW = Math.min(20, Math.max(1, ...view.map((i) => stringWidth(i.name))));
  view.forEach((item, idx) => {
    const real = top + idx;
    if (real === state.index) {
      // selected: plain glyph inside the label (selectionBar recolors the whole bar), ▌ edge marker.
      // budget w-4: ▌(1) + selectionBar's none-caps `› `(2) + the leading space(1) + label ≤ w.
      const label = clipToWidth(
        `${glyphPlain(item.presence)} ${item.name}  ${item.summary}`,
        w - 4,
      );
      lines.push(`${p.accent("▌")}${selectionBar(` ${label}`, w - 1, caps)}`);
    } else {
      const nameCut = clipToWidth(item.name, nameW);
      const sumBudget = Math.max(0, w - 5 - stringWidth(nameCut));
      const sumCut = clipToWidth(item.summary, sumBudget);
      lines.push(`  ${presenceMark(item.presence)} ${p.accent(nameCut)} ${p.muted(sumCut)}`);
    }
  });
  if (n === 0) lines.push(p.muted(clipToWidth("  (no matches)", w)));
  lines.push(p.muted(clipToWidth("  ↑↓ move · Enter select · Esc close", w)));
  return lines;
}
