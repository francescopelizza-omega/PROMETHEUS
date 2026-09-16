/**
 * registry.test.ts — node:test for the PURE shell command registry (leap #1).
 *
 * Pins the exact-modifier chord matcher (so ⌘B never also fires ⌥⌘B), the
 * platform-aware label rendering, command execution by id, and the keydown→command
 * dispatch. Pure — no react/DOM — runs under node --test directly. The KeyboardEvent
 * is a minimal structural fake (only the fields the matcher reads).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isRouteTab } from "../../routes/route-tabs.js";
import {
  type Command,
  type CommandContext,
  type KeyChord,
  SHELL_COMMANDS,
  chordLabel,
  commandPaletteRows,
  commandTarget,
  effectiveKeybinding,
  executeCommandId,
  handleChord,
  matchChord,
  parseChordString,
} from "./registry.js";

interface FakeKey {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault?(): void;
}
function key(k: string, mods: Partial<FakeKey> = {}): FakeKey {
  return { key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods };
}

/** A CommandContext that records which callbacks fired. */
function spyCtx(): { ctx: CommandContext; log: string[] } {
  const log: string[] = [];
  const ctx: CommandContext = {
    navigate: (id) => log.push(`navigate:${id}`),
    togglePalette: () => log.push("togglePalette"),
    toggleSidebar: () => log.push("toggleSidebar"),
    toggleRightRail: () => log.push("toggleRightRail"),
    toggleBottomPanel: () => log.push("toggleBottomPanel"),
    openBottomPanel: (tab) => log.push(`openBottomPanel:${tab}`),
    openSettings: () => log.push("openSettings"),
    runEditorCommand: (id) => log.push(`runEditorCommand:${id}`),
  };
  return { ctx, log };
}

test("matchChord: ⌘K matches on mac, not when an extra modifier is held", () => {
  const cmdK: KeyChord = { key: "k", mod: true };
  assert.equal(matchChord(key("k", { metaKey: true }), cmdK, "mac"), true);
  assert.equal(matchChord(key("k", { metaKey: true, shiftKey: true }), cmdK, "mac"), false);
  assert.equal(matchChord(key("k", { ctrlKey: true }), cmdK, "mac"), false); // ctrl≠⌘ on mac
});

test("matchChord: ⇧⌥F still matches when macOS mangles Option+F into a diacritic (via e.code)", () => {
  const fmt: KeyChord = { key: "f", shift: true, alt: true };
  // real macOS keydown: Option+Shift+F → key "Ï", but code "KeyF".
  assert.equal(
    matchChord(key("Ï", { code: "KeyF", shiftKey: true, altKey: true }), fmt, "mac"),
    true,
  );
  // the code fallback is alt-only: a non-alt chord with a mismatched key does NOT match on code.
  const plainF: KeyChord = { key: "f", mod: true };
  assert.equal(matchChord(key("Ï", { code: "KeyF", metaKey: true }), plainF, "mac"), false);
  // wrong physical key doesn't match either.
  assert.equal(
    matchChord(key("Ï", { code: "KeyG", shiftKey: true, altKey: true }), fmt, "mac"),
    false,
  );
});

test("matchChord: ⌘B and ⌥⌘B are distinct (exact modifier match)", () => {
  const sidebar: KeyChord = { key: "b", mod: true };
  const rail: KeyChord = { key: "b", mod: true, alt: true };
  assert.equal(matchChord(key("b", { metaKey: true }), sidebar, "mac"), true);
  assert.equal(matchChord(key("b", { metaKey: true }), rail, "mac"), false);
  assert.equal(matchChord(key("b", { metaKey: true, altKey: true }), rail, "mac"), true);
  assert.equal(matchChord(key("b", { metaKey: true, altKey: true }), sidebar, "mac"), false);
});

test("matchChord: literal ⌃` is Control on every platform", () => {
  const bottom: KeyChord = { key: "`", ctrl: true };
  assert.equal(matchChord(key("`", { ctrlKey: true }), bottom, "mac"), true);
  assert.equal(matchChord(key("`", { ctrlKey: true }), bottom, "other"), true);
  assert.equal(matchChord(key("`", { ctrlKey: true, metaKey: true }), bottom, "mac"), false);
});

test("matchChord: `mod` maps to Ctrl on non-mac", () => {
  const cmdK: KeyChord = { key: "k", mod: true };
  assert.equal(matchChord(key("k", { ctrlKey: true }), cmdK, "other"), true);
  assert.equal(matchChord(key("k", { metaKey: true }), cmdK, "other"), false);
});

test("chordLabel: mac glyphs vs other text", () => {
  assert.equal(chordLabel({ key: "k", mod: true }, "mac"), "⌘K");
  assert.equal(chordLabel({ key: "f", mod: true, shift: true }, "mac"), "⇧⌘F");
  assert.equal(chordLabel({ key: "`", ctrl: true }, "mac"), "⌃`");
  assert.equal(chordLabel({ key: "k", mod: true }, "other"), "Ctrl+K");
  assert.equal(chordLabel(undefined, "mac"), "");
});

test("executeCommandId: runs the handler, unknown id ⇒ false", () => {
  const { ctx, log } = spyCtx();
  assert.equal(executeCommandId("panel.health", ctx), true);
  assert.deepEqual(log, ["openBottomPanel:health"]);
  assert.equal(executeCommandId("does.not.exist", ctx), false);
});

test("executeCommandId: editor-scoped command routes through runEditorCommand", () => {
  const { ctx, log } = spyCtx();
  assert.equal(executeCommandId("editor.action.formatDocument", ctx), true);
  assert.deepEqual(log, ["runEditorCommand:editor.action.formatDocument"]);
});

test("handleChord: fires the matched command + preventDefault, ignores unbound keys", () => {
  const { ctx, log } = spyCtx();
  let prevented = 0;
  const fired = handleChord(
    {
      ...key("k", { metaKey: true }),
      preventDefault: () => prevented++,
    } as unknown as KeyboardEvent,
    ctx,
    "mac",
  );
  assert.equal(fired, true);
  assert.equal(prevented, 1);
  assert.deepEqual(log, ["togglePalette"]);

  const miss = handleChord(
    {
      ...key("z", { metaKey: true }),
      preventDefault: () => prevented++,
    } as unknown as KeyboardEvent,
    ctx,
    "mac",
  );
  assert.equal(miss, false);
});

test("parseChordString: inverse of chordToKeysString; rejects chords + modifier-only", () => {
  assert.deepEqual(parseChordString("mod+shift+k"), { key: "k", mod: true, shift: true });
  assert.deepEqual(parseChordString("ctrl+`"), { key: "`", ctrl: true });
  assert.deepEqual(parseChordString("alt+enter"), { key: "enter", alt: true });
  assert.deepEqual(parseChordString("cmd+p"), { key: "p", mod: true }); // cmd folds to mod
  assert.equal(parseChordString("g d"), null); // multi-segment chord not dispatchable here
  assert.equal(parseChordString("mod+shift"), null); // modifier-only → no key
  assert.equal(parseChordString(""), null);
});

test("effectiveKeybinding: override wins; '' unbinds; bad override falls back to default", () => {
  const palette = SHELL_COMMANDS.find((c) => c.id === "view.commandPalette") as Command;
  assert.deepEqual(effectiveKeybinding(palette), { key: "k", mod: true }); // no override → default
  assert.deepEqual(effectiveKeybinding(palette, { "view.commandPalette": "mod+shift+j" }), {
    key: "j",
    mod: true,
    shift: true,
  });
  assert.equal(effectiveKeybinding(palette, { "view.commandPalette": "" }), undefined); // unbind
  // an unparseable override never leaves the command dead — falls back to the built-in.
  assert.deepEqual(effectiveKeybinding(palette, { "view.commandPalette": "g d" }), {
    key: "k",
    mod: true,
  });
});

test("handleChord: a user override rebinds the LIVE dispatch (APP-057)", () => {
  const overrides = { "view.commandPalette": "mod+shift+j" };
  // the NEW chord fires the command…
  const a = spyCtx();
  let prevented = 0;
  assert.equal(
    handleChord(
      {
        ...key("j", { metaKey: true, shiftKey: true }),
        preventDefault: () => prevented++,
      } as unknown as KeyboardEvent,
      a.ctx,
      "mac",
      overrides,
    ),
    true,
  );
  assert.deepEqual(a.log, ["togglePalette"]);
  // …and the OLD default chord no longer does.
  const b = spyCtx();
  assert.equal(
    handleChord(
      {
        ...key("k", { metaKey: true }),
        preventDefault: () => prevented++,
      } as unknown as KeyboardEvent,
      b.ctx,
      "mac",
      overrides,
    ),
    false,
  );
  assert.deepEqual(b.log, []);
});

test("commandPaletteRows: every command is projected with its key hint", () => {
  const rows = commandPaletteRows("mac");
  assert.equal(rows.length, SHELL_COMMANDS.length);
  const palette = rows.find((r) => r.id === "view.commandPalette");
  assert.equal(palette?.keybind, "⌘K");
  // an unbound command has an empty hint, not a stray label.
  assert.equal(rows.find((r) => r.id === "git.commit")?.keybind, "");
});

test("no command id is registered twice (duplicate palette rows / React keys)", () => {
  // A second copy of run.config/run.debug/run.stop once shipped alongside the originals, so
  // `commandPaletteRows` emitted two rows per id and every consumer keying by `item.id`
  // (CommandPalette.tsx, the docs cheat sheet) hit React's duplicate-key path.
  const seen = new Set<string>();
  for (const c of SHELL_COMMANDS) {
    assert.equal(seen.has(c.id), false, `duplicate command id: ${c.id}`);
    seen.add(c.id);
  }
});

test("no two bound commands share a chord on mac (deterministic dispatch)", () => {
  const seen = new Map<string, string>();
  for (const c of SHELL_COMMANDS) {
    if (!c.keybinding) continue;
    const label = chordLabel(c.keybinding, "mac");
    assert.equal(seen.has(label), false, `duplicate chord ${label}: ${seen.get(label)} & ${c.id}`);
    seen.set(label, c.id);
  }
});

/* ── commandTarget: the merge turned four rail nouns into SEGMENTS (handoff_3 §1) ──── */

test("commandTarget: python.* lands on Workspace's ENVIRONMENTS segment, not Repos", () => {
  // The live defect this pins: `python.selectInterpreter` is offered by the shell palette
  // (ide/state/palette-commands.ts) but has no registry handler, so `executeCommandId`
  // returns false and the shell falls back to a navigate. Naming only the activity put the
  // user on Workspace→Repos — §1's own failure mode, on a shipped code path.
  assert.deepEqual(commandTarget("python.selectInterpreter"), {
    activity: "workspace",
    tab: "environments",
  });
  assert.deepEqual(commandTarget("python.createVenv"), {
    activity: "workspace",
    tab: "environments",
  });
});

test("commandTarget: the un-segmented routes carry no tab", () => {
  assert.deepEqual(commandTarget("models.pull"), { activity: "models" });
  assert.deepEqual(commandTarget("prometheus.scan"), { activity: "security" });
  assert.deepEqual(commandTarget("gate.audit"), { activity: "security" });
  assert.deepEqual(commandTarget("git.commit"), { activity: "editor" });
  assert.deepEqual(commandTarget("editor.format"), { activity: "editor" });
});

test("commandTarget: panel.* is handled inline, never navigated to", () => {
  assert.equal(commandTarget("panel.problems"), null);
});

test("commandTarget: every tab it names is a REAL segment of the route it names", () => {
  // a typo'd tab would be silently dropped by requestRouteTab's own guard, leaving the
  // user on the default segment with nothing to show for it.
  for (const id of ["python.selectInterpreter", "models.pull", "git.commit", "panel.problems"]) {
    const t = commandTarget(id);
    if (t?.tab) {
      assert.ok(
        t.activity === "catalog" || t.activity === "workspace",
        `${id}: a tab on an un-segmented route`,
      );
      assert.ok(isRouteTab(t.activity, t.tab), `${id}: ${t.tab} is not a segment of ${t.activity}`);
    }
  }
});

/* -- the Run toolbar's three verbs must EXIST and reach the editor -- */

test("run.config / run.debug / run.stop are registered and editor-scoped", () => {
  // The TopBar called `debug.start` for both Run and Debug (a handler that only opens the
  // debug panel) and `debug.stop`, which was never registered - so executeCommandId returned
  // false and Stop did nothing, silently, forever.
  for (const id of ["run.config", "run.debug", "run.stop"]) {
    const cmd = SHELL_COMMANDS.find((c) => c.id === id);
    assert.ok(cmd, `${id} is not registered`);
    const ran = [];
    cmd.run({
      ...({} as CommandContext),
      runEditorCommand: (x) => ran.push(x),
    } as CommandContext);
    assert.deepEqual(ran, [id], `${id} does not reach the editor`);
  }
});

test("executeCommandId returns TRUE for each of them (a silent false is the bug)", () => {
  const ran = [];
  const ctx = { ...({} as CommandContext), runEditorCommand: (x) => ran.push(x) } as CommandContext;
  for (const id of ["run.config", "run.debug", "run.stop"]) {
    assert.equal(executeCommandId(id, ctx), true, `${id} fell through to the navigate fallback`);
  }
  assert.deepEqual(ran, ["run.config", "run.debug", "run.stop"]);
  // and the id that never existed still reports false rather than pretending
  assert.equal(executeCommandId("debug.stop", ctx), false);
});
