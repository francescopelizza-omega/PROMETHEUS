/**
 * client.test.ts — the provider-agnostic AI client (file 07 §7).
 *
 * No real model runs here (env limit). We stand up a LOCAL node:http server that
 * serves a hand-written OpenAI-compatible SSE stream (`data: {...}\n\n` … `[DONE]`)
 * and point the client at it via the injectable `fetch` seam. We assert:
 *  - chat() streams + concatenates `delta.content` and stops on `[DONE]`,
 *  - edit() builds the inline-edit prompt and streams the replacement,
 *  - the SSE parser handles frames split mid-line across chunks,
 *  - the cloud-policy guard REFUSES a cloud endpoint BEFORE any request leaves
 *    (no HTTP hit), while a local endpoint streams normally,
 *  - the api key is resolved from a keychain REF (never raw in state),
 *  - parseSseChunk / deltaFromPayload / endpointAllowed pure helpers.
 */
import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import { test } from "node:test";

import {
  type AiEndpoint,
  CloudPolicyError,
  type FetchLike,
  ModelIdlePausedError,
  type WorkspacePolicy,
  createAiClient,
  deltaFromPayload,
  endpointAllowed,
  parseSseChunk,
  usageFromPayload,
} from "./client.js";

/* --- a local OpenAI-compatible SSE stub (node:http, no real model) -------- */

/** Build the SSE body the stub serves: token deltas, then [DONE]. */
function sseBody(tokens: string[]): string {
  const frames = tokens.map(
    (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`,
  );
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

interface Stub {
  server: Server;
  url: string;
  /** the bodies POSTed to the stub, for assertions. */
  received: { path: string; body: unknown }[];
}

async function startStub(tokens: string[]): Promise<Stub> {
  const received: { path: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { "content-type": "text/event-stream" });
      // write the SSE body in TWO writes that split a frame mid-line, to exercise
      // the chunk-reassembly path.
      const body = sseBody(tokens);
      const mid = Math.floor(body.length / 2);
      res.write(body.slice(0, mid));
      res.end(body.slice(mid));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}`, received };
}

/** A FetchLike backed by the global fetch (Node 26 has it) — used in tests. */
const realFetch: FetchLike = (input, init) =>
  fetch(input, init) as unknown as ReturnType<FetchLike>;

const localEndpoint = (baseUrl: string): AiEndpoint => ({
  id: "local:qwen2.5-coder@vllm",
  baseUrl,
  locality: "local",
  contextWindow: 32768,
  supportsTools: true,
  model: "qwen2.5-coder",
});

const OPEN_POLICY: WorkspacePolicy = { neverSendToCloud: false };
const STRICT_POLICY: WorkspacePolicy = { neverSendToCloud: true };

/* --- chat streaming ------------------------------------------------------ */

test("chat() streams OpenAI SSE deltas and stops on [DONE]", async () => {
  const stub = await startStub(["Hel", "lo", " world"]);
  try {
    const client = createAiClient(localEndpoint(stub.url), OPEN_POLICY, { fetch: realFetch });
    let text = "";
    let sawDone = false;
    for await (const chunk of client.chat([{ role: "user", content: "hi" }])) {
      if (chunk.done) sawDone = true;
      text += chunk.delta;
    }
    assert.equal(text, "Hello world");
    assert.equal(sawDone, true);
    // it POSTed to /v1/chat/completions with stream:true and our messages.
    const req = stub.received.at(-1)!;
    assert.equal(req.path, "/v1/chat/completions");
    const body = req.body as {
      stream?: boolean;
      model?: string;
      messages?: unknown[];
      stream_options?: { include_usage?: boolean };
    };
    assert.equal(body.stream, true);
    assert.equal(body.model, "qwen2.5-coder");
    assert.equal(Array.isArray(body.messages), true);
    // CLI-029: the terminal usage frame is requested on CLOUD only. Unconditional was wrong —
    // a strict local server 400s on the unknown field, and this client is what the text
    // tool-call transport runs on, so that 400 kills the whole turn rather than losing a
    // token count.
    //
    // `keep_alive` is no longer pinned at "30m" — that held model weights resident for half an
    // hour after the last prompt. It is now a bound Prometheus puts on ITS OWN requests
    // (DEFAULT_LOCAL_KEEP_ALIVE), which caps what Prometheus causes a runner to hold without
    // touching a runner the user drives from their own terminal. Multi-round turns stay warm
    // regardless: the runner restarts its idle timer on every request.
    assert.equal(body.stream_options, undefined);
    assert.equal((body as { keep_alive?: string }).keep_alive, "60s");
  } finally {
    stub.server.close();
  }
});

test("chat() surfaces the SSE `usage` frame on the terminal chunk (CLI-029)", async () => {
  // an include_usage stream: deltas, then a CHOICE-LESS usage frame, then [DONE].
  const deltaFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`;
  const usageFrame = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } })}\n\n`;
  const frames = `${deltaFrame}${usageFrame}data: [DONE]\n\n`;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(frames);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try {
    const client = createAiClient(localEndpoint(url), OPEN_POLICY, { fetch: realFetch });
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let text = "";
    for await (const chunk of client.chat([{ role: "user", content: "hi" }])) {
      text += chunk.delta;
      if (chunk.usage) usage = chunk.usage;
    }
    assert.equal(text, "hi");
    assert.deepEqual(usage, { inputTokens: 11, outputTokens: 4, totalTokens: 15 });
  } finally {
    server.close();
  }
});

test("chat() without a usage frame leaves chunk.usage undefined (fallback is the caller's)", async () => {
  const stub = await startStub(["a", "b"]); // sseBody has no usage frame
  try {
    const client = createAiClient(localEndpoint(stub.url), OPEN_POLICY, { fetch: realFetch });
    let sawUsage = false;
    for await (const chunk of client.chat([{ role: "user", content: "hi" }])) {
      if (chunk.usage) sawUsage = true;
    }
    assert.equal(sawUsage, false);
  } finally {
    stub.server.close();
  }
});

/* --- inactivity pause ------------------------------------------------------
 *
 * `stream()` (and therefore `chat()`) used to have NO idle protection of any kind — this is the
 * ONE shared transport every non-native caller falls back to (the CLI's text-protocol demotion,
 * `makeSummarizer`'s background call, and the entire VS Code extension), so a cold-loading or
 * wedged local model hung any of them forever, silently, with no way to recover short of
 * killing the process. These tests exercise the real `IdleWatchdog` wired into `stream()`
 * itself, using the SAME time-compressed-clock technique
 * `apps/cli/src/session/agent-runtime.test.ts` already established: a realistic,
 * floor-respecting `idleTimeoutMs` (≥30s) fires in milliseconds of real test time.
 */

/** A stub that accepts the connection but never writes ANY response — the pre-first-byte hang
 *  this whole fix targets (a cold model load, or a queue wait behind another request). */
async function startHangingStub(): Promise<{ server: Server; url: string }> {
  const server = createServer((req) => {
    req.on("data", () => {});
    req.on("end", () => {
      /* never responds */
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

/** Real-elapsed-time × `speedup`, mirroring `agent-runtime.test.ts`'s `compressedClock` — lets a
 *  test request a fully realistic `idleTimeoutMs` while the watchdog fires in real milliseconds. */
function compressedClock(speedup: number) {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * speedup,
    setTimeoutFn: (cb: () => void, ms: number) => setTimeout(cb, ms / speedup),
    clearTimeoutFn: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  };
}

test("chat(): a response that never arrives PAUSES via ModelIdlePausedError, not an indefinite hang", async () => {
  const stub = await startHangingStub();
  try {
    const client = createAiClient(localEndpoint(stub.url), OPEN_POLICY, { fetch: realFetch });
    const clock = compressedClock(1000); // a real "30s" idle window fires in ~30ms of test time
    const started = Date.now();
    await assert.rejects(
      async () => {
        for await (const _chunk of client.chat([{ role: "user", content: "hi" }], {
          idleTimeoutMs: 30_000,
          idleWatchdogNow: clock.now,
          idleWatchdogSetTimeout: clock.setTimeoutFn,
          idleWatchdogClearTimeout: clock.clearTimeoutFn,
        })) {
          /* never yields */
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof ModelIdlePausedError, `expected ModelIdlePausedError, got ${err}`);
        assert.ok(err.idleMs >= 30_000, `idleMs (${err.idleMs}) should be at least the window`);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 2000,
      `expected a bounded pause well under 2s of real time, took ${elapsed}ms`,
    );
  } finally {
    stub.server.close();
  }
});

test("chat(): an idle-fire landing during a retry backoff sleep still PAUSES, not silently retried forever (regression: the watchdog used to abort a controller nothing was listening to and could never fire again)", async () => {
  // A 503 is retryable (isRetryableStatus), so the FIRST failed attempt schedules a real
  // backoff sleep via retry() — exactly the window the old per-attempt-controller design lost
  // an idle-fire in. `watchdog.touch()` (fired via onRetry) resets the idle clock right as that
  // sleep begins, and the compressed clock lets the (real, floor-respecting) 30s window elapse
  // in milliseconds of test time while the sleep is still pending.
  let attempts = 0;
  const doFetch: FetchLike = (async () => {
    attempts += 1;
    return {
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      async text() {
        return "";
      },
      headers: { get: () => null },
    };
  }) as unknown as FetchLike;
  const client = createAiClient(localEndpoint("http://127.0.0.1:1"), OPEN_POLICY, {
    fetch: doFetch,
    /**
     * Pin the jitter to its MAXIMUM, which is what makes this test deterministic.
     *
     * `retry()` applies FULL jitter — the delay is uniform in `[0, backoffDelay]` — so the first
     * retry's 400ms curve can land anywhere from 0ms to 400ms. The compressed idle window below
     * is ~30ms of real time, so roughly one run in thirteen drew a shorter sleep than that,
     * finished the backoff first, and fired a second attempt: a flake in the TEST, not in the
     * watchdog it is guarding. No speedup can fix that by itself (a 0ms sleep always wins), so
     * the race is removed rather than tuned — `rng: () => 1` makes the sleep the full 400ms,
     * an order of magnitude past the window it has to lose to.
     *
     * The pause still resolves in milliseconds of real time: the idle-fire ABORTS the backoff
     * sleep rather than waiting it out, which is the behaviour the elapsed-time assertion below
     * exists to prove.
     */
    rng: () => 1,
  });
  const clock = compressedClock(1000);
  const started = Date.now();
  await assert.rejects(
    async () => {
      for await (const _chunk of client.chat([{ role: "user", content: "hi" }], {
        idleTimeoutMs: 30_000,
        idleWatchdogNow: clock.now,
        idleWatchdogSetTimeout: clock.setTimeoutFn,
        idleWatchdogClearTimeout: clock.clearTimeoutFn,
      })) {
        /* never yields */
      }
    },
    (err: unknown) => {
      assert.ok(err instanceof ModelIdlePausedError, `expected ModelIdlePausedError, got ${err}`);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 2000,
    `expected a bounded pause well under 2s of real time, took ${elapsed}ms`,
  );
  assert.equal(
    attempts,
    1,
    "the idle-fire during the backoff sleep must stop the retry loop before a second attempt — not be silently lost and let a doomed retry run to exhaustion",
  );
});

/* --- inline edit --------------------------------------------------------- */

test("edit() builds the inline-edit prompt and streams the replacement", async () => {
  const stub = await startStub(["for ", "attempt ", "in range(3):"]);
  try {
    const client = createAiClient(localEndpoint(stub.url), OPEN_POLICY, { fetch: realFetch });
    let out = "";
    for await (const chunk of client.edit({
      instruction: "add retry with backoff",
      selection: "res = self.model.complete(ctx)",
      languageId: "python",
    })) {
      out += chunk.delta;
    }
    assert.equal(out, "for attempt in range(3):");
    const body = stub.received.at(-1)!.body as { messages: { role: string; content: string }[] };
    // a system prompt + a user prompt that carries the instruction + selection.
    assert.equal(body.messages[0]!.role, "system");
    assert.match(body.messages[1]!.content, /add retry with backoff/);
    assert.match(body.messages[1]!.content, /self\.model\.complete/);
    assert.match(body.messages[1]!.content, /Language: python/);
  } finally {
    stub.server.close();
  }
});

/* --- the cloud-policy guard (the load-bearing privacy check) ------------- */

test("cloud-policy guard REFUSES a cloud endpoint before any request leaves", async () => {
  // a fetch that MUST NOT be called — if it is, the guard failed.
  let fetchCalls = 0;
  const spyFetch: FetchLike = (...args) => {
    fetchCalls += 1;
    return realFetch(...args);
  };
  const cloud: AiEndpoint = {
    id: "cloud:anthropic:claude",
    baseUrl: "https://api.anthropic.invalid",
    locality: "cloud",
    apiKeyRef: "keychain://anthropic",
    contextWindow: 200000,
    supportsTools: true,
  };
  const client = createAiClient(cloud, STRICT_POLICY, {
    fetch: spyFetch,
    resolveKey: async () => "should-not-be-read",
  });
  await assert.rejects(async () => {
    for await (const _ of client.chat([{ role: "user", content: "leak me" }])) {
      // unreachable
    }
  }, CloudPolicyError);
  assert.equal(fetchCalls, 0, "no network request may leave when policy forbids cloud");
});

test("cloud endpoint streams normally when the policy allows cloud", async () => {
  const stub = await startStub(["ok"]);
  try {
    const cloud: AiEndpoint = {
      id: "cloud:openai:gpt",
      baseUrl: stub.url, // stub stands in for the cloud URL
      locality: "cloud",
      apiKeyRef: "keychain://openai",
      contextWindow: 128000,
      supportsTools: true,
      model: "gpt",
    };
    let resolvedRef = "";
    const client = createAiClient(cloud, OPEN_POLICY, {
      fetch: realFetch,
      resolveKey: async (ref) => {
        resolvedRef = ref;
        return "sk-secret";
      },
    });
    let text = "";
    for await (const chunk of client.chat([{ role: "user", content: "hi" }])) {
      text += chunk.delta;
    }
    assert.equal(text, "ok");
    // the key was resolved from the keychain REF, not held raw.
    assert.equal(resolvedRef, "keychain://openai");
  } finally {
    stub.server.close();
  }
});

/* --- pure helpers -------------------------------------------------------- */

test("parseSseChunk splits data: lines and retains a partial tail", () => {
  const first = parseSseChunk('data: {"a":1}\ndata: {"b":2}\ndata: {"c"');
  assert.deepEqual(first.payloads, ['{"a":1}', '{"b":2}']);
  assert.equal(first.rest, 'data: {"c"');
  const second = parseSseChunk(`${first.rest}:3}\n`);
  assert.deepEqual(second.payloads, ['{"c":3}']);
});

test("deltaFromPayload extracts chat delta.content and tolerates [DONE]/garbage", () => {
  assert.equal(deltaFromPayload(JSON.stringify({ choices: [{ delta: { content: "X" } }] })), "X");
  assert.equal(deltaFromPayload("[DONE]"), "");
  assert.equal(deltaFromPayload("not json"), "");
  assert.equal(deltaFromPayload(JSON.stringify({ choices: [] })), "");
  // legacy completions shape (choices[].text)
  assert.equal(deltaFromPayload(JSON.stringify({ choices: [{ text: "Y" }] })), "Y");
});

test("usageFromPayload (kept identical to the renderer) parses both variants, fail-soft", () => {
  const inc = JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });
  assert.deepEqual(usageFromPayload(inc), { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  const folded = JSON.stringify({
    choices: [{ delta: { content: "" } }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  });
  assert.deepEqual(usageFromPayload(folded), { inputTokens: 2, outputTokens: 1, totalTokens: 3 });
  assert.equal(usageFromPayload("[DONE]"), null);
  assert.equal(usageFromPayload("not json"), null);
  assert.equal(usageFromPayload(JSON.stringify({ choices: [{ delta: { content: "hi" } }] })), null);
});

test("usageFromPayload normalizes per-provider prompt-cache fields; absent ⇒ undefined (CLI-090)", () => {
  // Anthropic — flat cache_read / cache_creation.
  const anth = usageFromPayload(
    JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      },
    }),
  );
  assert.equal(anth?.cacheRead, 80);
  assert.equal(anth?.cacheCreate, 10);
  // OpenAI — nested prompt_tokens_details.cached_tokens (read only, no create).
  const oai = usageFromPayload(
    JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    }),
  );
  assert.equal(oai?.cacheRead, 64);
  assert.equal(oai?.cacheCreate, undefined);
  // no cache field → both undefined (unmeasurable, NOT 0 — the report must distinguish these).
  const bare = usageFromPayload(
    JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
  );
  assert.equal(bare?.cacheRead, undefined);
  assert.equal(bare?.cacheCreate, undefined);
});

test("endpointAllowed greys out cloud endpoints under a strict policy", () => {
  const local = localEndpoint("http://x");
  const cloud: AiEndpoint = { ...local, id: "c", locality: "cloud" };
  assert.equal(endpointAllowed(local, STRICT_POLICY), true);
  assert.equal(endpointAllowed(cloud, STRICT_POLICY), false);
  assert.equal(endpointAllowed(cloud, OPEN_POLICY), true);
});

test("a CLOUD endpoint gets stream_options and NO keep_alive", async () => {
  // The mirror of the local case: cloud can afford the usage frame (its tokens cost money)
  // and must never receive the Ollama-only `keep_alive`.
  const stub = await startStub(["hi"]);
  try {
    const cloud: AiEndpoint = {
      id: "cloud:openai:gpt",
      baseUrl: stub.url,
      locality: "cloud",
      contextWindow: 128000,
      supportsTools: true,
      model: "gpt-x",
    };
    const client = createAiClient(cloud, OPEN_POLICY, { fetch: realFetch });
    for await (const _c of client.chat([{ role: "user", content: "hi" }])) {
      // drain
    }
    const body = stub.received.at(-1)?.body as {
      stream_options?: { include_usage?: boolean };
      keep_alive?: string;
    };
    assert.equal(body.stream_options?.include_usage, true);
    assert.equal(body.keep_alive, undefined);
  } finally {
    stub.server.close();
  }
});

/* ── the non-OpenAI wire formats ─────────────────────────────────────────────*/

/** A byte stream over pre-baked SSE frames — no socket needed for a shape assertion. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(frames[i] ?? ""));
      i += 1;
    },
  });
}

test("an Anthropic endpoint gets the Messages protocol, not chat/completions", async () => {
  // A request built for OpenAI hits `/v1/chat/completions` on api.anthropic.com — an endpoint
  // that does not exist — and 404s. That is what made the vendor unreachable.
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  let seenBody: Record<string, unknown> = {};
  const client = createAiClient(
    {
      id: "cloud:anthropic:claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
      locality: "cloud",
      apiKeyRef: "env:ANTHROPIC_API_KEY",
      contextWindow: 200000,
      supportsTools: true,
      model: "claude-sonnet-4-6",
    },
    { neverSendToCloud: false },
    {
      resolveKey: async () => "sk-ant",
      fetch: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
        seenUrl = url;
        seenHeaders = init.headers;
        seenBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "",
          body: sseStream([
            'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
            'data: {"type":"message_stop"}\n\n',
          ]),
        };
      }) as never,
    },
  );
  const out: string[] = [];
  for await (const c of client.chat([
    { role: "system", content: "be terse" },
    { role: "user", content: "q" },
  ])) {
    if (c.delta) out.push(c.delta);
  }
  assert.equal(seenUrl, "https://api.anthropic.com/v1/messages");
  // x-api-key, not a bearer — and the version header is mandatory.
  assert.equal(seenHeaders["x-api-key"], "sk-ant");
  assert.equal(seenHeaders["anthropic-version"], "2023-06-01");
  assert.equal(seenHeaders.authorization, undefined, "a bearer token would 401 here");
  // The system prompt is a top-level field; left in `messages` it is rejected outright.
  assert.equal(seenBody.system, "be terse");
  assert.equal((seenBody.messages as unknown[]).length, 1);
  // max_tokens is REQUIRED by this API — omitting it is a 400, not a default.
  assert.equal(typeof seenBody.max_tokens, "number");
  assert.deepEqual(out, ["hi"]);
});

test("a Gemini endpoint gets generateContent, and its usage is normalized", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const client = createAiClient(
    {
      id: "cloud:gemini:gemini-2.5-pro",
      baseUrl: "https://generativelanguage.googleapis.com",
      locality: "cloud",
      apiKeyRef: "env:GEMINI_API_KEY",
      contextWindow: 1000000,
      supportsTools: true,
      model: "gemini-2.5-pro",
    },
    { neverSendToCloud: false },
    {
      resolveKey: async () => "goog-key",
      fetch: (async (url: string, init: { headers: Record<string, string> }) => {
        seenUrl = url;
        seenHeaders = init.headers;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "",
          body: sseStream([
            'data: {"candidates":[{"content":{"parts":[{"text":"yo"}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}\n\n',
          ]),
        };
      }) as never,
    },
  );
  let usage: { totalTokens: number } | undefined;
  const out: string[] = [];
  for await (const c of client.chat([{ role: "user", content: "q" }])) {
    if (c.delta) out.push(c.delta);
    if (c.usage) usage = c.usage;
  }
  assert.match(seenUrl, /\/v1beta\/models\/gemini-2\.5-pro:streamGenerateContent\?alt=sse$/);
  // A header, not the query string: a URL is logged by proxies and appears in error messages.
  assert.equal(seenHeaders["x-goog-api-key"], "goog-key");
  assert.deepEqual(out, ["yo"]);
  assert.equal(usage?.totalTokens, 6);
});

test("usageFromPayload reads Anthropic and Gemini frames, not only OpenAI's", () => {
  /**
   * It gated on `usage.prompt_tokens` / `usage.completion_tokens` and returned null for anything
   * else, despite a docstring promising it normalizes the per-provider counters. The CLI's native
   * tool transport uses it as its ONLY usage source, and native is the transport BOTH Claude and
   * Gemini take (each wire reports supportsTools:true), so every agentic turn on either provider
   * fell back to a chars/4 estimate flagged `estimated: true` and recorded no cache counters.
   */
  // Anthropic message_start — usage nested under `message`, input + cache counters
  const start = usageFromPayload(
    JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 12000,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 1500,
        },
      },
    }),
  );
  assert.equal(start?.inputTokens, 12000);
  assert.equal(start?.cacheRead, 9000);
  assert.equal(start?.cacheCreate, 1500);

  // Anthropic message_delta — usage at the top level, output only
  const delta = usageFromPayload(
    JSON.stringify({ type: "message_delta", usage: { output_tokens: 350 } }),
  );
  assert.equal(delta?.outputTokens, 350);

  // Gemini — no `usage` key at all
  const gem = usageFromPayload(
    JSON.stringify({
      usageMetadata: {
        promptTokenCount: 900,
        candidatesTokenCount: 120,
        cachedContentTokenCount: 400,
        totalTokenCount: 1020,
      },
    }),
  );
  assert.equal(gem?.inputTokens, 900);
  assert.equal(gem?.outputTokens, 120);
  assert.equal(gem?.totalTokens, 1020);
  assert.equal(gem?.cacheRead, 400);

  // OpenAI still works exactly as before
  const oai = usageFromPayload(
    JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
  );
  assert.deepEqual(oai, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });

  // and a frame with no usage at all is still null
  assert.equal(usageFromPayload(JSON.stringify({ choices: [] })), null);
  assert.equal(usageFromPayload("[DONE]"), null);
});

test("a mid-stream provider error is REPORTED, not swallowed into an empty answer", async () => {
  /**
   * `wire.ts` parses all three providers' mid-stream faults — Anthropic's
   * `{"type":"error",…}`, an OpenAI-compatible bare `{"error":{…}}`, Gemini's
   * `promptFeedback.blockReason` — into `WireEvent.error`. The stream loop read only
   * `delta`/`usage`/`done`, so every one of them was dropped: the turn ended normally, the user
   * got a truncated or completely empty reply, and nothing anywhere said why.
   *
   * Reproduced against a real HTTP server before the fix: text `""`, threw nothing.
   */
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first half" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ error: { type: "server_error", message: "boom" } })}\n\n`);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  try {
    const client = createAiClient(localEndpoint(url), OPEN_POLICY, { fetch: realFetch });
    let text = "";
    let caught: unknown;
    try {
      for await (const c of client.chat([{ role: "user", content: "hi" }])) text += c.delta ?? "";
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "the provider error was swallowed — the turn ended as if it succeeded");
    assert.equal((caught as Error).name, "ProviderStreamError");
    assert.match((caught as Error).message, /boom/);
    // the text that DID arrive is not thrown away — a host can still show it
    assert.equal(text, "first half");
    assert.equal((caught as { partial?: string }).partial, "first half");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/**
 * A RAW socket server, because `node:http` always emits a content-type and this defect is
 * about its ABSENCE. Answers any request with the given head + body, then closes.
 */
async function startRawStub(
  contentType: string | null,
  body: string,
): Promise<{ close(): void; url: string }> {
  const { createServer: createNetServer } = await import("node:net");
  const server = createNetServer((sock) => {
    sock.once("data", () => {
      sock.end(
        `HTTP/1.1 200 OK\r\n${contentType ? `Content-Type: ${contentType}\r\n` : ""}` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { close: () => server.close(), url: `http://127.0.0.1:${port}` };
}

const WHOLE_JSON = JSON.stringify({ choices: [{ message: { content: "the real answer" } }] });
const RAW_SSE =
  'data: {"choices":[{"delta":{"content":"streamed "}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n';

async function collectChat(url: string): Promise<{ text: string; threw: string | null }> {
  const client = createAiClient(localEndpoint(url), OPEN_POLICY, { fetch: realFetch });
  let text = "";
  try {
    for await (const chunk of client.chat([{ role: "user", content: "hi" }])) text += chunk.delta;
    return { text, threw: null };
  } catch (e) {
    return { text, threw: e instanceof Error ? e.message : String(e) };
  }
}

test("a 200 with a whole JSON completion and NO content-type is READ, not silently empty", async () => {
  // regression: the fast path took the whole-body route only when a content-type was PRESENT
  // (`contentType && !isEventStream`), so a header-less 200 fell through to the SSE reader,
  // found no `data:` frames and yielded nothing — no text, no error, indistinguishable from the
  // model declining to answer. Measured against this same raw server: header present →
  // "the real answer", header absent → "".
  const stub = await startRawStub(null, WHOLE_JSON);
  try {
    const { text, threw } = await collectChat(stub.url);
    assert.equal(threw, null);
    assert.equal(text, "the real answer");
  } finally {
    stub.close();
  }
});

test("the declared-content-type path is unchanged", async () => {
  const stub = await startRawStub("application/json", WHOLE_JSON);
  try {
    assert.equal((await collectChat(stub.url)).text, "the real answer");
  } finally {
    stub.close();
  }
});

test("a server that streams REAL SSE without declaring a content-type still streams", async () => {
  // the recovery must not change this: it runs only when the stream yielded nothing at all.
  const stub = await startRawStub(null, RAW_SSE);
  try {
    const { text, threw } = await collectChat(stub.url);
    assert.equal(threw, null);
    assert.equal(text, "streamed answer");
  } finally {
    stub.close();
  }
});

test("a 200 whose body is unreadable is a LOUD failure, never silence", async () => {
  const stub = await startRawStub(null, "not json at all");
  try {
    const { text, threw } = await collectChat(stub.url);
    assert.equal(text, "");
    assert.match(String(threw), /no readable content/);
  } finally {
    stub.close();
  }
});
