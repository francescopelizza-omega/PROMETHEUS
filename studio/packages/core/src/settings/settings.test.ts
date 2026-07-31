/**
 * settings.test.ts — schema validation + deep-merge layering + profiles (§7.1).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type SettingsLayerInput,
  deepMerge,
  explainKey,
  flattenSettings,
  isSetAt,
  layerSettings,
  rawValueAt,
} from "./layering.js";
import { BUILTIN_PROFILES, DEFAULT_PROFILE_ID, applyProfile, getProfile } from "./profiles.js";
import { DEFAULT_SETTINGS, type Settings, validateSettings } from "./schema.js";

test("validateSettings: type-check known keys, pass through extension keys", () => {
  const v = validateSettings({
    theme: "dracula",
    density: "compact",
    cloudModelsEnabled: false,
    gateStrict: "yes", // wrong type → dropped
    "acme.maxRows": 5000, // extension key → kept
  });
  assert.equal(v.theme, "dracula");
  assert.equal(v.density, "compact");
  assert.equal(v.cloudModelsEnabled, false);
  assert.equal("gateStrict" in v, false);
  assert.equal(v["acme.maxRows"], 5000);
  // bad density value dropped
  assert.equal("density" in validateSettings({ density: "huge" }), false);
  // non-record → {}
  assert.deepEqual(validateSettings(42), {});
});

test("validateSettings: todoPatterns is sanitized element-wise (drop bad row, keep rest)", () => {
  const v = validateSettings({
    todoPatterns: [
      { name: "TODO", regex: "\\bTODO\\b" }, // good
      { name: "ci", regex: "\\bNOCOMMIT\\b", caseSensitive: false }, // good (optional flag)
      { name: "missing-regex" }, // bad: no regex → dropped
      { regex: "\\bORPHAN\\b" }, // bad: no name → dropped
      { name: "x", regex: 42 }, // bad: non-string regex → dropped
      { name: "y", regex: "\\bY\\b", caseSensitive: "no" }, // bad: non-boolean flag → dropped
      "nope", // bad: not an object → dropped
    ],
  });
  assert.deepEqual(v.todoPatterns, [
    { name: "TODO", regex: "\\bTODO\\b" },
    { name: "ci", regex: "\\bNOCOMMIT\\b", caseSensitive: false },
  ]);
  // a non-array drops the whole key (never fatal).
  assert.equal("todoPatterns" in validateSettings({ todoPatterns: "x" }), false);
  // the shipped defaults seed the four builtin markers.
  assert.deepEqual(
    (DEFAULT_SETTINGS.todoPatterns ?? []).map((p) => p.name),
    ["TODO", "FIXME", "HACK", "XXX"],
  );
});

test("deepMerge: nested objects merge, arrays/scalars replace, later wins", () => {
  const merged = deepMerge(
    { a: 1, nested: { x: 1, y: 2 }, arr: [1, 2] },
    { a: 2, nested: { y: 3, z: 4 }, arr: [9] },
  );
  assert.equal(merged.a, 2);
  assert.deepEqual(merged.nested, { x: 1, y: 3, z: 4 }); // sibling x preserved
  assert.deepEqual(merged.arr, [9]); // array replaced, not concatenated
});

test("layerSettings: precedence defaults ◀ global ◀ profile ◀ workspace", () => {
  const eff = layerSettings(
    DEFAULT_SETTINGS,
    { theme: "global-theme", gateStrict: false },
    { gateStrict: true }, // profile overrides global
    { theme: "workspace-theme" }, // workspace overrides global theme
  );
  assert.equal(eff.theme, "workspace-theme"); // highest layer wins
  assert.equal(eff.gateStrict, true); // profile beat global
  assert.equal(eff.density, "comfortable"); // from defaults (untouched)
});

// ---- per-key provenance (APP-058) ----------------------------------------- //

test("flattenSettings: nested records recurse; arrays/scalars are single leaves; undefined skipped", () => {
  const flat = flattenSettings({
    theme: "dark",
    nested: { x: 1, y: { z: 2 } },
    arr: [1, 2, 3],
    "format.onSave": false, // an already-dotted flat key stays one leaf
    gone: undefined,
    zero: 0,
  });
  assert.equal(flat.theme, "dark");
  assert.equal(flat["nested.x"], 1);
  assert.equal(flat["nested.y.z"], 2);
  assert.deepEqual(flat.arr, [1, 2, 3]); // array is ONE leaf, not arr.0/arr.1
  assert.equal(flat["format.onSave"], false);
  assert.equal(flat.zero, 0); // falsy but real
  assert.equal(Object.hasOwn(flat, "gone"), false); // undefined → not a leaf
});

test("explainKey: winner = highest layer that sets it; definedIn lists all in order", () => {
  const layers: SettingsLayerInput[] = [
    { id: "defaults", settings: { theme: "system", gateStrict: false } },
    { id: "global", settings: { theme: "dark" } },
    { id: "profile", settings: {} },
    { id: "workspace", settings: { theme: "light" } },
  ];
  const theme = explainKey("theme", layers);
  assert.equal(theme.effective, "light");
  assert.equal(theme.winner, "workspace");
  assert.deepEqual(theme.definedIn, ["defaults", "global", "workspace"]);
  // a key only in defaults → winner defaults, defined only there.
  const gate = explainKey("gateStrict", layers);
  assert.equal(gate.effective, false);
  assert.equal(gate.winner, "defaults");
  assert.deepEqual(gate.definedIn, ["defaults"]);
  // an absent key → no winner, empty definedIn, undefined effective.
  const missing = explainKey("nope", layers);
  assert.equal(missing.winner, undefined);
  assert.deepEqual(missing.definedIn, []);
  assert.equal(missing.effective, undefined);
});

test("explainKey: a User false wins over a Default true (falsy ≠ absent)", () => {
  const layers: SettingsLayerInput[] = [
    { id: "defaults", settings: { autoApprove: true } },
    { id: "global", settings: { autoApprove: false } },
  ];
  const p = explainKey("autoApprove", layers);
  assert.equal(p.effective, false);
  assert.equal(p.winner, "global");
  assert.deepEqual(p.definedIn, ["defaults", "global"]);
});

test("explainKey matches layerSettings' effective value (no drift)", () => {
  const defaults = { ...DEFAULT_SETTINGS };
  const global = { theme: "dark", "format.onSave": true } as Settings;
  const workspace = { theme: "light" } as Settings;
  const eff = layerSettings(defaults, global, undefined, workspace);
  const layers: SettingsLayerInput[] = [
    { id: "defaults", settings: defaults },
    { id: "global", settings: global },
    { id: "workspace", settings: workspace },
  ];
  assert.equal(explainKey("theme", layers).effective, eff.theme);
  assert.equal(explainKey("format.onSave", layers).effective, eff["format.onSave"]);
});

test("rawValueAt / isSetAt read the PRE-merge value at one scope", () => {
  const global = { theme: "dark", autoApprove: false } as Settings;
  assert.equal(rawValueAt("theme", global), "dark");
  assert.equal(rawValueAt("autoApprove", global), false);
  assert.equal(rawValueAt("density", global), undefined); // not set at this scope
  assert.equal(isSetAt("autoApprove", global), true); // falsy but set
  assert.equal(isSetAt("density", global), false);
  assert.equal(isSetAt("theme", undefined), false); // no layer at all
});

test("profiles: 3 built-ins; Security-strict disables force + auto-approve", () => {
  assert.equal(BUILTIN_PROFILES.length, 3);
  assert.equal(getProfile(DEFAULT_PROFILE_ID)?.label, "Power-dev");
  assert.equal(getProfile("missing"), undefined);

  const strict = getProfile("security-strict");
  assert.ok(strict);
  const applied = applyProfile(DEFAULT_SETTINGS, strict as NonNullable<typeof strict>);
  assert.equal(applied.gateStrict, true);
  assert.equal(applied.allowForce, false);
  assert.equal(applied.autoApprove, false);

  const local = getProfile("local-only");
  const localApplied = applyProfile(
    DEFAULT_SETTINGS as Settings,
    local as NonNullable<typeof local>,
  );
  assert.equal(localApplied.cloudModelsEnabled, false);
  assert.equal(localApplied.defaultNetwork, "none");
});
