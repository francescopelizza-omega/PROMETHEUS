/**
 * autocomplete.test.ts — slash trigger, ranking, navigation, accept, and dropdown render.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AcItem,
  acceptAc,
  isOpen,
  moveAc,
  rankSlash,
  renderDropdown,
  slashQuery,
  syncAutocomplete,
} from "./autocomplete.js";

const ITEMS: AcItem[] = [
  { name: "scan", summary: "scan a target", aliases: ["s"] },
  { name: "install", summary: "install a tool", args: "<id>" },
  { name: "status", summary: "show status" },
  { name: "harden", summary: "harden the host" },
  { name: "help", summary: "list commands" },
];

test("slashQuery opens only within the leading slash-word", () => {
  assert.equal(slashQuery("/inst", 5), "inst");
  assert.equal(slashQuery("/", 1), "");
  assert.equal(slashQuery("hello", 5), null); // no leading slash
  assert.equal(slashQuery("/install foo", 12), null); // past the space → args
});

test("rankSlash: exact > prefix > substring > subsequence", () => {
  assert.equal(rankSlash("scan", ITEMS)[0]?.name, "scan");
  assert.equal(rankSlash("inst", ITEMS)[0]?.name, "install");
  // alias prefix
  assert.equal(rankSlash("s", ITEMS)[0]?.name, "scan");
  // subsequence: "hrd" → harden
  assert.equal(rankSlash("hrd", ITEMS)[0]?.name, "harden");
  // no match
  assert.deepEqual(rankSlash("zzz", ITEMS), []);
});

test("empty query lists everything alphabetically", () => {
  const r = rankSlash("", ITEMS);
  assert.equal(r.length, ITEMS.length);
  assert.deepEqual(
    r.map((i) => i.name),
    ["harden", "help", "install", "scan", "status"],
  );
});

test("syncAutocomplete opens/closes + clamps the selection index across keystrokes", () => {
  const a = syncAutocomplete("/s", 2, ITEMS);
  assert.ok(isOpen(a));
  assert.equal(a.index, 0); // fresh → best match
  // navigate down, then narrow the query → index clamped into the new (smaller) range
  const moved = moveAc(a, 1);
  const next = syncAutocomplete("/st", 3, ITEMS, moved);
  assert.ok(next.index >= 0 && next.index < next.items.length);
  // closed when past a space
  assert.equal(isOpen(syncAutocomplete("/scan x", 7, ITEMS)), false);
});

test("moveAc wraps; acceptAc returns the completed line", () => {
  const a = syncAutocomplete("/", 1, ITEMS); // all, index 0 = harden
  assert.equal(acceptAc(a), "/harden ");
  const up = moveAc(a, -1); // wrap to last
  assert.equal(up.index, ITEMS.length - 1);
});

test("renderDropdown: highlighted row uses the gradient bar, others muted", () => {
  const a = syncAutocomplete("/", 1, ITEMS);
  const rows = renderDropdown(a, 50, "truecolor");
  assert.equal(rows.length, ITEMS.length); // all fit (maxRows 8)
  assert.match(rows[0] ?? "", /48;2;/); // selected row has a gradient background
  assert.doesNotMatch(rows[1] ?? "", /48;2;/);
});

test("renderDropdown scrolls a window + shows a more-footer for long lists", () => {
  const many: AcItem[] = Array.from({ length: 20 }, (_, i) => ({
    name: `cmd${i}`,
    summary: `command ${i}`,
  }));
  const a = syncAutocomplete("/", 1, many);
  const rows = renderDropdown(a, 50, "none", { maxRows: 5 });
  assert.equal(rows.length, 6); // 5 rows + 1 footer
  assert.match(rows[5] ?? "", /more|scroll/);
});

test("no-color render still emits readable rows", () => {
  const a = syncAutocomplete("/sc", 3, ITEMS);
  const rows = renderDropdown(a, 40, "none");
  assert.match(rows[0] ?? "", /scan/);
  assert.doesNotMatch(rows.join("\n"), /\x1b\[/); // no ANSI in no-color
});
