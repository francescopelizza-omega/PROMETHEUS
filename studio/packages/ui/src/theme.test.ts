/**
 * theme.test.ts — node:test coverage for the theme@1 loader/applier.
 * Pure logic only (no React, no DOM) — runnable after a plain tsc emit.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTheme,
  defaultTheme,
  exportTheme,
  loadTheme,
  schemeToTheme,
  themeFromBase,
  themeToCssVars,
  validateTheme,
} from "./theme.js";
import { getScheme } from "./tokens.js";

const GOOD = JSON.stringify({
  schema: "theme@1",
  meta: { id: "acme-midnight", label: "Acme Midnight" },
  base: "dark",
  uiTokens: { "bg-app": "#000000", "text-primary": "#ffffff" },
  syntaxTokens: { keyword: "#ff00ff", comment: { color: "#888888", italic: true } },
});

test("loadTheme parses a valid theme@1 document", () => {
  const t = loadTheme(GOOD);
  assert.ok(t);
  assert.equal(t?.meta.id, "acme-midnight");
  assert.equal(t?.base, "dark");
});

test("loadTheme fails SOFT (null) on malformed JSON — never throws (13 §3.7)", () => {
  assert.equal(loadTheme("{ not json"), null);
});

test("validateTheme rejects a wrong schema discriminator", () => {
  assert.equal(validateTheme({ ...JSON.parse(GOOD), schema: "theme@2" }), null);
});

test("validateTheme rejects an unknown base", () => {
  assert.equal(validateTheme({ ...JSON.parse(GOOD), base: "neon" }), null);
});

test("validateTheme rejects empty uiTokens / syntaxTokens", () => {
  assert.equal(validateTheme({ ...JSON.parse(GOOD), uiTokens: {} }), null);
  assert.equal(validateTheme({ ...JSON.parse(GOOD), syntaxTokens: {} }), null);
});

test("validateTheme rejects a non-string ui token value", () => {
  assert.equal(validateTheme({ ...JSON.parse(GOOD), uiTokens: { "bg-app": 123 } }), null);
});

test("themeToCssVars maps ui tokens to --<key> and syntax to --syntax-<scope>", () => {
  const vars = themeToCssVars(loadTheme(GOOD)!);
  assert.equal(vars["--bg-app"], "#000000");
  assert.equal(vars["--text-primary"], "#ffffff");
  assert.equal(vars["--syntax-keyword"], "#ff00ff");
  assert.equal(vars["--syntax-comment"], "#888888"); // object → its color
});

test("applyTheme writes vars + data-theme onto a stub root", () => {
  const written: Record<string, string> = {};
  let dataTheme = "";
  const root = {
    style: {
      setProperty: (k: string, v: string): void => {
        written[k] = v;
      },
    },
    setAttribute: (name: string, value: string) => {
      if (name === "data-theme") dataTheme = value;
    },
  };
  const out = applyTheme(loadTheme(GOOD)!, root);
  assert.equal(dataTheme, "dark");
  assert.equal(written["--bg-app"], "#000000");
  assert.deepEqual(out, written);
});

test("applyTheme is a no-op-safe pure map when there is no DOM (returns vars)", () => {
  const out = applyTheme(loadTheme(GOOD)!, null);
  assert.equal(out["--bg-app"], "#000000");
});

test("defaultTheme is a valid theme@1 doc on the dark base (★ Prometheus Dark)", () => {
  const t = defaultTheme();
  assert.equal(t.schema, "theme@1");
  assert.equal(t.base, "dark");
  assert.equal(t.meta.id, "prometheus-dark");
  assert.ok(t.uiTokens["bg-app"]);
});

test("schemeToTheme round-trips a built-in scheme through validateTheme", () => {
  const theme = schemeToTheme(getScheme("ember"));
  // re-serialize and re-load to prove it satisfies the schema shape.
  assert.ok(validateTheme(JSON.parse(JSON.stringify(theme))));
  assert.equal(theme.base, "dark");
});

test("themeFromBase produces a complete, valid doc for each base", () => {
  for (const base of ["dark", "light", "high-contrast"] as const) {
    const t = themeFromBase(base);
    assert.ok(validateTheme(JSON.parse(JSON.stringify(t))), `base ${base} invalid`);
    assert.equal(t.base, base);
  }
});

/* ── APP-094: exportTheme deterministic + round-trip ────────────────────────*/

test("exportTheme is deterministic (sorted keys) + round-trips through validate/load", () => {
  // build from a builtin scheme (the normalized, post-load form).
  const t = schemeToTheme(getScheme("prometheus-dark"));
  const json = exportTheme(t);
  // deterministic: uiTokens keys are emitted sorted.
  const parsed = JSON.parse(json);
  const uiKeys = Object.keys(parsed.uiTokens);
  assert.deepEqual(uiKeys, [...uiKeys].sort(), "uiTokens keys are sorted");
  // round-trip: validate(load(export(t))) deep-equals the normalized document.
  const back = loadTheme(json);
  assert.ok(back);
  assert.deepEqual(validateTheme(back), t);
  // and re-exporting is byte-identical (stable).
  assert.equal(exportTheme(back as NonNullable<typeof back>), json);
});

test("exportTheme carries optional meta fields when present", () => {
  const t = validateTheme({
    schema: "theme@1",
    meta: { id: "x-y", label: "X Y", author: "me", version: "1.2.3", description: "d" },
    base: "light",
    uiTokens: { "bg-app": "#ffffff", "text-primary": "#111111" },
    syntaxTokens: { keyword: "#ff00ff" },
  });
  assert.ok(t);
  const parsed = JSON.parse(exportTheme(t as NonNullable<typeof t>));
  assert.equal(parsed.meta.author, "me");
  assert.equal(parsed.meta.version, "1.2.3");
  assert.equal(parsed.meta.description, "d");
});
