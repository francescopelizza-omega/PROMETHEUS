/**
 * tokens.test.ts — node:test coverage for the dependency-free token logic.
 * Runnable after a plain tsc emit (no React, no test framework install).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILTIN_SCHEMES,
  DEFAULT_SCHEME_ID,
  SEVERITY_ROLE,
  STATE_ROLE,
  type SemanticColors,
  VERDICT_GLYPH,
  VERDICT_LABEL,
  VERDICT_ROLE,
  baseSemantic,
  getScheme,
  resolveScheme,
} from "./tokens.js";

test("ships the 41 built-in schemes (20 first-party + 20 famous + Pelly)", () => {
  assert.equal(BUILTIN_SCHEMES.length, 41);
});

test("scheme ids are unique", () => {
  const ids = BUILTIN_SCHEMES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the default scheme exists and is first", () => {
  assert.equal(BUILTIN_SCHEMES[0]?.id, DEFAULT_SCHEME_ID);
  assert.equal(getScheme(DEFAULT_SCHEME_ID).id, DEFAULT_SCHEME_ID);
});

test("at least 6 schemes are fully hand-authored", () => {
  const filled = BUILTIN_SCHEMES.filter((s) => s.filled);
  assert.ok(filled.length >= 6, `expected >=6 filled, got ${filled.length}`);
});

test("getScheme falls back to the default for an unknown id", () => {
  assert.equal(getScheme("does-not-exist").id, DEFAULT_SCHEME_ID);
});

test("resolveScheme yields a complete SemanticColors map for every scheme", () => {
  const keys = Object.keys(baseSemantic("dark")) as (keyof SemanticColors)[];
  for (const scheme of BUILTIN_SCHEMES) {
    const resolved = resolveScheme(scheme);
    for (const k of keys) {
      assert.equal(typeof resolved[k], "string", `${scheme.id} missing ${k}`);
      assert.ok(resolved[k].length > 0, `${scheme.id} empty ${k}`);
    }
  }
});

test("verdict role map matches C3 (allow=ok, warn=warn, block/error=danger)", () => {
  assert.equal(VERDICT_ROLE.allow, "ok");
  assert.equal(VERDICT_ROLE.warn, "warn");
  assert.equal(VERDICT_ROLE.block, "danger");
  assert.equal(VERDICT_ROLE.error, "danger");
});

test("severity role map: clean/low=ok, medium=warn, high/critical=danger (08 §2.2)", () => {
  assert.equal(SEVERITY_ROLE.clean, "ok");
  assert.equal(SEVERITY_ROLE.low, "ok");
  assert.equal(SEVERITY_ROLE.medium, "warn");
  assert.equal(SEVERITY_ROLE.high, "danger");
  assert.equal(SEVERITY_ROLE.critical, "danger");
});

test("component-state role map mirrors cmd_status (08 §2.2)", () => {
  assert.equal(STATE_ROLE.enabled, "ok");
  assert.equal(STATE_ROLE.installed, "ok");
  assert.equal(STATE_ROLE.disabled, "warn");
  assert.equal(STATE_ROLE.muted, "accent");
  assert.equal(STATE_ROLE.absent, "text-disabled");
  assert.equal(STATE_ROLE.missing, "warn");
});

test("error tier carries the distinct ⚠ glyph + SCAN FAILED copy (C5 fail-closed)", () => {
  assert.equal(VERDICT_GLYPH.error, "⚠");
  assert.equal(VERDICT_LABEL.error, "SCAN FAILED");
  assert.equal(VERDICT_GLYPH.allow, "✓");
  assert.equal(VERDICT_LABEL.allow, "CLEAN");
});
