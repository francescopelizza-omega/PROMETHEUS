/**
 * keymap.test.ts — keymap presets, key normalization, conflict detection (file 13 §2.2)
 * + the §2.1 settings tree + search.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BINDABLE_COMMANDS,
  BUILTIN_KEYMAPS,
  DEFAULT_KEYMAP_ID,
  KEYMAP_MACOS,
  type KeyBinding,
  type Keymap,
  applyUserBinding,
  clearUserBinding,
  conflictsForCandidate,
  detectConflicts,
  exportKeymap,
  getKeymap,
  importKeymap,
  isChord,
  mergeUserBindings,
  normalizeKeys,
  resolveBindings,
  resolveConflict,
  setBinding,
} from "./keymap.js";
import { SETTINGS_TREE, findNode, flattenTree, nodePath, searchSettings } from "./tree.js";

// ---- presets --------------------------------------------------------------- //

test("ships PyCharm, VS Code, Vim, and macOS presets; VS Code is the default", () => {
  assert.equal(BUILTIN_KEYMAPS.length, 4);
  assert.equal(DEFAULT_KEYMAP_ID, "vscode");
  for (const id of ["pycharm", "vscode", "vim", "macos"])
    assert.ok(getKeymap(id), `missing keymap ${id}`);
});

test("Vim extends VS Code (base bindings inherited + its own)", () => {
  const vim = getKeymap("vim");
  assert.ok(vim);
  const resolved = resolveBindings(vim as NonNullable<typeof vim>);
  assert.ok(
    resolved.some((x) => x.command === "navigate.file"),
    "inherits VS Code's go-to-file",
  );
  assert.ok(
    resolved.some((x) => x.command === "navigate.symbol" && isChord(x.keys)),
    "adds its own chord",
  );
});

// ---- key normalization (cmd↔ctrl, chords, modifier order) ------------------ //

test("normalizeKeys is order-insensitive, lowercases, and folds cmd↔ctrl to mod", () => {
  // modifier order + case don't matter — same canonical form
  assert.equal(normalizeKeys("Shift+Ctrl+F10"), normalizeKeys("ctrl+shift+f10"));
  assert.ok(normalizeKeys("Shift+Ctrl+F10").includes("f10"));
  // cmd+k and ctrl+k normalize to the same canonical form (OS-modifier normalization)
  assert.equal(normalizeKeys("cmd+k"), normalizeKeys("ctrl+k"));
  // without folding, cmd and ctrl differ
  assert.notEqual(normalizeKeys("cmd+k", false), normalizeKeys("ctrl+k", false));
});

test("isChord detects multi-segment bindings", () => {
  assert.equal(isChord("g d"), true);
  assert.equal(isChord("cmd+k cmd+k"), true);
  assert.equal(isChord("ctrl+shift+f10"), false);
});

// ---- conflict detection (§2.2) -------------------------------------------- //

test("detectConflicts finds a same-keys/same-scope collision", () => {
  const bindings: KeyBinding[] = [
    { command: "terminal.runPrompt", keys: "alt+enter", when: "editorTextFocus", source: "user" },
    { command: "ai.inlineEdit", keys: "alt+enter", when: "editorTextFocus", source: "preset" },
    { command: "editor.save", keys: "cmd+s", source: "preset" },
  ];
  const conflicts = detectConflicts(bindings);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(
    new Set(conflicts[0]?.commands),
    new Set(["terminal.runPrompt", "ai.inlineEdit"]),
  );
});

test("distinct when-scopes on the same keys do NOT conflict", () => {
  const bindings: KeyBinding[] = [
    { command: "a", keys: "alt+enter", when: "editorTextFocus", source: "user" },
    { command: "b", keys: "alt+enter", when: "terminalFocus", source: "user" },
  ];
  assert.equal(detectConflicts(bindings).length, 0);
});

test("a global + a scoped binding on the same keys report the collision ONCE, not twice", () => {
  const bindings: KeyBinding[] = [
    { command: "a", keys: "cmd+b", source: "preset" }, // global (no when)
    { command: "b", keys: "cmd+b", when: "editorFocus", source: "user" }, // scoped
  ];
  const conflicts = detectConflicts(bindings);
  assert.equal(conflicts.length, 1); // used to be 2 (one per outer index / when value)
  assert.deepEqual(new Set(conflicts[0]?.commands), new Set(["a", "b"]));
});

test("resolveConflict remove-other keeps one command on the keys", () => {
  const bindings: KeyBinding[] = [
    { command: "terminal.runPrompt", keys: "alt+enter", when: "editorTextFocus", source: "user" },
    { command: "ai.inlineEdit", keys: "alt+enter", when: "editorTextFocus", source: "preset" },
  ];
  const conflict = detectConflicts(bindings)[0];
  assert.ok(conflict);
  const after = resolveConflict(bindings, conflict as NonNullable<typeof conflict>, {
    kind: "remove-other",
    keep: "terminal.runPrompt",
  });
  assert.equal(after.length, 1);
  assert.equal(after[0]?.command, "terminal.runPrompt");
});

test("setBinding replaces a same-command/same-keys binding and marks it user", () => {
  const out = setBinding([{ command: "x", keys: "cmd+1", source: "preset" }], {
    command: "x",
    keys: "cmd+1",
    source: "preset",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.source, "user");
});

// ---- user-override layer (APP-057 interactive rebinding) ------------------- //

const PRESET057: KeyBinding[] = [
  { command: "view.commandPalette", keys: "mod+k", source: "preset" },
  { command: "view.toggleSidebar", keys: "mod+b", source: "preset" },
  { command: "search.findInFiles", keys: "mod+shift+f", source: "preset" },
];

test("applyUserBinding replaces by command, forces source:user, drops a redundant default", () => {
  // a real rebind → an override row for that command, source user.
  let ov = applyUserBinding(PRESET057, [], {
    command: "view.commandPalette",
    keys: "mod+shift+k",
    source: "preset",
  });
  assert.equal(ov.length, 1);
  assert.equal(ov[0]?.command, "view.commandPalette");
  assert.equal(ov[0]?.source, "user");
  // a second rebind of the SAME command replaces (not appends) the override.
  ov = applyUserBinding(PRESET057, ov, {
    command: "view.commandPalette",
    keys: "mod+j",
    source: "user",
  });
  assert.equal(ov.length, 1);
  assert.equal(normalizeKeys(ov[0]?.keys ?? ""), normalizeKeys("mod+j"));
  // rebinding BACK to the preset chord drops the override (reset-to-default).
  ov = applyUserBinding(PRESET057, ov, {
    command: "view.commandPalette",
    keys: "mod+k",
    source: "user",
  });
  assert.equal(ov.length, 0);
});

test("clearUserBinding removes exactly the one command's override", () => {
  const ov: KeyBinding[] = [
    { command: "view.commandPalette", keys: "mod+j", source: "user" },
    { command: "view.toggleSidebar", keys: "mod+e", source: "user" },
  ];
  const out = clearUserBinding(ov, "view.commandPalette");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.command, "view.toggleSidebar");
});

test("mergeUserBindings layers overrides over the preset; source truthful; new bindings appended", () => {
  const ov: KeyBinding[] = [
    { command: "view.commandPalette", keys: "mod+j", source: "user" }, // overrides a preset row
    { command: "ai.inlineEdit", keys: "mod+i", source: "user" }, // a command NOT in the preset
  ];
  const merged = mergeUserBindings(PRESET057, ov);
  const palette = merged.find((m) => m.command === "view.commandPalette");
  assert.equal(normalizeKeys(palette?.keys ?? ""), normalizeKeys("mod+j"));
  assert.equal(palette?.source, "user");
  // an untouched preset row keeps its source.
  assert.equal(merged.find((m) => m.command === "view.toggleSidebar")?.source, "preset");
  // the brand-new (not-in-preset) override is appended.
  assert.ok(merged.some((m) => m.command === "ai.inlineEdit" && m.source === "user"));
});

test("conflictsForCandidate flags a duplicate BEFORE commit — regardless of modifier order", () => {
  // binding view.commandPalette to mod+b collides with view.toggleSidebar's mod+b.
  const merged = mergeUserBindings(PRESET057, []);
  const c = conflictsForCandidate(merged, { command: "view.commandPalette", keys: "shift+shift" });
  assert.equal(c.length, 0); // no collision → no conflict
  const c2 = conflictsForCandidate(merged, { command: "view.commandPalette", keys: "b+mod" });
  assert.equal(c2.length, 1);
  assert.ok(c2[0]?.commands.includes("view.commandPalette"));
  assert.ok(c2[0]?.commands.includes("view.toggleSidebar"));
  // re-binding a command to ITS OWN current keys is not a self-conflict.
  const c3 = conflictsForCandidate(merged, { command: "view.toggleSidebar", keys: "mod+b" });
  assert.equal(c3.length, 0);
});

test("BINDABLE_COMMANDS includes terminal + view/navigate actions", () => {
  assert.ok(BINDABLE_COMMANDS.some((c) => c.id === "terminal.runPrompt"));
  assert.ok(BINDABLE_COMMANDS.some((c) => c.id === "search.everywhere"));
});

// ---- settings tree (§2.1) + search ---------------------------------------- //

test("settings tree has the JetBrains top-level groups with owner provenance", () => {
  const ids = SETTINGS_TREE.map((n) => n.id);
  for (const id of [
    "appearance-behavior",
    "keymap",
    "editor",
    "tools",
    "security",
    "plugins",
    "advanced",
  ]) {
    assert.ok(ids.includes(id), `tree missing ${id}`);
  }
  assert.equal(findNode("tools.terminal")?.ownerFile, "13");
  assert.equal(findNode("python.interpreter")?.ownerFile, "04");
});

test("nodePath returns the breadcrumb to a nested node", () => {
  const path = nodePath("tools.terminal").map((n) => n.id);
  assert.deepEqual(path, ["tools", "tools.terminal"]);
});

test("searchSettings filters by title/searchTerms, title-match ranked first", () => {
  const results = searchSettings("keymap");
  assert.ok(results.some((n) => n.id === "keymap"));
  const vim = searchSettings("vim");
  assert.ok(
    vim.some((n) => n.id === "keymap"),
    "matches via searchTerms",
  );
  assert.equal(searchSettings("").length, 0);
  assert.ok(flattenTree().length > SETTINGS_TREE.length, "flatten expands children");
});

/* ── APP-093: macOS preset + export/import round-trip ────────────────────────*/

test("KEYMAP_MACOS is registered, builtin, and internally conflict-free", () => {
  assert.ok(BUILTIN_KEYMAPS.some((k) => k.id === "macos"));
  assert.equal(getKeymap("macos")?.label, "macOS");
  assert.equal(KEYMAP_MACOS.builtin, true);
  // no two macOS bindings collide on the same (keys, when).
  assert.deepEqual(detectConflicts(resolveBindings(KEYMAP_MACOS)), []);
});

test("exportKeymap is deterministic; export→import round-trips byte-identical", () => {
  const km: Keymap = {
    id: "u1",
    base: "vscode",
    label: "Mine",
    builtin: false,
    bindings: [
      { command: "b.two", keys: "Shift+Cmd+K", source: "user" },
      { command: "a.one", keys: "cmd+p", source: "user", when: "editorFocus" },
    ],
  };
  const json = exportKeymap(km);
  // sorted by (command, keys) → a.one before b.two, and keys normalized (mods ordered).
  const parsed = JSON.parse(json);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.bindings[0].command, "a.one");
  assert.equal(parsed.bindings[1].keys, "cmd+shift+k"); // normalized order, cmd kept (not folded)
  // round-trip: import then re-export is byte-identical.
  const back = importKeymap(json);
  assert.ok(!("error" in back));
  assert.equal(exportKeymap(back as Keymap), json);
});

test("importKeymap rejects malformed / foreign files (fail-closed)", () => {
  assert.deepEqual(importKeymap("not json{"), { error: "not valid JSON" });
  assert.deepEqual(importKeymap("[]"), { error: "expected a keymap object" });
  assert.ok("error" in importKeymap('{"label":"x","bindings":[]}')); // missing id
  // an unknown top-level field is rejected (a foreign VSCode keybindings.json).
  assert.ok(
    "error" in importKeymap('{"id":"x","label":"x","builtin":false,"bindings":[],"vscodeOnly":1}'),
  );
  // an unknown per-binding field is rejected.
  assert.ok(
    "error" in
      importKeymap(
        '{"id":"x","label":"x","builtin":false,"bindings":[{"command":"a","keys":"cmd+p","evil":1}]}',
      ),
  );
  // a binding missing keys is rejected.
  assert.ok(
    "error" in importKeymap('{"id":"x","label":"x","builtin":false,"bindings":[{"command":"a"}]}'),
  );
});

test("importKeymap preserves a valid when verbatim + defaults source to user", () => {
  const r = importKeymap(
    '{"id":"x","label":"x","builtin":false,"bindings":[{"command":"a","keys":"cmd+p","when":"editorFocus && pythonFile"}]}',
  );
  assert.ok(!("error" in r));
  const km = r as Keymap;
  assert.equal(km.bindings[0]?.when, "editorFocus && pythonFile");
  assert.equal(km.bindings[0]?.source, "user");
});
