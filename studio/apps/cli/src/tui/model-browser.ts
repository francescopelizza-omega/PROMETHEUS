// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * tui/model-browser.ts — the full-screen `/model` picker.
 *
 * Modelled on the disk-space explorer (studio/python/tools/disk_space.py): a header with the
 * machine, a RAM gauge, a breadcrumb, then three panes — LAYERS (Local by RAM tier, serving
 * now, cloud, the spinner, the model servers) │ the MODELS of that layer, two rows each (name on
 * the left with the line under it left empty, the model's two description lines beside it, the
 * RAM it needs and the server that will run it on the right) │ DETAILS of the highlighted model,
 * including what choosing it will do. A status line and a key-hint bar close the screen.
 *
 * Pure: state in, state out, lines out. The data (rows, verdicts, the "what Enter does" text)
 * is built by the session from the same core planner every other surface uses
 * (`session/model-browser-data.ts`); this module only lays it out and moves the cursor. Its one
 * output is a command line to submit — `/models use local:<id>@<runtime>`, `/server lmstudio` —
 * so a pick re-enters the exact code path a typed command takes, with every confirmation,
 * nemesis gate and download consent that path already has. Nothing is installed from here.
 */
import type { KeyEvent } from "./keys.js";
import { type ColorCaps, type Role, paint, selectionBar } from "./palette.js";
import { clipToWidth, padToWidth, stringWidth, wrapLine } from "./width.js";

/* ------------------------------------------------------------------------- *
 * Data
 * ------------------------------------------------------------------------- */

/** How a row reads at a glance — the glyph and colour in front of its name. */
export type BrowserBadge =
  | "fits"
  | "tight"
  | "small-quant"
  | "too-big"
  | "no-build"
  | "no-disk"
  | "serving"
  | "installed"
  | "cloud"
  | "needs-key"
  | "server"
  | "slow";

/** One line in the details pane; `role` tints it. */
export type DetailLine = string | { text: string; role: Role };

export interface BrowserItem {
  /** unique within its layer. */
  key: string;
  label: string;
  /** the model's two description lines (right of the name). */
  lines: readonly [string, string];
  badge: BrowserBadge;
  /** right-hand column, first row: what it needs ("16 GB"). */
  need?: string;
  /** right-hand column, second row: who runs it ("LM Studio", "cloud"). */
  runner?: string;
  /** the command Enter submits. Absent with `disabled` set. */
  submit?: string;
  /** why Enter does nothing; shown on the status line. The row stays visible. */
  disabled?: string;
  /**
   * The "run it anyway" path for a model too big for this machine: `!` submits this command,
   * which streams the model's layers from disk (AirLLM, colibri, llama.cpp from SSD). The
   * session still asks the user to type the model's name before anything is installed.
   */
  insist?: { submit: string; runtime: string; speed: string };
  current?: boolean;
  /** lowercase text the filter searches. */
  search: string;
  /** capability tags the `c` filter cycles through. */
  traits?: readonly string[];
  sort: { ramGb: number; name: string; released: string; paramsB: number };
  /** RAM gauge in the details pane: need vs the machine. */
  ram?: { needGb: number; totalGb: number };
  /** the details pane, built only for the highlighted row. */
  details: () => readonly DetailLine[];
}

export interface BrowserLayer {
  id: string;
  label: string;
  /** 0 = a section heading, 1 = indented under the previous heading. */
  depth: 0 | 1;
  items: readonly BrowserItem[];
  /** shown in the list pane when the layer has no rows. */
  empty?: string;
  /** a sub-heading in the breadcrumb ("2–4 GB RAM"). */
  note?: string;
}

export interface BrowserData {
  /** left of the header, after the product mark: the machine. */
  machine: string;
  /** right of the header: the default server and its state. */
  server: string;
  /** the RAM gauge on the second row. */
  ram?: { totalGb: number; freeGb?: number; budgetGb: number };
  layers: readonly BrowserLayer[];
  /** the layer to open on (by id). */
  start?: string;
}

/* ------------------------------------------------------------------------- *
 * State
 * ------------------------------------------------------------------------- */

export type BrowserSort = "ram" | "name" | "new" | "size";
const SORTS: readonly BrowserSort[] = ["ram", "name", "new", "size"];
const SORT_LABEL: Record<BrowserSort, string> = {
  ram: "RAM ▲",
  name: "name",
  new: "newest",
  size: "size ▼",
};

export type BrowserTrait = "all" | "coding" | "tools" | "reasoning" | "vision";
const TRAITS: readonly BrowserTrait[] = ["all", "coding", "tools", "reasoning", "vision"];

export interface BrowserState {
  data: BrowserData;
  layer: number;
  focus: "layers" | "list";
  index: number;
  query: string;
  /** typing into the filter (after `/`). */
  editing: boolean;
  sort: BrowserSort;
  trait: BrowserTrait;
  fitsOnly: boolean;
  /** the details pane fills the screen (narrow terminals: `i`). */
  zoom: boolean;
  /** one status-line message, cleared by the next key. */
  message?: { text: string; role: Role };
}

export type BrowserAction = { type: "none" } | { type: "close" } | { type: "pick"; text: string };

/** The smallest screen the browser draws on; below it the session uses the inline overlay. */
export const BROWSER_MIN = { cols: 72, rows: 18 } as const;

export function browserFits(cols: number, rows: number): boolean {
  return cols >= BROWSER_MIN.cols && rows >= BROWSER_MIN.rows;
}

export function openBrowser(data: BrowserData): BrowserState {
  const at = data.start ? data.layers.findIndex((l) => l.id === data.start) : -1;
  const layer =
    at >= 0
      ? at
      : Math.max(
          0,
          data.layers.findIndex((l) => l.items.length > 0),
        );
  // `index` addresses visibleItems() (sorted, current pinned first) — NOT the raw layer list:
  // the raw position of the current model highlighted, and Enter picked, a different row.
  // The current model is always row 0 of the visible list.
  return {
    data,
    layer,
    focus: "list",
    index: 0,
    query: "",
    editing: false,
    sort: "ram",
    trait: "all",
    fitsOnly: false,
    zoom: false,
  };
}

const RUNNABLE: ReadonlySet<BrowserBadge> = new Set<BrowserBadge>([
  "fits",
  "tight",
  "small-quant",
  "serving",
  "installed",
  "cloud",
  "needs-key",
  "server",
]);

/** The rows of the current layer after the filter, the trait, "fits only" and the sort. */
export function visibleItems(state: BrowserState): BrowserItem[] {
  const all = state.data.layers[state.layer]?.items ?? [];
  const words = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = all.filter(
    (it) =>
      words.every((w) => it.search.includes(w)) &&
      (state.trait === "all" || (it.traits ?? []).includes(state.trait)) &&
      (!state.fitsOnly || RUNNABLE.has(it.badge)),
  );
  const by: Record<BrowserSort, (a: BrowserItem, b: BrowserItem) => number> = {
    ram: (a, b) => a.sort.ramGb - b.sort.ramGb || a.sort.name.localeCompare(b.sort.name),
    name: (a, b) => a.sort.name.localeCompare(b.sort.name),
    new: (a, b) =>
      b.sort.released.localeCompare(a.sort.released) || a.sort.name.localeCompare(b.sort.name),
    size: (a, b) => b.sort.paramsB - a.sort.paramsB || a.sort.name.localeCompare(b.sort.name),
  };
  // served / current rows stay on top of every sort: they cost nothing to pick
  const pinned = (it: BrowserItem): number => (it.current ? 0 : it.badge === "serving" ? 1 : 2);
  return rows.sort((a, b) => pinned(a) - pinned(b) || by[state.sort](a, b));
}

function clampIndex(state: BrowserState): BrowserState {
  const n = visibleItems(state).length;
  return { ...state, index: n === 0 ? 0 : Math.max(0, Math.min(state.index, n - 1)) };
}

function selected(state: BrowserState): BrowserItem | undefined {
  return visibleItems(state)[state.index];
}

/* ------------------------------------------------------------------------- *
 * Keys
 * ------------------------------------------------------------------------- */

type Step = { state: BrowserState; action: BrowserAction };
const none = (state: BrowserState): Step => ({ state, action: { type: "none" } });

function moveLayer(state: BrowserState, delta: number): BrowserState {
  const n = state.data.layers.length;
  if (n === 0) return state;
  const layer = (((state.layer + delta) % n) + n) % n;
  return { ...state, layer, index: 0 };
}

function moveRow(state: BrowserState, delta: number): BrowserState {
  const n = visibleItems(state).length;
  if (n === 0) return state;
  return { ...state, index: Math.max(0, Math.min(n - 1, state.index + delta)) };
}

function choose(state: BrowserState): Step {
  const it = selected(state);
  if (!it) return none({ ...state, message: { text: "Nothing to choose here.", role: "muted" } });
  if (it.disabled || !it.submit) {
    const extra = it.insist ? `  Press ! to run it anyway via ${it.insist.runtime}.` : "";
    return none({
      ...state,
      message: { text: `${it.disabled ?? "This row cannot be chosen."}${extra}`, role: "warn" },
    });
  }
  return { state, action: { type: "pick", text: it.submit } };
}

function insist(state: BrowserState): Step {
  const it = selected(state);
  if (!it) return none(state);
  if (!it.insist) {
    const text =
      it.badge === "too-big" || it.badge === "no-build"
        ? "No disk-streaming runtime can run this model here."
        : it.badge === "no-disk"
          ? "Not enough free disk for this download — free some space first."
          : it.badge === "cloud" || it.badge === "needs-key" || it.badge === "server"
            ? "Streaming from disk applies to local models only — press Enter to use this one."
            : "This model already runs here — press Enter.";
    return none({ ...state, message: { text, role: "muted" } });
  }
  return { state, action: { type: "pick", text: it.insist.submit } };
}

/** Advance the browser by one key. */
/** Below this width the layers pane is not drawn (see renderBrowser). */
export const LAYERS_PANE_MIN_COLS = 90;

export function onBrowserKey(state0: BrowserState, key: KeyEvent, cols?: number): Step {
  const state: BrowserState = state0.message ? { ...state0, message: undefined } : state0;
  if (key.name === "ctrl-c") return { state, action: { type: "close" } };

  // ── typing a filter ──
  if (state.editing) {
    switch (key.name) {
      case "enter":
        return none({ ...state, editing: false });
      case "esc":
        return none(clampIndex({ ...state, editing: false, query: "" }));
      case "backspace":
        return none(clampIndex({ ...state, query: state.query.slice(0, -1), index: 0 }));
      case "char":
      case "paste":
        return none(
          clampIndex({
            ...state,
            query: `${state.query}${(key.ch ?? "").replace(/[\r\n\t]/g, " ")}`,
            index: 0,
          }),
        );
      case "up":
      case "down":
        return none({ ...moveRow(state, key.name === "up" ? -1 : 1), editing: false });
      default:
        return none(state);
    }
  }

  const ch = key.name === "char" ? key.ch : undefined;
  if (key.name === "esc") {
    if (state.zoom) return none({ ...state, zoom: false });
    if (state.query) return none(clampIndex({ ...state, query: "" }));
    if (state.focus === "list") return none({ ...state, focus: "layers" });
    return { state, action: { type: "close" } };
  }
  if (ch === "q") return { state, action: { type: "close" } };
  if (ch === "/") return none({ ...state, editing: true, focus: "list" });
  if (ch === "s") {
    const sort = SORTS[(SORTS.indexOf(state.sort) + 1) % SORTS.length] ?? "ram";
    return none({ ...state, sort, index: 0 });
  }
  if (ch === "c") {
    const trait = TRAITS[(TRAITS.indexOf(state.trait) + 1) % TRAITS.length] ?? "all";
    return none(clampIndex({ ...state, trait, index: 0 }));
  }
  if (ch === "f") return none(clampIndex({ ...state, fitsOnly: !state.fitsOnly, index: 0 }));
  if (ch === "i") return none({ ...state, zoom: !state.zoom });
  if (ch === "!") return insist(state);

  if (state.focus === "layers") {
    switch (key.name) {
      case "up":
        return none(moveLayer(state, -1));
      case "down":
        return none(moveLayer(state, 1));
      case "right":
      case "enter":
      case "tab":
        return none({ ...state, focus: "list" });
      default:
        if (ch === "k") return none(moveLayer(state, -1));
        if (ch === "j") return none(moveLayer(state, 1));
        if (ch === "l") return none({ ...state, focus: "list" });
        return none(state);
    }
  }

  // No layers pane on a narrow terminal: ← → switch layers, as the title says. → used to
  // SUBMIT the highlighted model and ← focused a pane that is not drawn.
  if (cols !== undefined && cols - 1 < LAYERS_PANE_MIN_COLS) {
    if (key.name === "left") return none(moveLayer(state, -1));
    if (key.name === "right") return none(moveLayer(state, 1));
  }
  switch (key.name) {
    case "up":
      return none(moveRow(state, -1));
    case "down":
      return none(moveRow(state, 1));
    case "pageup":
      return none(moveRow(state, -10));
    case "pagedown":
      return none(moveRow(state, 10));
    case "home":
      return none({ ...state, index: 0 });
    case "end":
      return none(moveRow(state, Number.MAX_SAFE_INTEGER));
    case "left":
    case "backtab":
    case "backspace":
      return none({ ...state, focus: "layers" });
    case "tab":
      return none(moveLayer(state, 1));
    case "enter":
    case "right":
      return choose(state);
    default:
      if (ch === "k") return none(moveRow(state, -1));
      if (ch === "j") return none(moveRow(state, 1));
      if (ch === "g") return none({ ...state, index: 0 });
      if (ch === "G") return none(moveRow(state, Number.MAX_SAFE_INTEGER));
      if (ch === "h") return none({ ...state, focus: "layers" });
      if (ch === "l") return choose(state);
      return none(state);
  }
}

/* ------------------------------------------------------------------------- *
 * Render
 * ------------------------------------------------------------------------- */

const BADGE: Record<BrowserBadge, { glyph: string; role: Role }> = {
  fits: { glyph: "✓", role: "traitOn" },
  installed: { glyph: "✓", role: "traitOn" },
  serving: { glyph: "●", role: "accent" },
  tight: { glyph: "≈", role: "warn" },
  "small-quant": { glyph: "↓", role: "warn" },
  slow: { glyph: "⇅", role: "warn" },
  "too-big": { glyph: "✗", role: "danger" },
  "no-build": { glyph: "–", role: "muted" },
  "no-disk": { glyph: "⛁", role: "danger" },
  cloud: { glyph: "☁", role: "info" },
  "needs-key": { glyph: "⚿", role: "warn" },
  server: { glyph: "▣", role: "accent" },
};

/**
 * The highlighted row, exactly `w` columns. `selectionBar` prefixes `› ` in monochrome, which
 * would push a padded row two columns past its pane (and clip its right-hand column).
 */
function highlight(text: string, w: number, caps: ColorCaps): string {
  // monochrome: the marker takes the row's first column instead of pushing the row right
  return caps === "none" ? cell(`›${text.slice(1)}`, w) : selectionBar(cell(text, w), w, caps);
}

/** `s` clipped or padded to exactly `w` columns (never wider). */
function cell(s: string, w: number): string {
  if (w <= 0) return "";
  return padToWidth(stringWidth(s) > w ? clipToWidth(s, w) : s, w);
}

function gauge(fraction: number, width: number, caps: ColorCaps, role: Role): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const eighths = Math.round(f * width * 8);
  const full = Math.floor(eighths / 8);
  const part = eighths % 8;
  const parts = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const bar = "█".repeat(full) + (full < width ? (parts[part] ?? "") : "");
  const rest = " ".repeat(Math.max(0, width - stringWidth(bar)));
  return paint(bar, role, caps) + paint(rest.replace(/ /g, "░"), "muted", caps);
}

const fmtGb = (gb: number): string =>
  gb >= 1024 ? `${Math.round((gb / 1024) * 10) / 10} TB` : `${Math.round(gb * 10) / 10} GB`;

/** A rounded box: `title` in the top border, `body` lines inside (already ≤ inner width). */
function box(
  title: string,
  right: string,
  body: readonly string[],
  w: number,
  h: number,
  focused: boolean,
  caps: ColorCaps,
): string[] {
  const role: Role = focused ? "accent" : "muted";
  const inner = Math.max(0, w - 2);
  const t = title ? ` ${title} ` : "";
  const r = right ? ` ${right} ` : "";
  const room = Math.max(0, inner - stringWidth(t) - stringWidth(r));
  const top = `╭${clipToWidth(t, inner)}${"─".repeat(room)}${stringWidth(t) + stringWidth(r) <= inner ? r : ""}╮`;
  const out = [paint(cell(top, w), role, caps)];
  for (let i = 0; i < h - 2; i++) {
    const line = body[i] ?? "";
    out.push(`${paint("│", role, caps)}${cell(line, inner)}${paint("│", role, caps)}`);
  }
  out.push(paint(`╰${"─".repeat(inner)}╯`, role, caps));
  return out;
}

function layersBody(state: BrowserState, inner: number, h: number, caps: ColorCaps): string[] {
  const out: string[] = [];
  const layers = state.data.layers;
  const top = Math.max(0, Math.min(state.layer - Math.floor(h / 2), layers.length - h));
  for (let i = top; i < Math.min(layers.length, top + h); i++) {
    const l = layers[i];
    if (!l) continue;
    const count = String(l.items.length);
    // column 0 is the marker's (▸ / ›), so a label never loses its first letter to it
    const indent = l.depth === 1 ? "   " : " ";
    const label = cell(`${indent}${l.label}`, Math.max(1, inner - count.length - 2));
    const text = `${label} ${count} `;
    if (i === state.layer) {
      out.push(
        state.focus === "layers"
          ? highlight(text, inner, caps)
          : paint(cell(`▸${text.slice(1)}`, inner), "accent", caps),
      );
    } else {
      out.push(paint(cell(text, inner), l.depth === 0 ? "heading" : "plain", caps));
    }
  }
  return out;
}

function listBody(
  state: BrowserState,
  items: readonly BrowserItem[],
  inner: number,
  h: number,
  caps: ColorCaps,
): string[] {
  if (items.length === 0) {
    const layer = state.data.layers[state.layer];
    const why =
      state.query || state.trait !== "all" || state.fitsOnly
        ? "No model matches these filters — Esc clears the search, c / f change the filters."
        : (layer?.empty ?? "Nothing here.");
    return wrapLine(why, inner).map((l) => paint(l, "muted", caps));
  }
  const rightW = Math.min(12, Math.max(8, Math.floor(inner * 0.12)));
  const nameW = Math.max(14, Math.min(34, Math.floor(inner * 0.3)));
  const descW = Math.max(0, inner - 3 - nameW - 1 - 1 - rightW);
  const per = Math.max(1, Math.floor(h / 2));
  const top = Math.max(0, Math.min(state.index - Math.floor(per / 2), items.length - per));
  const out: string[] = [];
  for (let i = top; i < Math.min(items.length, top + per); i++) {
    const it = items[i];
    if (!it) continue;
    const b = BADGE[it.badge];
    const dim = it.disabled !== undefined;
    const mark = it.current ? "▶" : " ";
    const name = `${it.label}${it.current ? " ← current" : ""}`;
    const row1 = `${mark}${b.glyph} ${cell(name, nameW)} ${cell(it.lines[0], descW)} ${cell(it.need ?? "", rightW)}`;
    const row2 = `   ${cell("", nameW)} ${cell(it.lines[1], descW)} ${cell(it.runner ?? "", rightW)}`;
    if (i === state.index && state.focus === "list") {
      out.push(highlight(row1, inner, caps));
      out.push(highlight(row2, inner, caps));
      continue;
    }
    const head = `${mark}${paint(b.glyph, b.role, caps)} `;
    const nameP = paint(cell(name, nameW), dim ? "muted" : it.current ? "accent" : "heading", caps);
    const d1 = paint(cell(it.lines[0], descW), dim ? "muted" : "plain", caps);
    const d2 = paint(cell(it.lines[1], descW), "muted", caps);
    const needP = paint(cell(it.need ?? "", rightW), dim ? "muted" : b.role, caps);
    const runP = paint(cell(it.runner ?? "", rightW), "info", caps);
    out.push(`${head}${nameP} ${d1} ${needP}`);
    out.push(`   ${cell("", nameW)} ${d2} ${runP}`);
  }
  return out;
}

function detailsBody(it: BrowserItem | undefined, inner: number, caps: ColorCaps): string[] {
  if (!it) return [];
  const out: string[] = [];
  out.push(paint(clipToWidth(it.label, inner), "heading", caps));
  if (it.ram) {
    const label = `RAM ${fmtGb(it.ram.needGb)} of ${fmtGb(it.ram.totalGb)}`;
    const gw = Math.max(6, inner - stringWidth(label) - 1);
    const frac = it.ram.totalGb > 0 ? it.ram.needGb / it.ram.totalGb : 1;
    const role: Role = frac > 1 ? "danger" : frac > 0.8 ? "warn" : "traitOn";
    out.push(`${gauge(frac, gw, caps, role)} ${paint(label, role, caps)}`);
  }
  out.push("");
  for (const d of it.details()) {
    const text = typeof d === "string" ? d : d.text;
    const role: Role = typeof d === "string" ? "plain" : d.role;
    if (text === "") {
      out.push("");
      continue;
    }
    for (const l of wrapLine(text, inner)) out.push(paint(l, role, caps));
  }
  return out;
}

function header(state: BrowserState, w: number, caps: ColorCaps): string[] {
  const d = state.data;
  const left = `◆ Prometheus · Models  ${d.machine}`;
  const right = d.server;
  const gap = Math.max(1, w - stringWidth(left) - stringWidth(right));
  const row0 =
    stringWidth(left) + stringWidth(right) + 1 <= w
      ? `${paint(left, "brand", caps)}${" ".repeat(gap)}${paint(right, "info", caps)}`
      : paint(cell(left, w), "brand", caps);
  let row1 = "";
  if (d.ram) {
    const free = d.ram.freeGb !== undefined ? ` · ${fmtGb(d.ram.freeGb)} free now` : "";
    const text = ` ${fmtGb(d.ram.totalGb)} RAM${free} · models up to ≈${fmtGb(d.ram.budgetGb)} run natively`;
    const gw = Math.max(10, Math.min(36, w - stringWidth(text) - 6));
    const used =
      d.ram.freeGb !== undefined && d.ram.totalGb > 0 ? 1 - d.ram.freeGb / d.ram.totalGb : 0;
    row1 = cell(`RAM ${gauge(used, gw, caps, used > 0.85 ? "warn" : "fleetOurs")}${text}`, w);
  }
  const layer = d.layers[state.layer];
  const parent = layer?.depth === 1 ? findParent(d.layers, state.layer) : undefined;
  const crumbs = ["Models", ...(parent ? [parent.label] : []), layer?.label ?? ""].join(" › ");
  const items = visibleItems(state);
  const runnable = items.filter((i) => RUNNABLE.has(i.badge)).length;
  const bits = [
    `${items.length} shown`,
    ...(layer && items.length !== layer.items.length ? [`of ${layer.items.length}`] : []),
    `${runnable} usable`,
    `sort ${SORT_LABEL[state.sort]}`,
    ...(state.trait !== "all" ? [`only ${state.trait}`] : []),
    ...(state.fitsOnly ? ["fits only"] : []),
  ].join(" · ");
  const crumb = `▌ ${crumbs}${layer?.note ? `  (${layer.note})` : ""}`;
  const q =
    state.editing || state.query ? `  search: ${state.query}${state.editing ? "▏" : ""}` : "";
  const leftC = `${crumb}${q}`;
  const gap2 = Math.max(1, w - stringWidth(leftC) - stringWidth(bits) - 2);
  const row2 =
    stringWidth(leftC) + stringWidth(bits) + 3 <= w
      ? `${paint(leftC, "accent", caps)}${" ".repeat(gap2)}${paint(`[${bits}]`, "muted", caps)}`
      : paint(cell(leftC, w), "accent", caps);
  return [row0, row1, row2];
}

function findParent(layers: readonly BrowserLayer[], at: number): BrowserLayer | undefined {
  for (let i = at - 1; i >= 0; i--) if (layers[i]?.depth === 0) return layers[i];
  return undefined;
}

function statusLine(
  state: BrowserState,
  it: BrowserItem | undefined,
  w: number,
  caps: ColorCaps,
): string {
  if (state.message) return paint(cell(`▸ ${state.message.text}`, w), state.message.role, caps);
  if (!it) return "";
  if (it.disabled) {
    const extra = it.insist
      ? `  ·  ! runs it anyway via ${it.insist.runtime} (${it.insist.speed})`
      : "";
    return paint(cell(`✗ ${it.disabled}${extra}`, w), it.insist ? "warn" : "danger", caps);
  }
  return paint(cell(`Enter: ${it.submit ?? ""}`, w), "muted", caps);
}

function keyBar(state: BrowserState, w: number, caps: ColorCaps): string {
  const keys = state.editing
    ? "type to search · Enter keep · Esc clear"
    : state.focus === "layers"
      ? "↑↓ layer · → / Enter open · / search · s sort · c filter · f fits only · q close"
      : "↑↓ move · Enter choose · ! run anyway (stream from disk) · ← layers · Tab next layer · / search · s sort · c filter · f fits only · i details · q close";
  return paint(cell(keys, w), "muted", caps);
}

/** Exactly `rows` lines, each at most `cols - 1` columns wide (the last column is never drawn). */
export function renderBrowser(
  state: BrowserState,
  cols: number,
  rows: number,
  caps: ColorCaps,
): string[] {
  const w = Math.max(20, cols - 1);
  const h = Math.max(6, rows);
  const items = visibleItems(state);
  const it = items[state.index];
  const lines: string[] = header(state, w, caps);
  const paneH = h - lines.length - 2;
  const layer = state.data.layers[state.layer];

  if (state.zoom) {
    const body = detailsBody(it, w - 2, caps);
    lines.push(...box("Details", "i / Esc back", body, w, paneH, true, caps));
  } else {
    const showLayers = w >= LAYERS_PANE_MIN_COLS;
    const layersW = showLayers ? Math.min(32, Math.max(24, Math.floor(w * 0.17))) : 0;
    const detailsW = w >= 150 ? Math.min(56, Math.floor(w * 0.3)) : w >= 128 ? 40 : 0;
    const listW = w - layersW - detailsW;
    const panes: string[][] = [];
    if (showLayers) {
      panes.push(
        box(
          "Layers",
          "",
          layersBody(state, layersW - 2, paneH - 2, caps),
          layersW,
          paneH,
          state.focus === "layers",
          caps,
        ),
      );
    }
    const title = `${layer?.label ?? "Models"}${showLayers ? "" : "  ← → layers"}`;
    panes.push(
      box(
        title,
        `${items.length} rows`,
        listBody(state, items, listW - 2, paneH - 2, caps),
        listW,
        paneH,
        state.focus === "list",
        caps,
      ),
    );
    if (detailsW > 0) {
      panes.push(
        box("Details", "", detailsBody(it, detailsW - 2, caps), detailsW, paneH, false, caps),
      );
    }
    for (let r = 0; r < paneH; r++) lines.push(panes.map((p) => p[r] ?? "").join(""));
  }
  lines.push(statusLine(state, it, w, caps));
  lines.push(keyBar(state, w, caps));
  while (lines.length < h) lines.push("");
  return lines.slice(0, h);
}
