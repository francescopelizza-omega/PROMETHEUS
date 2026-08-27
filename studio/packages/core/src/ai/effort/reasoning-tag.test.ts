/**
 * reasoning-tag.test.ts — thinking must not arrive as the answer.
 *
 * `EffortCapability.reasoningTag` recorded which models emit inline `<think>…</think>` from the
 * day the type was written and nothing ever read it, so on DeepSeek R1, QwQ, Phi-4-reasoning
 * and EXAONE Deep the deliberation landed in the transcript — and, worse, was fed to the
 * tool-call scanner.
 *
 * Almost every test below is about CHUNK BOUNDARIES, because that is what makes this a state
 * machine instead of a `replace()`: a tag split across two deltas is the normal case on a
 * stream, not an edge case.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createReasoningTagSplitter } from "./reasoning-tag.js";

/** Feed `chunks` through a splitter and concatenate what came out of each channel. */
function run(tag: string | undefined, chunks: readonly string[]) {
  const s = createReasoningTagSplitter(tag);
  let text = "";
  let reasoning = "";
  for (const c of chunks) {
    const out = s.push(c);
    text += out.text;
    reasoning += out.reasoning;
  }
  const last = s.end();
  return { text: text + last.text, reasoning: reasoning + last.reasoning, inside: s.inside };
}

test("no tag configured ⇒ a strict pass-through, so callers need not branch", () => {
  const r = run(undefined, ["hello ", "<think>not special</think>", " world"]);
  assert.equal(r.text, "hello <think>not special</think> world");
  assert.equal(r.reasoning, "");
});

test("a whole thought in one chunk is split cleanly", () => {
  const r = run("think", ["<think>weighing it up</think>The answer is 4."]);
  assert.equal(r.text, "The answer is 4.");
  assert.equal(r.reasoning, "weighing it up");
});

test("text BEFORE and AFTER the thought both survive", () => {
  const r = run("think", ["Sure. <think>hmm</think> Here goes."]);
  assert.equal(r.text, "Sure.  Here goes.");
  assert.equal(r.reasoning, "hmm");
});

test("a tag split ACROSS chunks is still recognised — the whole reason this is a machine", () => {
  // `<thi` + `nk>` is what a stream actually delivers. A per-chunk replace() sees neither half
  // and passes both through, which is how the markup reached the transcript.
  const r = run("think", ["<thi", "nk>deliberating</thi", "nk>done"]);
  assert.equal(r.text, "done");
  assert.equal(r.reasoning, "deliberating");
});

test("a tag split one CHARACTER at a time is still recognised", () => {
  const r = run("think", [..."<think>abc</think>xyz"]);
  assert.equal(r.text, "xyz");
  assert.equal(r.reasoning, "abc");
});

test("text that merely LOOKS like the start of a tag is emitted, not swallowed", () => {
  // The held-back tail must be released the moment it cannot become a tag. Holding it forever
  // would silently truncate an ordinary answer that happened to contain a `<`.
  const r = run("think", ["a < b and c <th", "en d"]);
  assert.equal(r.text, "a < b and c <then d");
  assert.equal(r.reasoning, "");
});

test("the held tail is bounded — a long run of `<` does not accumulate", () => {
  const r = run("think", ["<<<<<<<<<<", "plain"]);
  assert.equal(r.text, "<<<<<<<<<<plain");
});

test("several thoughts in one stream are all captured", () => {
  const r = run("think", ["<think>one</think>A<think>two</think>B"]);
  assert.equal(r.text, "AB");
  assert.equal(r.reasoning, "onetwo");
});

test("an UNTERMINATED thought flushes as reasoning, never as the answer", () => {
  // A model cut off mid-thought was still thinking. Promoting a truncated deliberation to
  // "the answer" is the precise failure this module exists to prevent.
  const r = run("think", ["<think>I was interrupted"]);
  assert.equal(r.text, "");
  assert.equal(r.reasoning, "I was interrupted");
  assert.equal(r.inside, true);
});

test("a partial tag that never completed is ordinary text at end of stream", () => {
  const r = run("think", ["the answer</thin"]);
  assert.equal(r.text, "the answer</thin");
  assert.equal(r.reasoning, "");
});

test("a custom tag name works — EXAONE Deep uses `thought`", () => {
  const r = run("thought", ["<thought>pondering</thought>result"]);
  assert.equal(r.text, "result");
  assert.equal(r.reasoning, "pondering");
  // …and the OTHER tag is then just text, because the capability names exactly one.
  const other = run("thought", ["<think>x</think>y"]);
  assert.equal(other.text, "<think>x</think>y");
});

test("a stream with no tag at all is byte-identical through the splitter", () => {
  // The no-regression case: every non-R1 model on a reasoningTag-bearing rule still gets its
  // content through untouched.
  const chunks = ["Here is ", "a normal ", "answer with a < and a > in it."];
  const r = run("think", chunks);
  assert.equal(r.text, chunks.join(""));
  assert.equal(r.reasoning, "");
});

test("thinking is kept AWAY from the text channel, which is what the tool scanner reads", () => {
  // The non-cosmetic half of the bug: a model reasoning aloud about calling a tool used to
  // feed that reasoning to the text-protocol scanner, which could trip a real call.
  const r = run("think", [
    "<think>I could call <tool_call>{'name':'write_file'}</tool_call> here</think>",
    "I'll ask first.",
  ]);
  assert.equal(r.text, "I'll ask first.");
  assert.match(r.reasoning, /tool_call/);
});

test("empty pushes and empty streams are harmless", () => {
  assert.deepEqual(run("think", []), { text: "", reasoning: "", inside: false });
  assert.deepEqual(run("think", ["", "", ""]), { text: "", reasoning: "", inside: false });
});

/* ── the load-bearing invariant: the answer must not depend on the CHUNKING ──*/

/** Deterministic PRNG — a fuzz that cannot be reproduced is not a test. */
function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunks(s: string, rng: () => number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const n = 1 + Math.floor(rng() * 5);
    out.push(s.slice(i, i + n));
    i += n;
  }
  return out;
}

test("the split is IDENTICAL however the stream was chunked (4000 random inputs)", () => {
  // The one property that matters for a streaming parser, and the one a hand-written example
  // cannot establish: a delta boundary is invisible to the caller, so landing one inside a tag
  // must change nothing. Alphabet is deliberately tag-shaped — `<`, `>`, `/` and the letters
  // of "think" — so random strings produce real partial tags rather than harmless prose.
  const alphabet = "<>/thinkabc ";
  for (let seed = 0; seed < 4000; seed++) {
    const rng = mulberry(seed + 99_999);
    let input = "";
    const len = 1 + Math.floor(rng() * 40);
    for (let i = 0; i < len; i++) {
      input += alphabet[Math.floor(rng() * alphabet.length)] as string;
    }
    const whole = run("think", [input]);
    const random = run("think", chunks(input, mulberry(seed)));
    const perChar = run("think", [...input]);
    assert.deepEqual(
      { text: random.text, reasoning: random.reasoning },
      { text: whole.text, reasoning: whole.reasoning },
      `seed ${seed}: chunking changed the result for ${JSON.stringify(input)}`,
    );
    assert.equal(perChar.text, whole.text, `seed ${seed}: per-character chunking diverged`);
  }
});

test("nothing is lost: every character is either text, reasoning, or a tag", () => {
  const input = "pre <think>a b</think> mid <think>c</think> post";
  const { text, reasoning } = run("think", chunks(input, mulberry(7)));
  const tagChars = "<think></think>".length * 2;
  assert.equal(text.length + reasoning.length, input.length - tagChars);
});
