/**
 * ide/state/tabs-reducer.ts — the PURE tab / model-swap reducer (file 07 §3.1).
 *
 * Monaco's unit is the ITextModel (one per file, keyed by URI). The renderer keeps
 * ONE Monaco editor instance per visible group and SWAPS models into it on tab
 * switch — never one editor per tab (memory blows up, §3.1/§11). This module owns
 * the PURE state math behind that: which docs are open, which is active per group,
 * the preview-tab promotion rule, the dirty flag, and the split bookkeeping.
 *
 * It is framework-free — NO monaco / react / electron / window.prometheus — so the
 * model-swap discipline is fully testable in isolation (file 07 build-notes: "tab/
 * model-swap reducer"). The React EditorPane binds the live `monaco.ITextModel`
 * objects to the `uri`s this reducer tracks; the reducer never holds a live handle.
 *
 * Node built-ins only (none needed — pure data).
 */

/** The plain, serialisable descriptor of one open document (no live monaco handle). */
export interface TabDoc {
  /** file:///abs/path — the canonical key (matches the Monaco model URI). */
  uri: string;
  /** display name (basename), precomputed so the tab bar needs no path math. */
  name: string;
  /** 'python' | 'typescript' | … (from the language detector). */
  languageId: string;
  /** unsaved edits pending a save (file 07 §3.1 dirty flag). */
  dirty: boolean;
  /**
   * Preview tabs (single-click in the tree = italic, replaceable) keep the tab bar
   * from exploding during navigation (§3.1). A preview tab is REPLACED by the next
   * preview open in the same group; an edit/double-click PINS it (preview=false).
   */
  preview: boolean;
  /** which split group this tab lives in (§3.1 multi-tab + split). */
  group: number;
  /** opened in the large-file read-only / no-LSP mode (§3.1 large-file guard). */
  large: boolean;
}

/** The whole tabs state (one Monaco editor per group + the active uri per group). */
export interface TabsState {
  /** open docs in tab-bar order (a list, not a Map, so order is explicit + stable). */
  docs: TabDoc[];
  /** the active uri per group (the model the group's single editor currently shows). */
  activeByGroup: Record<number, string>;
  /** the group whose editor has focus (drives "open in active group"). */
  focusedGroup: number;
}

/** The empty initial state — one group (0), nothing open. */
export function initialTabsState(): TabsState {
  return { docs: [], activeByGroup: {}, focusedGroup: 0 };
}

/** Options when opening a uri. */
export interface OpenOpts {
  name: string;
  languageId: string;
  /** open as a replaceable preview tab (single-click); default false = pinned. */
  preview?: boolean;
  /** target split group; default = the focused group. */
  group?: number;
  /** opened in large-file mode (read-only, no LSP). */
  large?: boolean;
}

/** Find a doc by uri (pure lookup). */
export function findDoc(state: TabsState, uri: string): TabDoc | undefined {
  return state.docs.find((d) => d.uri === uri);
}

/** The active doc of a group (undefined when the group is empty). */
export function activeDoc(state: TabsState, group: number): TabDoc | undefined {
  const uri = state.activeByGroup[group];
  return uri ? findDoc(state, uri) : undefined;
}

/**
 * Open a uri (file 07 §3.1). If already open, just activate it (and PIN it when the
 * caller opens non-preview — re-opening a preview tab as an edit promotes it). When
 * opening a NEW preview tab, it REPLACES the group's existing preview tab so the bar
 * stays small. Opening a non-preview tab pins it. Idempotent + immutable.
 */
export function openTab(state: TabsState, uri: string, opts: OpenOpts): TabsState {
  const group = opts.group ?? state.focusedGroup;
  const preview = opts.preview ?? false;
  const existing = findDoc(state, uri);

  if (existing) {
    // already open: activate in its group; promote out of preview if opened as edit.
    const docs =
      !preview && existing.preview
        ? state.docs.map((d) => (d.uri === uri ? { ...d, preview: false } : d))
        : state.docs;
    return {
      ...state,
      docs,
      activeByGroup: { ...state.activeByGroup, [existing.group]: uri },
      focusedGroup: existing.group,
    };
  }

  const doc: TabDoc = {
    uri,
    name: opts.name,
    languageId: opts.languageId,
    dirty: false,
    preview,
    group,
    large: opts.large ?? false,
  };

  // A new PREVIEW tab replaces the group's current preview tab (single-click nav).
  let docs = state.docs;
  if (preview) {
    docs = docs.filter((d) => !(d.group === group && d.preview));
  }
  docs = [...docs, doc];
  return {
    ...state,
    docs,
    activeByGroup: { ...state.activeByGroup, [group]: uri },
    focusedGroup: group,
  };
}

/**
 * Close ONE tab row (file 07 §3.1) — a (group, uri) pair, not every row sharing the uri.
 *
 * `uri` stops being a unique key the moment a split exists: `splitActive` deliberately copies
 * the active doc into a NEW group under the SAME uri so both panes share Monaco's ITextModel.
 * This filtered on `d.uri !== uri`, so closing one pane's tab deleted the row from EVERY group —
 * open a file, split right, click × on either side, and BOTH panes vanish along with the split
 * itself. `activeByGroup` was then left pointing at a doc that no longer existed, directly
 * contradicting this docstring's "or is dropped when the group empties".
 *
 * `group` is optional so existing callers keep compiling; omitted, it closes the row in the
 * doc's own group (the first match), which is the single-pane case and is what they meant.
 *
 * The group's active pointer falls back to the nearest remaining tab IN THE SAME GROUP (the one
 * before it, else the one after), and any group left with no docs at all loses its pointer.
 * Immutable; a no-op for an unknown uri.
 */
export function closeTab(state: TabsState, uri: string, group?: number): TabsState {
  const target =
    group === undefined
      ? findDoc(state, uri)
      : state.docs.find((d) => d.uri === uri && d.group === group);
  if (!target) return state;
  const g = target.group;

  const idxInGroup = state.docs.filter((d) => d.group === g).findIndex((d) => d.uri === uri);
  const docs = state.docs.filter((d) => !(d.uri === uri && d.group === g));
  const activeByGroup = { ...state.activeByGroup };

  if (activeByGroup[g] === uri) {
    const survivors = docs.filter((d) => d.group === g);
    if (survivors.length === 0) {
      delete activeByGroup[g];
    } else {
      // pick the previous tab in-group, else the first survivor.
      const next = survivors[Math.max(0, Math.min(idxInGroup - 1, survivors.length - 1))];
      activeByGroup[g] = next ? next.uri : (survivors[0] as TabDoc).uri;
    }
  }
  // No pointer may outlive its group. A group can empty through a path that never touched its
  // own active pointer, which is how a closed split left `{"1": "…"}` behind with no docs at all.
  for (const key of Object.keys(activeByGroup)) {
    const gid = Number(key);
    if (!docs.some((d) => d.group === gid)) delete activeByGroup[gid];
  }
  // Focus must land on a group that still exists, or the next open would target a dead pane.
  const focusedGroup = docs.some((d) => d.group === state.focusedGroup)
    ? state.focusedGroup
    : (docs[0]?.group ?? 0);
  return { ...state, docs, activeByGroup, focusedGroup };
}

/** Activate an already-open tab (the model-swap trigger). No-op for unknown uri. */
export function activateTab(state: TabsState, uri: string): TabsState {
  const doc = findDoc(state, uri);
  if (!doc) return state;
  return {
    ...state,
    activeByGroup: { ...state.activeByGroup, [doc.group]: uri },
    focusedGroup: doc.group,
  };
}

/** Mark a doc dirty/clean (file 07 §3.1). Editing also PINS a preview tab. */
export function setDirty(state: TabsState, uri: string, dirty: boolean): TabsState {
  if (!findDoc(state, uri)) return state;
  return {
    ...state,
    docs: state.docs.map((d) =>
      d.uri === uri ? { ...d, dirty, preview: dirty ? false : d.preview } : d,
    ),
  };
}

/** Promote a preview tab to a pinned tab (double-click / first edit). */
export function pinTab(state: TabsState, uri: string): TabsState {
  if (!findDoc(state, uri)) return state;
  return { ...state, docs: state.docs.map((d) => (d.uri === uri ? { ...d, preview: false } : d)) };
}

/**
 * Split the focused group's active tab into a new group (file 07 §3.1 split). The
 * active doc is COPIED (same uri/model) into a fresh group id so both groups show
 * the same model — Monaco shares the ITextModel across editor instances. Returns the
 * new group id alongside the state so the caller can mount a second editor.
 */
export function splitActive(state: TabsState): { state: TabsState; group: number } {
  const src = activeDoc(state, state.focusedGroup);
  if (!src) return { state, group: state.focusedGroup };
  const newGroup = nextGroupId(state);
  const copy: TabDoc = { ...src, group: newGroup, preview: false };
  return {
    state: {
      ...state,
      docs: [...state.docs, copy],
      activeByGroup: { ...state.activeByGroup, [newGroup]: src.uri },
      focusedGroup: newGroup,
    },
    group: newGroup,
  };
}

/** The next free group id (max existing + 1, or 0). */
export function nextGroupId(state: TabsState): number {
  const groups = state.docs.map((d) => d.group);
  return groups.length === 0 ? 0 : Math.max(...groups) + 1;
}

/** The distinct group ids that currently host at least one tab (split layout). */
export function groupIds(state: TabsState): number[] {
  return [...new Set(state.docs.map((d) => d.group))].sort((a, b) => a - b);
}

/** The tabs of one group, in tab-bar order. */
export function tabsOf(state: TabsState, group: number): TabDoc[] {
  return state.docs.filter((d) => d.group === group);
}

/** Whether ANY open doc has unsaved edits (drives the close-confirm + title dot). */
export function hasDirty(state: TabsState): boolean {
  return state.docs.some((d) => d.dirty);
}
