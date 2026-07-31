/**
 * markdown.test.ts — node:test for the PURE markdown block parser (#12).
 *
 * Pins fence detection (with/without a lang), the text/code interleave, and the
 * unterminated-fence-runs-to-end rule. Pure — no react — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBlocks } from "./markdown-parse.js";

test("plain text → a single text block", () => {
  assert.deepEqual(parseBlocks("hello world"), [{ type: "text", text: "hello world" }]);
});

test("a fenced code block with a lang is split out", () => {
  const md = "before\n```ts\nconst x = 1;\n```\nafter";
  assert.deepEqual(parseBlocks(md), [
    { type: "text", text: "before" },
    { type: "code", text: "const x = 1;", lang: "ts" },
    { type: "text", text: "after" },
  ]);
});

test("a fence with no lang has no lang field", () => {
  const md = "```\nplain\n```";
  assert.deepEqual(parseBlocks(md), [{ type: "code", text: "plain" }]);
});

test("an unterminated fence runs to end-of-input as code", () => {
  const md = "intro\n```py\nx = 1\ny = 2";
  assert.deepEqual(parseBlocks(md), [
    { type: "text", text: "intro" },
    { type: "code", text: "x = 1\ny = 2", lang: "py" },
  ]);
});

test("multiple code blocks interleave with text", () => {
  const blocks = parseBlocks("a\n```\n1\n```\nb\n```\n2\n```");
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0]?.type, "text");
  assert.equal(blocks[1]?.type, "code");
  assert.equal(blocks[1]?.text, "1");
  assert.equal(blocks[3]?.text, "2");
});
