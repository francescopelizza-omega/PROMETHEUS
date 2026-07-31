/**
 * ai-client.test.ts — node:test for the renderer THIN AI client (§7).
 *
 * Pins the PURE SSE parsing (split frames, [DONE], delta extraction), the cloud-
 * policy refusal BEFORE any request leaves (§7.5), and an end-to-end stream against a
 * LOCAL fetch STUB (no real model — the env has none) so the streaming loop + prompt
 * build are exercised without faking a session. Pure/injected — runs under node --test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CloudPolicyError,
  type RendererEndpoint,
  type ToolCallAccumulator,
  accumulateToolCalls,
  buildInlineEditMessages,
  deltaFromPayload,
  finalizeToolCalls,
  joinUrl,
  parseSseChunk,
  streamChat,
  usageFromPayload,
} from "./ai-client.js";
import { accumulateUsage, emptyTotals, estimateCostUsd } from "./usage-cost.js";

test("usageFromPayload parses both SSE variants; malformed is fail-soft", () => {
  // include_usage variant: empty choices + usage on the final chunk.
  const includeUsage = JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
  assert.deepEqual(usageFromPayload(includeUsage), {
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
  });
  // usage folded into the last content chunk (no total → derived).
  const folded = JSON.stringify({
    choices: [{ delta: { content: "" } }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  });
  assert.deepEqual(usageFromPayload(folded), { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
  // fail-soft: [DONE], no usage, malformed json → null (never a throw, never partial)
  assert.equal(usageFromPayload("[DONE]"), null);
  assert.equal(usageFromPayload(JSON.stringify({ choices: [{ delta: { content: "hi" } }] })), null);
  assert.equal(usageFromPayload("{not json"), null);
  assert.equal(usageFromPayload(JSON.stringify({ usage: { foo: 1 } })), null);
});

test("cost accumulator: priced turns accrue USD; local (null price) stays cost-unknown", () => {
  const price = { in: 3, out: 15 }; // $/Mtok
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
  assert.equal(estimateCostUsd(usage, price), 18); // 1×3 + 1×15
  assert.equal(estimateCostUsd(usage, null), null); // unknown price → null, never $0
  let t = emptyTotals();
  t = accumulateUsage(t, usage, price);
  assert.equal(t.totalTokens, 2_000_000);
  assert.equal(t.costUsd, 18);
  assert.equal(t.turns, 1);
  assert.equal(t.lastTurnTokens, 2_000_000);
  // a local turn (null price) adds tokens but not cost.
  t = accumulateUsage(t, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, null);
  assert.equal(t.totalTokens, 2_000_015);
  assert.equal(t.costUsd, 18); // unchanged by the free turn
  // a turn with no usage still counts but adds nothing.
  const before = t.totalTokens;
  t = accumulateUsage(t, undefined, price);
  assert.equal(t.totalTokens, before);
  assert.equal(t.turns, 3);
});

test("tool-call accumulator folds streamed fragments by index", () => {
  const acc: ToolCallAccumulator = new Map();
  // name arrives first, arguments stream in pieces (OpenAI behavior).
  accumulateToolCalls(
    acc,
    JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file" } }] } },
      ],
    }),
  );
  accumulateToolCalls(
    acc,
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
    }),
  );
  accumulateToolCalls(
    acc,
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }],
    }),
  );
  const calls = finalizeToolCalls(acc);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, "c1");
  assert.equal(calls[0]?.name, "read_file");
  assert.deepEqual(JSON.parse(calls[0]?.arguments ?? "{}"), { path: "a.ts" });
});

test("tool-call accumulator ignores plain content + malformed payloads", () => {
  const acc: ToolCallAccumulator = new Map();
  accumulateToolCalls(acc, JSON.stringify({ choices: [{ delta: { content: "hello" } }] }));
  accumulateToolCalls(acc, "not json");
  accumulateToolCalls(acc, "[DONE]");
  assert.deepEqual(finalizeToolCalls(acc), []);
});

test("finalizeToolCalls drops fragments with no function name", () => {
  const acc: ToolCallAccumulator = new Map();
  accumulateToolCalls(
    acc,
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }],
    }),
  );
  assert.deepEqual(finalizeToolCalls(acc), []);
});

test("parseSseChunk splits complete frames and keeps the partial tail", () => {
  const { payloads, rest } = parseSseChunk('data: {"a":1}\ndata: [DONE]\ndata: {"b":');
  assert.deepEqual(payloads, ['{"a":1}', "[DONE]"]);
  assert.equal(rest, 'data: {"b":');
});

test("deltaFromPayload reads chat delta.content and legacy text", () => {
  assert.equal(deltaFromPayload(JSON.stringify({ choices: [{ delta: { content: "hi" } }] })), "hi");
  assert.equal(deltaFromPayload(JSON.stringify({ choices: [{ text: "yo" }] })), "yo");
  assert.equal(deltaFromPayload("[DONE]"), "");
  assert.equal(deltaFromPayload("not json"), "");
});

test("joinUrl normalises the slash", () => {
  assert.equal(
    joinUrl("http://localhost:8000/", "/v1/chat/completions"),
    "http://localhost:8000/v1/chat/completions",
  );
  assert.equal(
    joinUrl("http://localhost:8000", "v1/chat/completions"),
    "http://localhost:8000/v1/chat/completions",
  );
});

const LOCAL: RendererEndpoint = {
  id: "local:qwen",
  baseUrl: "http://localhost:8000",
  locality: "local",
};
const CLOUD: RendererEndpoint = { id: "cloud:claude", baseUrl: "https://api", locality: "cloud" };

test("cloud policy refuses a cloud endpoint BEFORE any request (§7.5)", async () => {
  let called = false;
  const doFetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(
    async () => {
      for await (const _ of streamChat(CLOUD, [{ role: "user", content: "hi" }], {
        neverSendToCloud: true,
        doFetch,
      })) {
        /* drain */
      }
    },
    (e: unknown) => e instanceof CloudPolicyError,
  );
  assert.equal(called, false); // nothing left the machine
});

/** Build a fetch stub returning an SSE body from a list of chunk strings. */
function sseStub(chunks: string[]): typeof fetch {
  return (async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

test("streamChat yields deltas from a LOCAL SSE stub then stops on [DONE]", async () => {
  const doFetch = sseStub([
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
    "data: [DONE]\n",
    'data: {"choices":[{"delta":{"content":"IGNORED"}}]}\n',
  ]);
  const out: string[] = [];
  for await (const d of streamChat(LOCAL, [{ role: "user", content: "hi" }], { doFetch })) {
    out.push(d);
  }
  assert.equal(out.join(""), "Hello");
});

test("streamChat handles a frame split across read() chunks", async () => {
  const doFetch = sseStub([
    'data: {"choices":[{"delta":{"con',
    'tent":"X"}}]}\n',
    "data: [DONE]\n",
  ]);
  const out: string[] = [];
  for await (const d of streamChat(LOCAL, [{ role: "user", content: "hi" }], { doFetch })) {
    out.push(d);
  }
  assert.equal(out.join(""), "X");
});

test("streamChat throws on a non-ok HTTP status", async () => {
  const doFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(async () => {
    for await (const _ of streamChat(LOCAL, [{ role: "user", content: "hi" }], { doFetch })) {
      /* drain */
    }
  });
});

test("buildInlineEditMessages includes instruction, selection, language, context", () => {
  const msgs = buildInlineEditMessages({
    instruction: "add retry",
    selection: "res = call()",
    context: "def run():",
    languageId: "python",
  });
  assert.equal(msgs[0]?.role, "system");
  assert.match(msgs[1]?.content ?? "", /Instruction: add retry/);
  assert.match(msgs[1]?.content ?? "", /Language: python/);
  assert.match(msgs[1]?.content ?? "", /res = call\(\)/);
  assert.match(msgs[1]?.content ?? "", /Context:/);
});
