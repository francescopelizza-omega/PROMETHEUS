/**
 * slash.test.ts — PURE slash-command detection + filtering (APP-092).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type SlashCommand,
  activeSlashQuery,
  clampSlashIndex,
  filterSlashCommands,
} from "./slash.js";

test("activeSlashQuery: triggers only for a leading, unterminated slash token", () => {
  assert.equal(activeSlashQuery("/"), "");
  assert.equal(activeSlashQuery("/git"), "git");
  assert.equal(activeSlashQuery("/git status"), null); // space ends the command token
  assert.equal(activeSlashQuery("hello /git"), null); // not at composer start
  assert.equal(activeSlashQuery("open /etc/hosts please"), null); // a path mid-message
  assert.equal(activeSlashQuery(""), null);
});

const ROWS: SlashCommand[] = [
  { id: "git.commit", title: "Git: Commit", category: "Git" },
  { id: "view.commandPalette", title: "Command Palette", category: "View" },
  { id: "git.push", title: "Git: Push", category: "Git" },
];

test("filterSlashCommands: empty query = full menu; prefix ranks above substring", () => {
  assert.equal(filterSlashCommands(ROWS, "").length, 3);
  const git = filterSlashCommands(ROWS, "git");
  assert.equal(git.length, 2);
  assert.ok(git.every((r) => r.id.startsWith("git")));
  // "comm" is a prefix of "Command Palette" AND a substring of "Git: Commit" → prefix wins.
  const comm = filterSlashCommands(ROWS, "comm");
  assert.equal(comm[0]?.id, "view.commandPalette");
});

test("clampSlashIndex wraps within the match count", () => {
  assert.equal(clampSlashIndex(0, 3), 0);
  assert.equal(clampSlashIndex(3, 3), 0); // wrap
  assert.equal(clampSlashIndex(-1, 3), 2); // wrap back
  assert.equal(clampSlashIndex(5, 0), 0); // no matches
});
