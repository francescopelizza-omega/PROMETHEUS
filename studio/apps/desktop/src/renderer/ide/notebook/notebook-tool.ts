/**
 * notebook-tool.ts — the `notebook_edit` agent tool (desktop only).
 *
 * WHY A DEDICATED TOOL. The agent's generic file tools treat a `.ipynb` as text, so "change
 * the third cell" becomes "rewrite this JSON document" — and the model, editing JSON by hand,
 * reliably destroys the parts it was not asked to touch: the on-disk `outputs`, the
 * `execution_count`, the per-cell `metadata` other tools wrote, and the nbformat quirk where
 * `source` is *either* a string *or* an array of already-newline-terminated lines.
 *
 * So this routes through the notebook STORE — `ensureLoaded` → `dispatch({type:"update"})` →
 * `save`, which is `parseIpynb` → mutate `cells[i].source` → `serializeIpynb`. That pipeline
 * matches cells BY ID and rewrites only `source`/`cell_type`, carrying every unknown key and
 * every untouched cell's outputs through verbatim. A naive JSON.parse/stringify round trip
 * would silently drop all of it.
 *
 * Going through the store (rather than reading and writing the file behind its back) is also
 * what keeps an OPEN notebook consistent: if the user has the tab open with unsaved cells, a
 * direct write would be clobbered by their next save — or would clobber their edits.
 */
import type { ToolOutcome } from "@prometheus/core/agent-loop";
import type { ToolDef } from "@prometheus/core/agent-tools";

import { useNotebookStore } from "./notebook-store.js";

export const NOTEBOOK_EDIT_TOOL_NAME = "notebook_edit";

/**
 * The tool the model sees.
 *
 * NOT `readOnlyHint` and explicitly `destructiveHint`: it overwrites a cell's source in a file
 * on disk. That classification is what routes it to a human confirm under the broker and the
 * authorization ladder, exactly like `write_file` — an edit tool that classified as a read
 * would be auto-approved at A1 and could rewrite a notebook with nobody asked.
 */
export const NOTEBOOK_EDIT_TOOL: ToolDef = {
  name: NOTEBOOK_EDIT_TOOL_NAME,
  title: "Edit notebook cell",
  description:
    "Replace the source of ONE cell in a Jupyter notebook (.ipynb), preserving every other " +
    "cell's outputs, execution counts and metadata. Cells are addressed by zero-based index. " +
    "Use this instead of write_file for notebooks — rewriting the JSON by hand destroys outputs.",
  schema: {
    path: { type: "string", required: true, description: "Path to the .ipynb file." },
    cellIndex: {
      type: "number",
      required: true,
      description: "Zero-based index of the cell to replace.",
    },
    newSource: {
      type: "string",
      required: true,
      description: "The cell's new source text (may be empty to clear the cell).",
    },
  },
  annotations: { destructiveHint: true },
  // Editor-local: there is no argv for this — it is dispatched in the renderer, not spawned.
  toArgv: () => {
    throw new Error("notebook_edit is dispatched in the editor, not as a command");
  },
};

/** The slice of the notebook store this tool drives (injectable so a test needs no zustand). */
export interface NotebookToolStore {
  ensureLoaded(uri: string): Promise<void>;
  dispatch(uri: string, action: { type: "update"; id: string; source: string }): void;
  save(uri: string): Promise<boolean>;
  getDoc(uri: string): { cells: { id: string }[]; loadError?: string } | undefined;
}

/** The live store, adapted to the seam above. */
function liveStore(): NotebookToolStore {
  return {
    ensureLoaded: (uri) => useNotebookStore.getState().ensureLoaded(uri),
    dispatch: (uri, action) => useNotebookStore.getState().dispatch(uri, action),
    save: (uri) => useNotebookStore.getState().save(uri),
    getDoc: (uri) => useNotebookStore.getState().docs[uri],
  };
}

/**
 * Run `notebook_edit`. Returns `null` when `name` is a different tool — the same
 * "not mine" contract `runBrowserTool` uses, so the renderer's dispatcher can chain these
 * without a second name list to keep in sync.
 *
 * Every failure is a `{ok:false}` OUTCOME, never a throw: a tool that throws aborts the round
 * with a stack trace the model cannot act on, where a summary ("cellIndex 9 is out of range;
 * the notebook has 3 cells") is something it can immediately fix.
 */
export function runNotebookTool(
  name: string,
  args: Record<string, unknown>,
  store: NotebookToolStore = liveStore(),
): Promise<ToolOutcome> | null {
  if (name !== NOTEBOOK_EDIT_TOOL_NAME) return null;
  return runNotebookEdit(args, store);
}

async function runNotebookEdit(
  args: Record<string, unknown>,
  store: NotebookToolStore,
): Promise<ToolOutcome> {
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return { ok: false, summary: "notebook_edit: `path` is required" };
  if (!path.toLowerCase().endsWith(".ipynb")) {
    // Refused rather than attempted: `parseIpynb` fail-softs a non-notebook to zero cells, so
    // without this the tool would report "cell 0 is out of range" for a perfectly good .py
    // file and the model would waste a round guessing why.
    return { ok: false, summary: `notebook_edit: "${path}" is not a .ipynb notebook` };
  }
  const idx = args.cellIndex;
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
    return { ok: false, summary: "notebook_edit: `cellIndex` must be a non-negative integer" };
  }
  if (typeof args.newSource !== "string") {
    return { ok: false, summary: "notebook_edit: `newSource` must be a string" };
  }
  const newSource = args.newSource;

  try {
    await store.ensureLoaded(path);
  } catch (e) {
    return { ok: false, summary: `notebook_edit: could not open ${path}: ${errText(e)}` };
  }
  const doc = store.getDoc(path);
  if (!doc) return { ok: false, summary: `notebook_edit: could not open ${path}` };
  if (doc.loadError) {
    return { ok: false, summary: `notebook_edit: could not read ${path}: ${doc.loadError}` };
  }
  const cell = doc.cells[idx];
  if (!cell) {
    return {
      ok: false,
      summary: `notebook_edit: cellIndex ${idx} is out of range — ${path} has ${doc.cells.length} cell(s)`,
    };
  }
  // Addressed by INDEX for the model (which counts cells as it reads them) but dispatched by
  // ID, because the reducer keys on id and that is what survives a concurrent move/insert.
  store.dispatch(path, { type: "update", id: cell.id, source: newSource });
  const saved = await store.save(path);
  if (!saved) {
    return {
      ok: false,
      summary: `notebook_edit: cell ${idx} was updated in the editor but ${path} could not be written`,
    };
  }
  const lines = newSource === "" ? 0 : newSource.split("\n").length;
  return {
    ok: true,
    summary: `notebook_edit: replaced cell ${idx} of ${path} (${lines} line${lines === 1 ? "" : "s"})`,
    data: { path, cellIndex: idx, cells: doc.cells.length },
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
