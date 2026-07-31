import assert from "node:assert/strict";
/**
 * templates.test.ts — the 6 shipped init-package templates (file 04 §7).
 *
 * Asserts: all 6 parse, the §7 id set is EXACT, each carries the required
 * file-04 §2 fields (id/title/description/packages/editable:true/builtin:true),
 * every package row has a name, optional rows are honoured, and the §7 CUDA-
 * relevant templates carry a torch row + an `nvidia` need.
 */
import { test } from "node:test";

import type { Template } from "../env-store.js";
import { templateResolve } from "../env-store.js";
import { BUILTIN_TEMPLATES, BUILTIN_TEMPLATE_IDS, getBuiltinTemplate } from "./index.js";

const EXPECTED_IDS = [
  "ml-starter",
  "llm-serving",
  "data-science",
  "airllm",
  "notebook-min",
  "deep-research",
];

test("all 6 §7 templates load and the id set is exact + in order", () => {
  assert.equal(BUILTIN_TEMPLATES.length, 6);
  assert.deepEqual([...BUILTIN_TEMPLATE_IDS], EXPECTED_IDS);
});

test("every template carries the required file-04 §2 fields", () => {
  for (const t of BUILTIN_TEMPLATES) {
    assert.equal(typeof t.id, "string");
    assert.ok(t.id.length > 0, `${t.id}: id non-empty`);
    assert.equal(typeof t.title, "string");
    assert.ok(t.title.length > 0, `${t.id}: title non-empty`);
    assert.equal(typeof t.description, "string");
    assert.ok(t.description.length > 0, `${t.id}: description non-empty`);
    assert.ok(Array.isArray(t.packages), `${t.id}: packages is array`);
    assert.ok(t.packages.length > 0, `${t.id}: has at least one package`);
    assert.equal(t.editable, true, `${t.id}: editable must be true`);
    assert.equal(t.builtin, true, `${t.id}: shipped template is builtin`);
    // optional fields, when present, are the right type.
    if (t.needs !== undefined) assert.ok(Array.isArray(t.needs));
    if (t.postNotes !== undefined) assert.ok(Array.isArray(t.postNotes));
    if (t.pythonHint !== undefined) assert.equal(typeof t.pythonHint, "string");
    for (const p of t.packages) {
      assert.equal(typeof p.name, "string", `${t.id}: package name is string`);
      assert.ok(p.name.length > 0, `${t.id}: package name non-empty`);
    }
  }
});

test("getBuiltinTemplate resolves a shipped id and rejects an unknown one", () => {
  const ml = getBuiltinTemplate("ml-starter");
  assert.ok(ml);
  assert.equal(ml?.title, "ML Starter");
  assert.equal(getBuiltinTemplate("does-not-exist"), undefined);
});

test("§7 GPU templates (ml-starter, llm-serving) carry torch + an nvidia need", () => {
  for (const id of ["ml-starter", "llm-serving"]) {
    const t = getBuiltinTemplate(id) as Template;
    assert.ok(
      t.packages.some((p) => p.name === "torch"),
      `${id}: has a torch row`,
    );
    assert.ok(t.needs?.includes("nvidia"), `${id}: declares the nvidia prerequisite`);
  }
});

test("llm-serving keeps flash-attn + bitsandbytes OPTIONAL (unchecked by default)", () => {
  const t = getBuiltinTemplate("llm-serving") as Template;
  const fa = t.packages.find((p) => p.name === "flash-attn");
  const bnb = t.packages.find((p) => p.name === "bitsandbytes");
  assert.equal(fa?.optional, true);
  assert.equal(bnb?.optional, true);
  // default resolve drops the optional rows; opting in folds them back.
  const def = templateResolve(t);
  assert.equal(
    def.some((r) => r.name === "flash-attn"),
    false,
  );
  const withOpt = templateResolve(t, null, { includeOptional: true });
  assert.ok(withOpt.some((r) => r.name === "flash-attn"));
});

test("data-science / deep-research / notebook-min / airllm are CPU-only (no nvidia need)", () => {
  for (const id of ["data-science", "deep-research", "notebook-min", "airllm"]) {
    const t = getBuiltinTemplate(id) as Template;
    assert.ok(!t.needs || !t.needs.includes("nvidia"), `${id}: should not require nvidia`);
  }
});

test("every shipped template resolves to a non-empty default gate plan", () => {
  for (const t of BUILTIN_TEMPLATES) {
    const specs = templateResolve(t, null);
    assert.ok(specs.length > 0, `${t.id}: resolves at least one default-checked spec`);
  }
});
