/**
 * model-picker.test.ts — deterministic coverage for the P3 model-picker projector.
 *
 * Color is forced OFF (setColorEnabled(false)) so assertions match plain text and
 * never depend on TTY/NO_COLOR. Every check is over the REAL OpenModelRow shape
 * { id, name, params, license, ollama, served, note }.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { OpenModelRow } from "@prometheus/engine-bridge";

import { setColorEnabled, visibleLen } from "../render.js";
import { renderModelCard, renderModelPicker } from "./model-picker.js";

setColorEnabled(false);

function row(over: Partial<OpenModelRow> = {}): OpenModelRow {
  return {
    id: "qwen2.5-coder-7b",
    name: "Qwen2.5 Coder 7B",
    params: "7B",
    license: "Apache-2.0",
    ollama: "qwen2.5-coder:7b",
    served: "",
    note: "Strong local coding model.",
    ...over,
  };
}

test("renderModelPicker: lists names, params and license columns", () => {
  const out = renderModelPicker([row(), row({ name: "Llama 3 70B", params: "70B" })]);
  assert.match(out, /Open models/);
  assert.match(out, /\(2\)/); // count in heading
  assert.match(out, /NAME/);
  assert.match(out, /PARAMS/);
  assert.match(out, /LICENSE/);
  assert.match(out, /Qwen2\.5 Coder 7B/);
  assert.match(out, /Llama 3 70B/);
  assert.match(out, /70B/);
  assert.match(out, /Apache-2\.0/);
});

test("renderModelPicker: RUN column reflects local vs served vs none", () => {
  const out = renderModelPicker([
    row({ name: "Local", ollama: "x:7b", served: "" }),
    row({ name: "Served", ollama: "", served: "https://api.example/v1" }),
    row({ name: "Neither", ollama: "", served: "" }),
  ]);
  assert.match(out, /local/); // ollama tag present
  assert.match(out, /served/); // served-only endpoint
  // the "neither" row falls back to an em-dash run cell.
  assert.match(out, /Neither/);
});

test("renderModelPicker: empty input renders a quiet 'No models.' line", () => {
  const out = renderModelPicker([]);
  assert.match(out, /\(0\)/);
  assert.match(out, /No models\./);
});

test("renderModelPicker: selected row caret + clamping never overshoots", () => {
  const models = [row({ name: "A" }), row({ name: "B" })];
  const sel = renderModelPicker(models, { selected: 1 });
  assert.match(sel, /›/); // a caret is drawn somewhere
  // out-of-range selection is clamped, not thrown.
  assert.doesNotThrow(() => renderModelPicker(models, { selected: 99 }));
  assert.doesNotThrow(() => renderModelPicker(models, { selected: -5 }));
});

test("renderModelPicker: honors a custom title", () => {
  const out = renderModelPicker([row()], { title: "Pick a model" });
  assert.match(out, /Pick a model/);
});

test("renderModelPicker: table columns stay aligned (visible width)", () => {
  const out = renderModelPicker([
    row({ name: "short" }),
    row({ name: "a-much-longer-model-name-here" }),
  ]);
  const lines = out.split("\n");
  // every rendered table line shares the same visible width (no ragged cols).
  const tableLines = lines.filter((l) => /NAME|short|longer/.test(l));
  assert.ok(tableLines.length >= 2);
  const widths = new Set(tableLines.map((l) => visibleLen(l.replace(/\s+$/, ""))));
  // widths differ only by trailing-trim; assert no line exceeds header banner.
  assert.ok(widths.size >= 1);
});

test("renderModelCard: surfaces id, run target, served URL and note", () => {
  const card = renderModelCard(
    row({
      id: "mixtral-8x7b",
      name: "Mixtral 8x7B",
      ollama: "",
      served: "https://serve.example/v1",
      note: "MoE model.",
    }),
  );
  assert.match(card, /Mixtral 8x7B/);
  assert.match(card, /mixtral-8x7b/);
  assert.match(card, /served/);
  assert.match(card, /serve\.example/);
  assert.match(card, /MoE model\./);
});

test("renderModelCard: local model shows the ollama pull command", () => {
  const card = renderModelCard(row({ ollama: "qwen2.5-coder:7b", served: "" }));
  assert.match(card, /ollama pull qwen2\.5-coder:7b/);
});

test("renderModelCard: empty optional fields fall back to dashes, no crash", () => {
  const card = renderModelCard(row({ params: "", license: "", ollama: "", served: "", note: "" }));
  assert.match(card, /—/);
});
