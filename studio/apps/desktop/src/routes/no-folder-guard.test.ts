/**
 * no-folder-guard.test.ts — node:test for the editor's no-folder decisions (APP-073).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { hasFolderOpen, shouldPromptOpenFolder, terminalCwd } from "./no-folder-guard.js";

test("hasFolderOpen: only a real absolute path counts (null/''/'.' do not)", () => {
  assert.equal(hasFolderOpen("/Users/me/proj"), true);
  assert.equal(hasFolderOpen("C:\\proj"), true);
  assert.equal(hasFolderOpen(null), false); // never opened
  assert.equal(hasFolderOpen(""), false);
  assert.equal(hasFolderOpen("."), false); // the old CWD-leak shim is not a folder
});

test("shouldPromptOpenFolder: the Open-Folder prompt shows iff no folder is open", () => {
  assert.equal(shouldPromptOpenFolder(null), true);
  assert.equal(shouldPromptOpenFolder("."), true);
  assert.equal(shouldPromptOpenFolder("/repo"), false);
});

test("terminalCwd: open folder → the folder; no folder → '' (main resolves home, never '.')", () => {
  assert.equal(terminalCwd("/repo"), "/repo");
  assert.equal(terminalCwd(null), "");
  assert.equal(terminalCwd("."), ""); // never hands the process cwd to the shell
});
