/**
 * settings-scope.test.ts — the PURE scope-tab + provenance helpers (APP-058).
 *
 * SettingsTreePage is a React component (no node:test render), so the scope-switch /
 * provenance / edit-routing LOGIC is pinned here against plain SettingsNodeView data.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SETTINGS_SCOPES,
  displayValue,
  layerLabel,
  provenanceSummary,
  rawAtScope,
  scopeToWriteScope,
} from "./settings-scope.js";
import type { SettingsNodeView } from "./settings-view.js";

test("SETTINGS_SCOPES: Default is read-only; User/Project are writable", () => {
  assert.deepEqual(
    SETTINGS_SCOPES.map((s) => [s.id, s.writable]),
    [
      ["default", false],
      ["user", true],
      ["project", true],
    ],
  );
});

test("scopeToWriteScope: user→global, project→workspace, default→null (read-only)", () => {
  assert.equal(scopeToWriteScope("user"), "global");
  assert.equal(scopeToWriteScope("project"), "workspace");
  assert.equal(scopeToWriteScope("default"), null);
});

test("layerLabel: layer → human scope label", () => {
  assert.equal(layerLabel("global"), "User");
  assert.equal(layerLabel("workspace"), "Project");
  assert.equal(layerLabel("default"), "Default");
  assert.equal(layerLabel("profile"), "Profile");
  assert.equal(layerLabel(undefined), "—");
});

test("rawAtScope: reads the pre-merge value; falsy-but-set ≠ not-set", () => {
  const node: SettingsNodeView = {
    id: "n",
    title: "T",
    category: "C",
    ownerFile: "13",
    rawByScope: { default: true, user: false }, // user set it to false (real override)
  };
  assert.deepEqual(rawAtScope(node, "default"), { set: true, value: true });
  assert.deepEqual(rawAtScope(node, "user"), { set: true, value: false }); // falsy but SET
  assert.deepEqual(rawAtScope(node, "project"), { set: false, value: undefined }); // not set
  // a node with no rawByScope at all → every scope is unset.
  assert.deepEqual(rawAtScope({ ...node, rawByScope: undefined }, "user"), {
    set: false,
    value: undefined,
  });
});

test("displayValue: scalars, objects, undefined", () => {
  assert.equal(displayValue(14), "14");
  assert.equal(displayValue(false), "false");
  assert.equal(displayValue("dark"), "dark");
  assert.equal(displayValue(["a", "b"]), '["a","b"]');
  assert.equal(displayValue(undefined), "—");
});

test("provenanceSummary: default-only, override chain, unset", () => {
  const base: Omit<SettingsNodeView, "layer" | "definedIn"> = {
    id: "n",
    title: "T",
    category: "C",
    ownerFile: "13",
  };
  // shipped default only
  assert.equal(provenanceSummary({ ...base, layer: "default", definedIn: ["default"] }), "default");
  // project wins, overrides user + default (chain in precedence order)
  assert.equal(
    provenanceSummary({
      ...base,
      layer: "workspace",
      definedIn: ["default", "global", "workspace"],
    }),
    "set in Project, overrides Default + User",
  );
  // user wins over default
  assert.equal(
    provenanceSummary({ ...base, layer: "global", definedIn: ["default", "global"] }),
    "set in User, overrides Default",
  );
  // profile winner (no editable tab, still named)
  assert.equal(
    provenanceSummary({ ...base, layer: "profile", definedIn: ["default", "profile"] }),
    "set in Profile, overrides Default",
  );
  // unset everywhere
  assert.equal(provenanceSummary({ ...base, layer: "unset", definedIn: [] }), "not set");
});
