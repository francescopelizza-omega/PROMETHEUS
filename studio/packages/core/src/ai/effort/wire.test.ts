/**
 * wire.test.ts — the tier actually reaches the SOCKET, in each provider's own dialect.
 *
 * The gap this closes, named by an audit: every other effort test drives the pure resolver in
 * isolation, so `applyEffort` could be deleted from `ai/client.ts` and the entire `packages/`
 * tree stayed green. A resolver can be perfect while nothing calls it — the exact shape of
 * "the setting looks implemented and isn't" that this repo keeps finding.
 *
 * Method: a real `node:http` server on 127.0.0.1 records the bytes. The endpoint keeps the REAL
 * provider base URL — `runtimeFromBaseUrl` matches on hostname, and a localhost URL would
 * silently select the OpenAI wire and never exercise the Anthropic path at all — and an
 * injected `fetch` rewrites only the origin. No cloud host is contacted and no key is used.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import { createAiClient } from "../client.js";
import { resolveEffort } from "./apply.js";
import { resolveCapability, runtimeFromBaseUrl } from "./rules.js";
import type { EffortTier } from "./types.js";

/** Bodies the current case received, newest last. */
const received: Record<string, unknown>[] = [];

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    try {
      received.push(JSON.parse(raw));
    } catch {
      received.push({ __unparseable: raw });
    }
    // One terminal SSE frame is enough: every assertion here is about the REQUEST.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((r) => {
  server.listen(0, "127.0.0.1", () => r());
});
const port = (server.address() as AddressInfo).port;
after(() => {
  server.close();
});

/**
 * Forward every request to the local recorder, rewriting ONLY the origin.
 *
 * The assertion in the middle is not decoration. The first version of this file passed the
 * fetch seam in the wrong ARGUMENT SLOT (`createAiClient(endpoint, policy, deps)` takes three),
 * so `deps` was empty, the client used the global fetch, and the run put a real request on the
 * wire to api.anthropic.com — which answered 401. A test that reaches the internet when its
 * injection is mis-wired is worse than no test, so the seam now fails LOUDLY instead: if this
 * function is ever bypassed the request goes out un-rewritten and nothing here would notice,
 * but if it IS called it can only ever talk to loopback.
 */
const localFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  url.protocol = "http:";
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return fetch(url, init);
}) as typeof fetch;

/**
 * A global-fetch tripwire for the duration of this file.
 *
 * Belt to the seam's braces: anything that slips past the injected fetch throws here instead of
 * reaching a provider. Restored in `after`.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(href).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`wire.test.ts tried to reach ${host} — the fetch seam is not wired`);
  }
  return realFetch(input as never, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

function endpointFor(baseUrl: string, model: string): Record<string, unknown> {
  return {
    id: model,
    baseUrl,
    model,
    locality: "cloud",
    contextWindow: 200_000,
    supportsTools: false,
  };
}

async function drive(
  baseUrl: string,
  model: string,
  tier?: EffortTier,
): Promise<Record<string, unknown>> {
  received.length = 0;
  // THREE arguments: (endpoint, policy, deps). The fetch seam lives in `deps` — putting it in
  // the policy slot is what let the first version of this file hit the real network.
  const client = createAiClient(
    endpointFor(baseUrl, model) as never,
    { neverSendToCloud: false },
    { fetch: localFetch, resolveKey: async () => "test-key-not-a-real-one" },
  );
  const opts =
    tier === undefined
      ? {}
      : {
          effort: resolveEffort(
            tier,
            resolveCapability({
              modelId: model,
              runtime: runtimeFromBaseUrl(baseUrl, "cloud"),
              locality: "cloud",
            }).cap,
          ),
        };
  for await (const _chunk of client.chat([{ role: "user", content: "ping" }], opts)) {
    /* drain */
  }
  const body = received[0];
  assert.ok(body, "the server received nothing — the request never left the client");
  return body;
}

test("Anthropic: the tier lands in output_config.effort, xhigh included", async () => {
  const b = await drive("https://api.anthropic.com", "claude-opus-5", "xhigh");
  assert.deepEqual(b.output_config, { effort: "xhigh" });
  const clamped = await drive("https://api.anthropic.com", "claude-opus-5", "ultra");
  assert.deepEqual(
    clamped.output_config,
    { effort: "xhigh" },
    "ultra is not an Anthropic value — it must arrive clamped, not verbatim",
  );
});

test("OpenAI: the tier lands in reasoning_effort, xhigh and max included", async () => {
  assert.equal(
    (await drive("https://api.openai.com/v1", "gpt-5.5", "xhigh")).reasoning_effort,
    "xhigh",
  );
  assert.equal(
    (await drive("https://api.openai.com/v1", "gpt-5.5", "max")).reasoning_effort,
    "max",
  );
  // the conservative o-series clamps rather than posting a value it may reject
  assert.equal((await drive("https://api.openai.com/v1", "o3", "max")).reasoning_effort, "high");
});

test("a model with NO reasoning knob gets no effort field at all", async () => {
  const b = await drive("https://api.openai.com/v1", "gpt-4o", "max");
  assert.equal("reasoning_effort" in b, false, "reasoning_effort is a hard 400 on GPT-4-class");
  assert.equal("output_config" in b, false);
});

test("no tier means no field — an unset effort must not invent one", async () => {
  const b = await drive("https://api.openai.com/v1", "gpt-5.5");
  assert.equal("reasoning_effort" in b, false);
});
