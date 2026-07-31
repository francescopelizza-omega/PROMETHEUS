/**
 * keymap-overrides.test.ts — the container glue + the full rebind LIFECYCLE (APP-057).
 *
 * SettingsPanel is a React component (no node:test render), so the "rebind → conflict →
 * save → reset" interaction the plan asks for is pinned here at the logic level: the shell
 * registry → core override layer → live map, exercised end to end with the same functions
 * the container calls.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type KeyBinding,
  applyUserBinding,
  clearUserBinding,
  conflictsForCandidate,
  mergeUserBindings,
} from "@prometheus/core/keymap";

import { parseChordString } from "../commands/registry.js";
import {
  commandTitle,
  overridesToMap,
  parseOverrides,
  shellPresetBindings,
} from "./keymap-overrides.js";

test("shellPresetBindings: every registry chord becomes a preset binding (id + keys)", () => {
  const preset = shellPresetBindings();
  const palette = preset.find((b) => b.command === "view.commandPalette");
  assert.equal(palette?.keys, "mod+k");
  assert.equal(palette?.source, "preset");
  // every listed binding is dispatchable (parseChordString round-trips it).
  for (const b of preset) assert.ok(parseChordString(b.keys), `unparseable preset keys ${b.keys}`);
});

test("commandTitle resolves the id → human title; unknown id passes through", () => {
  assert.equal(commandTitle("view.commandPalette"), "Command Palette");
  assert.equal(commandTitle("nope.nope"), "nope.nope");
});

test("full lifecycle: rebind → conflict flagged pre-save → save → live map → reset", () => {
  const preset = shellPresetBindings();
  let overrides: KeyBinding[] = [];

  // 1) rebinding view.commandPalette to view.toggleSidebar's chord (mod+b) is a CONFLICT.
  const merged0 = mergeUserBindings(preset, overrides);
  const conflicts = conflictsForCandidate(merged0, {
    command: "view.commandPalette",
    keys: "mod+b",
  });
  assert.equal(conflicts.length, 1);
  assert.ok(conflicts[0]?.commands.includes("view.toggleSidebar"));

  // 2) instead bind a free chord (mod+shift+j) — no conflict → save.
  assert.equal(
    conflictsForCandidate(merged0, { command: "view.commandPalette", keys: "mod+shift+j" }).length,
    0,
  );
  overrides = applyUserBinding(preset, overrides, {
    command: "view.commandPalette",
    keys: "mod+shift+j",
    source: "user",
  });

  // 3) merged shows the override with source user; the live map carries the new chord.
  const merged1 = mergeUserBindings(preset, overrides);
  const row = merged1.find((b) => b.command === "view.commandPalette");
  assert.equal(row?.keys, "mod+shift+j");
  assert.equal(row?.source, "user");
  assert.equal(overridesToMap(overrides)["view.commandPalette"], "mod+shift+j");

  // 4) reset restores the preset chord + removes the override entirely.
  overrides = clearUserBinding(overrides, "view.commandPalette");
  const merged2 = mergeUserBindings(preset, overrides);
  assert.equal(merged2.find((b) => b.command === "view.commandPalette")?.keys, "mod+k");
  assert.equal(merged2.find((b) => b.command === "view.commandPalette")?.source, "preset");
  assert.equal(overrides.length, 0);
});

test("parseOverrides: fail-soft, forces source user, drops malformed rows", () => {
  assert.deepEqual(parseOverrides(null), []);
  assert.deepEqual(parseOverrides("{not json"), []);
  assert.deepEqual(parseOverrides(JSON.stringify({ not: "array" })), []);
  const ok = parseOverrides(
    JSON.stringify([
      { command: "a.b", keys: "mod+k", source: "preset" }, // source coerced → user
      { command: "bad" }, // no keys → dropped
      { keys: "mod+x" }, // no command → dropped
    ]),
  );
  assert.equal(ok.length, 1);
  assert.deepEqual(ok[0], { command: "a.b", keys: "mod+k", source: "user" });
});
