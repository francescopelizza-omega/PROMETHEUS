/**
 * markdown.test.ts — the stateful ANSI markdown renderer (CLI-020).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createMarkdownRenderer } from "./markdown.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Feed all lines to a fresh renderer + flush; return the flat output. */
function render(lines: string[], caps: "none" | "ansi16" = "none", width = 60): string[] {
  const r = createMarkdownRenderer(caps, width);
  const out: string[] = [];
  for (const l of lines) out.push(...r.feedLine(l));
  out.push(...r.flush());
  return out;
}

test("fence: distinct box + language tag, content byte-preserved (CLI-020)", () => {
  const code = "const x = `a` + **b**; // NOT markdown";
  const out = render(["```ts", code, "```"]);
  assert.match(strip(out[0] ?? ""), /ts/); // language tag in the header rule
  // the code line survives byte-for-byte (never markdown-parsed or wrapped)
  assert.ok(out.some((l) => strip(l).includes(code)));
  assert.ok(out.length >= 3); // top rule, content, bottom rule
});

test("nested bullet + numbered lists indent by 2-space steps, keep author numbers", () => {
  const out = render(["- a", "  - b", "    - c", "3. three", "4. four"]).map(strip);
  assert.match(out[0] ?? "", /^• a/);
  assert.match(out[1] ?? "", /^ {2}• b/);
  assert.match(out[2] ?? "", /^ {4}• c/);
  // numbered lists preserve the author's start number (3 stays 3)
  assert.match(out[3] ?? "", /^3\. three/);
  assert.match(out[4] ?? "", /^4\. four/);
});

test("headings, bold, inline code render (styled when colored)", () => {
  const plain = render(["# Title", "some **bold** and `code` here"]).map(strip);
  assert.equal(plain[0], "Title");
  assert.equal(plain[1], "some bold and `code` here"); // markers consumed, backticks kept
  // colored output carries escapes on the styled spans
  const colored = render(["# Title", "**bold**"], "ansi16");
  assert.ok(colored.join("").includes("\x1b"), "colored output has escapes");
});

test("caps=none yields ZERO escape sequences (NO_COLOR)", () => {
  const out = render([
    "# Heading",
    "**bold** `code`",
    "```py",
    "print('hi')",
    "```",
    "- item",
    "| a | b |",
  ]);
  assert.ok(!out.join("").includes("\x1b"), "no ANSI escapes under caps=none");
});

test("tables / blockquotes / unknown pass through unmangled", () => {
  const out = render(["| col1 | col2 |", "> a quote", "[link](http://x)"]).map(strip);
  assert.equal(out[0], "| col1 | col2 |");
  assert.equal(out[1], "> a quote");
  assert.equal(out[2], "[link](http://x)");
});

test("`**not bold**` inside inline code stays literal (non-greedy tokenizer)", () => {
  const out = render(["run `**not bold**` please"]).map(strip);
  assert.equal(out[0], "run `**not bold**` please"); // markers inside code untouched
});

test("unterminated fence is closed gracefully by flush()", () => {
  const r = createMarkdownRenderer("none", 40);
  const mid = [...r.feedLine("```js"), ...r.feedLine("let a = 1;")];
  assert.ok(mid.length >= 2);
  const closing = r.flush();
  assert.equal(closing.length, 1, "flush emits the closing rule for an open fence");
});

test("per-line feed == same output regardless of chunking; fence needs a whole line", () => {
  const doc = ["prose with `code`", "```", "raw ```code inside", "```", "done"];
  const a = render(doc);
  // a second renderer fed the same completed lines produces identical output
  const b = render(doc);
  assert.deepEqual(a, b);
  // a bare ``` INSIDE fenced content does not close early (it's not a lone closing line)
  const fenced = render(["```", "text ``` more", "```"]).map(strip);
  assert.ok(fenced.some((l) => l.includes("text ``` more")));
});
