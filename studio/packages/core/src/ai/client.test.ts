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
    // CLI-029: it requests the terminal usage frame.
    assert.equal(body.stream_options?.include_usage, true);
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
