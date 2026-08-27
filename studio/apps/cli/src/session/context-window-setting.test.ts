import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT_WINDOW_PRESETS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  loadContextWindowTokens,
  parseContextWindowInput,
  saveContextWindowTokens,
} from "./context-window-setting.js";

test("parseContextWindowInput: plain / k / m suffixes", () => {
  assert.equal(parseContextWindowInput("250000"), 250_000);
  assert.equal(parseContextWindowInput("250k"), 250_000);
  assert.equal(parseContextWindowInput("250K"), 250_000);
  assert.equal(parseContextWindowInput("1.5m"), 1_500_000);
  assert.equal(parseContextWindowInput(" 1m "), 1_000_000);
});

test("parseContextWindowInput: rejects garbage + out-of-range", () => {
  assert.equal(parseContextWindowInput("abc"), null);
  assert.equal(parseContextWindowInput(""), null);
  assert.equal(parseContextWindowInput("1"), null); // below the 1,000-token floor
  assert.equal(parseContextWindowInput("999999999"), null); // above the ceiling
  assert.equal(parseContextWindowInput("-5"), null);
});

test("CONTEXT_WINDOW_PRESETS: the 9 documented sizes, 250k included", () => {
  assert.equal(CONTEXT_WINDOW_PRESETS.length, 9);
  assert.ok(CONTEXT_WINDOW_PRESETS.includes(250_000));
  assert.ok(CONTEXT_WINDOW_PRESETS.includes(1_500_000));
});

test("load/save round-trip; unset home defaults to 250k", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-ctxwin-"));
  try {
    assert.equal(loadContextWindowTokens(home), DEFAULT_CONTEXT_WINDOW_TOKENS);
    saveContextWindowTokens(home, 750_000);
    assert.equal(loadContextWindowTokens(home), 750_000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadContextWindowTokens: a corrupt/out-of-range stored value falls back to the default", () => {
  const home = mkdtempSync(join(tmpdir(), "prom-ctxwin-"));
  try {
    saveContextWindowTokens(home, 99); // below MIN_TOKENS, but saveSettings doesn't validate
    assert.equal(loadContextWindowTokens(home), DEFAULT_CONTEXT_WINDOW_TOKENS);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
