/**
 * prompt-cache.test.ts — asking for the cache this repo already measures.
 *
 * `usageFromPayload` has normalized three providers' cache counters from the start,
 * `AccountingRecord` persists them and `prometheus tokens report` prices the savings. The
 * `prompt-caching` toggle ships labelled `wired` and defaulting ON. And `cache_control` appeared
 * nowhere in the repo except a documentation string — so the toggle changed nothing and the
 * report measured only whatever the provider chose to do on its own.
 *
 * The important tests here are the ones that check we DON'T send anything. A body that gained
 * block-shaped content for no reason is a body that 400s on a server which only accepts strings,
 * and a breakpoint on the wrong message bills a cache WRITE every single turn while never
 * earning a read — worse than not caching at all.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROMPT_CACHE_MIN_CHARS,
  applyPromptCache,
  cacheDialectFor,
  promptCachingSupported,
  shouldRequestPromptCache,
} from "./prompt-cache.js";

const sys = (n = PROMPT_CACHE_MIN_CHARS + 10): { role: string; content: string } => ({
  role: "system",
  content: "x".repeat(n),
});
const user = (c = "hello"): { role: string; content: string } => ({ role: "user", content: c });

/* ── which provider wants what ─────────────────────────────────────────────*/

test("each provider gets the dialect it actually speaks", () => {
  // One boolean cannot mean all three: Anthropic caches only what you MARK, OpenAI caches on
  // its own with no request field at all, and Gemini needs a separate resource created ahead
  // of time (a different API, not a request field).
  assert.equal(cacheDialectFor("anthropic"), "anthropic-blocks");
  assert.equal(cacheDialectFor("openai"), "automatic");
  assert.equal(cacheDialectFor("gemini"), "automatic");
  assert.equal(cacheDialectFor("ollama"), "none");
  assert.equal(cacheDialectFor("llamacpp"), "none");
  assert.equal(promptCachingSupported("ollama"), false);
  assert.equal(promptCachingSupported("anthropic"), true);
});

/* ── what goes on the wire ─────────────────────────────────────────────────*/

test("an automatic provider gets NOTHING added — asking would risk a 400", () => {
  // The strict local servers that share this wire format reject unknown body fields, and a
  // block-shaped `content` is exactly such a change.
  const msgs = [sys(), user()];
  const out = applyPromptCache(msgs, "automatic");
  assert.deepEqual(out, msgs);
  assert.deepEqual(applyPromptCache(msgs, "none"), msgs);
});

test("Anthropic gets a breakpoint on the SYSTEM prefix, and only there", () => {
  const out = applyPromptCache([sys(), user("q1"), user("q2")], "anthropic-blocks");
  const first = out[0] as { content: { type: string; cache_control?: unknown }[] };
  assert.ok(Array.isArray(first.content), "the system message was not converted to blocks");
  assert.deepEqual(first.content[0]?.cache_control, { type: "ephemeral" });
  // Everything after it is untouched — marking a user turn would mint a new cache entry every
  // turn: a write charge, never a read.
  assert.equal(typeof (out[1] as { content: unknown }).content, "string");
  assert.equal(typeof (out[2] as { content: unknown }).content, "string");
});

test("the system message's TEXT survives the conversion intact", () => {
  const text = "y".repeat(PROMPT_CACHE_MIN_CHARS + 1);
  const out = applyPromptCache([{ role: "system", content: text }, user()], "anthropic-blocks");
  const blocks = (out[0] as { content: { text: string }[] }).content;
  assert.equal(blocks[0]?.text, text);
});

test("a prefix too SHORT to be cacheable is left alone", () => {
  // Providers impose a ~1024-token minimum. Marking a shorter prefix earns a write charge and
  // can never earn a read, so the toggle would make short sessions more expensive.
  const out = applyPromptCache([{ role: "system", content: "short" }, user()], "anthropic-blocks");
  assert.equal(typeof (out[0] as { content: unknown }).content, "string");
});

test("a conversation with no system message is left alone", () => {
  const msgs = [user("just a question")];
  assert.deepEqual(applyPromptCache(msgs, "anthropic-blocks"), msgs);
});

test("only the LEADING run of system messages counts as the stable prefix", () => {
  // A system message spliced in later (the tool preamble is one) must not become the
  // breakpoint: everything before a breakpoint is cached, so a later one would cache the
  // user's turn too — which changes every turn.
  const out = applyPromptCache(
    [sys(), user("q"), { role: "system", content: "z".repeat(9000) }],
    "anthropic-blocks",
  );
  assert.ok(Array.isArray((out[0] as { content: unknown }).content));
  assert.equal(typeof (out[2] as { content: unknown }).content, "string");
});

/* ── the toggle ────────────────────────────────────────────────────────────*/

test("the toggle can turn it OFF, and an unsupported runtime is off regardless", () => {
  assert.equal(shouldRequestPromptCache(undefined, "anthropic"), true, "defaults on where free");
  assert.equal(shouldRequestPromptCache({ "prompt-caching": false }, "anthropic"), false);
  assert.equal(shouldRequestPromptCache({ "prompt-caching": true }, "ollama"), false);
});
