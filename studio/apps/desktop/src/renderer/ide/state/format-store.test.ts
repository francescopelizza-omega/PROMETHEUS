/**
 * format-store.test.ts — node:test for the renderer format-store (APP-019). Pins the
 * derived core FormatPolicy + the per-language flag write path (no window/IPC needed:
 * hydrate/set degrade to cache-only when window.prometheus is absent).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FORMAT_LANG_IDS, useFormatStore } from "./format-store.js";

test("default state: onSave off, every language enabled, policy() reflects it", () => {
  useFormatStore.setState({
    onSave: false,
    optimizeImportsOnSave: false,
    byLang: Object.fromEntries(FORMAT_LANG_IDS.map((id) => [id, true])),
  });
  const p = useFormatStore.getState().policy();
  assert.equal(p.onSave, false);
  assert.equal(p.afterAiEdit, false); // save is the ONLY formatter (no double-format)
  assert.equal(p.optimizeImportsOnSave, false);
  for (const id of FORMAT_LANG_IDS) assert.equal(p.byLang?.[id], true);
});

test("setLang(false) suppresses one language in the derived policy (cache path)", async () => {
  await useFormatStore.getState().setLang("python", false);
  const p = useFormatStore.getState().policy();
  assert.equal(p.byLang?.python, false);
  assert.equal(p.byLang?.typescript, true); // others unaffected
});

test("setOnSave / setOptimizeImports flip the cached flags", async () => {
  await useFormatStore.getState().setOnSave(true);
  await useFormatStore.getState().setOptimizeImports(true);
  const p = useFormatStore.getState().policy();
  assert.equal(p.onSave, true);
  assert.equal(p.optimizeImportsOnSave, true);
});
