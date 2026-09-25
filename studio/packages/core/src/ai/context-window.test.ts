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
  PROBE_TIMEOUT_MS,
  contextFromModelsEntry,
  contextFromOllamaShow,
  probeContextWindow,
  revisionFromOllamaShow,
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

test("the SERVED context wins over the model's declared maximum", async () => {
  // The 2026-09-24 incident: /api/show reports what the WEIGHTS allow (262144) while the daemon
  // serves OLLAMA_CONTEXT_LENGTH (8192). Budgeting against the declared number is what built a
  // 7,254-token prompt for an 8,192-token slot — the preamble budgets scale with the window.
  const { fetchLike } = stub({
    "/api/show": { model_info: { "qwen3moe.context_length": 262144 } },
    "/api/ps": { models: [{ name: "qwen3.6", context_length: 8192 }] },
  });
  const r = await probeContextWindow("http://127.0.0.1:11434/v1", "qwen3.6", fetchLike);
  assert.equal(r.contextWindow, 8192);
  assert.equal(r.source, "ollama-loaded", "and it says the number is the SERVED one");
});

test("a model that is not loaded keeps the declared window", async () => {
  const { fetchLike } = stub({
    "/api/show": { model_info: { "qwen3moe.context_length": 262144 } },
    "/api/ps": { models: [] },
  });
  const r = await probeContextWindow("http://127.0.0.1:11434/v1", "qwen3.6", fetchLike);
  assert.deepEqual(r, { contextWindow: 262144, source: "ollama" });
});

test("an /api/ps that reports MORE than the weights allow does not raise the budget", async () => {
  const { fetchLike } = stub({
    "/api/show": { model_info: { "gemma3.context_length": 8192 } },
    "/api/ps": { models: [{ model: "m", context_length: 131072 }] },
  });
  const r = await probeContextWindow("http://x/v1", "m", fetchLike);
  assert.equal(r.contextWindow, 8192, "the smaller, safer number stays");
  assert.equal(r.source, "ollama");
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

/* ── the cache-invalidation token ───────────────────────────────────────────*/

test("revision prefers a content DIGEST wherever a build reports one", () => {
  assert.equal(revisionFromOllamaShow({ digest: "sha256:abc", modified_at: "t" }), "sha256:abc");
  assert.equal(
    revisionFromOllamaShow({ details: { digest: "sha256:def" }, modified_at: "t" }),
    "sha256:def",
  );
});

test("revision falls back to modified_at — Ollama 0.32.6's /api/show carries no digest", () => {
  // Verified against the live daemon: the top-level keys are license/modelfile/parameters/
  // template/details/model_info/tensors/capabilities/modified_at. No digest anywhere. A
  // re-pull rewrites `modified_at`, so it invalidates — it just also invalidates on a no-op
  // re-pull, which costs one redundant probe and never a stale answer.
  assert.equal(
    revisionFromOllamaShow({ modified_at: "2026-07-24T05:25:11.337173291+02:00" }),
    "2026-07-24T05:25:11.337173291+02:00",
  );
});

test("revision is undefined when the runner reports no identity at all", () => {
  // Not "" and not a fabricated key: a cache must be able to tell "unverifiable" from
  // "verified as X", because only the first one has to fall back to a time bound.
  assert.equal(revisionFromOllamaShow({ model_info: {} }), undefined);
  assert.equal(revisionFromOllamaShow({ digest: "" }), undefined);
  assert.equal(revisionFromOllamaShow(null), undefined);
  assert.equal(revisionFromOllamaShow("nope"), undefined);
});

test("probeContextWindow carries the revision through alongside the window", async () => {
  const { fetchLike } = stub({
    "/api/show": {
      model_info: { "qwen3moe.context_length": 262144 },
      capabilities: ["completion", "tools", "thinking"],
      modified_at: "2026-07-24T05:25:11Z",
    },
  });
  const r = await probeContextWindow("http://127.0.0.1:11434/v1", "qwen3.6:latest", fetchLike);
  assert.deepEqual(r, {
    contextWindow: 262144,
    source: "ollama",
    capabilities: ["completion", "tools", "thinking"],
    revision: "2026-07-24T05:25:11Z",
  });
});

/* ── V0: every probe request is BOUNDED ─────────────────────────────────────*/

test("a runner that accepts the socket and never answers does NOT hang the probe", async () => {
  // The nasty case, and the one `/model` made load-bearing: a refused connection fails fast on
  // its own, but a process that ACCEPTS and then goes silent hangs forever. `/model` awaits
  // this probe before reporting the switch, so an unbounded request hangs the command itself
  // with no output and no way back short of Ctrl-C.
  const seen: Array<AbortSignal | undefined> = [];
  const silent = ((_url: string, init?: { signal?: AbortSignal }) => {
    seen.push(init?.signal);
    return new Promise<never>((_res, rej) => {
      // resolve only if the caller aborts — i.e. never, unless the timeout fires.
      init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
    });
  }) as never;

  const started = Date.now();
  const r = await probeContextWindow("http://127.0.0.1:1/v1", "m", silent, 25);
  assert.deepEqual(r, { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "default" });
  assert.ok(Date.now() - started < 2000, "the probe did not return promptly");
  assert.ok(seen.length >= 1 && seen[0] instanceof AbortSignal, "no abort signal was passed");
});

test("the default ceiling is short — this is a loopback call, not a model request", () => {
  assert.equal(PROBE_TIMEOUT_MS, 2_500);
});

test("a 200 whose body is not JSON falls through to the floor rather than THROWING", async () => {
  // `probeContextWindow`'s whole contract is that it never throws at its caller: a proxy error
  // page served with a 200 must read as "could not measure", like any other failure.
  const html = (async () => ({
    ok: true,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  })) as never;
  const r = await probeContextWindow("http://x/v1", "m", html);
  assert.deepEqual(r, { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "default" });
});
