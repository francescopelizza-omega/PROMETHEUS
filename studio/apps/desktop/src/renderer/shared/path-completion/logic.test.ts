import assert from "node:assert/strict";
import test from "node:test";

import { acceptMention, joinPath, resolveMentionDir, splitMentionQuery } from "./logic.js";

test("splitMentionQuery: no slash → the whole query is the fragment", () => {
  assert.deepEqual(splitMentionQuery("red"), { dirPart: "", frag: "red" });
});

test("splitMentionQuery: splits on the LAST slash", () => {
  assert.deepEqual(splitMentionQuery("src/tui/re"), { dirPart: "src/tui", frag: "re" });
});

test("splitMentionQuery: a trailing slash means an empty fragment", () => {
  assert.deepEqual(splitMentionQuery("src/"), { dirPart: "src", frag: "" });
});

test("splitMentionQuery: a single-level absolute path keeps the leading slash as dirPart", () => {
  assert.deepEqual(splitMentionQuery("/etc"), { dirPart: "/", frag: "etc" });
});

test("splitMentionQuery: a bare trailing slash after the root is also dirPart '/'", () => {
  assert.deepEqual(splitMentionQuery("/"), { dirPart: "/", frag: "" });
});

test("joinPath: empty rel returns base unchanged", () => {
  assert.equal(joinPath("/proj", ""), "/proj");
});

test("joinPath: joins without a double slash when base already ends in one", () => {
  assert.equal(joinPath("/proj/", "src"), "/proj/src");
  assert.equal(joinPath("/proj", "src"), "/proj/src");
});

test("resolveMentionDir: empty dirPart resolves to baseDir", () => {
  assert.equal(resolveMentionDir("", "/proj"), "/proj");
});

test("resolveMentionDir: an absolute dirPart is used as-is", () => {
  assert.equal(resolveMentionDir("/etc", "/proj"), "/etc");
});

test("resolveMentionDir: a relative dirPart resolves against baseDir", () => {
  assert.equal(resolveMentionDir("src/tui", "/proj"), "/proj/src/tui");
});

test("acceptMention: a directory keeps the mention open one level deeper (trailing slash, no space)", () => {
  const text = "please check @src for bugs";
  const start = text.indexOf("@");
  const active = { start, token: "src" };
  const res = acceptMention(text, active, "", "/proj", "src/", true);
  assert.equal(res.text, "please check @src/ for bugs");
  assert.equal(res.acceptedPath, undefined);
});

test("acceptMention: a single-level absolute path (@/e) splices cleanly, keeping the root slash", () => {
  const text = "@/e";
  const active = { start: 0, token: "/e" };
  const res = acceptMention(text, active, "/", "/", "etc/", true);
  assert.equal(res.text, "@/etc/");
});

test("acceptMention: a file closes the mention (trailing space) and reports its resolved path", () => {
  const text = "please check @src/red for bugs";
  const start = text.indexOf("@");
  const active = { start, token: "src/red" };
  const res = acceptMention(text, active, "src", "/proj/src", "reducer.ts", false);
  assert.equal(res.text, "please check @src/reducer.ts for bugs");
  assert.equal(res.acceptedPath, "/proj/src/reducer.ts");
  assert.equal(res.caret, "please check @src/reducer.ts".length);
});

test("acceptMention: no double space when the tail already starts with whitespace", () => {
  const text = "@red  and more"; // NOTE: two spaces after "red" already
  const active = { start: 0, token: "red" };
  const res = acceptMention(text, active, "", "/proj", "reducer.ts", false);
  assert.equal(res.text, "@reducer.ts  and more");
});

test("acceptMention: adds a trailing space at the very end of the buffer", () => {
  const text = "@red";
  const active = { start: 0, token: "red" };
  const res = acceptMention(text, active, "", "/proj", "reducer.ts", false);
  assert.equal(res.text, "@reducer.ts ");
});

test("acceptMention: bare (no dirPart) file accept resolves against baseDir directly", () => {
  const text = "@red";
  const active = { start: 0, token: "red" };
  const res = acceptMention(text, active, "", "/proj", "reducer.ts", false);
  assert.equal(res.acceptedPath, "/proj/reducer.ts");
});
