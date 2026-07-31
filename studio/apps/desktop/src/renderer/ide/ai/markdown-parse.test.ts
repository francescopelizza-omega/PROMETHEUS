/**
 * markdown-parse.test.ts — the chat/hover markdown block splitter (bug-fix coverage): a fenced
 * code block whose info string isn't a bare `\w` word (e.g. `c++`, `objective-c`, `js title="x"`)
 * must still be recognized as ONE code block, not mis-rendered as literal text + a spurious empty
 * block. node:test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBlocks } from "./markdown-parse.ts";

test("parseBlocks: plain fenced block with a word language", () => {
  const b = parseBlocks("before\n```python\nprint(1)\n```\nafter");
  assert.deepEqual(
    b.map((x) => x.type),
    ["text", "code", "text"],
  );
  const code = b.find((x) => x.type === "code");
  assert.equal(code?.text, "print(1)");
  assert.equal((code as { lang?: string }).lang, "python");
});

test("parseBlocks: non-word / multi-token info strings still parse as ONE code block", () => {
  for (const [info, lang] of [
    ["c++", "c++"],
    ["objective-c", "objective-c"],
    ['js title="x"', "js"],
    ["f#", "f#"],
  ] as const) {
    const b = parseBlocks(`\`\`\`${info}\nCODE\n\`\`\``);
    const codes = b.filter((x) => x.type === "code");
    assert.equal(codes.length, 1, `${info}: exactly one code block`);
    assert.equal(codes[0]?.text, "CODE", `${info}: body preserved`);
    assert.equal((codes[0] as { lang?: string }).lang, lang, `${info}: first token is the lang`);
    // no stray empty block or leaked literal text.
    assert.equal(b.filter((x) => x.type === "text").length, 0, `${info}: no literal-text leak`);
  }
});
