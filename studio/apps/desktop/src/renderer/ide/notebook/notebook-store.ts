/**
 * notebook-store.ts — the URI-keyed notebook state + kernel IPC (APP-045).
 *
 * Holds one NotebookDoc per open `.ipynb` (cells + the raw nbformat for lossless save +
 * the live kernel session), so state SURVIVES a tab switch (the container unmounts, the
 * store does not). ALL kernel IPC lives here (mirrors the SQL sources store ↔ DatabasePanel
 * split): the container is a thin view. Kernel NDJSON events arrive on the shared
 * `ide.onEvent` feed and are routed by sessionId → uri → cellId into the pure reducer.
 *
 * No-orphan: a tabs-store subscription shuts a doc's kernel down once its uri leaves every
 * editor tab (tab close), and the container never shuts down on a mere tab switch.
 */
import { create } from "zustand";

import type {
  IdeEvent,
  IdeKernelDataFrameEvent,
  IdeKernelStreamEvent,
  IdeKernelVar,
} from "../../../shared/ipc-contract.js";
import { useTabsStore } from "../state/stores.js";
import { type RawNotebook, parseIpynb, serializeIpynb, stripAnsi } from "./ipynb.js";
import { type Cell, type NotebookAction, cellReducer } from "./notebook-view.js";

export type KernelStatus = "none" | "starting" | "ready" | "busy" | "error" | "exited";

export interface NotebookDoc {
  uri: string;
  cells: Cell[];
  activeCellId?: string;
  nb: RawNotebook;
  loaded: boolean;
  dirty: boolean;
  loadError?: string;
  sessionId?: string;
  kernelStatus: KernelStatus;
  kernelError?: string;
  // APP-088: introspection state fed to the Variables / SciView / DataFrame windows.
  // `vars` + `plots` are AUTO-refreshed after every cell completes; `dataframe` is the
  // last on-demand paged frame (undefined until the user opens a DataFrame view).
  vars?: IdeKernelVar[];
  plots?: string[];
  dataframe?: IdeKernelDataFrameEvent;
  /** the DataFrame view currently being paged (name the user clicked to inspect). */
  dataframeName?: string;
}

interface NotebookStore {
  docs: Record<string, NotebookDoc>;
  ensureLoaded(uri: string): Promise<void>;
  dispatch(uri: string, action: NotebookAction): void;
  setActive(uri: string, id: string): void;
  run(uri: string, cellId: string): Promise<void>;
  interrupt(uri: string): void;
  restart(uri: string): void;
  /** APP-088: open/page a DataFrame view for kernel-global `name`; result arrives async. */
  viewDataframe(uri: string, name: string, offset: number, limit: number): void;
  /** APP-088: close/clear the on-demand DataFrame view. */
  closeDataframe(uri: string): void;
  /** APP-088: clear all captured SciView plots. */
  clearPlots(uri: string): void;
  save(uri: string): Promise<boolean>;
  closeDoc(uri: string): void;
}

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** Pick the best renderable representation from a kernel mime bundle (HTML never rendered). */
function pickOutput(data: Record<string, unknown>): { mime: string; data: string } | null {
  if (typeof data["image/png"] === "string")
    return { mime: "image/png", data: data["image/png"] as string };
  if (typeof data["image/jpeg"] === "string")
    return { mime: "image/jpeg", data: data["image/jpeg"] as string };
  if (typeof data["image/svg+xml"] === "string") {
    return { mime: "image/svg+xml", data: data["image/svg+xml"] as string };
  }
  if (data["text/plain"] !== undefined) {
    const v = data["text/plain"];
    return { mime: "text/plain", data: Array.isArray(v) ? v.join("") : String(v) };
  }
  return null;
}

/** sessionId → uri, so a kernel event can find its notebook. */
const sessionToUri = new Map<string, string>();

export const useNotebookStore = create<NotebookStore>((set, get) => ({
  docs: {},

  async ensureLoaded(uri) {
    const existing = get().docs[uri];
    if (existing?.loaded) return;
    const api = ide();
    const res = await api?.fsRead(uri).catch(() => undefined);
    const doc: NotebookDoc =
      res?.ok && res.text !== undefined
        ? (() => {
            const { cells, nb } = parseIpynb(res.text);
            return {
              uri,
              cells,
              activeCellId: cells[0]?.id,
              nb,
              loaded: true,
              dirty: false,
              kernelStatus: "none" as KernelStatus,
            };
          })()
        : {
            uri,
            cells: [],
            nb: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] },
            loaded: true,
            dirty: false,
            loadError: res?.error ?? "could not read notebook",
            kernelStatus: "none" as KernelStatus,
          };
    set((s) => ({ docs: { ...s.docs, [uri]: doc } }));
  },

  dispatch(uri, action) {
    set((s) => {
      const doc = s.docs[uri];
      if (!doc) return s;
      const cells = cellReducer(doc.cells, action);
      // structural/content edits dirty the buffer; run-lifecycle events do not.
      const dirties =
        action.type === "add" ||
        action.type === "remove" ||
        action.type === "update" ||
        action.type === "move";
      return { docs: { ...s.docs, [uri]: { ...doc, cells, dirty: doc.dirty || dirties } } };
    });
  },

  setActive(uri, id) {
    set((s) => {
      const doc = s.docs[uri];
      if (!doc) return s;
      return { docs: { ...s.docs, [uri]: { ...doc, activeCellId: id } } };
    });
  },

  async run(uri, cellId) {
    const api = ide();
    if (!api) return;
    let doc = get().docs[uri];
    if (!doc) return;
    // lazy-start the kernel session on first run (its cwd = the notebook's folder).
    if (!doc.sessionId) {
      set((s) => ({ docs: { ...s.docs, [uri]: { ...s.docs[uri]!, kernelStatus: "starting" } } }));
      const cwd = uriToDir(uri);
      const started = await api.kernel.start(cwd).catch(() => undefined);
      if (!started?.ok || !started.sessionId) {
        set((s) => ({
          docs: {
            ...s.docs,
            [uri]: {
              ...s.docs[uri]!,
              kernelStatus: "error",
              kernelError: started?.error ?? "kernel failed to start",
            },
          },
        }));
        return;
      }
      sessionToUri.set(started.sessionId, uri);
      set((s) => ({
        docs: { ...s.docs, [uri]: { ...s.docs[uri]!, sessionId: started.sessionId } },
      }));
      doc = get().docs[uri]!;
    }
    get().dispatch(uri, { type: "run-start", id: cellId });
    set((s) => ({ docs: { ...s.docs, [uri]: { ...s.docs[uri]!, kernelStatus: "busy" } } }));
    await api.kernel
      .execute(doc.sessionId!, cellId, cellOf(doc, cellId)?.source ?? "")
      .catch(() => undefined);
  },

  interrupt(uri) {
    const doc = get().docs[uri];
    if (doc?.sessionId) void ide()?.kernel.interrupt(doc.sessionId);
  },

  restart(uri) {
    const doc = get().docs[uri];
    if (doc?.sessionId) {
      // the namespace is wiped on restart — drop the now-stale introspection state.
      patchDoc(uri, { vars: [], plots: [], dataframe: undefined, dataframeName: undefined });
      void ide()?.kernel.restart(doc.sessionId);
    }
  },

  viewDataframe(uri, name, offset, limit) {
    const doc = get().docs[uri];
    if (!doc?.sessionId) return;
    // remember which frame is being paged so a `dataframe` event for a stale name is ignored.
    patchDoc(uri, { dataframeName: name });
    void ide()?.kernel.dataframe(doc.sessionId, name, offset, limit);
  },

  closeDataframe(uri) {
    patchDoc(uri, { dataframe: undefined, dataframeName: undefined });
  },

  clearPlots(uri) {
    patchDoc(uri, { plots: [] });
  },

  async save(uri) {
    const doc = get().docs[uri];
    if (!doc) return false;
    const text = serializeIpynb(doc.cells, doc.nb);
    const res = await ide()
      ?.fsWrite(uri, text)
      .catch(() => undefined);
    if (res?.ok) {
      set((s) => ({ docs: { ...s.docs, [uri]: { ...s.docs[uri]!, dirty: false } } }));
      return true;
    }
    return false;
  },

  closeDoc(uri) {
    const doc = get().docs[uri];
    if (doc?.sessionId) {
      void ide()?.kernel.shutdown(doc.sessionId);
      sessionToUri.delete(doc.sessionId);
    }
    set((s) => {
      const { [uri]: _gone, ...rest } = s.docs;
      return { docs: rest };
    });
  },
}));

function cellOf(doc: NotebookDoc, id: string): Cell | undefined {
  return doc.cells.find((c) => c.id === id);
}

/** `file:///a/b/nb.ipynb` → `/a/b` (the kernel cwd). Falls back to "." on a non-file uri. */
function uriToDir(uri: string): string {
  const path = uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : ".";
}

/** Route ONE kernel NDJSON event into its notebook's reducer. */
function routeKernelEvent(sessionId: string, ev: IdeKernelStreamEvent): void {
  const uri = sessionToUri.get(sessionId);
  if (!uri) return;
  const store = useNotebookStore.getState();
  const cellId = typeof ev.id === "string" ? ev.id : undefined;
  switch (ev.event) {
    case "ready":
      patchDoc(uri, { kernelStatus: "ready" });
      return;
    case "stream":
      if (cellId)
        store.dispatch(uri, {
          type: "append-output",
          id: cellId,
          output: { mime: "text/plain", data: String(ev.text ?? "") },
        });
      return;
    case "execute_result":
    case "display_data": {
      const out = pickOutput((ev.data as Record<string, unknown>) ?? {});
      if (cellId && out) store.dispatch(uri, { type: "append-output", id: cellId, output: out });
      return;
    }
    case "error":
      if (ev.fatal) {
        patchDoc(uri, { kernelStatus: "error", kernelError: String(ev.error ?? "kernel error") });
      } else if (cellId) {
        const tb = Array.isArray(ev.traceback)
          ? (ev.traceback as string[]).join("\n")
          : `${ev.ename ?? "Error"}: ${ev.evalue ?? ""}`;
        store.dispatch(uri, {
          type: "append-output",
          id: cellId,
          output: { mime: "text/plain", data: stripAnsi(tb) },
        });
      }
      return;
    case "done": {
      const execCount = typeof ev.execution_count === "number" ? ev.execution_count : undefined;
      if (cellId) {
        store.dispatch(
          uri,
          ev.status === "ok"
            ? { type: "run-ok", id: cellId, ...(execCount !== undefined ? { execCount } : {}) }
            : { type: "run-error", id: cellId, ...(execCount !== undefined ? { execCount } : {}) },
        );
      }
      patchDoc(uri, { kernelStatus: "ready" });
      return;
    }
    case "exit":
      patchDoc(uri, { kernelStatus: "exited", sessionId: undefined });
      sessionToUri.delete(sessionId);
      return;
    // ── APP-088 introspection (auto-emitted after each cell, plus on-demand frames) ──
    case "vars": {
      const vars = Array.isArray(ev.vars) ? (ev.vars as IdeKernelVar[]) : [];
      patchDoc(uri, { vars });
      return;
    }
    case "plots": {
      const fresh = Array.isArray(ev.plots) ? (ev.plots as string[]) : [];
      if (fresh.length === 0) return; // a non-plot cell adds nothing to SciView
      // SciView COLLECTS figures across cells, newest first; capped so it can't grow
      // unbounded (each cell emits only its own new figures — the kernel closes them after).
      const prev = useNotebookStore.getState().docs[uri]?.plots ?? [];
      patchDoc(uri, { plots: [...fresh, ...prev].slice(0, 50) });
      return;
    }
    case "dataframe": {
      const df = ev as unknown as IdeKernelDataFrameEvent;
      // ignore a frame the user is no longer viewing (paged a different var meanwhile).
      const current = useNotebookStore.getState().docs[uri]?.dataframeName;
      if (current !== undefined && df.name !== current) return;
      patchDoc(uri, { dataframe: df });
      return;
    }
  }
}

function patchDoc(uri: string, patch: Partial<NotebookDoc>): void {
  useNotebookStore.setState((s) => {
    const doc = s.docs[uri];
    if (!doc) return s;
    return { docs: { ...s.docs, [uri]: { ...doc, ...patch } } };
  });
}

/* ── one-time wiring: subscribe to the shared IDE feed + reap kernels on tab close ── */

let wired = false;
export function ensureNotebookWiring(): void {
  if (wired || typeof window === "undefined") return;
  const api = window.prometheus?.ide;
  if (!api) return;
  wired = true;
  api.onEvent((ev: IdeEvent) => {
    if (ev.channel === "kernel") routeKernelEvent(ev.sessionId, ev.event);
  });
  // when a notebook uri leaves EVERY editor tab, shut its kernel down (no orphan).
  useTabsStore.subscribe((state) => {
    const open = new Set(state.tabs.docs.map((d) => d.uri));
    for (const uri of Object.keys(useNotebookStore.getState().docs)) {
      if (!open.has(uri)) useNotebookStore.getState().closeDoc(uri);
    }
  });
}
