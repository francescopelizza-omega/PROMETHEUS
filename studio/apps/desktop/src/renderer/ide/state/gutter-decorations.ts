/**
 * ide/state/gutter-decorations.ts — the PURE glyph-margin decoration registry (APP-011).
 *
 * ONE registry for every feature that wants a gutter icon — breakpoints (APP-012),
 * run icons (APP-014), bookmarks, blame, coverage — instead of each hand-rolling
 * Monaco decoration plumbing. Providers register by id, add per-line decorations
 * per file, and subscribe to glyph-margin click/hover events; EditorPane owns the
 * thin Monaco wiring (ONE createDecorationsCollection per editor) and re-syncs from
 * `decorationsForFile` whenever this registry changes.
 *
 * Monaco renders only ONE glyph per line, so when several providers decorate the
 * same line the reducer resolves a single winning `glyphClassName` deterministically
 * (lowest `order`, then providerId) while hover messages stack across providers.
 *
 * Framework-free — NO monaco / react imports (C5): the mouse-target shapes Monaco
 * feeds the wiring are mirrored locally, type-only. Glyph CSS classes provided by
 * providers must color via design tokens (var(--…)), never raw hex.
 */

/** One provider's decoration on one line of one file. */
export interface GutterDecoration {
  providerId: string;
  /** 1-based line number (Monaco convention). */
  line: number;
  /** CSS class rendered in the glyph margin (token-colored, provider-supplied). */
  glyphClassName: string;
  /** optional markdown hover for the glyph (stacked across providers on a line). */
  hoverMessage?: string;
  /** precedence when providers collide on a line — LOWER wins the visible glyph. */
  order: number;
}

/** A decoration as a provider supplies it (`providerId` is stamped by the registry). */
export type GutterDecorationInput = Omit<GutterDecoration, "providerId">;

/** providerId → path → that provider's decorations in the file (line-keyed: one per line). */
export type GutterState = Record<string, Record<string, GutterDecoration[]>>;

/** The empty registry state. */
export function initialGutterState(): GutterState {
  return {};
}

/** Register a provider (idempotent — an already-registered id is a same-ref no-op). */
export function registerProvider(state: GutterState, providerId: string): GutterState {
  if (providerId in state) return state;
  return { ...state, [providerId]: {} };
}

/** Unregister a provider, dropping ALL of its decorations (same-ref no-op if unknown). */
export function unregisterProvider(state: GutterState, providerId: string): GutterState {
  if (!(providerId in state)) return state;
  const next = { ...state };
  delete next[providerId];
  return next;
}

/** A provider's decorations for a path ([] when none / provider unknown). */
function decsOf(state: GutterState, providerId: string, path: string): GutterDecoration[] {
  return state[providerId]?.[path] ?? [];
}

/** Immutably set one provider's decoration list for a path ([] drops the path key). */
function withDecs(
  state: GutterState,
  providerId: string,
  path: string,
  decs: GutterDecoration[],
): GutterState {
  const byPath = { ...state[providerId] };
  if (decs.length === 0) delete byPath[path];
  else byPath[path] = decs;
  return { ...state, [providerId]: byPath };
}

/** Two decoration lists carry identical content (order-sensitive)? */
function sameDecs(a: GutterDecoration[], b: GutterDecoration[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (d, i) =>
        d.line === b[i]?.line &&
        d.glyphClassName === b[i]?.glyphClassName &&
        d.hoverMessage === b[i]?.hoverMessage &&
        d.order === b[i]?.order,
    )
  );
}

/**
 * Add (or replace — one decoration per provider per line) a decoration. A no-op for
 * an UNREGISTERED provider: the register/unregister lifecycle is the contract that
 * lets unregister reliably sweep everything a provider owns.
 */
export function addDecoration(
  state: GutterState,
  providerId: string,
  path: string,
  dec: GutterDecorationInput,
): GutterState {
  if (!(providerId in state)) return state;
  const stamped: GutterDecoration = { ...dec, providerId };
  const rest = decsOf(state, providerId, path).filter((d) => d.line !== dec.line);
  return withDecs(state, providerId, path, [...rest, stamped]);
}

/** Remove a provider's decoration on a line (same-ref no-op when absent). */
export function removeDecoration(
  state: GutterState,
  providerId: string,
  path: string,
  line: number,
): GutterState {
  const cur = decsOf(state, providerId, path);
  const rest = cur.filter((d) => d.line !== line);
  if (rest.length === cur.length) return state;
  return withDecs(state, providerId, path, rest);
}

/**
 * Replace a provider's ENTIRE decoration set for a path (idempotent: replaying the
 * same list is a same-ref no-op). A no-op for an unregistered provider.
 */
export function replaceForProvider(
  state: GutterState,
  providerId: string,
  path: string,
  decs: GutterDecorationInput[],
): GutterState {
  if (!(providerId in state)) return state;
  const stamped = decs.map((d): GutterDecoration => ({ ...d, providerId }));
  if (sameDecs(decsOf(state, providerId, path), stamped)) return state;
  return withDecs(state, providerId, path, stamped);
}

/** One resolved gutter line: the winning glyph + every provider's hover, stacked. */
export interface GutterLineView {
  /** 1-based line number. */
  line: number;
  /** the winning glyph class (lowest `order`, then providerId — Monaco shows ONE). */
  glyphClassName: string;
  /** every provider's hover on this line, in precedence order. */
  hoverMessages: string[];
  /** every provider decorating this line, in precedence order (winner first). */
  providerIds: string[];
}

/** Precedence comparator: lower `order` wins, providerId breaks ties (deterministic). */
function byPrecedence(a: GutterDecoration, b: GutterDecoration): number {
  return a.order - b.order || a.providerId.localeCompare(b.providerId);
}

/**
 * Project every provider's decorations for one file into per-line resolved views,
 * sorted by line — the shape EditorPane feeds into its decorations collection.
 */
export function decorationsForFile(state: GutterState, path: string): GutterLineView[] {
  const byLine = new Map<number, GutterDecoration[]>();
  for (const providerId of Object.keys(state).sort()) {
    for (const d of decsOf(state, providerId, path)) {
      const list = byLine.get(d.line);
      if (list) list.push(d);
      else byLine.set(d.line, [d]);
    }
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, decs]) => {
      decs.sort(byPrecedence);
      return {
        line,
        glyphClassName: decs[0]?.glyphClassName ?? "",
        hoverMessages: decs.map((d) => d.hoverMessage).filter((m): m is string => !!m),
        providerIds: decs.map((d) => d.providerId),
      };
    });
}

/* ── glyph-margin mouse events (mirrored Monaco shapes — C5, no monaco import) ────*/

/** Monaco's `editor.MouseTargetType.GUTTER_GLYPH_MARGIN` enum value (mirrored). */
export const GUTTER_GLYPH_MARGIN = 2;

/** The slice of Monaco's IEditorMouseEvent the layer consumes (structural). */
export interface EditorMouseEventLike {
  target: {
    type: number;
    /** null when the pointer is over empty margin below the last line. */
    position?: { lineNumber: number } | null;
  };
}

/** A glyph-margin click/hover, resolved against the registry state. */
export interface GutterMouseEvent {
  path: string;
  /** 1-based line number. */
  line: number;
  /** the winning provider decorating this line (absent on an undecorated line). */
  providerId?: string;
}

/**
 * Filter a Monaco mouse event to the glyph margin: returns the gutter event (with
 * the line's winning provider, when decorated) or null for any other target /
 * a null position (empty margin). An UNdecorated glyph-margin line still emits —
 * that is how a breakpoint provider (APP-012) hears "add one here".
 */
export function gutterEventFromMouse(
  e: EditorMouseEventLike,
  path: string,
  state: GutterState,
): GutterMouseEvent | null {
  if (e.target.type !== GUTTER_GLYPH_MARGIN) return null;
  const line = e.target.position?.lineNumber;
  if (typeof line !== "number") return null;
  const winner = decorationsForFile(state, path).find((v) => v.line === line)?.providerIds[0];
  return { path, line, ...(winner ? { providerId: winner } : {}) };
}

/* ── the registry: reducer state + change/click/hover subscriptions ───────────────*/

/** Unsubscribe handle returned by every subscription. */
export type Unsubscribe = () => void;

/** The stateful registry facade EditorPane and providers share (thin over the reducers). */
export interface GutterRegistry {
  getState(): GutterState;
  register(providerId: string): void;
  /** removes the provider AND all of its decorations (state change notifies EditorPane). */
  unregister(providerId: string): void;
  add(providerId: string, path: string, dec: GutterDecorationInput): void;
  remove(providerId: string, path: string, line: number): void;
  replaceForProvider(providerId: string, path: string, decs: GutterDecorationInput[]): void;
  decorationsForFile(path: string): GutterLineView[];
  /** notified after every real state change (same-ref no-ops don't fire). */
  subscribe(fn: () => void): Unsubscribe;
  onGutterClick(fn: (e: GutterMouseEvent) => void): Unsubscribe;
  onGutterHover(fn: (e: GutterMouseEvent) => void): Unsubscribe;
  /** dispatch a filtered glyph-margin click to every click subscriber. */
  emitClick(e: GutterMouseEvent): void;
  /** dispatch a hover, DEDUPED by path+line (onMouseMove fires per-pixel). */
  emitHover(e: GutterMouseEvent): void;
  /** reset the hover dedupe (pointer left the glyph margin) so a re-hover re-emits. */
  clearHover(): void;
}

/** Build an isolated registry (tests); the app shares the `gutterRegistry` singleton. */
export function createGutterRegistry(): GutterRegistry {
  let state = initialGutterState();
  const changed = new Set<() => void>();
  const clicks = new Set<(e: GutterMouseEvent) => void>();
  const hovers = new Set<(e: GutterMouseEvent) => void>();
  let lastHover: { path: string; line: number } | null = null;

  const commit = (next: GutterState): void => {
    if (next === state) return;
    state = next;
    for (const fn of [...changed]) fn();
  };
  const on = <T>(set: Set<(e: T) => void>, fn: (e: T) => void): Unsubscribe => {
    set.add(fn);
    return () => set.delete(fn);
  };

  return {
    getState: () => state,
    register: (providerId): void => commit(registerProvider(state, providerId)),
    unregister: (providerId): void => {
      commit(unregisterProvider(state, providerId));
    },
    add: (providerId, path, dec): void => commit(addDecoration(state, providerId, path, dec)),
    remove: (providerId, path, line): void =>
      commit(removeDecoration(state, providerId, path, line)),
    replaceForProvider: (providerId, path, decs): void =>
      commit(replaceForProvider(state, providerId, path, decs)),
    decorationsForFile: (path) => decorationsForFile(state, path),
    subscribe: (fn) => on(changed, fn),
    onGutterClick: (fn) => on(clicks, fn),
    onGutterHover: (fn) => on(hovers, fn),
    emitClick: (e): void => {
      for (const fn of [...clicks]) fn(e);
    },
    emitHover: (e): void => {
      if (lastHover && lastHover.path === e.path && lastHover.line === e.line) return;
      lastHover = { path: e.path, line: e.line };
      for (const fn of [...hovers]) fn(e);
    },
    clearHover: (): void => {
      lastHover = null;
    },
  };
}

/** The app-wide registry every gutter provider and EditorPane share. */
export const gutterRegistry: GutterRegistry = createGutterRegistry();
