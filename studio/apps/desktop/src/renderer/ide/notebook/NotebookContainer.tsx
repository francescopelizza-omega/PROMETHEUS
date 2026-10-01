// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * NotebookContainer.tsx — the stateful notebook host mounted for a `.ipynb` tab (APP-045).
 *
 * Owns NOTHING itself: it binds the URI-keyed notebook store (which holds cells + the
 * kernel session + all IPC) to the presentational NotebookView. State lives in the store
 * so it survives a tab switch; the kernel is reaped when the tab closes (store wiring).
 * Cmd-S serializes + writes a valid round-tripped .ipynb via the path-guarded fs IPC.
 */
import { type ReactElement, useEffect } from "react";

import { NotebookView } from "./NotebookView.js";
import { DataFrameWindow, SciView, VariablesWindow } from "./ScienceWindows.js";
import { ensureNotebookWiring, useNotebookStore } from "./notebook-store.js";
import { nextCellId } from "./notebook-view.js";

/** page size for the on-demand DataFrame viewer (server-paged via the kernel). */
const DF_LIMIT = 100;

let seq = 0;
function mintCellId(): string {
  seq += 1;
  return `cell-new-${seq}-${seq * 7}`;
}

export function NotebookContainer({ uri }: { uri: string }): ReactElement {
  const doc = useNotebookStore((s) => s.docs[uri]);
  const ensureLoaded = useNotebookStore((s) => s.ensureLoaded);
  const dispatch = useNotebookStore((s) => s.dispatch);
  const setActive = useNotebookStore((s) => s.setActive);
  const run = useNotebookStore((s) => s.run);
  const interrupt = useNotebookStore((s) => s.interrupt);
  const restart = useNotebookStore((s) => s.restart);
  const viewDataframe = useNotebookStore((s) => s.viewDataframe);
  const closeDataframe = useNotebookStore((s) => s.closeDataframe);
  const clearPlots = useNotebookStore((s) => s.clearPlots);
  const save = useNotebookStore((s) => s.save);

  // one-time: subscribe to the kernel event feed + tab-close reaping, then load this nb.
  useEffect(() => {
    ensureNotebookWiring();
    void ensureLoaded(uri);
  }, [uri, ensureLoaded]);

  // Cmd/Ctrl-S saves this notebook (serialize → path-guarded fsWrite) when it is active.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void save(uri);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [uri, save]);

  if (!doc) {
    return (
      <div style={{ padding: "var(--space-4, 8px)", color: "var(--text-secondary)" }}>loading…</div>
    );
  }

  const hasKernel = doc.kernelStatus !== "none";
  const dfOffset = doc.dataframe?.offset ?? 0;
  return (
    <div style={{ height: "100%", overflow: "auto", padding: "var(--space-2, 4px)" }}>
      <div style={{ display: "flex", gap: "var(--space-2, 4px)", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <NotebookView
            cells={doc.cells}
            activeCellId={doc.activeCellId}
            kernelStatus={doc.kernelStatus}
            loadError={doc.loadError}
            onAdd={(afterId) => {
              const id = mintCellId();
              dispatch(uri, { type: "add", id, afterId });
              setActive(uri, id);
            }}
            onRemove={(id) => dispatch(uri, { type: "remove", id })}
            onUpdate={(id, source) => dispatch(uri, { type: "update", id, source })}
            onSelect={(id) => setActive(uri, id)}
            onRun={(id) => {
              void run(uri, id);
              const nxt = nextCellId(doc.cells, id);
              if (nxt) setActive(uri, nxt);
            }}
            onInterrupt={hasKernel ? () => interrupt(uri) : undefined}
            onRestart={hasKernel ? () => restart(uri) : undefined}
          />
          {/* APP-088: the DataFrame viewer opens full-width beneath the cells when a var is
              opened (it needs the horizontal room the narrow sidebar cannot give). */}
          {doc.dataframeName && (
            <div style={{ marginTop: "var(--space-2, 4px)" }}>
              <DataFrameWindow
                name={doc.dataframeName}
                frame={doc.dataframe}
                offset={dfOffset}
                limit={DF_LIMIT}
                onPage={(nextOffset) =>
                  viewDataframe(uri, doc.dataframeName as string, nextOffset, DF_LIMIT)
                }
                onClose={() => closeDataframe(uri)}
              />
            </div>
          )}
        </div>
        {/* APP-088: Variables + SciView refresh automatically on each cell completion (the
            store routes the auto-emitted kernel `vars`/`plots` events — no polling here). */}
        <div
          style={{
            width: 340,
            minWidth: 260,
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2, 4px)",
          }}
        >
          <VariablesWindow
            vars={doc.vars}
            onView={(name) => viewDataframe(uri, name, 0, DF_LIMIT)}
          />
          <SciView plots={doc.plots} onClear={() => clearPlots(uri)} />
        </div>
      </div>
    </div>
  );
}

export default NotebookContainer;
