/**
 * memory/loader.test.ts — the durable-memory PARSE/VALIDATE/ASSEMBLE half (no fs).
 *
 * Three things load-bearing here, each with its own test group:
 *   - `slugify` must be safe to use as a filename, not merely tidy.
 *   - `validateMemoryWrite` is the entire `memory_write` gate — every required field
 *     (INCLUDING `why`, the "worth remembering" check) and every length cap.
 *   - `renderMemoryIndex`/`memoryIndexBlock` are what a session folds into its system
 *     prompt, so their EMPTY-ness decision (inject nothing vs. inject a placeholder)
 *     matters as much as their content.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_BODY_CHARS,
  MAX_CATEGORY_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_WHY_CHARS,
  entryFromParsed,
  memoryIndexBlock,
  parseMemoryFile,
  renderMemoryIndex,
  serializeMemoryEntry,
  slugify,
  validateMemoryWrite,
} from "./loader.js";

/* ── slugify: must be a SAFE filename stem ───────────────────────────────────*/

test("slugify lowercases, hyphenates and strips unsafe characters", () => {
  assert.equal(slugify("Deploy Order"), "deploy-order");
  assert.equal(slugify("  spaced  out  "), "spaced-out");
  assert.equal(slugify("weird!!chars??"), "weird-chars");
  assert.equal(slugify("a/../../etc/passwd"), "a-etc-passwd"); // no path traversal survives
});

test("slugify returns empty for names with nothing safe to keep", () => {
  assert.equal(slugify("???"), "");
  assert.equal(slugify("   "), "");
  assert.equal(slugify("---"), "");
});

/* ── frontmatter round-trip ───────────────────────────────────────────────────*/

test("serializeMemoryEntry then parseMemoryFile round-trips name/description/category/body", () => {
  const entry = {
    name: 'deploy "order"',
    description: "staging must migrate before the API deploys",
    category: "infra",
    body: "run `migrate` THEN `deploy api` — never the reverse (found via an outage).",
  };
  const text = serializeMemoryEntry(entry);
  const parsed = parseMemoryFile(text);
  assert.equal(parsed.meta.name, entry.name);
  assert.equal(parsed.meta.description, entry.description);
  assert.equal(parsed.meta.category, entry.category);
  assert.equal(parsed.body, entry.body);
});

test("parseMemoryFile with no frontmatter treats the whole text as the body", () => {
  const parsed = parseMemoryFile("just some text, no frontmatter at all");
  assert.deepEqual(parsed.meta, {});
  assert.equal(parsed.body, "just some text, no frontmatter at all");
});

test("entryFromParsed refuses a file missing required frontmatter (corrupt/hand-edited)", () => {
  assert.equal(entryFromParsed("x", { meta: {}, body: "hi" }), null);
  assert.equal(
    entryFromParsed("x", { meta: { name: "n", description: "d" }, body: "hi" }),
    null, // category missing
  );
  assert.equal(
    entryFromParsed("x", { meta: { name: "n", description: "d", category: "c" }, body: "" }),
    null, // empty body
  );
  const ok = entryFromParsed("x", {
    meta: { name: "n", description: "d", category: "c" },
    body: "hi",
  });
  assert.deepEqual(ok, { slug: "x", name: "n", description: "d", category: "c", body: "hi" });
});

/* ── validateMemoryWrite: the `memory_write` gate ─────────────────────────────*/

const goodInput = {
  name: "deploy order",
  description: "staging must migrate before the API deploys",
  category: "infra",
  why: "the deploy pipeline silently reorders these otherwise and it has caused an outage before",
  body: "run migrate, then deploy — never the reverse.",
};

test("a fully-formed write validates and derives a slug from the name", () => {
  const r = validateMemoryWrite(goodInput);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.entry.slug, "deploy-order");
    assert.equal(r.entry.name, goodInput.name);
    assert.equal(r.why, goodInput.why);
  }
});

test("every field is required — name, description, category, why, body", () => {
  for (const key of ["name", "description", "category", "why", "body"] as const) {
    const bad = { ...goodInput, [key]: "" };
    const r = validateMemoryWrite(bad);
    assert.equal(r.ok, false, `expected "${key}" missing to be refused`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.toLowerCase().includes(key)));
  }
});

test("`why` is required INDEPENDENTLY of the other fields being present", () => {
  // the tool description calls `why` the check that the fact clears the "worth remembering"
  // bar — a call that supplies everything else but omits it must still be refused.
  const r = validateMemoryWrite({ ...goodInput, why: undefined });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => /why/i.test(e)));
});

test("a name with no letters or digits cannot be slugified and is refused", () => {
  const r = validateMemoryWrite({ ...goodInput, name: "???" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => /name/i.test(e)));
});

test("length caps are enforced on description/category/why/body", () => {
  const over = (n: number) => "x".repeat(n + 1);
  assert.equal(
    validateMemoryWrite({ ...goodInput, description: over(MAX_DESCRIPTION_CHARS) }).ok,
    false,
  );
  assert.equal(validateMemoryWrite({ ...goodInput, category: over(MAX_CATEGORY_CHARS) }).ok, false);
  assert.equal(validateMemoryWrite({ ...goodInput, why: over(MAX_WHY_CHARS) }).ok, false);
  assert.equal(validateMemoryWrite({ ...goodInput, body: over(MAX_BODY_CHARS) }).ok, false);
});

test("non-string args (e.g. a model sending a number) are treated as absent, not thrown", () => {
  const r = validateMemoryWrite({ ...goodInput, name: 42, why: true, body: null });
  assert.equal(r.ok, false);
});

/* ── the index: cheap, category-grouped, and knows when it's empty ──────────*/

test("renderMemoryIndex groups by category (alphabetical) then by name within it", () => {
  const text = renderMemoryIndex([
    { slug: "b", name: "b-topic", description: "b desc", category: "zeta" },
    { slug: "a", name: "a-topic", description: "a desc", category: "alpha" },
    { slug: "c", name: "c-topic", description: "c desc", category: "alpha" },
  ]);
  const alphaIdx = text.indexOf("## alpha");
  const zetaIdx = text.indexOf("## zeta");
  assert.ok(alphaIdx >= 0 && zetaIdx > alphaIdx, "alpha category must render before zeta");
  const aIdx = text.indexOf("a desc");
  const cIdx = text.indexOf("c desc");
  assert.ok(aIdx >= 0 && cIdx > aIdx, "within a category, entries sort by name");
});

test("renderMemoryIndex never includes the body — only name/category/description", () => {
  const text = renderMemoryIndex([
    { slug: "s", name: "topic", description: "the summary", category: "cat" },
  ]);
  assert.match(text, /the summary/);
  assert.match(text, /\(s\)/); // the slug is shown so memory_read can be called with it
});

test("renderMemoryIndex says so plainly when there is nothing recorded", () => {
  const text = renderMemoryIndex([]);
  assert.match(text, /no durable facts recorded yet/);
});

test("memoryIndexBlock is null for empty/whitespace text, else the trimmed text", () => {
  assert.equal(memoryIndexBlock(""), null);
  assert.equal(memoryIndexBlock("   \n  "), null);
  assert.equal(memoryIndexBlock("  some text  "), "some text");
});
