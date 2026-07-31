/**
 * ipynb.test.ts — node:test for the pure nbformat parse/serialize seam (APP-045).
 * Pure JSON/string logic — no react, no monaco — runs under node --test directly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseIpynb, serializeIpynb, stripAnsi } from "./ipynb.js";

const NB = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: "python3", display_name: "Python 3" },
    language_info: { name: "python", version: "3.11" },
    custom_key: { keep: "me" },
  },
  cells: [
    {
      cell_type: "code",
      id: "abc123",
      metadata: { collapsed: false },
      execution_count: 2,
      source: ["print('hello')\n", "print('world')"],
      outputs: [{ output_type: "stream", name: "stdout", text: ["hello\n", "world\n"] }],
    },
    {
      cell_type: "markdown",
      id: "md1",
      metadata: {},
      source: "# Title",
    },
  ],
});

test("parseIpynb joins multiline source without re-inserting \\n", () => {
  const { cells } = parseIpynb(NB);
  assert.equal(cells.length, 2);
  assert.equal(cells[0]!.source, "print('hello')\nprint('world')");
  assert.equal(cells[0]!.kind, "code");
  assert.equal(cells[0]!.execCount, 2);
  assert.equal(cells[1]!.kind, "markdown");
  assert.equal(cells[1]!.source, "# Title");
});

test("parseIpynb flattens stream outputs for display", () => {
  const { cells } = parseIpynb(NB);
  assert.ok(cells[0]!.outputs && cells[0]!.outputs.length === 1);
  assert.equal(cells[0]!.outputs![0]!.data, "hello\nworld\n");
});

test("round-trip preserves top-level + per-cell metadata and unknown keys", () => {
  const { cells, nb } = parseIpynb(NB);
  const text = serializeIpynb(cells, nb);
  const back = JSON.parse(text);
  assert.equal(back.nbformat, 4);
  assert.equal(back.nbformat_minor, 5);
  assert.deepEqual(back.metadata.custom_key, { keep: "me" });
  assert.equal(back.metadata.kernelspec.name, "python3");
  // per-cell id + unknown metadata preserved
  assert.equal(back.cells[0].id, "abc123");
  assert.deepEqual(back.cells[0].metadata, { collapsed: false });
  // source round-tripped as line-array (no doubled blank lines)
  assert.deepEqual(back.cells[0].source, ["print('hello')\n", "print('world')"]);
  assert.equal(text.endsWith("\n"), true);
});

test("idle cell keeps on-disk outputs; a run cell contributes fresh outputs", () => {
  const { cells, nb } = parseIpynb(NB);
  // mark cell 0 as run this session with new outputs
  const run = cells.map((c) =>
    c.id === "abc123"
      ? {
          ...c,
          status: "ok" as const,
          execCount: 3,
          outputs: [{ mime: "text/plain", data: "42\n" }],
        }
      : c,
  );
  const back = JSON.parse(serializeIpynb(run, nb));
  assert.equal(back.cells[0].execution_count, 3);
  assert.equal(back.cells[0].outputs[0].output_type, "stream");
  assert.deepEqual(back.cells[0].outputs[0].text, ["42\n"]);
});

test("markdown cell serializes without execution_count/outputs", () => {
  const { cells, nb } = parseIpynb(NB);
  const back = JSON.parse(serializeIpynb(cells, nb));
  assert.equal(back.cells[1].cell_type, "markdown");
  assert.equal("execution_count" in back.cells[1], false);
  assert.equal("outputs" in back.cells[1], false);
});

test("malformed .ipynb yields an empty notebook shell (never throws)", () => {
  const { cells, nb } = parseIpynb("not json at all");
  assert.deepEqual(cells, []);
  assert.equal(nb.nbformat, 4);
  const text = serializeIpynb(cells, nb);
  assert.equal(JSON.parse(text).cells.length, 0);
});

test("stripAnsi removes SGR escape codes from a traceback line", () => {
  const ESC = String.fromCharCode(27);
  const colored = `${ESC}[0;31mTraceback${ESC}[0m most recent`;
  assert.equal(stripAnsi(colored), "Traceback most recent");
});

test("newly-added cell (no raw match) serializes as a valid code cell", () => {
  const { nb } = parseIpynb(NB);
  const added = [{ id: "new1", kind: "code" as const, source: "x=1", status: "idle" as const }];
  const back = JSON.parse(serializeIpynb(added, nb));
  assert.equal(back.cells.length, 1);
  assert.equal(back.cells[0].id, "new1");
  assert.deepEqual(back.cells[0].source, ["x=1"]);
  assert.deepEqual(back.cells[0].outputs, []);
});
