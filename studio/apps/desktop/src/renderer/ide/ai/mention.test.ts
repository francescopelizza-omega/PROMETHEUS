/**
 * mention.test.ts — node:test for the pure @-mention model (APP-054).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type MentionChip,
  addChip,
  capFolderFiles,
  chipsToContext,
  classifyMention,
  detectActiveMention,
  discoverDocs,
  folderList,
  removeChip,
  replaceMention,
  sliceSymbolRegion,
} from "./mention.js";

test("classifyMention routes prefixed kinds; bare = file", () => {
  assert.deepEqual(classifyMention("sym:Widget"), {
    kind: "sym",
    query: "Widget",
    token: "sym:Widget",
  });
  assert.equal(classifyMention("folder:src").kind, "folder");
  assert.equal(classifyMention("docs:readme").kind, "docs");
  assert.deepEqual(classifyMention("src/a.ts"), {
    kind: "file",
    query: "src/a.ts",
    token: "src/a.ts",
  });
});

test("detectActiveMention is caret-anchored + email-safe + earlier-@-safe", () => {
  const text = "look at @file1 then @sym:Wid";
  const a = detectActiveMention(text, text.length);
  assert.ok(a);
  assert.equal(a?.kind, "sym");
  assert.equal(a?.query, "Wid");
  assert.equal(text.slice(a!.start, a!.start + 1), "@");
  // caret in the middle (after @file1) picks the FIRST mention, not the later one.
  const mid = detectActiveMention(text, "look at @file1".length);
  assert.equal(mid?.token, "file1");
  // an email `a@b` never triggers
  assert.equal(detectActiveMention("mail me a@bob", "mail me a@bob".length), null);
  // a space after the token closes the mention
  assert.equal(detectActiveMention("@done ", 6), null);
});

test("replaceMention splices the token in place", () => {
  const text = "see @sym:Wid more";
  const a = detectActiveMention("see @sym:Wid", "see @sym:Wid".length)!;
  assert.equal(replaceMention("see @sym:Wid", a, ""), "see ");
});

test("sliceSymbolRegion returns a bounded window around the 1-based line", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");
  const slice = sliceSymbolRegion(text, 25, 2, 3);
  assert.ok(slice.includes("line25"));
  assert.ok(slice.includes("line23")); // before
  assert.ok(slice.includes("line28")); // after
  assert.ok(!slice.includes("line10"));
  assert.ok(slice.includes("…")); // truncation markers present
});

test("capFolderFiles stops at the file-count and byte caps", () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ path: `f${i}`, text: "x".repeat(100) }));
  const byCount = capFolderFiles(files, 5, 1_000_000);
  assert.equal(byCount.kept.length, 5);
  assert.ok(byCount.truncated);
  const byBytes = capFolderFiles(files, 100, 250);
  assert.ok(byBytes.kept.length < 5);
  assert.ok(byBytes.truncated);
  const all = capFolderFiles(files.slice(0, 3), 100, 1_000_000);
  assert.equal(all.truncated, false);
});

test("discoverDocs finds markdown, README-first, query-filtered", () => {
  const files = ["src/a.ts", "README.md", "docs/guide.md", "notes.txt", "docs/api.md"];
  const all = discoverDocs(files, "", 10);
  assert.equal(all[0], "README.md"); // readme leads
  assert.ok(!all.includes("notes.txt")); // non-md dropped
  assert.deepEqual(discoverDocs(files, "guide", 10), ["docs/guide.md"]);
});

test("folderList derives unique parent dirs", () => {
  assert.deepEqual(folderList(["src/a.ts", "src/b.ts", "pkg/x/y.ts", "top.ts"]), ["pkg/x", "src"]);
});

test("chip reducer: add dedupes by id, remove drops it, context joins blocks", () => {
  const c1: MentionChip = { id: "sym:A", kind: "sym", label: "A", block: "BLOCK A" };
  const c2: MentionChip = { id: "docs:R", kind: "docs", label: "R", block: "BLOCK R" };
  let chips = addChip([], c1);
  chips = addChip(chips, c1); // dup
  chips = addChip(chips, c2);
  assert.equal(chips.length, 2);
  assert.equal(chipsToContext(chips), "BLOCK A\n\nBLOCK R");
  chips = removeChip(chips, "sym:A");
  assert.deepEqual(
    chips.map((c) => c.id),
    ["docs:R"],
  );
});
