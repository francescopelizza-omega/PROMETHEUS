// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/breakpoint-store.ts — the PURE breakpoint model + store (APP-012).
 *
 * ONE map of breakpoints keyed by ABSOLUTE file path (the fs/path-guard seam's
 * form — never a file:// uri, never workspace-relative), each file's list sorted
 * by its 1-based line. Both Monaco and DAP `SourceBreakpoint.line` are 1-based,
 * so lines pass through this store with ZERO conversion — a `±1` anywhere here
 * puts gutter glyphs one line off from where the adapter actually stops.
 *
 * Consumers:
 *   - EditorPane's `breakpoints` gutter provider (APP-011 layer) renders the map
 *     as filled/hollow glyphs + toggles on glyph-margin clicks;
 *   - DebugPanel lists/enables/removes them and, while a session is live, sends
 *     DAP `setBreakpoints` per affected source — REPLACE-ALL per source, so the
 *     selector emits the FULL enabled list (and an emptied source must still be
 *     sent as `breakpoints: []`, which `dapAffectedPaths` surfaces);
 *   - the adapter's response is folded back via `applySetBreakpointsResponse`
 *     (verified flag + the ADJUSTED line an adapter may snap a breakpoint to).
 *
 * Persistence reuses the renderer's localStorage session mechanism (the
 * `useAiSessionStore` pattern in stores.ts), bucketed PER WORKSPACE ROOT so each
 * project's breakpoints survive an app reload independently. Only the durable
 * fields ({line, enabled}) persist — `verified` is per-session adapter state.
 *
 * Reducers/selectors are PURE and same-ref no-ops when nothing changes (the
 * gutter-decorations contract) — node:test-able without zustand or a DOM.
 * Imports: zustand + the sibling tabs store (workspace root) only. NO monaco /
 * electron / node:* (renderer sandbox, C5).
 */

import { create } from "zustand";

import type { GutterDecorationInput, GutterRegistry } from "./gutter-decorations.js";
import { useTabsStore } from "./stores.js";

/** One breakpoint (line is 1-based, Monaco AND DAP convention — no conversion). */
export interface Breakpoint {
  /** OUR id — distinct from any adapter-assigned `body.breakpoints[].id`; DAP
   *  setBreakpoints has no request-side ids, so responses correlate by index. */
  id: string;
  /** ABSOLUTE file path (fs/path-guard form; DAP `source.path` wants exactly this). */
  path: string;
  line: number;
  enabled: boolean;
  /** boolean expression the adapter evaluates — stop only when true (APP-079). */
  condition?: string;
  /** hit-count expression the adapter evaluates (STRING: `">5"`, `"%2"`, bare `"5"`
   *  = the 5th hit) — passed through verbatim, never coerced (APP-079). */
  hitCondition?: string;
  /** LOGPOINT message (`{expr}` interpolation): the adapter logs it and does NOT
   *  pause. Requires `capabilities.supportsLogPoints` (APP-079). */
  logMessage?: string;
  /** the adapter's verdict from the last setBreakpoints response (per-session,
   *  never persisted); undefined until a live session has seen this breakpoint. */
  verified?: boolean;
}

/** The user-editable predicate fields of a breakpoint (APP-079). An empty/blank
 *  string clears the field (DAP has no "empty predicate" — omit it instead). */
export interface BreakpointPredicates {
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** Normalize a predicate value: a blank/whitespace-only string clears it (→ undefined). */
function cleanPredicate(v: string | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** True when this breakpoint is a logpoint (has a non-empty log message). */
export function isLogpoint(bp: Breakpoint): boolean {
  return typeof bp.logMessage === "string" && bp.logMessage !== "";
}

/** True when this breakpoint carries a condition or hit-count predicate. */
export function isConditional(bp: Breakpoint): boolean {
  return (
    (typeof bp.condition === "string" && bp.condition !== "") ||
    (typeof bp.hitCondition === "string" && bp.hitCondition !== "")
  );
}

/** absolute path → that file's breakpoints, sorted by line (one per line). */
export type BreakpointsState = Record<string, Breakpoint[]>;

/** The empty store state. */
export function initialBreakpointsState(): BreakpointsState {
  return {};
}

/** Normalize a breakpoint path: lowercase a leading drive letter (`C:` / `/C:`) so
 *  Windows adapters' case-sensitive source-map match stays consistent; posix paths
 *  pass through untouched. */
export function normalizeBreakpointPath(path: string): string {
  const m = /^(\/?)([A-Z])(:[/\\])/.exec(path);
  return m ? `${m[1]}${m[2]!.toLowerCase()}${m[3]}${path.slice(m[0].length)}` : path;
}

/** The house tab-uri form for an absolute path (FileTree convention: raw, unencoded). */
export function pathToFileUri(path: string): string {
  return path.startsWith("file://") ? path : `file://${path}`;
}

/** Absolute path from a file:// uri (tolerates Monaco's percent-encoded model form).
 *  Returns null for any other scheme (scratch:, untitled:, …). */
export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  const raw = uri.slice("file://".length).replace(/[?#].*$/, "");
  try {
    return normalizeBreakpointPath(decodeURIComponent(raw));
  } catch {
    return normalizeBreakpointPath(raw); // malformed escapes — keep the raw form
  }
}

/** Immutably set one file's list ([] drops the path key); assumes `list` sorted. */
function withFile(state: BreakpointsState, path: string, list: Breakpoint[]): BreakpointsState {
  const next = { ...state };
  if (list.length === 0) delete next[path];
  else next[path] = list;
  return next;
}

const byLine = (a: Breakpoint, b: Breakpoint): number => a.line - b.line;

/**
 * Toggle a breakpoint: absent → add (enabled); present (any enabled state) →
 * remove. `mintId` is injected so tests stay deterministic.
 */
export function toggleBreakpoint(
  state: BreakpointsState,
  path: string,
  line: number,
  mintId: () => string,
): BreakpointsState {
  const p = normalizeBreakpointPath(path);
  const cur = state[p] ?? [];
  const rest = cur.filter((b) => b.line !== line);
  if (rest.length < cur.length) return withFile(state, p, rest);
  const added = [...cur, { id: mintId(), path: p, line, enabled: true }].sort(byLine);
  return withFile(state, p, added);
}

/** Enable/disable one breakpoint (same-ref no-op when absent or unchanged). */
export function setBreakpointEnabled(
  state: BreakpointsState,
  path: string,
  line: number,
  enabled: boolean,
): BreakpointsState {
  const p = normalizeBreakpointPath(path);
  const cur = state[p] ?? [];
  const hit = cur.find((b) => b.line === line);
  if (!hit || hit.enabled === enabled) return state;
  return withFile(
    state,
    p,
    cur.map((b) => (b.line === line ? { ...b, enabled } : b)),
  );
}

/**
 * Patch one breakpoint's predicates (condition / hitCondition / logMessage). Only
 * the keys PRESENT in `patch` change; a blank/whitespace value CLEARS that key (DAP
 * carries no empty predicate — the field is dropped from `SourceBreakpoint`). Adds
 * the breakpoint (enabled) when absent, so a right-click "set condition/logpoint" on
 * a bare line creates one. Same-ref no-op when nothing effectively changes.
 */
export function updateBreakpoint(
  state: BreakpointsState,
  path: string,
  line: number,
  patch: BreakpointPredicates,
  mintId: () => string,
): BreakpointsState {
  const p = normalizeBreakpointPath(path);
  const cur = state[p] ?? [];
  const hit = cur.find((b) => b.line === line);
  const apply = (base: Breakpoint): Breakpoint => {
    const next = { ...base };
    for (const k of ["condition", "hitCondition", "logMessage"] as const) {
      if (!(k in patch)) continue;
      const cleaned = cleanPredicate(patch[k]);
      if (cleaned === undefined) delete next[k];
      else next[k] = cleaned;
    }
    return next;
  };
  if (!hit) {
    const seeded = apply({ id: mintId(), path: p, line, enabled: true });
    // nothing to set on a fresh breakpoint (all cleared) → don't create one.
    if (!seeded.condition && !seeded.hitCondition && !seeded.logMessage) return state;
    return withFile(state, p, [...cur, seeded].sort(byLine));
  }
  const updated = apply(hit);
  if (
    updated.condition === hit.condition &&
    updated.hitCondition === hit.hitCondition &&
    updated.logMessage === hit.logMessage
  ) {
    return state; // same-ref no-op
  }
  return withFile(
    state,
    p,
    cur.map((b) => (b.line === line ? updated : b)),
  );
}

/** Remove one breakpoint (same-ref no-op when absent). */
export function removeBreakpoint(
  state: BreakpointsState,
  path: string,
  line: number,
): BreakpointsState {
  const p = normalizeBreakpointPath(path);
  const cur = state[p] ?? [];
  const rest = cur.filter((b) => b.line !== line);
  if (rest.length === cur.length) return state;
  return withFile(state, p, rest);
}

/** Drop every breakpoint in one file (same-ref no-op when the file has none). */
export function clearFile(state: BreakpointsState, path: string): BreakpointsState {
  const p = normalizeBreakpointPath(path);
  if (!(p in state)) return state;
  const next = { ...state };
  delete next[p];
  return next;
}

/** One adapter-reported breakpoint from a setBreakpoints response body. */
interface DapBreakpointResult {
  verified: boolean;
  line?: number;
}

/** Validate one `body.breakpoints[]` entry (fail-soft: junk → null). */
function asDapResult(v: unknown): DapBreakpointResult | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    verified: o.verified === true,
    ...(typeof o.line === "number" && o.line >= 1 ? { line: o.line } : {}),
  };
}

/**
 * Fold a DAP setBreakpoints response back into the store. `sentLines` are the
 * request's `breakpoints[].line` IN ORDER — the response correlates by index
 * (setBreakpoints has no request-side ids). The adapter may ADJUST a line (snap
 * to the next executable one): the store keeps the adapter's line, or the gutter
 * glyph desyncs from where the debugger actually stops. An adjustment that lands
 * on another breakpoint's line collapses the two (first-in wins). Same-ref no-op
 * when nothing effectively changes.
 */
export function applySetBreakpointsResponse(
  state: BreakpointsState,
  path: string,
  sentLines: number[],
  results: unknown[],
): BreakpointsState {
  const p = normalizeBreakpointPath(path);
  const cur = state[p] ?? [];
  if (cur.length === 0) return state;

  const byRequestedLine = new Map<number, DapBreakpointResult>();
  sentLines.forEach((line, i) => {
    const r = asDapResult(results[i]);
    if (r) byRequestedLine.set(line, r);
  });
  if (byRequestedLine.size === 0) return state;

  let changed = false;
  const seen = new Set<number>();
  const next: Breakpoint[] = [];
  for (const b of cur) {
    const r = b.enabled ? byRequestedLine.get(b.line) : undefined;
    const line = r?.line ?? b.line;
    const verified = r ? r.verified : b.verified;
    if (seen.has(line)) {
      changed = true; // adjusted onto an existing breakpoint — collapse the pair
      continue;
    }
    seen.add(line);
    if (line !== b.line || verified !== b.verified) {
      changed = true;
      next.push({ ...b, line, ...(verified === undefined ? {} : { verified }) });
    } else {
      next.push(b);
    }
  }
  if (!changed) return state;
  return withFile(state, p, next.sort(byLine));
}

/* ── selectors ─────────────────────────────────────────────────────────────────*/

/** One `SourceBreakpoint` as DAP wants it — `{ line, condition?, hitCondition?,
 *  logMessage? }`, empty predicates OMITTED (DAP has no empty field). */
export interface DapSourceBreakpoint {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/** Project one breakpoint onto its DAP `SourceBreakpoint` (predicates passed through
 *  verbatim; blanks already normalized away at write time, re-guarded here). */
function toSourceBreakpoint(b: Breakpoint): DapSourceBreakpoint {
  const out: DapSourceBreakpoint = { line: b.line };
  const c = cleanPredicate(b.condition);
  const h = cleanPredicate(b.hitCondition);
  const l = cleanPredicate(b.logMessage);
  if (c !== undefined) out.condition = c;
  if (h !== undefined) out.hitCondition = h;
  if (l !== undefined) out.logMessage = l;
  return out;
}

/**
 * One file's ENABLED breakpoints shaped as DAP `SourceBreakpoint[]` (sorted, with
 * condition/hitCondition/logMessage). REPLACE-ALL semantics: this is the FULL list
 * for the source — `[]` means "clear this source". A disabled breakpoint is OMITTED
 * (DAP has no `enabled` field), so toggling one off re-sends the surviving set.
 */
export function toDapSourceBreakpoints(
  state: BreakpointsState,
  path: string,
): DapSourceBreakpoint[] {
  return (state[normalizeBreakpointPath(path)] ?? [])
    .filter((b) => b.enabled)
    .map(toSourceBreakpoint);
}

/** Every breakpoint, flat, sorted by path then line (the DebugPanel list shape). */
export function allBreakpoints(state: BreakpointsState): Breakpoint[] {
  return Object.keys(state)
    .sort()
    .flatMap((p) => state[p] ?? []);
}

/** The DAP-visible fingerprint of one file — line AND predicates, since a condition/
 *  hit-count/log-message edit changes what the adapter must be told (APP-079). */
function enabledLines(state: BreakpointsState, path: string): string {
  return (state[path] ?? [])
    .filter((b) => b.enabled)
    .map((b) => `${b.line}|${b.condition ?? ""}|${b.hitCondition ?? ""}|${b.logMessage ?? ""}`)
    .join(",");
}

/**
 * The paths whose DAP-visible breakpoints differ between two store snapshots —
 * each needs a fresh REPLACE-ALL `setBreakpoints` (a path that emptied out is
 * included: its `breakpoints: []` must still be sent, never omitted). Changes
 * DAP can't see (verified flags, disabled-only edits) do NOT surface here —
 * that is also what stops the response-fold-back from re-triggering a send.
 */
export function dapAffectedPaths(prev: BreakpointsState, next: BreakpointsState): string[] {
  if (prev === next) return [];
  const paths = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...paths].filter((p) => enabledLines(prev, p) !== enabledLines(next, p)).sort();
}

/**
 * Launch-time replay (DAP protocol-fixed ordering): send every source's enabled
 * breakpoints AFTER the adapter's `initialized` event and BEFORE the caller's
 * `configurationDone` — this helper awaits each send so the caller can sequence
 * configurationDone strictly after it resolves. Sources with no enabled
 * breakpoints are skipped (the adapter starts empty; there is nothing to clear).
 */
export async function replayBreakpoints(
  state: BreakpointsState,
  send: (path: string, breakpoints: DapSourceBreakpoint[]) => Promise<void>,
): Promise<void> {
  for (const path of Object.keys(state).sort()) {
    const bps = toDapSourceBreakpoints(state, path);
    if (bps.length > 0) await send(path, bps);
  }
}

/** One source's launch-time plan entry (absolute path + its enabled SourceBreakpoints). */
export interface DapSourcePlan {
  path: string;
  breakpoints: DapSourceBreakpoint[];
}

/**
 * The full launch-time breakpoint plan (APP-079): every source with ≥1 enabled
 * breakpoint, as DAP `SourceBreakpoint[]`. Handed to the HOST at launch so it can
 * queue `setBreakpoints` for the strict `initialized`→setBreakpoints→configurationDone
 * ordering (the host, not the renderer, sequences the config phase).
 */
export function dapLaunchPlan(state: BreakpointsState): DapSourcePlan[] {
  const out: DapSourcePlan[] = [];
  for (const path of Object.keys(state).sort()) {
    const breakpoints = toDapSourceBreakpoints(state, path);
    if (breakpoints.length > 0) out.push({ path, breakpoints });
  }
  return out;
}

/* ── the APP-011 gutter provider (registry wiring — monaco stays injected) ─────*/

/** The breakpoints provider id on the APP-011 gutter-decoration layer. */
export const BREAKPOINT_PROVIDER = "breakpoints";
/** Breakpoint glyph precedence (LOWER wins the visible glyph on a shared line). */
export const BREAKPOINT_GLYPH_ORDER = 10;

/** The glyph-margin class for a breakpoint: a distinct glyph for LOGPOINTS (diamond)
 *  and CONDITIONAL breakpoints (marked dot) vs a plain dot; hollow when disabled
 *  (the global.css .bp-glyph* / .bp-logpoint* classes, token-colored, no raw hex). */
export function breakpointGlyphClass(bp: Breakpoint): string {
  const kind = isLogpoint(bp) ? "logpoint" : isConditional(bp) ? "conditional" : "plain";
  if (kind === "logpoint") return bp.enabled ? "bp-logpoint" : "bp-logpoint-disabled";
  if (kind === "conditional")
    return bp.enabled ? "bp-glyph-conditional" : "bp-glyph-conditional-disabled";
  return bp.enabled ? "bp-glyph" : "bp-glyph-disabled";
}

/** A human label of a breakpoint's predicates, for the gutter hover + panel list. */
export function breakpointDetail(bp: Breakpoint): string {
  const parts: string[] = [];
  if (isLogpoint(bp)) parts.push(`log: ${bp.logMessage}`);
  if (bp.condition) parts.push(`when ${bp.condition}`);
  if (bp.hitCondition) parts.push(`hits ${bp.hitCondition}`);
  return parts.join(" · ");
}

/** One file's breakpoints as APP-011 gutter decorations: filled = enabled, hollow =
 *  disabled; logpoints + conditional breakpoints get distinct glyphs (APP-079). */
export function gutterDecorationsFor(list: Breakpoint[]): GutterDecorationInput[] {
  return list.map((b) => {
    const noun = isLogpoint(b)
      ? "Logpoint"
      : isConditional(b)
        ? "Conditional breakpoint"
        : "Breakpoint";
    const detail = breakpointDetail(b);
    return {
      line: b.line,
      glyphClassName: breakpointGlyphClass(b),
      hoverMessage: `${b.enabled ? noun : `Disabled ${noun.toLowerCase()}`} — ${b.path}:${b.line}${
        detail ? ` (${detail})` : ""
      }${b.enabled && b.verified === false ? " — unverified" : ""}`,
      order: BREAKPOINT_GLYPH_ORDER,
    };
  });
}

/** The uri seam EditorPane injects (monaco.Uri — this module never imports monaco):
 *  the registry keys by CANONICAL model uri, the store by absolute path. */
export interface BreakpointGutterUris {
  /** canonical model-uri string for an absolute path (monaco.Uri.file(p).toString()). */
  pathToModelUri(path: string): string;
  /** absolute fs path for a model uri, or null for a non-file scheme (scratch:, …). */
  modelUriToPath(uri: string): string | null;
}

/**
 * Wire the `breakpoints` provider onto the APP-011 layer: store changes REPLACE
 * the provider's decoration set per file (sweeping files that emptied out), and a
 * glyph-margin click toggles the store — including on an UNdecorated line (the
 * layer still emits there; that is the "add one here" path). Clicks on non-file
 * buffers are ignored. Returns an unwire fn (tests; the app wires once for life).
 */
export function wireBreakpointGutter(
  registry: Pick<GutterRegistry, "register" | "replaceForProvider" | "onGutterClick">,
  uris: BreakpointGutterUris,
  store: Pick<typeof useBreakpointStore, "getState" | "subscribe"> = useBreakpointStore,
): () => void {
  registry.register(BREAKPOINT_PROVIDER);
  let decorated = new Set<string>();
  const sync = (): void => {
    const byPath = store.getState().byPath;
    const next = new Set<string>();
    for (const [path, bps] of Object.entries(byPath)) {
      const uri = uris.pathToModelUri(path);
      next.add(uri);
      // replaceForProvider is idempotent — an unchanged file is a same-ref no-op.
      registry.replaceForProvider(BREAKPOINT_PROVIDER, uri, gutterDecorationsFor(bps));
    }
    for (const uri of decorated) {
      if (!next.has(uri)) registry.replaceForProvider(BREAKPOINT_PROVIDER, uri, []);
    }
    decorated = next;
  };
  const unsubStore = store.subscribe(sync);
  sync();
  const unsubClick = registry.onGutterClick((e) => {
    // another provider's glyph won this line (e.g. the APP-014 test-run icon): the
    // click is theirs — running a test must not also toggle a breakpoint. An
    // UNdecorated line still carries no providerId and adds a breakpoint here.
    if (e.providerId && e.providerId !== BREAKPOINT_PROVIDER) return;
    const path = uris.modelUriToPath(e.path);
    if (path !== null) store.getState().toggle(path, e.line);
  });
  return () => {
    unsubStore();
    unsubClick();
  };
}

/* ── persistence codec (per-workspace localStorage bucket) ─────────────────────*/

/** The durable per-file shape ({line, enabled} + optional predicates — never
 *  `verified`/ids, which are per-session/runtime state). */
export type PersistedBreakpoint = {
  line: number;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
};
export type PersistedBreakpoints = Record<string, PersistedBreakpoint[]>;

/** Project the live state onto its durable form (predicates included when set). */
export function serializeBreakpoints(state: BreakpointsState): PersistedBreakpoints {
  const out: PersistedBreakpoints = {};
  for (const [path, list] of Object.entries(state)) {
    if (list.length === 0) continue;
    out[path] = list.map((b) => {
      const e: PersistedBreakpoint = { line: b.line, enabled: b.enabled };
      if (b.condition) e.condition = b.condition;
      if (b.hitCondition) e.hitCondition = b.hitCondition;
      if (b.logMessage) e.logMessage = b.logMessage;
      return e;
    });
  }
  return out;
}

/** Rebuild live state from a persisted blob (fail-soft: junk entries are dropped,
 *  duplicate lines deduped, lists re-sorted; fresh ids are minted). */
export function deserializeBreakpoints(raw: unknown, mintId: () => string): BreakpointsState {
  if (!raw || typeof raw !== "object") return {};
  const out: BreakpointsState = {};
  for (const [path, list] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof path !== "string" || !path || !Array.isArray(list)) continue;
    const seen = new Set<number>();
    const bps: Breakpoint[] = [];
    for (const e of list) {
      if (!e || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      if (typeof o.line !== "number" || !Number.isInteger(o.line) || o.line < 1) continue;
      if (seen.has(o.line)) continue;
      seen.add(o.line);
      const bp: Breakpoint = {
        id: mintId(),
        path: normalizeBreakpointPath(path),
        line: o.line,
        enabled: o.enabled !== false,
      };
      const c = cleanPredicate(typeof o.condition === "string" ? o.condition : undefined);
      const h = cleanPredicate(typeof o.hitCondition === "string" ? o.hitCondition : undefined);
      const l = cleanPredicate(typeof o.logMessage === "string" ? o.logMessage : undefined);
      if (c !== undefined) bp.condition = c;
      if (h !== undefined) bp.hitCondition = h;
      if (l !== undefined) bp.logMessage = l;
      bps.push(bp);
    }
    if (bps.length > 0) out[normalizeBreakpointPath(path)] = bps.sort(byLine);
  }
  return out;
}

/* ── the zustand facade ────────────────────────────────────────────────────────*/

let bpSeq = 0;
function mintBpId(): string {
  bpSeq += 1;
  return `bp-${bpSeq}`;
}

export interface BreakpointStore {
  byPath: BreakpointsState;
  toggle(path: string, line: number): void;
  setEnabled(path: string, line: number, enabled: boolean): void;
  /** patch a breakpoint's condition/hitCondition/logMessage (create-if-missing). */
  update(path: string, line: number, patch: BreakpointPredicates): void;
  remove(path: string, line: number): void;
  clearFile(path: string): void;
  /** fold a DAP setBreakpoints response back in (verified + adjusted lines). */
  applyDapResponse(path: string, sentLines: number[], results: unknown[]): void;
  /** replace the whole map (boot restore / workspace switch). */
  restore(byPath: BreakpointsState): void;
}

export const useBreakpointStore = create<BreakpointStore>((set) => {
  // returning the SAME store state skips notification entirely (zustand
  // Object.is), preserving the reducers' same-ref contract end-to-end.
  const via =
    (reduce: (byPath: BreakpointsState) => BreakpointsState) =>
    (s: BreakpointStore): BreakpointStore => {
      const next = reduce(s.byPath);
      return next === s.byPath ? s : { ...s, byPath: next };
    };
  return {
    byPath: initialBreakpointsState(),
    toggle: (path, line): void => set(via((b) => toggleBreakpoint(b, path, line, mintBpId))),
    setEnabled: (path, line, enabled): void =>
      set(via((b) => setBreakpointEnabled(b, path, line, enabled))),
    update: (path, line, patch): void =>
      set(via((b) => updateBreakpoint(b, path, line, patch, mintBpId))),
    remove: (path, line): void => set(via((b) => removeBreakpoint(b, path, line))),
    clearFile: (path): void => set(via((b) => clearFile(b, path))),
    applyDapResponse: (path, sentLines, results): void =>
      set(via((b) => applySetBreakpointsResponse(b, path, sentLines, results))),
    restore: (byPath): void => set({ byPath }),
  };
});

/* ── per-workspace persistence wiring (the stores.ts localStorage pattern) ─────*/

const BREAKPOINTS_KEY = "prometheus.breakpoints";

/** Read one workspace's persisted bucket (fail-soft on junk / private mode). */
function loadPersisted(root: string): BreakpointsState {
  try {
    const raw = window.localStorage.getItem(BREAKPOINTS_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, unknown>;
    return deserializeBreakpoints(all?.[root], mintBpId);
  } catch {
    return {};
  }
}

/** Write one workspace's bucket without disturbing other workspaces' buckets. */
function savePersisted(root: string, state: BreakpointsState): void {
  try {
    let all: Record<string, unknown> = {};
    const raw = window.localStorage.getItem(BREAKPOINTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") all = parsed as Record<string, unknown>;
    }
    const bucket = serializeBreakpoints(state);
    if (Object.keys(bucket).length === 0) delete all[root];
    else all[root] = bucket;
    window.localStorage.setItem(BREAKPOINTS_KEY, JSON.stringify(all));
  } catch {
    /* private mode / quota — breakpoints just won't persist this run. */
  }
}

if (typeof window !== "undefined") {
  // restore the boot workspace's breakpoints + follow workspace switches; while a
  // root is active, every real store change writes back into that root's bucket.
  let currentRoot = useTabsStore.getState().workspaceRoot;
  let restoring = false;
  const restoreFor = (root: string | null): void => {
    restoring = true;
    useBreakpointStore.getState().restore(root ? loadPersisted(root) : {});
    restoring = false;
  };
  if (currentRoot) restoreFor(currentRoot);
  useTabsStore.subscribe((s) => {
    if (s.workspaceRoot !== currentRoot) {
      currentRoot = s.workspaceRoot;
      restoreFor(currentRoot);
    }
  });
  useBreakpointStore.subscribe((s) => {
    if (currentRoot && !restoring) savePersisted(currentRoot, s.byPath);
  });
}
