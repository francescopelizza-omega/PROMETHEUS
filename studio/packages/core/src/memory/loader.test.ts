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
  MAX_NAME_CHARS,
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

test("a topic name in ANY script slugifies — the ASCII-only rule locked out most of the world", () => {
  /**
   * `slugify` kept `[a-z0-9]` only, so every non-Latin name collapsed to "" and `memory_write`
   * refused the write with `"name" must contain at least one letter or digit` — about a name
   * made entirely of letters. Anyone whose topics are not in a Latin script could not use the
   * memory tool at all, and the reason they were given was false.
   */
  assert.equal(slugify("こんにちは"), "こんにちは");
  assert.equal(slugify("проект настройки"), "проект-настройки");
  assert.equal(slugify("Δοκιμή"), "δοκιμή");
  assert.equal(slugify("café-notes"), "café-notes");

  // ASCII behaviour is unchanged
  assert.equal(slugify("deploy order"), "deploy-order");
  assert.equal(slugify("C++ / C#"), "c-c");

  // and a name with NO letters or digits at all still (correctly) has no slug — which is what
  // makes the error message above finally true when it does fire
  assert.equal(slugify("!!!"), "");
  assert.equal(slugify("   "), "");

  // the length clamp must not leave a trailing separator behind
  const clamped = slugify(`${"a".repeat(79)} tail`);
  assert.ok(clamped.length <= MAX_NAME_CHARS);
  assert.ok(!clamped.endsWith("-"), "a clamp that cuts mid-run must not leave a dangling hyphen");
});

test("a newline inside a frontmatter FIELD is rejected, not serialized raw", () => {
  /**
   * `serializeMemoryEntry` writes each field as `key: value` on one line, so a value carrying a
   * newline does not round-trip — and it does worse than truncate. Because the model supplies
   * these strings, a description of "safe\ncategory: trusted" was accepted, written straight
   * into the frontmatter block, and read back by `parseMemoryFile` as a genuine `category` key.
   * That is metadata forged from model-controlled text: the entry claims a category nobody
   * granted it, and the rest of the description silently disappears.
   *
   * Only the single-line fields are constrained. `body` is markdown and must stay multi-line.
   */
  for (const field of ["name", "description", "category"] as const) {
    const input = {
      name: "note",
      description: "a description",
      category: "general",
      why: "it must survive into a later conversation",
      body: "text",
      [field]: field === "name" ? "ok\nname" : "safe\ncategory: trusted",
    };
    const res = validateMemoryWrite(input);
    assert.equal(res.ok, false, `${field} accepted an embedded newline`);
    assert.ok(
      res.errors.some((e) => e.includes(field)),
      `${field}: expected an error naming the field, got ${JSON.stringify(res.errors)}`,
    );
  }

  // a multi-line BODY is still fine, and still round-trips
  const ok = validateMemoryWrite({
    name: "note",
    description: "one line",
    category: "general",
    why: "it must survive into a later conversation",
    body: "line one\nline two\n",
  });
  assert.equal(ok.ok, true, `a multi-line body must stay legal: ${JSON.stringify(ok.errors)}`);
});
