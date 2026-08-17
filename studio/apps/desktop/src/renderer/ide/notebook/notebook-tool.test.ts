/**
 * notebook-tool.test.ts — the `notebook_edit` agent tool.
 *
 * Two halves, and the second is the one that matters:
 *
 *  1. argument validation + the store dispatch (a fake store records what it was told);
 *  2. a REAL round trip through `parseIpynb` → mutate → `serializeIpynb` against a notebook
 *     carrying outputs, execution counts, per-cell metadata and unknown top-level keys.
 *
 * (2) exists because the entire reason this tool is not just `write_file` is preservation. A
 * test that only checks "the reducer got an update action" would pass just as happily against
 * a JSON.parse/stringify implementation that silently dropped every output in the file.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseIpynb, serializeIpynb } from "./ipynb.js";
import {
  NOTEBOOK_EDIT_TOOL,
  NOTEBOOK_EDIT_TOOL_NAME,
  type NotebookToolStore,
  runNotebookTool,
} from "./notebook-tool.js";
import { cellReducer } from "./notebook-view.js";

/** A notebook with everything a naive rewrite would destroy. */
const NB = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: "python3" }, custom_top_level: "keep me" },
  // an unknown TOP-LEVEL key — nbformat allows them and tools write them
  extra_top_level: { anything: true },
  cells: [
    {
      id: "c0",
      cell_type: "code",
      source: ["print(1)\n"],
      execution_count: 7,
      metadata: { tags: ["slow"] },
      outputs: [{ output_type: "stream", name: "stdout", text: ["1\n"] }],
    },
    {
      id: "c1",
      cell_type: "markdown",
      source: "# title",
      metadata: {},
    },
  ],
});

/** A fake store that runs the REAL parse/reduce/serialize pipeline over an in-memory file. */
function fakeStore(initial: string): NotebookToolStore & { text(): string; saves: number } {
  let text = initial;
  let doc: ReturnType<typeof parseIpynb> | undefined;
  let saves = 0;
  return {
    text: () => text,
    get saves() {
      return saves;
    },
    ensureLoaded: async (_uri) => {
      if (!doc) doc = parseIpynb(text);
    },
    dispatch: (_uri, action) => {
      if (doc) doc.cells = cellReducer(doc.cells, action);
    },
    save: async (_uri) => {
      if (!doc) return false;
      saves += 1;
      text = serializeIpynb(doc.cells, doc.nb);
      return true;
    },
    getDoc: (_uri) => (doc ? { cells: doc.cells } : undefined),
  };
}

/* ── the tool definition ─────────────────────────────────────────────────────*/

test("notebook_edit is destructive, so no authorization level auto-approves a cell overwrite", () => {
  // Annotating it `readOnlyHint` (or leaving the hints off in a way that classified as a read)
  // would auto-approve it at A1 "read freely", and the agent could rewrite a notebook with
  // nobody asked. It writes a file; it must classify like `write_file` does.
  assert.equal(NOTEBOOK_EDIT_TOOL.annotations.readOnlyHint, undefined);
  assert.equal(NOTEBOOK_EDIT_TOOL.annotations.destructiveHint, true);
});

test("notebook_edit has no argv — it is dispatched in the editor, never spawned", () => {
  assert.throws(() => NOTEBOOK_EDIT_TOOL.toArgv({}));
});

test("runNotebookTool returns null for a tool that is not its own", () => {
  assert.equal(runNotebookTool("read_file", { path: "a.ipynb" }), null);
});

/* ── argument validation: every failure is an OUTCOME the model can act on ────*/

test("a missing path is refused with a summary, not a throw", async () => {
  const out = await runNotebookTool(NOTEBOOK_EDIT_TOOL_NAME, {}, fakeStore(NB));
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /`path` is required/);
});

test("a non-.ipynb path is refused BEFORE parsing (parseIpynb fail-softs to zero cells)", async () => {
  // Without this the tool would report "cellIndex 0 is out of range" for a perfectly valid
  // .py file, and the model would spend rounds guessing why its notebook was empty.
  const out = await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "script.py", cellIndex: 0, newSource: "x" },
    fakeStore(NB),
  );
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /is not a \.ipynb notebook/);
});

test("a non-integer / negative cellIndex is refused", async () => {
  for (const cellIndex of [1.5, -1, "0", undefined]) {
    const out = await runNotebookTool(
      NOTEBOOK_EDIT_TOOL_NAME,
      { path: "a.ipynb", cellIndex, newSource: "x" },
      fakeStore(NB),
    );
    assert.equal(out?.ok, false, `cellIndex ${String(cellIndex)} should be refused`);
    assert.match(out?.summary ?? "", /non-negative integer/);
  }
});

test("a non-string newSource is refused (undefined must not clear a cell by accident)", async () => {
  const out = await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "a.ipynb", cellIndex: 0 },
    fakeStore(NB),
  );
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /`newSource` must be a string/);
});

test("an out-of-range cellIndex names the real cell count so the model can retry correctly", async () => {
  const store = fakeStore(NB);
  const out = await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "a.ipynb", cellIndex: 9, newSource: "x" },
    store,
  );
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /out of range — a\.ipynb has 2 cell\(s\)/);
  assert.equal(store.saves, 0, "a rejected edit must not write the file");
});

test("a notebook that could not be read is reported, not silently treated as empty", async () => {
  const broken: NotebookToolStore = {
    ensureLoaded: async () => {},
    dispatch: () => {},
    save: async () => true,
    getDoc: () => ({ cells: [], loadError: "EACCES" }),
  };
  const out = await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "a.ipynb", cellIndex: 0, newSource: "x" },
    broken,
  );
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /could not read a\.ipynb: EACCES/);
});

test("a failed write is reported as a failure (never 'ok' for an edit that did not land)", async () => {
  const store = fakeStore(NB);
  const readOnly: NotebookToolStore = { ...store, save: async () => false };
  const out = await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "a.ipynb", cellIndex: 0, newSource: "print(2)" },
    readOnly,
  );
  assert.equal(out?.ok, false);
  assert.match(out?.summary ?? "", /could not be written/);
});

/* ── the real round trip: what makes this tool worth having ───────────────────*/

test("editing one cell replaces ONLY its source", async () => {
  const store = fakeStore(NB);
  const out = await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "a.ipynb", cellIndex: 0, newSource: "print(2)\nprint(3)" },
    store,
  );
  assert.equal(out?.ok, true);
  const nb = JSON.parse(store.text());
  // nbformat's `source` is a LINE ARRAY whose entries keep their newlines — a plain string
  // would round-trip through most viewers but is not what Jupyter writes.
  assert.deepEqual(nb.cells[0].source, ["print(2)\n", "print(3)"]);
  // The other cell's TEXT is untouched. (Its `source` is re-emitted in the canonical line-array
  // form, which is `serializeIpynb`'s normalization of the string|string[] union, not a change
  // to the content — that is exactly the nbformat quirk a hand-written rewrite gets wrong.)
  assert.equal(
    Array.isArray(nb.cells[1].source) ? nb.cells[1].source.join("") : nb.cells[1].source,
    "# title",
  );
});

test("an UNTOUCHED cell keeps its outputs, execution_count and metadata verbatim", async () => {
  // This is the regression the whole tool exists to prevent: a model rewriting the .ipynb JSON
  // with write_file drops exactly these, and the loss is invisible until someone reopens the
  // notebook and finds every result gone.
  const store = fakeStore(NB);
  await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "a.ipynb", cellIndex: 1, newSource: "# new title" },
    store,
  );
  const nb = JSON.parse(store.text());
  assert.deepEqual(nb.cells[0].outputs, [{ output_type: "stream", name: "stdout", text: ["1\n"] }]);
  assert.equal(nb.cells[0].execution_count, 7);
  assert.deepEqual(nb.cells[0].metadata, { tags: ["slow"] });
});

test("unknown top-level keys and notebook metadata survive the edit", async () => {
  const store = fakeStore(NB);
  await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "a.ipynb", cellIndex: 0, newSource: "print(2)" },
    store,
  );
  const nb = JSON.parse(store.text());
  assert.deepEqual(nb.extra_top_level, { anything: true });
  assert.equal(nb.metadata.custom_top_level, "keep me");
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.nbformat_minor, 5);
});

test("a markdown cell stays markdown — an edit changes source, never the cell type", async () => {
  const store = fakeStore(NB);
  await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "a.ipynb", cellIndex: 1, newSource: "print('not code')" },
    store,
  );
  const nb = JSON.parse(store.text());
  assert.equal(nb.cells[1].cell_type, "markdown");
});

test("an empty newSource clears the cell rather than being rejected", async () => {
  const store = fakeStore(NB);
  const out = await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "a.ipynb", cellIndex: 1, newSource: "" },
    store,
  );
  assert.equal(out?.ok, true);
  const nb = JSON.parse(store.text());
  assert.deepEqual(nb.cells[1].source, []);
});

test("the success summary names the file and the cell (the transcript's audit line)", async () => {
  const out = await runNotebookTool(
    NOTEBOOK_EDIT_TOOL_NAME,
    { path: "a.ipynb", cellIndex: 0, newSource: "a\nb\nc" },
    fakeStore(NB),
  );
  assert.equal(out?.ok, true);
  assert.match(out?.summary ?? "", /replaced cell 0 of a\.ipynb \(3 lines\)/);
});
