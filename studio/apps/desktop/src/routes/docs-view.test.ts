import assert from "node:assert/strict";
/**
 * docs-view.test.ts — pure Docs view-model (search/group/signature). node:test.
 */
import { test } from "node:test";

import { COMMAND_SPECS } from "@prometheus/core/commands";

import { SHELL_COMMANDS } from "../renderer/commands/registry.js";
import { TUTORIALS } from "./docs-tutorials.js";
import {
  cheatSheetRows,
  commandDocRows,
  commandSignature,
  filterCheatSheet,
  filterCommandDocs,
  filterTutorials,
  formatChord,
  groupDocRows,
  requestDocsTab,
  searchCommandDocs,
  searchHelp,
  takeDocsTab,
} from "./docs-view.js";

test("commandDocRows: one row per spec, all fields present", () => {
  const rows = commandDocRows(COMMAND_SPECS);
  assert.equal(rows.length, COMMAND_SPECS.length);
  for (const r of rows) {
    assert.ok(r.id && r.title && r.group);
    assert.equal(typeof r.description, "string");
    assert.equal(typeof r.signature, "string");
  }
});

test("commandSignature: secure shows its positional + flag", () => {
  const secure = COMMAND_SPECS.find((s) => s.id === "secure");
  assert.ok(secure, "secure spec exists");
  const sig = commandSignature(secure!);
  assert.match(sig, /target/);
});

test("filterCommandDocs: blank → all; token narrows", () => {
  const rows = commandDocRows(COMMAND_SPECS);
  assert.equal(filterCommandDocs(rows, "").length, rows.length);
  const scan = filterCommandDocs(rows, "scan");
  assert.ok(scan.length > 0 && scan.length < rows.length);
  for (const r of scan) {
    const hay = `${r.id} ${r.title} ${r.group} ${r.description} ${r.signature}`.toLowerCase();
    assert.ok(hay.includes("scan"));
  }
});

test("filterCommandDocs: AND of tokens", () => {
  const rows = commandDocRows(COMMAND_SPECS);
  const both = filterCommandDocs(rows, "zzzznope scan");
  assert.equal(both.length, 0);
});

test("groupDocRows: groups, order preserved, covers all rows", () => {
  const rows = commandDocRows(COMMAND_SPECS);
  const groups = groupDocRows(rows);
  assert.ok(groups.length >= 1);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  assert.equal(total, rows.length);
});

test("searchCommandDocs: returns grouped + count", () => {
  const r = searchCommandDocs(COMMAND_SPECS, "");
  assert.equal(r.count, COMMAND_SPECS.length);
  assert.ok(r.groups.length >= 1);
});

/* ── APP-099: cheat-sheet + tutorials + unified search ───────────────────────── */

test("formatChord: mac glyph order ⌃⌥⇧⌘+Key, no separators", () => {
  assert.equal(formatChord({ key: "p", mod: true, shift: true }, "mac"), "⇧⌘P");
  assert.equal(formatChord({ key: "f12", mod: true }, "mac"), "⌘F12");
  assert.equal(
    formatChord({ key: "f3", ctrl: true, alt: true, shift: true, mod: true }, "mac"),
    "⌃⌥⇧⌘F3",
  );
  assert.equal(formatChord({ key: "arrowleft", mod: true, alt: true }, "mac"), "⌥⌘←");
});

test("formatChord: non-mac Ctrl+Alt+Shift+Key with separators; mod≡Ctrl", () => {
  assert.equal(formatChord({ key: "p", mod: true, shift: true }, "other"), "Ctrl+Shift+P");
  assert.equal(formatChord({ key: "k", mod: true }, "other"), "Ctrl+K");
  // a literal ctrl collapses into the same physical Ctrl, never "Ctrl+Ctrl".
  assert.equal(formatChord({ key: "g", mod: true, ctrl: true }, "other"), "Ctrl+G");
  assert.equal(formatChord({ key: "enter", alt: true }, "other"), "Alt+Enter");
});

test("cheatSheetRows: one row per command with a live key label (mac vs other)", () => {
  const rowsMac = cheatSheetRows(SHELL_COMMANDS, "mac");
  assert.equal(rowsMac.length, SHELL_COMMANDS.length);
  const findMac = rowsMac.find((r) => r.id === "search.findInFiles");
  assert.ok(findMac);
  assert.equal(findMac.keys, "⇧⌘F"); // { key:"f", mod:true, shift:true }
  const findOther = cheatSheetRows(SHELL_COMMANDS, "other").find(
    (r) => r.id === "search.findInFiles",
  );
  assert.equal(findOther?.keys, "Ctrl+Shift+F");
  // an unbound command has an empty label, not a fake key.
  assert.equal(rowsMac.find((r) => r.id === "docs.quickDoc")?.keys, "");
});

test("filterCheatSheet: blank → all; token narrows over id/title/category/keys", () => {
  const rows = cheatSheetRows(SHELL_COMMANDS, "mac");
  assert.equal(filterCheatSheet(rows, "").length, rows.length);
  const git = filterCheatSheet(rows, "git");
  assert.ok(git.length > 0 && git.length < rows.length);
});

test("filterTutorials: blank → all; token narrows over title/summary/steps", () => {
  assert.equal(filterTutorials(TUTORIALS, "").length, TUTORIALS.length);
  const sec = filterTutorials(TUTORIALS, "security");
  assert.ok(
    sec.length >= 1 &&
      sec.every((t) => t.id === "security-scan" || /secur/i.test(JSON.stringify(t))),
  );
});

test("searchHelp: one query narrows all three surfaces together", () => {
  const all = searchHelp("", {
    specs: COMMAND_SPECS,
    commands: SHELL_COMMANDS,
    tutorials: TUTORIALS,
    platform: "mac",
  });
  assert.equal(all.engine.count, COMMAND_SPECS.length);
  assert.equal(all.cheatSheet.length, SHELL_COMMANDS.length);
  assert.equal(all.tutorials.length, TUTORIALS.length);

  const narrowed = searchHelp("zzzznomatch", {
    specs: COMMAND_SPECS,
    commands: SHELL_COMMANDS,
    tutorials: TUTORIALS,
    platform: "mac",
  });
  assert.equal(narrowed.engine.count, 0);
  assert.equal(narrowed.cheatSheet.length, 0);
  assert.equal(narrowed.tutorials.length, 0);
});

test("tutorials: shape valid + every commandId resolves against SHELL_COMMANDS", () => {
  const ids = new Set(SHELL_COMMANDS.map((c) => c.id));
  assert.ok(TUTORIALS.length >= 4 && TUTORIALS.length <= 6);
  const seen = new Set<string>();
  for (const t of TUTORIALS) {
    assert.ok(t.id && t.title && t.summary, `tutorial ${t.id} has id/title/summary`);
    assert.ok(!seen.has(t.id), `duplicate tutorial id ${t.id}`);
    seen.add(t.id);
    assert.ok(t.steps.length > 0, `tutorial ${t.id} has steps`);
    for (const s of t.steps) {
      assert.equal(typeof s.text, "string");
      if (s.commandId) {
        assert.ok(
          ids.has(s.commandId),
          `tutorial ${t.id} step links unknown command "${s.commandId}"`,
        );
      }
    }
  }
});

/* ── the docs sub-tab latch: the same StrictMode hazard as routes/route-tabs.ts ────── */

test("takeDocsTab is STABLE within one tick, one-shot across ticks", async () => {
  // docs.tsx reads this from a `useState` initializer, which React StrictMode
  // double-invokes in development while KEEPING THE SECOND value. Clearing on the first
  // call handed the route null on the pass that counts, so a `help.*` command landed on
  // the default "engine" tab under `vite dev` and was correct only in a production build.
  requestDocsTab("cheatsheet");
  assert.equal(takeDocsTab(), "cheatsheet", "pass 1 (discarded by React)");
  assert.equal(takeDocsTab(), "cheatsheet", "pass 2 — the one React keeps");
  await Promise.resolve();
  assert.equal(takeDocsTab(), null, "still a one-shot handoff across navigations");
});

test("a fresh docs request within the same tick is not masked by the memo", async () => {
  requestDocsTab("engine");
  assert.equal(takeDocsTab(), "engine");
  requestDocsTab("cheatsheet");
  assert.equal(takeDocsTab(), "cheatsheet");
  await Promise.resolve();
  assert.equal(takeDocsTab(), null);
});
