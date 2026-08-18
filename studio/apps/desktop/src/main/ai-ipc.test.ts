/**
 * ai-ipc.test.ts — model streaming in MAIN (§9c).
 *
 * The behaviour worth pinning is mostly about what MUST NOT depend on the delta feed: a
 * dropped `ai:progress` message is cosmetic, so the tool calls, the usage and the final
 * text all have to come back in the typed reply. And the cloud policy has to be refused
 * HERE, not merely in the renderer, or the enforcement is advisory.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { settings as coreSettings } from "@prometheus/core";
import type { AiProgressEvent, AiStreamRequest } from "../shared/ipc-contract.js";

import {
  chatCompletionsUrl,
  freeLocalModels,
  getSecurityPosture,
  localityOfUrl,
  parseSseChunk,
  probeServedModels,
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
  );
  assert.equal(bodies[0]?.keep_alive, "30m");
  assert.equal(bodies[1]?.keep_alive, undefined);
  assert.deepEqual(bodies[1]?.stream_options, { include_usage: true });
});

test("the request is shaped by the URL, NOT by the renderer's `locality` label", async () => {
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
  // a LOCALHOST url mislabelled "cloud" — it is local, whatever the renderer says
  await runAiStream(
    req({ endpoint: { ...LOCAL, locality: "cloud" } }),
    undefined,
    capture as never,
  );
  assert.equal(bodies[0]?.keep_alive, "30m", "a localhost endpoint lost keep_alive to a label");
  assert.equal(bodies[0]?.stream_options, undefined);

  // a CLOUD url mislabelled "local" — it is cloud, and must not receive keep_alive
  await runAiStream(
    req({
      endpoint: { ...LOCAL, baseUrl: "https://api.example.com/v1", locality: "local" },
      neverSendToCloud: false,
    }),
    undefined,
    capture as never,
  );
  assert.equal(
    bodies[1]?.keep_alive,
    undefined,
    "a cloud provider received Ollama's keep_alive because the renderer called it local",
  );
  assert.deepEqual(bodies[1]?.stream_options, { include_usage: true });
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
