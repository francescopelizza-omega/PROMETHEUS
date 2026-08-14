/**
 * context-window.test.ts — measure the window, never assume it.
 *
 * The assumption being replaced: every endpoint builder hard-coded 8192. On the machine this
 * was written for that is exactly right for `gemma4:12b` and wrong by 32x for `qwen3.6`
 * (262144). It is also the number compaction budgets against, so the guess made a long run
 * compact a huge-window model as though it were about to overflow.
 *
 * The load-bearing property is FAIL-SOFT: an unreachable runner, an unrecognised shape or a
 * nonsense number must all land on the documented floor and SAY they did, so a caller never
 * presents a default as a measurement.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_CONTEXT_WINDOW,
  contextFromModelsEntry,
  contextFromOllamaShow,
  probeContextWindow,
} from "./context-window.js";

/** A fetch stub: route → payload, anything else is a 404. */
function stub(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const fetchLike = async (url: string) => {
    seen.push(url);
    const hit = Object.entries(routes).find(([k]) => url.endsWith(k));
    if (!hit) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => hit[1] };
  };
  return { fetchLike, seen };
}

/* ── parsing what a runner actually returns ─────────────────────────────────*/

test("an architecture-prefixed context_length is read whatever the architecture", () => {
  // Enumerating known architectures would silently return the default for every model
  // released after this was written, so the key is matched by SUFFIX.
  for (const arch of ["qwen3moe", "llama", "gemma3", "something.new.in.2027"]) {
    const n = contextFromOllamaShow({ model_info: { [`${arch}.context_length`]: 262144 } });
    assert.equal(n, 262144, `missed ${arch}`);
  }
});

test("the real gemma4 and qwen3.6 shapes both parse", () => {
  assert.equal(contextFromOllamaShow({ model_info: { "gemma3.context_length": 8192 } }), 8192);
  assert.equal(
    contextFromOllamaShow({ model_info: { "qwen3moe.context_length": 262144 } }),
    262144,
  );
});

test("`details` and a flattened top level are both accepted", () => {
  assert.equal(contextFromOllamaShow({ details: { context_length: 32768 } }), 32768);
  assert.equal(contextFromOllamaShow({ context_length: 16384 }), 16384);
});

test("a nonsense window is rejected rather than believed", () => {
  // A misparse that yields 12 would make the agent compact after one message; one that
  // yields 1e9 would make it never compact at all. Both are worse than the floor.
  for (const bad of [0, -1, 12, 1e12, "8192", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      contextFromOllamaShow({ model_info: { "llama.context_length": bad } }),
      null,
      `accepted ${String(bad)}`,
    );
  }
});

test("the OpenAI-compatible spellings are all read", () => {
  assert.equal(contextFromModelsEntry({ context_length: 4096 }), 4096);
  assert.equal(contextFromModelsEntry({ max_context_length: 4096 }), 4096);
  assert.equal(contextFromModelsEntry({ max_model_len: 4096 }), 4096);
  assert.equal(contextFromModelsEntry({ meta: { n_ctx: 4096 } }), 4096);
  assert.equal(contextFromModelsEntry({ nothing: 1 }), null);
});

/* ── probing ────────────────────────────────────────────────────────────────*/

test("Ollama's /api/show is asked first and its answer is labelled as measured", async () => {
  const { fetchLike, seen } = stub({
    "/api/show": { model_info: { "qwen3moe.context_length": 262144 } },
  });
  const r = await probeContextWindow("http://127.0.0.1:11434/v1", "qwen3.6", fetchLike);
  assert.deepEqual(r, { contextWindow: 262144, source: "ollama" });
  assert.ok(seen[0]?.endsWith("/api/show"), "the runner was not asked first");
  // the `/v1` suffix must not become `/v1/api/show`.
  assert.equal(seen[0], "http://127.0.0.1:11434/api/show");
});

test("it falls back to /v1/models, matching the requested model", async () => {
  const { fetchLike } = stub({
    "/v1/models": {
      data: [
        { id: "other", context_length: 1024 },
        { id: "wanted", context_length: 32768 },
      ],
    },
  });
  const r = await probeContextWindow("http://x/v1", "wanted", fetchLike);
  assert.deepEqual(r, { contextWindow: 32768, source: "openai-models" });
});

test("an unreachable runner yields the FLOOR, labelled as a default", async () => {
  // The caller must be able to tell "I measured 8192" from "I could not measure".
  const dead = async () => {
    throw new Error("ECONNREFUSED");
  };
  const r = await probeContextWindow("http://127.0.0.1:1/v1", "m", dead);
  assert.deepEqual(r, { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "default" });
});

test("a runner that answers with a shape we do not know yields the floor", async () => {
  const { fetchLike } = stub({ "/api/show": { surprise: true }, "/v1/models": { data: [] } });
  const r = await probeContextWindow("http://x", "m", fetchLike);
  assert.equal(r.source, "default");
  assert.equal(r.contextWindow, DEFAULT_CONTEXT_WINDOW);
});
