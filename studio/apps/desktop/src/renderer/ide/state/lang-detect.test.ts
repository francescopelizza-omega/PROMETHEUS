/**
 * lang-detect.test.ts — node:test for the PURE file→languageId detector (§3.1).
 *
 * Pins the extension + well-known-filename mapping and the LSP-known predicate the
 * EditorPane uses to decide whether to call lspEnsure. Pure — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { baseName, detectLanguage, extOf, hasKnownLsp } from "./lang-detect.js";

test("baseName strips dirs and the file:// scheme", () => {
  assert.equal(baseName("file:///Users/x/src/runner.py"), "runner.py");
  assert.equal(baseName("/a/b/c.ts"), "c.ts");
  assert.equal(baseName("plain.md"), "plain.md");
});

test("extOf lowercases and drops the dot; dotfiles have no ext", () => {
  assert.equal(extOf("file:///x/A.TS"), "ts");
  assert.equal(extOf(".gitignore"), "");
  assert.equal(extOf("Makefile"), "");
});

test("detectLanguage maps common extensions", () => {
  assert.equal(detectLanguage("file:///x/runner.py"), "python");
  assert.equal(detectLanguage("schema.ts"), "typescript");
  assert.equal(detectLanguage("app.tsx"), "typescript");
  assert.equal(detectLanguage("main.rs"), "rust");
  assert.equal(detectLanguage("data.json"), "json");
  assert.equal(detectLanguage("notes.md"), "markdown");
});

test("detectLanguage honours well-known basenames", () => {
  assert.equal(detectLanguage("file:///proj/Dockerfile"), "dockerfile");
  assert.equal(detectLanguage("requirements.txt"), "pip-requirements");
  assert.equal(detectLanguage(".gitignore"), "ignore");
});

test("detectLanguage falls back to plaintext", () => {
  assert.equal(detectLanguage("file:///x/unknown.xyz"), "plaintext");
  assert.equal(detectLanguage("file:///x/LICENSE"), "plaintext");
});

test("hasKnownLsp matches the bundled servers (pyright/tsserver)", () => {
  assert.equal(hasKnownLsp("python"), true);
  assert.equal(hasKnownLsp("typescript"), true);
  assert.equal(hasKnownLsp("javascript"), true);
  assert.equal(hasKnownLsp("rust"), false);
  assert.equal(hasKnownLsp("markdown"), false);
});
