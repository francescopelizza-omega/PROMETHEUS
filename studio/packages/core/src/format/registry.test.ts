/**
 * registry.test.ts — node:test for the format-on-save policy gating (APP-019 extension).
 * The preset/argv/resolver spine is covered by commands/loader.test.ts; this pins the
 * new per-language flags (byLang) and the LSP-oriented formatOnSaveEnabled gate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type FormatPolicy, formatOnSaveEnabled, shouldFormatOnSave } from "./registry.js";

test("formatOnSaveEnabled: off by default, on when policy.onSave, per-lang false suppresses", () => {
  assert.equal(formatOnSaveEnabled("python"), false); // DEFAULT policy onSave=false
  const on: FormatPolicy = { onSave: true, afterAiEdit: true };
  assert.equal(formatOnSaveEnabled("python", on), true);
  assert.equal(formatOnSaveEnabled("typescript", on), true);
  const pyOff: FormatPolicy = { onSave: true, afterAiEdit: true, byLang: { python: false } };
  assert.equal(formatOnSaveEnabled("python", pyOff), false); // python suppressed…
  assert.equal(formatOnSaveEnabled("typescript", pyOff), true); // …others unaffected
  // an explicit `true` is the same as absent (enabled).
  assert.equal(
    formatOnSaveEnabled("go", { onSave: true, afterAiEdit: true, byLang: { go: true } }),
    true,
  );
});

test("shouldFormatOnSave: optional lang arg gates the external-formatter path too", () => {
  const on: FormatPolicy = { onSave: true, afterAiEdit: true };
  assert.equal(shouldFormatOnSave("a.ts", on), true); // prettier/biome preset matches ts
  assert.equal(shouldFormatOnSave("a.ts", on, "typescript"), true);
  const tsOff: FormatPolicy = { onSave: true, afterAiEdit: true, byLang: { typescript: false } };
  assert.equal(shouldFormatOnSave("a.ts", tsOff, "typescript"), false); // lang flag wins
  // back-compat: the 2-arg form is unchanged (no lang gating).
  assert.equal(shouldFormatOnSave("a.ts", tsOff), true);
});
