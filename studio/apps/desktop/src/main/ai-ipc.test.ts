import assert from "node:assert/strict";
import { test } from "node:test";
/**
 * ai-ipc.test.ts — model streaming in MAIN (§9c).
 *
 * The behaviour worth pinning is mostly about what MUST NOT depend on the delta feed: a
 * dropped `ai:progress` message is cosmetic, so the tool calls, the usage and the final
 * text all have to come back in the typed reply. And the cloud policy has to be refused
 * HERE, not merely in the renderer, or the enforcement is advisory.
 */
import { DEFAULT_AUTH_LEVEL, NETWORK_AUTH_LEVEL } from "@prometheus/core/agent-authorization";

import { settings as coreSettings } from "@prometheus/core";
import type { EvictionEvent } from "@prometheus/engine-bridge";
import type { AiProgressEvent, AiStreamRequest } from "../shared/ipc-contract.js";

import {
  chatCompletionsUrl,
  freeLocalModels,
  getSecurityPosture,
  localityOfUrl,
  parseSseChunk,
  probeEndpointCapabilities,
  probeRequestCount,
  probeServedModels,
  resetProbeCache,
  runAiStream,
  setSecurityPosture,
} from "./ai-ipc.js";

/** A response whose body streams `frames` (each already a full `data:` line). */
function sseResponse(frames: string[], init: { ok?: boolean; status?: number } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body,
  } as unknown as Response;
}

const LOCAL: AiStreamRequest["endpoint"] = {
  id: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "qwen",
  locality: "local",
};

/** Collect the deltas a run emits, standing in for a WebContents. */
function recorder(): { sender: unknown; events: AiProgressEvent[] } {
  const events: AiProgressEvent[] = [];
  return {
    events,
    sender: {
      isDestroyed: () => false,
      send: (_ch: string, ev: AiProgressEvent) => events.push(ev),
    },
  };
}

function req(over: Partial<AiStreamRequest> = {}): AiStreamRequest {
  return { runId: "r1", endpoint: LOCAL, messages: [{ role: "user", content: "hi" }], ...over };
}

/**
 * These cloud tests are about wire shape, headers and posture — not the authorisation
 * ladder — so they pin a level that permits network work. Without it they read the
 * developer's own `~/.prometheus/config/authorisation.json`, and the suite's result
 * depends on whose machine it runs on (it is `{"level": 1}` on the box this landed on,
 * which refused all five of them).
 */
const CLOUD_OK = { readAuthLevel: () => 7 } as const;

test("chatCompletionsUrl does not double a baseUrl that already ends in /v1", () => {
  assert.equal(
    chatCompletionsUrl("http://x/v1"),
    "http://x/v1/chat/completions",
    "a doubled /v1/v1 makes the runner answer 404 page not found",
  );
  assert.equal(chatCompletionsUrl("http://x"), "http://x/v1/chat/completions");
  assert.equal(chatCompletionsUrl("http://x/"), "http://x/v1/chat/completions");
});

test("parseSseChunk splits complete frames and keeps the partial tail", () => {
  const { payloads, rest } = parseSseChunk('data: {"a":1}\ndata: {"b":2}\ndata: {"c"');
  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, 'data: {"c"');
});

/**
 * Task #18: `probeServedModels` MOVED here from the renderer's `endpoint-hook.ts` — the
 * production CSP (`connect-src 'self'`) refused the renderer's own `fetch` to a local runner,
 * silently dropping every local model from the Model Hub picker in the packaged app. This is
 * the SAME probe logic, now exercised in MAIN via an injectable `doFetch` (exactly like
 * `runAiStream` above) instead of a live socket — the e2e half of this fix
 * (`e2e/model-probe.spec.ts`) is what proves the REAL network hop survives the REAL CSP; this
 * half pins the parsing/timeout/fail-soft behavior cheaply and offline.
 */
test("probeServedModels GETs {baseUrl}/models and returns the parsed ids", async () => {
  let requested: { url: string; method?: string } | undefined;
  const r = await probeServedModels("http://127.0.0.1:11434/v1/", async (url, init) => {
    requested = { url: String(url), method: init?.method };
    return new Response(JSON.stringify({ data: [{ id: "qwen3:latest" }, { id: "llama3" }] }), {
      status: 200,
    });
  });
  assert.deepEqual(r, { ok: true, models: ["qwen3:latest", "llama3"] });
  // a doubled slash (baseUrl already trailing-slashed) would 404 on a real runner.
  assert.equal(requested?.url, "http://127.0.0.1:11434/v1/models");
  assert.equal(requested?.method, "GET");
});

test("probeServedModels is fail-soft: a down/error runner is an empty list, not an ok:false", async () => {
  const down = await probeServedModels("http://127.0.0.1:1/v1", async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.deepEqual(down, { ok: true, models: [] });

  const notOk = await probeServedModels(
    "http://127.0.0.1:11434/v1",
    async () => new Response("nope", { status: 500 }),
  );
  assert.deepEqual(notOk, { ok: true, models: [] });
});

test("probeServedModels drops entries with no usable id and tolerates a malformed body", async () => {
  const r = await probeServedModels(
    "http://127.0.0.1:11434/v1",
    async () =>
      new Response(JSON.stringify({ data: [{ id: "real" }, {}, { id: "" }] }), { status: 200 }),
  );
  assert.deepEqual(r, { ok: true, models: ["real"] });

  const malformed = await probeServedModels(
    "http://127.0.0.1:11434/v1",
    async () => new Response("not json", { status: 200 }),
  );
  assert.deepEqual(malformed, { ok: true, models: [] });
});

test("text deltas stream AND the same bytes come back in the typed reply", async () => {
  const rec = recorder();
  const r = await runAiStream(req(), rec.sender as never, async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"He"}}]}\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n',
      "data: [DONE]\n",
    ]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.text, "Hello", "the reply is authoritative — a dropped delta must not lose text");
  assert.deepEqual(
    rec.events.filter((e) => e.kind === "text").map((e) => e.text),
    ["He", "llo"],
  );
});

test("reasoning is emitted as its own kind and never folded into the answer", async () => {
  const rec = recorder();
  const r = await runAiStream(req(), rec.sender as never, async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"reasoning":"thinking…"}}]}\n',
      'data: {"choices":[{"delta":{"reasoning_content":"more"}}]}\n',
      'data: {"choices":[{"delta":{"content":"42"}}]}\n',
      "data: [DONE]\n",
    ]),
  );
  assert.equal(r.text, "42");
  assert.deepEqual(
    rec.events.filter((e) => e.kind === "reasoning").map((e) => e.text),
    ["thinking…", "more"],
    "Ollama says `reasoning`, other servers `reasoning_content` — both must be read",
  );
});

test("tool-call fragments fold by index and survive a split arguments string", async () => {
  const r = await runAiStream(req(), undefined, async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}}]}\n',
      "data: [DONE]\n",
    ]),
  );
  assert.deepEqual(r.toolCalls, [{ id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }]);
});

test("a fragment with no function name is dropped (it can never be dispatched)", async () => {
  const r = await runAiStream(req(), undefined, async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n',
      "data: [DONE]\n",
    ]),
  );
  assert.deepEqual(r.toolCalls, []);
});

test("usage arriving on its own choice-less frame is captured", async () => {
  const r = await runAiStream(req(), undefined, async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"x"}}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n',
      "data: [DONE]\n",
    ]),
  );
  assert.deepEqual(r.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
});

test("usage sent BEFORE [DONE] still lands (some providers order it that way)", async () => {
  const r = await runAiStream(req(), undefined, async () =>
    sseResponse([
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":9}}\ndata: [DONE]\n',
    ]),
  );
  assert.equal(r.usage?.totalTokens, 9);
});

test("a frame split across reads is reassembled", async () => {
  const r = await runAiStream(req(), undefined, async () =>
    sseResponse(['data: {"choices":[{"delta":{"con', 'tent":"ok"}}]}\n', "data: [DONE]\n"]),
  );
  assert.equal(r.text, "ok");
});

test("the LAST frame is not lost when the server closes without a final newline", async () => {
  // Found by a scout on 2026-09-25. Core (`ai/client.ts`) and the CLI (`session/agent-runtime.ts`)
  // both drain `buf` after the read loop ends; this file did not — `if (streamDone) break;` left
  // whatever had not yet been terminated by a `\n` sitting in the buffer, unparsed.
  //
  // Loopback rarely produces that shape, which is why it survived. A REMOTE endpoint — over a
  // LAN, a proxy or an ssh tunnel — fragments differently and can end the body exactly on a
  // frame boundary, so the remote-compute work makes this far more likely to bite. What is lost
  // is the tail of the answer, or the tail of a tool call's arguments.
  const r = await runAiStream(req(), undefined, async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"first "}}]}\n',
      // no trailing newline, and no [DONE] — the server just closes.
      'data: {"choices":[{"delta":{"content":"LAST"}}]}',
    ]),
  );
  assert.equal(r.text, "first LAST", "the unterminated final frame must still be delivered");
});

test("a malformed / keepalive frame is skipped, not fatal", async () => {
  const r = await runAiStream(req(), undefined, async () =>
    sseResponse([
      "data: \n",
      "data: {not json\n",
      'data: {"choices":[{"delta":{"content":"still here"}}]}\n',
      "data: [DONE]\n",
    ]),
  );
  assert.equal(r.ok, true);
  assert.equal(r.text, "still here");
});

test("the CLOUD POLICY is refused HERE, before any request leaves (§7.5)", async () => {
  let called = false;
  const r = await runAiStream(
    req({
      endpoint: { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "cloud" },
      neverSendToCloud: true,
    }),
    undefined,
    async () => {
      called = true;
      return sseResponse(["data: [DONE]\n"]);
    },
  );
  assert.equal(called, false, "main is the enforcer — the renderer's check is a courtesy");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /never send to cloud/);
});

test("`keep_alive` goes to LOCAL endpoints only — a cloud provider never sees it", async () => {
  const bodies: Record<string, unknown>[] = [];
  const capture = async (_u: unknown, init: { body: string }): Promise<Response> => {
    bodies.push(JSON.parse(init.body));
    return sseResponse(["data: [DONE]\n"]);
  };
  await runAiStream(req(), undefined, capture as never);
  // A REAL cloud endpoint: a cloud URL, not merely a cloud label. The label used to be what
  // decided this, which is the defect the next test pins.
  await runAiStream(
    req({ endpoint: { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "cloud" } }),
    undefined,
    capture as never,
    undefined,
    CLOUD_OK,
  );
  // DEFAULT: a bounded 60s, not the old hardcoded "30m" which held model weights for half an
  // hour after the last prompt. Local gets the bound; cloud still gets nothing.
  assert.equal(bodies[0]?.keep_alive, "60s");
  assert.equal(bodies[1]?.keep_alive, undefined);
  assert.deepEqual(bodies[1]?.stream_options, { include_usage: true });

  // OVERRIDDEN: when the user pins a different value it still reaches LOCAL only — the
  // local/cloud split this test exists to protect is unchanged by the default becoming a bound.
  const prev = process.env.PROMETHEUS_LOCAL_KEEP_ALIVE;
  process.env.PROMETHEUS_LOCAL_KEEP_ALIVE = "9m";
  try {
    bodies.length = 0;
    await runAiStream(req(), undefined, capture as never);
    await runAiStream(
      req({ endpoint: { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "cloud" } }),
      undefined,
      capture as never,
      undefined,
      CLOUD_OK,
    );
    assert.equal(bodies[0]?.keep_alive, "9m");
    assert.equal(bodies[1]?.keep_alive, undefined, "a cloud provider received keep_alive");
  } finally {
    if (prev === undefined) delete process.env.PROMETHEUS_LOCAL_KEEP_ALIVE;
    else process.env.PROMETHEUS_LOCAL_KEEP_ALIVE = prev;
  }
});

test("the request is shaped by the URL, NOT by the renderer's `locality` label", async (t) => {
  /**
   * The comment above the derivation in ai-ipc.ts says the renderer's label is never trusted,
   * and the security decisions (cloud-allowed, egress, budget, wire format) did re-derive it.
   * Three request-SHAPING lines still read `req.endpoint.locality`, so a mislabelled endpoint
   * sent Ollama's non-standard `keep_alive` to a cloud provider — which answers an unknown
   * field with a 400 — and dropped the usage counters the billing view depends on.
   */
  const bodies: Record<string, unknown>[] = [];
  const capture = async (_u: unknown, init: { body: string }): Promise<Response> => {
    bodies.push(JSON.parse(init.body));
    return sseResponse(["data: [DONE]\n"]);
  };
  // Pin a value so the URL-vs-label decision is OBSERVABLE: with the default (send nothing)
  // both branches would be `undefined` and the test could not tell them apart.
  const prevKA = process.env.PROMETHEUS_LOCAL_KEEP_ALIVE;
  process.env.PROMETHEUS_LOCAL_KEEP_ALIVE = "9m";
  t.after(() => {
    if (prevKA === undefined) delete process.env.PROMETHEUS_LOCAL_KEEP_ALIVE;
    else process.env.PROMETHEUS_LOCAL_KEEP_ALIVE = prevKA;
  });

  // a LOCALHOST url mislabelled "cloud" — it is local, whatever the renderer says
  await runAiStream(
    req({ endpoint: { ...LOCAL, locality: "cloud" } }),
    undefined,
    capture as never,
  );
  assert.equal(bodies[0]?.keep_alive, "9m", "a localhost endpoint lost keep_alive to a label");
  assert.equal(bodies[0]?.stream_options, undefined);

  // a CLOUD url mislabelled "local" — it is cloud, and must not receive keep_alive
  await runAiStream(
    req({
      endpoint: { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "local" },
      neverSendToCloud: false,
    }),
    undefined,
    capture as never,
    undefined,
    CLOUD_OK,
  );
  assert.equal(
    bodies[1]?.keep_alive,
    undefined,
    "a cloud provider received Ollama's keep_alive because the renderer called it local",
  );
  assert.deepEqual(bodies[1]?.stream_options, { include_usage: true });
});

/**
 * The autostart gate itself is OPT-IN: `ensureOllamaRunningFn` is omitted by default, and
 * EVERY test above this point already proves that omission means no extra call ever happens
 * — each one drives an exact-call-count-sensitive mocked `doFetch` and none of them pass this
 * option, yet all pass. The two tests below cover the gate's actual behaviour when a caller
 * (production's one real call site) DOES opt in.
 */
test("ollama autostart fires for an ollama-port local endpoint when injected, with the endpoint's OWN model", async () => {
  let seenModelId: string | undefined = "not called";
  await runAiStream(
    req({ runId: "autostart-fires" }),
    undefined,
    async () => sseResponse(["data: [DONE]\n"]),
    undefined,
    {
      ensureOllamaRunningFn: async (opts) => {
        seenModelId = opts?.modelId;
        return { started: false };
      },
    },
  );
  assert.equal(seenModelId, LOCAL.model, "the already-picked model must never be silently swapped");
});

test("ollama autostart does NOT fire for a local endpoint on a different port (e.g. LM Studio)", async () => {
  let calls = 0;
  await runAiStream(
    req({
      runId: "autostart-wrong-port",
      endpoint: { ...LOCAL, baseUrl: "http://127.0.0.1:1234/v1" },
    }),
    undefined,
    async () => sseResponse(["data: [DONE]\n"]),
    undefined,
    {
      ensureOllamaRunningFn: async () => {
        calls += 1;
        return { started: false };
      },
    },
  );
  assert.equal(calls, 0, "the ollama-specific gate must never touch a non-ollama local runner");
  // Clean up the model this test just pinned into the module-level `residentModels` ledger —
  // "freeLocalModels unloads exactly the LOCAL models a run pinned" (below) asserts an EXACT
  // list, and this test's port-1234 endpoint is otherwise never used anywhere else in the file.
  await freeLocalModels(async () => ({ ok: true }) as Response);
});

test("lmstudio autostart fires for a port-1234 local endpoint when injected, exactly the way ollama's does", async () => {
  let seenModelId: string | undefined = "not called";
  await runAiStream(
    req({
      runId: "lmstudio-autostart-fires",
      endpoint: {
        ...LOCAL,
        baseUrl: "http://127.0.0.1:1234/v1",
        id: "lmstudio",
        model: "qwen2.5-coder",
      },
    }),
    undefined,
    async () => sseResponse(["data: [DONE]\n"]),
    undefined,
    {
      ensureLmStudioRunningFn: async (opts) => {
        seenModelId = opts?.modelId;
        return { started: false };
      },
    },
  );
  assert.equal(seenModelId, "qwen2.5-coder");
  await freeLocalModels(async () => ({ ok: true }) as Response);
});

test("lmstudio autostart does NOT fire for an ollama-port endpoint, and vice versa — never the wrong runner", async () => {
  let ollamaCalls = 0;
  let lmstudioCalls = 0;
  await runAiStream(
    req({ runId: "cross-runner-guard" }),
    undefined,
    async () => sseResponse(["data: [DONE]\n"]),
    undefined,
    {
      ensureOllamaRunningFn: async () => {
        ollamaCalls += 1;
        return { started: false };
      },
      ensureLmStudioRunningFn: async () => {
        lmstudioCalls += 1;
        return { started: false };
      },
    },
  );
  assert.equal(ollamaCalls, 1, "the ollama endpoint must still bring up ollama");
  assert.equal(lmstudioCalls, 0, "never LM Studio, for an ollama-port endpoint");
});

test("NEITHER autostart fires for an unmatched local endpoint (e.g. a vLLM port) — regression guard", async () => {
  // A prior version of the dispatch logic used a two-way ternary (ollama vs "everything else"),
  // which silently routed an UNMATCHED runner id (undefined — no LOCAL_RUNNERS entry owns this
  // port) into the Ollama branch. Neither must ever fire for a runner this app doesn't know.
  let ollamaCalls = 0;
  let lmstudioCalls = 0;
  await runAiStream(
    req({
      runId: "unmatched-runner-guard",
      endpoint: { ...LOCAL, baseUrl: "http://127.0.0.1:8000/v1", id: "vllm" },
    }),
    undefined,
    async () => sseResponse(["data: [DONE]\n"]),
    undefined,
    {
      ensureOllamaRunningFn: async () => {
        ollamaCalls += 1;
        return { started: false };
      },
      ensureLmStudioRunningFn: async () => {
        lmstudioCalls += 1;
        return { started: false };
      },
    },
  );
  assert.equal(ollamaCalls, 0);
  assert.equal(lmstudioCalls, 0);
  await freeLocalModels(async () => ({ ok: true }) as Response);
});

/* ── ACTIVE EVICTION: a runner Prometheus force-stopped under critical RAM pressure ────────*/

test("ACTIVE EVICTION: a resource-ceiling refusal PAUSES the turn without ever attempting the doomed request", async () => {
  let fetchCalled = false;
  const r = await runAiStream(
    req({ runId: "resource-ceiling" }),
    undefined,
    async () => {
      fetchCalled = true;
      return sseResponse(["data: [DONE]\n"]);
    },
    undefined,
    {
      ensureOllamaRunningFn: async () => ({
        started: false,
        reason: "resource-ceiling",
        resourceReason: "RAM at 96% ≥ 90% ceiling",
      }),
    },
  );
  assert.equal(
    fetchCalled,
    false,
    "a runner just refused a restart must never be asked to serve anyway",
  );
  assert.equal(r.ok, true);
  assert.equal(r.paused, true);
  assert.equal(r.pausedReason, "resources-critical");
  assert.equal(r.text, "");
  assert.deepEqual(r.toolCalls, []);
});

test("ACTIVE EVICTION: a connection failure matching a JUST-evicted runner pauses (resumable), not a red error", async () => {
  const fail = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const recentEvent: EvictionEvent = {
    id: "evt-1",
    runnerId: "ollama",
    name: "Ollama",
    ramPct: 97,
    ceiling: 95,
    at: new Date(Date.now() - 5_000).toISOString(), // 5s ago — well inside the recency window
    reason: "RAM at 97% ≥ 95% for 2 consecutive checks",
  };
  const r = await runAiStream(req({ runId: "mid-stream-evicted" }), undefined, fail, undefined, {
    sleep: async () => {},
    retries: 0,
    readEvictionEventsFn: () => [recentEvent],
  });
  assert.equal(r.ok, true, "an eviction-caused failure must never surface as ok:false");
  assert.equal(r.paused, true);
  assert.equal(r.pausedReason, "resources-critical");
});

test("ACTIVE EVICTION: a connection failure with NO matching recent eviction still reports the ordinary error (no false positives)", async () => {
  const fail = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await runAiStream(
    req({ runId: "mid-stream-not-evicted" }),
    undefined,
    fail,
    undefined,
    {
      sleep: async () => {},
      retries: 0,
      readEvictionEventsFn: () => [],
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.paused, undefined);
  assert.match(r.error ?? "", /ECONNREFUSED/);
});

test("ACTIVE EVICTION: a STALE eviction (outside the recency window) does not mask an unrelated failure", async () => {
  const fail = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const staleEvent: EvictionEvent = {
    id: "evt-old",
    runnerId: "ollama",
    name: "Ollama",
    ramPct: 97,
    ceiling: 95,
    at: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 minutes ago — long stale
    reason: "old news",
  };
  const r = await runAiStream(
    req({ runId: "mid-stream-stale-eviction" }),
    undefined,
    fail,
    undefined,
    {
      sleep: async () => {},
      retries: 0,
      readEvictionEventsFn: () => [staleEvent],
    },
  );
  assert.equal(
    r.ok,
    false,
    "a stale eviction from long ago must not paper over today's real failure",
  );
  assert.equal(r.paused, undefined);
});

test("a `tool` role is re-mapped to `user` on the wire", async () => {
  let sent: { messages: { role: string }[] } | undefined;
  await runAiStream(
    req({
      messages: [
        { role: "user", content: "a" },
        { role: "tool", content: "[tool_result read_file]" },
      ],
    }),
    undefined,
    (async (_u: unknown, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return sseResponse(["data: [DONE]\n"]);
    }) as never,
  );
  assert.deepEqual(
    sent?.messages.map((m) => m.role),
    ["user", "user"],
    "a strict endpoint rejects an unpaired role:'tool' with no tool_call_id",
  );
});

test("a non-ok HTTP status comes back as ok:false, not a throw", async () => {
  let attempts = 0;
  const r = await runAiStream(
    req(),
    undefined,
    async () => {
      attempts += 1;
      return sseResponse([], { ok: false, status: 503 });
    },
    undefined,
    { sleep: async () => {} },
  );
  assert.equal(r.ok, false);
  // It used to give up after ONE attempt and report the bare number `503`. A 5xx is the
  // provider saying "not now", which is exactly what a retry is for.
  assert.equal(attempts, 3, "a 5xx was not retried");
  assert.match(r.error ?? "", /server error \(503\)/);
});

test("a 4xx is NOT retried, and its BODY reaches the user", async () => {
  // Retrying a request the endpoint understood and rejected spends the user's money three
  // times for the same answer. The body used to be discarded entirely, so a 400 explaining
  // the problem arrived as the number 400.
  let attempts = 0;
  const r = await runAiStream(
    req(),
    undefined,
    async () => {
      attempts += 1;
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        body: null,
        text: async () => "max_tokens must be less than the context window",
        headers: { get: () => null },
      } as unknown as Response;
    },
    undefined,
    { sleep: async () => {} },
  );
  assert.equal(attempts, 1, "a 400 was retried");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /max_tokens must be less than/);
});

test("a rate limit honours the provider's Retry-After instead of our curve", async () => {
  const waits: number[] = [];
  let attempts = 0;
  await runAiStream(
    req(),
    undefined,
    async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          body: null,
          text: async () => "slow down",
          headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? "7" : null) },
        } as unknown as Response;
      }
      return sseResponse(["data: [DONE]\n"]);
    },
    undefined,
    {
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    },
  );
  assert.deepEqual(waits, [7000], "the provider said 7s and we did not listen");
});

test("tools are only sent when there are some", async () => {
  const bodies: Record<string, unknown>[] = [];
  const capture = (async (_u: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return sseResponse(["data: [DONE]\n"]);
  }) as never;
  const realTool = {
    type: "function",
    function: { name: "read_file", description: "read", parameters: { type: "object" } },
  };
  await runAiStream(req({ tools: [] }), undefined, capture);
  await runAiStream(req({ tools: [realTool] }), undefined, capture);
  // A MALFORMED entry (no `function`, so no name) is dropped rather than forwarded: it is a
  // 400 on every provider, and one bad tool must not cost the whole turn.
  await runAiStream(req({ tools: [{ type: "function" }] }), undefined, capture);
  assert.equal(bodies[0]?.tools, undefined);
  assert.equal(bodies[0]?.tool_choice, undefined);
  assert.equal(bodies[1]?.tool_choice, "auto");
  assert.equal(
    (bodies[1]?.tools as Array<{ function: { name: string } }>)[0]?.function.name,
    "read_file",
  );
  assert.equal(bodies[2]?.tools, undefined, "a nameless tool must not reach the wire");
});

/* ── the inactivity-pause watchdog (root causes #1/#6, verification pass #1's finding #8) ────
 *
 * This file had ZERO coverage for the idle-timeout/pause/orphan-guard path before this — exactly
 * what let a real bug (the pre-first-byte catch swallowing a pause/cancel as a hard failure) and
 * a missing `userSignal` ship undetected in an earlier round of this same work. A real-elapsed-
 * time × 1000 compressed clock lets these use a fully realistic, floor-respecting `idleTimeoutMs`
 * (30s) while actually firing in milliseconds of test time.
 */

function compressedClock(speedup: number) {
  const start = Date.now();
  return {
    now: () => start + (Date.now() - start) * speedup,
    setTimeoutFn: (cb: () => void, ms: number) => setTimeout(cb, ms / speedup),
    clearTimeoutFn: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  };
}

/** A stream that never produces a chunk — UNLESS aborted, mirroring how a real `fetch()`
 *  rejects a pending read the instant its request signal aborts. */
function hangingFetch(): typeof fetch {
  return (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
      pull() {
        return new Promise<void>(() => {
          /* never enqueue, never close on its own */
        });
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  }) as unknown as typeof fetch;
}

test("runAiStream: a connection whose body never produces a byte PAUSES (paused:true), not an indefinite hang", async () => {
  const clock = compressedClock(1000); // a real "30s" idle window fires in ~30ms of test time
  const started = Date.now();
  const r = await runAiStream(
    req({ idleTimeoutMs: 30_000 }),
    undefined,
    hangingFetch(),
    undefined,
    {
      sleep: async () => {},
      idleWatchdogNow: clock.now,
      idleWatchdogSetTimeout: clock.setTimeoutFn,
      idleWatchdogClearTimeout: clock.clearTimeoutFn,
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 2000,
    `expected a bounded pause well under 2s of real time, took ${elapsed}ms`,
  );
  assert.equal(r.ok, true, "a pause is not a failure");
  assert.equal(r.paused, true);
  assert.equal(r.text, "");
});

test("runAiStream: text streamed BEFORE going silent is kept when the turn pauses", async () => {
  const clock = compressedClock(1000);
  const sse = [
    'data: {"choices":[{"delta":{"content":"par"}}]}\n',
    'data: {"choices":[{"delta":{"content":"tial"}}]}\n',
  ];
  let call = 0;
  const doFetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    call += 1;
    // first attempt streams two chunks, then hangs forever (never [DONE]) until aborted.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of sse) controller.enqueue(enc.encode(f));
        init?.signal?.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
      pull() {
        return new Promise<void>(() => {
          /* never enqueue further, never close */
        });
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  }) as unknown as typeof fetch;
  const r = await runAiStream(req({ idleTimeoutMs: 30_000 }), undefined, doFetch, undefined, {
    sleep: async () => {},
    idleWatchdogNow: clock.now,
    idleWatchdogSetTimeout: clock.setTimeoutFn,
    idleWatchdogClearTimeout: clock.clearTimeoutFn,
  });
  assert.equal(call, 1, "an idle pause must not be retried as if it were a transient failure");
  assert.equal(r.paused, true);
  assert.equal(r.text, "partial", "text streamed before the pause must not be discarded");
});

test("runAiStream: a COMPLETE tool call streamed before the pause is not thrown away", async () => {
  // `text` was preserved on the idle-pause return and `toolCalls` was hardcoded `[]` right
  // beside it, so a turn that had already streamed a whole native call reported the prose and
  // silently dropped the call — while the pause line told the user no work was lost.
  const clock = compressedClock(1000);
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"/tmp/x\\"}"}}]}}]}\n',
  ];
  const doFetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(f));
        init?.signal?.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
      pull() {
        return new Promise<void>(() => {});
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  }) as unknown as typeof fetch;
  const r = await runAiStream(req({ idleTimeoutMs: 30_000 }), undefined, doFetch, undefined, {
    sleep: async () => {},
    idleWatchdogNow: clock.now,
    idleWatchdogSetTimeout: clock.setTimeoutFn,
    idleWatchdogClearTimeout: clock.clearTimeoutFn,
  });
  assert.equal(r.paused, true);
  assert.deepEqual(
    r.toolCalls.map((t) => t.name),
    ["read_file"],
    "a fully-formed tool call was dropped by the pause return",
  );
});

test("runAiStream: a tool call cut MID-ARGUMENTS by the pause is dropped, not half-run", async () => {
  // The other half of the same fix. Truncated arguments parse to `{}` downstream, and running
  // `write_file` with no arguments at all is a worse outcome than not running it.
  const clock = compressedClock(1000);
  const frames = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\\"path\\":\\"/tm"}}]}}]}\n',
  ];
  const doFetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) controller.enqueue(enc.encode(f));
        init?.signal?.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
      pull() {
        return new Promise<void>(() => {});
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  }) as unknown as typeof fetch;
  const r = await runAiStream(req({ idleTimeoutMs: 30_000 }), undefined, doFetch, undefined, {
    sleep: async () => {},
    idleWatchdogNow: clock.now,
    idleWatchdogSetTimeout: clock.setTimeoutFn,
    idleWatchdogClearTimeout: clock.clearTimeoutFn,
  });
  assert.equal(r.paused, true);
  assert.deepEqual(r.toolCalls, []);
});

test("runAiStream: a tools-shaped refusal is REPORTED so the renderer can fall back", async () => {
  // `looksLikeToolsRejection` has existed since the text protocol did and the desktop never
  // received the fact — only main can decide it (the status and body never cross the bridge),
  // so a tool-incapable endpoint failed every turn forever with the fallback one field away.
  const refuse = (async () =>
    ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: { get: () => null },
      text: async () => '{"error":{"message":"registry.ollama.ai does not support tools"}}',
    }) as unknown as Response) as unknown as typeof fetch;
  const r = await runAiStream(
    req({
      tools: [
        { type: "function", function: { name: "read_file", description: "d", parameters: {} } },
      ],
    }),
    undefined,
    refuse,
    undefined,
    { sleep: async () => {}, retries: 0 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.toolsRejected, true);
});

test("runAiStream: an unrelated 400 does NOT demote the endpoint", async () => {
  // The other half: a context overflow or a bad key has nothing to do with tool support, and
  // demoting on one would strand a capable model on the weaker transport for the session.
  const refuse = (async () =>
    ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: { get: () => null },
      text: async () => '{"error":{"message":"context length exceeded"}}',
    }) as unknown as Response) as unknown as typeof fetch;
  const r = await runAiStream(
    req({
      tools: [
        { type: "function", function: { name: "read_file", description: "d", parameters: {} } },
      ],
    }),
    undefined,
    refuse,
    undefined,
    { sleep: async () => {}, retries: 0 },
  );
  assert.equal(r.ok, false);
  assert.equal(r.toolsRejected, undefined);
});

/* ── the exit unload (§9c) ───────────────────────────────────────────────────*/

test("freeLocalModels unloads exactly the LOCAL models a run pinned", async () => {
  const posts: { url: string; body: unknown }[] = [];
  const capture = (async (url: string, init: { body: string }) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return { ok: true } as Response;
  }) as never;

  await runAiStream(req(), undefined, async () => sseResponse(["data: [DONE]\n"]));
  // A REAL cloud endpoint — a cloud URL. It used to be a localhost URL wearing a `"cloud"`
  // label, which only worked while the renderer's label was what decided locality.
  await runAiStream(
    req({
      endpoint: {
        ...LOCAL,
        model: "cloudy",
        baseUrl: "https://api.example.com/v1",
        locality: "cloud",
      },
    }),
    undefined,
    async () => sseResponse(["data: [DONE]\n"]),
  );

  await freeLocalModels(capture);
  assert.deepEqual(posts, [
    { url: "http://127.0.0.1:11434/api/generate", body: { model: "qwen", keep_alive: 0 } },
  ]);
});

test("freeLocalModels is idempotent — a second quit pass sends nothing", async () => {
  let calls = 0;
  const capture = (async () => {
    calls += 1;
    return { ok: true } as Response;
  }) as never;
  await runAiStream(req(), undefined, async () => sseResponse(["data: [DONE]\n"]));
  await freeLocalModels(capture);
  await freeLocalModels(capture);
  assert.equal(calls, 1);
});

test("freeLocalModels swallows an unreachable runner (quitting must never block)", async () => {
  await runAiStream(req(), undefined, async () => sseResponse(["data: [DONE]\n"]));
  await freeLocalModels((async () => {
    throw new Error("ECONNREFUSED");
  }) as never);
});

/* ── the security PROFILE is enforced here too, not just the checkbox ───────*/

/**
 * `cloudModelsEnabled` and `defaultNetwork` shipped in the settings schema, were set by the
 * `local-only` and `security-strict` profiles, and were read by NOTHING. Selecting "Local-only"
 * changed no behaviour whatsoever. These pin that the profile now stops a real request, in MAIN
 * — the renderer is the untrusted side, so a policy it evaluates for itself is a suggestion.
 */

/**
 * A CLOUD endpoint by its URL, not by its label.
 *
 * Main re-derives locality from the baseUrl it is about to POST to, so a fixture that merely
 * SAYS `locality: "cloud"` over `127.0.0.1` is local — which is the whole point of the check: the
 * label comes from the renderer and the URL is the fact.
 */
const CLOUD = { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "cloud" as const };

/** A fetch that records whether it was ever reached. */
function spyFetch(): { called: () => boolean; fetch: typeof fetch } {
  let called = false;
  return {
    called: () => called,
    fetch: (async () => {
      called = true;
      return sseResponse(["data: [DONE]\n"]);
    }) as unknown as typeof fetch,
  };
}

test("`cloudModelsEnabled: false` refuses a cloud endpoint before any request leaves", async () => {
  const spy = spyFetch();
  const r = await runAiStream(
    req({ endpoint: CLOUD }),
    undefined,
    spy.fetch,
    coreSettings.securityPosture({ cloudModelsEnabled: false }),
  );
  assert.equal(spy.called(), false, "a request left the machine under a local-only profile");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /cloudModelsEnabled/);
});

test("a session cannot UNTICK its way past the profile", async () => {
  // The per-session checkbox may add a restriction. It is not an escape hatch from the policy.
  const spy = spyFetch();
  const r = await runAiStream(
    req({ endpoint: CLOUD, neverSendToCloud: false }),
    undefined,
    spy.fetch,
    coreSettings.securityPosture({ cloudModelsEnabled: false }),
  );
  assert.equal(spy.called(), false);
  assert.equal(r.ok, false);
});

test('`defaultNetwork: "none"` refuses a cloud endpoint but still permits the local one', async () => {
  const posture = coreSettings.securityPosture({ defaultNetwork: "none" });
  const blocked = spyFetch();
  const r1 = await runAiStream(req({ endpoint: CLOUD }), undefined, blocked.fetch, posture);
  assert.equal(blocked.called(), false);
  assert.equal(r1.ok, false);
  assert.match(r1.error ?? "", /defaultNetwork/);

  // …and the profile must not brick the product: a LOCAL runner is not remote.
  const allowed = spyFetch();
  const r2 = await runAiStream(req(), undefined, allowed.fetch, posture);
  assert.equal(allowed.called(), true, "a local model was blocked by a no-network profile");
  assert.equal(r2.ok, true);
});

test("with no posture configured nothing changes — including cloud", async () => {
  // Turning enforcement on must be invisible to a user who never chose a profile.
  const spy = spyFetch();
  const r = await runAiStream(
    req({ endpoint: CLOUD }),
    undefined,
    spy.fetch,
    coreSettings.securityPosture(undefined),
    CLOUD_OK,
  );
  assert.equal(spy.called(), true);
  assert.equal(r.ok, true);
});

test("the module posture is adopted by setSecurityPosture and used as the default", async () => {
  // runAiStream's posture parameter defaults to the module-level one, which is what the real
  // IPC handler relies on — a test that only ever passes the parameter would miss that wiring.
  setSecurityPosture({ cloudModelsEnabled: false });
  try {
    assert.equal(getSecurityPosture().allowCloud, false);
    const spy = spyFetch();
    const r = await runAiStream(req({ endpoint: CLOUD }), undefined, spy.fetch);
    assert.equal(spy.called(), false, "the module posture was not consulted");
    assert.equal(r.ok, false);
  } finally {
    setSecurityPosture(undefined); // the store is a module singleton — leave it permissive
  }
});

test("a MISLABELLED endpoint cannot walk past the policy", async () => {
  // The enforcement point must not take its deciding fact from the process it is guarding.
  // `locality` arrives on the raw renderer arg; a renderer defect, injected script, or an
  // extension holding the bridge could send `locality:"local"` on a cloud URL. Main re-derives
  // it from the URL it is about to POST to.
  const spy = spyFetch();
  const r = await runAiStream(
    req({ endpoint: { ...LOCAL, baseUrl: "https://api.openai.com/v1", locality: "local" } }),
    undefined,
    spy.fetch,
    coreSettings.securityPosture({ cloudModelsEnabled: false }),
  );
  assert.equal(spy.called(), false, "a mislabelled cloud endpoint was contacted");
  assert.equal(r.ok, false);
});

test("localityOfUrl treats anything it cannot resolve as CLOUD", () => {
  // "I could not tell" must never resolve to "allowed".
  assert.equal(localityOfUrl("http://127.0.0.1:11434/v1"), "local");
  assert.equal(localityOfUrl("http://localhost:1234"), "local");
  assert.equal(localityOfUrl("http://[::1]:8080"), "local");
  assert.equal(localityOfUrl("http://box.local/v1"), "local");
  assert.equal(localityOfUrl("https://api.openai.com/v1"), "cloud");
  assert.equal(localityOfUrl("not a url at all"), "cloud");
  assert.equal(localityOfUrl(""), "cloud");
});

/* ── cloud authentication (the desktop had none at all) ──────────────────────*/

test("a cloud endpoint with a configured key gets an Authorization header", async () => {
  // `Authorization` appeared nowhere in any desktop model transport. The picker listed eleven
  // cloud base URLs from the engine and every one of them answered 401.
  const prev = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "sk-test-key";
  try {
    let seen: Record<string, string> | undefined;
    await runAiStream(
      req({ endpoint: { id: "cloud:groq", baseUrl: "https://api.groq.com/openai/v1" } }),
      undefined,
      (async (_u: unknown, init: { headers: Record<string, string> }) => {
        seen = init.headers;
        return sseResponse(["data: [DONE]\n"]);
      }) as never,
      { allowCloud: true, network: "allow", minGateMode: "off", allowForce: false },
      CLOUD_OK,
    );
    assert.equal(seen?.authorization, "Bearer sk-test-key");
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "GROQ_API_KEY");
    else process.env.GROQ_API_KEY = prev;
  }
});

test("a cloud endpoint with NO key is refused with an actionable message, not a 401", async () => {
  // An unauthenticated request would come back 401 seconds later and read as "the model is
  // broken" rather than "you have not configured it".
  const prev = process.env.GROQ_API_KEY;
  Reflect.deleteProperty(process.env, "GROQ_API_KEY");
  let called = 0;
  try {
    const r = await runAiStream(
      req({ endpoint: { id: "cloud:groq", baseUrl: "https://api.groq.com/openai/v1" } }),
      undefined,
      (async () => {
        called += 1;
        return sseResponse(["data: [DONE]\n"]);
      }) as never,
      { allowCloud: true, network: "allow", minGateMode: "off", allowForce: false },
      CLOUD_OK,
    );
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /prometheus provider connect groq|GROQ_API_KEY/);
    assert.equal(called, 0, "an unauthenticated request left the machine");
  } finally {
    if (prev !== undefined) process.env.GROQ_API_KEY = prev;
  }
});

test("a LOCAL endpoint is untouched — no key is looked up and none is needed", async () => {
  let seen: Record<string, string> | undefined;
  await runAiStream(req(), undefined, (async (
    _u: unknown,
    init: { headers: Record<string, string> },
  ) => {
    seen = init.headers;
    return sseResponse(["data: [DONE]\n"]);
  }) as never);
  assert.equal(seen?.authorization, undefined);
});

/* ── ai:probeEndpoint — MEASURE a local model instead of guessing at it ──────*/

test("probeEndpointCapabilities: returns the runner's window AND its capability array", async () => {
  // The capability array is the whole point: `ai/effort/rules.ts` resolves `/think` through
  // rules that match a PROBED capability ahead of any model-name guess, and Studio had no path
  // to this data at all — so every local model fell through to `UNKNOWN_CAPABILITY` and the
  // effort chip reported "not available", including for models that advertise `thinking`.
  const doFetch = (async (url: string) => ({
    ok: url.endsWith("/api/show"),
    json: async () => ({
      model_info: { "qwen3moe.context_length": 262144 },
      capabilities: ["completion", "vision", "tools", "thinking"],
      modified_at: "2026-07-24T05:25:11Z",
    }),
  })) as unknown as typeof fetch;
  const r = await probeEndpointCapabilities("http://127.0.0.1:11434/v1", "qwen3.6:latest", doFetch);
  assert.equal(r.ok, true);
  assert.equal(r.source, "ollama");
  assert.equal(r.contextWindow, 262144);
  assert.deepEqual(r.capabilities, ["completion", "vision", "tools", "thinking"]);
  assert.equal(r.revision, "2026-07-24T05:25:11Z");
});

test("probeEndpointCapabilities: a failed probe says `default` — never a fake 8192 measurement", async () => {
  // `source:"default"` is the difference between "this model has an 8k window" and "I could
  // not measure it". A caller that cannot tell those apart will present the floor as a fact.
  const dead = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const r = await probeEndpointCapabilities("http://127.0.0.1:1/v1", "m", dead);
  assert.equal(r.source, "default");
  assert.equal(r.capabilities, undefined);
});

test("probeEndpointCapabilities: an unrecognised payload is a failure, not a guess", async () => {
  const doFetch = (async () => ({
    ok: true,
    json: async () => ({ surprise: true }),
  })) as unknown as typeof fetch;
  const r = await probeEndpointCapabilities("http://127.0.0.1:11434/v1", "m", doFetch);
  assert.equal(r.source, "default");
});

/* ── inline <think> must not arrive as the answer (P4) ──────────────────────*/

/** One SSE content delta. */
function contentDelta(t: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
}

test("an R1-style model's inline thinking is split out of the AUTHORITATIVE text", async () => {
  // `text` is what the invoke returns and what the agent loop acts on — hiding the thinking
  // only in the presentational feed would leave it in the answer. The tag is resolved from the
  // model NAME (`deepseek-r1` carries `reasoningTag: "think"` in the capability table).
  const events: AiProgressEvent[] = [];
  // `isDestroyed` is not optional: `emit` guards on it, and a stub without it makes every
  // send throw and the whole turn return `ok:false` with empty text.
  const sender = {
    isDestroyed: () => false,
    send: (_c: string, e: AiProgressEvent) => events.push(e),
  } as never;
  const doFetch = (async () =>
    sseResponse([
      contentDelta("<thi"),
      contentDelta("nk>weighing it up</think>"),
      contentDelta("The answer is 4."),
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;

  const res = await runAiStream(
    {
      runId: "r1",
      endpoint: { id: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "deepseek-r1:8b" },
      messages: [{ role: "user", content: "2+2" }],
    } as unknown as AiStreamRequest,
    sender,
    doFetch,
  );

  assert.equal(res.text, "The answer is 4.", "the deliberation leaked into the answer");
  const thinking = events
    .filter((e) => e.kind === "reasoning")
    .map((e) => e.text)
    .join("");
  assert.equal(thinking, "weighing it up");
});

test("a model with NO reasoning tag streams byte-identically — the no-regression case", async () => {
  const doFetch = (async () =>
    sseResponse([
      contentDelta("plain <think>not special</think> answer"),
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
  const res = await runAiStream(
    {
      runId: "r2",
      endpoint: { id: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:12b" },
      messages: [{ role: "user", content: "hi" }],
    } as unknown as AiStreamRequest,
    undefined,
    doFetch,
  );
  assert.equal(res.text, "plain <think>not special</think> answer");
});

test("an UNTERMINATED thought never becomes the answer", async () => {
  const doFetch = (async () =>
    sseResponse([
      contentDelta("<think>I was cut off"),
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;
  const res = await runAiStream(
    {
      runId: "r3",
      endpoint: { id: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "deepseek-r1:8b" },
      messages: [{ role: "user", content: "x" }],
    } as unknown as AiStreamRequest,
    undefined,
    doFetch,
  );
  // The thought is still not the answer — and the turn now SAYS it produced no answer, rather
  // than handing the pane an empty string it silently drops (the 2026-09-24 incident).
  assert.doesNotMatch(res.text, /I was cut off/);
  assert.match(res.text, /only reasoning this turn/);
});

/* ── V0: the probe cache (four hook consumers, one request) ─────────────────*/

test("repeat probes for the same model make ONE request — four panes, one POST", () => {
  // AgentPane, two EditorPane surfaces and DatabasePanel each call `useActiveEndpoint` with
  // their own hook state, so every model switch used to fire four identical `/api/show` POSTs.
  // The CLI never had this problem because its probe owns a cache; main had none.
  resetProbeCache();
  let calls = 0;
  const doFetch = (async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({
        model_info: { "qwen3moe.context_length": 262144 },
        capabilities: ["completion", "tools", "thinking"],
        modified_at: "t",
      }),
    };
  }) as unknown as typeof fetch;

  return Promise.all(
    Array.from({ length: 4 }, () =>
      probeEndpointCapabilities("http://127.0.0.1:11434/v1", "qwen3.6:latest", doFetch),
    ),
  ).then((results) => {
    for (const r of results) assert.equal(r.contextWindow, 262144);
    assert.equal(probeRequestCount(), 1, "four callers must share one probe");
    // One probe now asks TWO questions: /api/show (what the weights allow) and /api/ps (what
    // the daemon actually serves). Four callers must still share that one probe.
    assert.ok(calls <= 2, `and one probe's worth of fetches, got ${calls}`);
  });
});

test("the cache is keyed on the MODEL — one daemon serves many", async () => {
  resetProbeCache();
  const doFetch = (async (_u: string, init?: { body?: string }) => {
    const model = JSON.parse(init?.body ?? "{}").model as string;
    return {
      ok: true,
      json: async () => ({
        model_info: { "x.context_length": model === "gemma4:12b" ? 8192 : 262144 },
        modified_at: "t",
      }),
    };
  }) as unknown as typeof fetch;
  const a = await probeEndpointCapabilities("http://127.0.0.1:11434/v1", "qwen3.6:latest", doFetch);
  const b = await probeEndpointCapabilities("http://127.0.0.1:11434/v1", "gemma4:12b", doFetch);
  assert.equal(a.contextWindow, 262144);
  assert.equal(b.contextWindow, 8192, "the second model got the first model's answer");
});

test("a FAILURE is not cached — a runner that was still booting must be re-askable", async () => {
  resetProbeCache();
  let payload: unknown = { nothing: "useful" };
  const doFetch = (async () => ({
    ok: true,
    json: async () => payload,
  })) as unknown as typeof fetch;
  const first = await probeEndpointCapabilities("http://127.0.0.1:11434/v1", "m", doFetch);
  assert.equal(first.source, "default");
  payload = { model_info: { "x.context_length": 32768 }, modified_at: "t" };
  const second = await probeEndpointCapabilities("http://127.0.0.1:11434/v1", "m", doFetch);
  assert.equal(second.contextWindow, 32768, "a cached failure would have pinned this");
  assert.equal(probeRequestCount(), 2);
});

test("a 200 that is NOT an SSE stream still yields the answer, not silence", async () => {
  /**
   * Plenty of OpenAI-compatible servers, proxies and gateways ignore `stream: true` and reply
   * with an ordinary JSON completion. The reader looks only for `data:` lines, finds none, and
   * the turn ends with no text, no usage and no error — a completely silent reply,
   * indistinguishable to the user from the model declining to answer.
   *
   * Core's shared client was fixed the same way in an earlier round; this transport is the
   * desktop's OWN copy and had the identical hole. Verified through the real `ai:stream` handler
   * against a live node:http server before and after.
   */
  const rec = recorder();
  const body = JSON.stringify({
    choices: [{ index: 0, message: { role: "assistant", content: "The answer is 42." } }],
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
  });
  const r = await runAiStream(
    req(),
    rec.sender as never,
    async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  );
  assert.equal(r.ok, true, `a non-SSE 200 was treated as a failure: ${r.error}`);
  assert.equal(r.text, "The answer is 42.", "the answer was silently discarded");
  assert.equal(r.usage?.inputTokens, 11, "usage from a non-streamed reply was dropped too");
  assert.equal(r.usage?.outputTokens, 5);

  // …and a 200 whose body carries nothing readable is an ERROR, not silence.
  const empty = await runAiStream(
    req(),
    rec.sender as never,
    async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  );
  assert.equal(empty.ok, false);
  assert.match(empty.error ?? "", /no readable content/);
});

/* ── the authorisation ladder as a THIRD policy floor (handoff_3 §3) ─────────────── */

test("a cloud endpoint is REFUSED below the network rung, before anything leaves", async () => {
  // The Model Hub greys cloud rows below A5 and labels them "key in keychain · A5+ only".
  // Nothing enforced it: CLOUD_MIN_AUTH drove an opacity and a note string and had no
  // reader outside that view, so a user at A0 reached the cloud exactly as easily as one
  // at A7. This is the check that makes the label true.
  let called = false;
  const r = await runAiStream(
    req({
      endpoint: { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "cloud" },
      neverSendToCloud: false,
    }),
    undefined,
    async () => {
      called = true;
      return sseResponse(["data: [DONE]\n"]);
    },
    { allowCloud: true, network: "allow", minGateMode: "off", allowForce: false },
    { readAuthLevel: () => 1 },
  );
  assert.equal(called, false, "the request left the machine below the network rung");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /authorisation A1 is below A5/);
});

test("the ladder gate is decided by the URL, not the renderer's locality label", async () => {
  // Same lesson the posture checks learned: a `locality:"local"` label on a cloud URL must
  // not walk past the gate.
  let called = false;
  const r = await runAiStream(
    req({
      endpoint: { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "local" },
      neverSendToCloud: false,
    }),
    undefined,
    async () => {
      called = true;
      return sseResponse(["data: [DONE]\n"]);
    },
    { allowCloud: true, network: "allow", minGateMode: "off", allowForce: false },
    { readAuthLevel: () => 0 },
  );
  assert.equal(called, false);
  assert.equal(r.ok, false);
});

test("at or above the network rung the cloud request proceeds", async () => {
  for (const level of [5, 6, 7]) {
    let called = false;
    const r = await runAiStream(
      req({
        endpoint: { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "cloud" },
        neverSendToCloud: false,
      }),
      undefined,
      async () => {
        called = true;
        return sseResponse(["data: [DONE]\n"]);
      },
      { allowCloud: true, network: "allow", minGateMode: "off", allowForce: false },
      { readAuthLevel: () => level },
    );
    assert.equal(called, true, `A${level} should reach the network`);
    assert.equal(r.ok, true);
  }
});

test("a LOCAL endpoint is never touched by the ladder gate", async () => {
  // `local-only` has to stay a usable profile: A0 must still reach a local runner.
  let called = false;
  const r = await runAiStream(
    req(),
    undefined,
    async () => {
      called = true;
      return sseResponse(["data: [DONE]\n"]);
    },
    undefined,
    { readAuthLevel: () => 0 },
  );
  assert.equal(called, true);
  assert.equal(r.ok, true);
});

test("an unreadable auth store falls back to the ladder's own default, not to open", () => {
  // DEFAULT_AUTH_LEVEL is 1, which is BELOW the network rung — so "we could not read your
  // level" must behave like a low level, never like a permissive one.
  assert.ok(DEFAULT_AUTH_LEVEL < NETWORK_AUTH_LEVEL);
});

test("a session posture can TIGHTEN the cloud gate but never loosen it", async () => {
  // The GUI's `plan` posture drives the level to 0 without writing the file (mode->level is
  // lossy, so persisting it would overwrite an explicit /authorisation 7). Main reads only
  // the file, so before this a read-only posture still shipped conversations to the cloud.
  const cloud = {
    endpoint: { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "cloud" as const },
    neverSendToCloud: false,
  };
  const posture = { allowCloud: true, network: "allow", minGateMode: "off", allowForce: false };

  // disk A7, session A0 (plan) -> REFUSED
  let called = false;
  const tightened = await runAiStream(
    req({ ...cloud, sessionAuthLevel: 0 }),
    undefined,
    async () => {
      called = true;
      return sseResponse(["data: [DONE]\n"]);
    },
    posture,
    { readAuthLevel: () => 7 },
  );
  assert.equal(called, false, "a plan posture must not reach the network");
  assert.equal(tightened.ok, false);
  assert.match(tightened.error ?? "", /authorisation A0 is below A5/);

  // disk A1, session A7 -> still REFUSED; the renderer cannot raise the ceiling
  called = false;
  const forged = await runAiStream(
    req({ ...cloud, sessionAuthLevel: 7 }),
    undefined,
    async () => {
      called = true;
      return sseResponse(["data: [DONE]\n"]);
    },
    posture,
    { readAuthLevel: () => 1 },
  );
  assert.equal(called, false, "a renderer-supplied level raised the ceiling");
  assert.equal(forged.ok, false);
  assert.match(forged.error ?? "", /authorisation A1 is below A5/);
});

test("no sessionAuthLevel behaves exactly as before", async () => {
  let called = false;
  const r = await runAiStream(
    req({
      endpoint: { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "cloud" as const },
      neverSendToCloud: false,
    }),
    undefined,
    async () => {
      called = true;
      return sseResponse(["data: [DONE]\n"]);
    },
    { allowCloud: true, network: "allow", minGateMode: "off", allowForce: false },
    { readAuthLevel: () => 6 },
  );
  assert.equal(called, true);
  assert.equal(r.ok, true);
});
