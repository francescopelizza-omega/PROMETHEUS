/**
 * free-rotation.test.ts — the endless free model: rotate on quota, never on a stream, never leak.
 *
 * Every test drives `createRotatingFetch` with a canned fetch — no network, no daemon.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createAiClient } from "./client.js";
import type { FetchLike } from "./client.js";
import {
  BAD_REQUEST_STRIKES,
  MIN_MEMBER_CONTEXT,
  ROTATION_BASE_URL,
  type RotationMember,
  cooldownMs,
  createRotatingFetch,
  createRotationState,
  isRotatableStatus,
  onRotationEvent,
  rotationEndpoint,
  rotationMembers,
  rotationStatus,
} from "./free-rotation.js";

type Call = { url: string; headers: Record<string, string>; body: string };

function response(status: number, text = "", headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    body: null,
    text: async () => text,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  };
}

/** A fetch that answers by host, recording every call. */
function fakeFetch(byHost: Record<string, number | (() => never)>, calls: Call[]): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const host = new URL(url).hostname;
    const answer = byHost[host];
    if (typeof answer === "function") return answer();
    return response(answer ?? 599, `from ${host}`);
  };
}

const member = (id: string, host: string, over: Partial<RotationMember> = {}): RotationMember => ({
  id: `${id}:m-${id}`,
  providerId: id,
  label: id,
  baseUrl: `https://${host}/v1`,
  model: `m-${id}`,
  apiKeyRef: `keychain:provider:${id}`,
  contextWindow: 131_072,
  ...over,
});

const keys = async (ref: string): Promise<string> => `KEY(${ref})`;
const init = (body: object = { model: "free-rotation", messages: [] }) => ({
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer " },
  body: JSON.stringify(body),
});

test("a non-rotation URL passes straight through, untouched", async () => {
  const calls: Call[] = [];
  const f = createRotatingFetch(fakeFetch({ "api.example.com": 200 }, calls), {
    members: [member("a", "a.test")],
    state: createRotationState(),
  });
  const res = await f("https://api.example.com/v1/chat/completions", init());
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.example.com/v1/chat/completions");
});

test("rewrites URL, key and model for the member that serves", async () => {
  const calls: Call[] = [];
  const f = createRotatingFetch(fakeFetch({ "a.test": 200 }, calls), {
    members: [member("a", "a.test")],
    resolveKey: keys,
    state: createRotationState(),
  });
  const res = await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(res.ok, true);
  assert.equal(calls[0]?.url, "https://a.test/v1/chat/completions");
  assert.equal(calls[0]?.headers.authorization, "Bearer KEY(keychain:provider:a)");
  assert.equal(JSON.parse(calls[0]?.body ?? "{}").model, "m-a");
});

test("429 on the first member → the same request goes to the next, at once", async () => {
  const calls: Call[] = [];
  const state = createRotationState();
  const f = createRotatingFetch(fakeFetch({ "a.test": 429, "b.test": 200 }, calls), {
    members: [member("a", "a.test"), member("b", "b.test")],
    resolveKey: keys,
    state,
    now: () => 1_000_000,
  });
  const res = await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(res.status, 200);
  assert.deepEqual(
    calls.map((c) => new URL(c.url).hostname),
    ["a.test", "b.test"],
  );
  // a is now cooling, so the NEXT request skips it entirely
  calls.length = 0;
  await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.deepEqual(
    calls.map((c) => new URL(c.url).hostname),
    ["b.test"],
  );
  const st = rotationStatus([member("a", "a.test"), member("b", "b.test")], state, 1_000_000);
  assert.equal(st[0]?.ready, false);
  assert.equal(st[1]?.serving, true);
});

test("a member's cooldown ends and it is tried first again (priority order)", async () => {
  const calls: Call[] = [];
  let t = 0;
  const hosts: Record<string, number> = { "a.test": 429, "b.test": 200 };
  const f = createRotatingFetch(fakeFetch(hosts, calls), {
    members: [member("a", "a.test"), member("b", "b.test")],
    resolveKey: keys,
    state: createRotationState(),
    now: () => t,
  });
  await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  hosts["a.test"] = 200;
  t += 61_000; // first 429 strike = 1 minute
  calls.length = 0;
  await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(new URL(calls[0]?.url ?? "").hostname, "a.test");
});

test("Retry-After from the provider sets the cooldown exactly", () => {
  assert.equal(cooldownMs(429, 90_000, 1), 90_000);
  assert.equal(cooldownMs(429, undefined, 1), 60_000);
  assert.equal(cooldownMs(429, undefined, 3), 240_000);
  assert.equal(cooldownMs(429, undefined, 50), 3_600_000, "escalation caps at an hour");
  assert.equal(cooldownMs(401, undefined, 0), 3_600_000);
  assert.equal(cooldownMs(503, undefined, 0), 15_000);
  assert.equal(cooldownMs(403, undefined, 0), 600_000, "403 is request-shaped, not account-wide");
});

test("every member cooling → one synthetic 429 with Retry-After, no network", async () => {
  const calls: Call[] = [];
  const f = createRotatingFetch(fakeFetch({ "a.test": 429, "b.test": 429 }, calls), {
    members: [member("a", "a.test"), member("b", "b.test")],
    resolveKey: keys,
    state: createRotationState(),
    now: () => 0,
  });
  const first = await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(first.status, 429, "both refused: the last refusal is returned");
  calls.length = 0;
  const second = await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(second.status, 429);
  assert.equal(calls.length, 0, "nothing was sent while every member cools");
  assert.equal(second.headers?.get("retry-after"), "60");
  assert.match(await second.text(), /every free provider/);
});

test("a non-rotatable status is returned as-is (no pointless fan-out)", async () => {
  assert.equal(isRotatableStatus(429), true);
  assert.equal(isRotatableStatus(500), true);
  assert.equal(isRotatableStatus(400), true);
  assert.equal(isRotatableStatus(304), false);
  const calls: Call[] = [];
  const f = createRotatingFetch(fakeFetch({ "a.test": 304, "b.test": 200 }, calls), {
    members: [member("a", "a.test"), member("b", "b.test")],
    resolveKey: keys,
    state: createRotationState(),
  });
  const res = await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(res.status, 304);
  assert.equal(calls.length, 1);
});

test("network error on one member rotates; an abort does NOT", async () => {
  const calls: Call[] = [];
  const boom = (): never => {
    throw new Error("ECONNREFUSED");
  };
  const f = createRotatingFetch(fakeFetch({ "a.test": boom, "b.test": 200 }, calls), {
    members: [member("a", "a.test"), member("b", "b.test")],
    resolveKey: keys,
    state: createRotationState(),
  });
  assert.equal((await f(`${ROTATION_BASE_URL}/chat/completions`, init())).status, 200);

  const abort = (): never => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  };
  const calls2: Call[] = [];
  const g = createRotatingFetch(fakeFetch({ "a.test": abort, "b.test": 200 }, calls2), {
    members: [member("a", "a.test"), member("b", "b.test")],
    resolveKey: keys,
    state: createRotationState(),
  });
  await assert.rejects(g(`${ROTATION_BASE_URL}/chat/completions`, init()), /aborted/);
  assert.equal(calls2.length, 1, "a user's cancel must not fan out to every provider");
});

test("a keyless member gets NO authorization header at all", async () => {
  const calls: Call[] = [];
  const { apiKeyRef: _unused, ...keyless } = member("k", "k.test");
  const f = createRotatingFetch(fakeFetch({ "k.test": 200 }, calls), {
    members: [keyless],
    state: createRotationState(),
  });
  await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(
    Object.keys(calls[0]?.headers ?? {}).some((h) => h.toLowerCase() === "authorization"),
    false,
  );
});

test("a refused key benches EVERY model of that provider at once; a 429 benches one", async () => {
  const calls: Call[] = [];
  const two = [
    member("a", "a.test"),
    { ...member("a", "a.test"), id: "a:m-a2", model: "m-a2" },
    member("b", "b.test"),
  ];
  const f = createRotatingFetch(fakeFetch({ "a.test": 401, "b.test": 200 }, calls), {
    members: two,
    resolveKey: keys,
    state: createRotationState(),
  });
  await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.deepEqual(
    calls.map((c) => new URL(c.url).hostname),
    ["a.test", "b.test"],
    "the second a.test model was not tried after a 401",
  );
  const calls429: Call[] = [];
  const g = createRotatingFetch(fakeFetch({ "a.test": 429, "b.test": 200 }, calls429), {
    members: two,
    resolveKey: keys,
    state: createRotationState(),
  });
  await g(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.deepEqual(
    calls429.map((c) => new URL(c.url).hostname),
    ["a.test", "a.test", "b.test"],
    "free quotas are per model, so each model is tried",
  );
});

test("one key is never sent to another provider", async () => {
  const calls: Call[] = [];
  const f = createRotatingFetch(fakeFetch({ "a.test": 429, "b.test": 200 }, calls), {
    members: [member("a", "a.test"), member("b", "b.test")],
    resolveKey: keys,
    state: createRotationState(),
  });
  await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  for (const c of calls) {
    const host = new URL(c.url).hostname;
    const provider = host.split(".")[0];
    assert.equal(c.headers.authorization, `Bearer KEY(keychain:provider:${provider})`);
  }
});

test("a rotation event names where it moved and why", async () => {
  const seen: string[] = [];
  const off = onRotationEvent((e) =>
    seen.push(`${e.from?.id ?? "-"}→${e.to.id}:${e.reason ?? ""}`),
  );
  try {
    const hosts: Record<string, number> = { "a.test": 200, "b.test": 200 };
    const f = createRotatingFetch(fakeFetch(hosts, []), {
      members: [member("a", "a.test"), member("b", "b.test")],
      resolveKey: keys,
      state: createRotationState(),
    });
    await f(`${ROTATION_BASE_URL}/chat/completions`, init());
    hosts["a.test"] = 429;
    await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  } finally {
    off();
  }
  assert.deepEqual(seen, ["-→a:m-a:", "a:m-a→b:m-b:429 rate-limited / quota used up"]);
});

test("members: only providers with a key, plus explicitly keyless tiers", () => {
  const none = rotationMembers({ env: {} });
  assert.ok(none.length > 0, "the keyless OVHcloud tier is always there");
  assert.ok(none.every((m) => m.apiKeyRef === undefined));
  assert.ok(rotationMembers({ env: {}, excludeKeyless: true }).length === 0);

  const withGroq = rotationMembers({ env: { GROQ_API_KEY: "x" } });
  assert.ok(withGroq.some((m) => m.providerId === "groq" && m.apiKeyRef === "env:GROQ_API_KEY"));
  // keyed members come before the keyless last resort
  assert.equal(withGroq.at(-1)?.apiKeyRef, undefined);
});

test("members: keychain counts, training opt-out drops may-train tiers, small windows dropped", () => {
  const ms = rotationMembers({ env: {}, hasKeychainKey: (id) => id === "gemini" });
  const gem = ms.find((m) => m.providerId === "gemini");
  assert.ok(gem, "gemini via keychain");
  assert.equal(gem?.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(gem?.apiKeyRef, "keychain:provider:gemini");
  const strict = rotationMembers({
    env: {},
    hasKeychainKey: (id) => id === "gemini",
    excludeTraining: true,
  });
  assert.ok(strict.every((m) => m.providerId !== "gemini"));
  const small = rotationMembers({
    env: { GROQ_API_KEY: "x" },
    excludeKeyless: true,
    models: [
      {
        section: "free",
        providerId: "groq",
        model: "tiny-window",
        label: "t",
        blurb: { strengths: "s", limits: "l" },
        tools: true,
        rotation: true,
        contextWindow: 8_000,
      },
    ],
  });
  assert.equal(small.length, 0, `a member below ${MIN_MEMBER_CONTEXT} tokens is left out`);
});

test("the endpoint: reserved host, smallest member window, cloud locality", () => {
  const ep = rotationEndpoint([
    member("a", "a.test", { contextWindow: 200_000 }),
    member("b", "b.test"),
  ]);
  assert.ok(ep);
  assert.equal(ep?.locality, "cloud");
  assert.equal(
    ep?.contextWindow,
    200_000,
    "the largest member's window: requests are routed by fit",
  );
  assert.match(ep?.baseUrl ?? "", /\.invalid\//);
  assert.equal(rotationEndpoint([]), null);
});

test("createAiClient on the rotation endpoint fails over end-to-end", async () => {
  const calls: Call[] = [];
  const sse = (text: string) => {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
  };
  const doFetch: FetchLike = async (url, i) => {
    calls.push({ url, headers: i.headers, body: i.body });
    const host = new URL(url).hostname;
    if (host === "a.test") return response(429, "quota");
    return { ...response(200), body: sse("hello from b") };
  };
  const ep = rotationEndpoint([member("a", "a.test"), member("b", "b.test")]);
  assert.ok(ep);
  const client = createAiClient(
    ep,
    { neverSendToCloud: false },
    { fetch: doFetch, resolveKey: keys },
  );
  let text = "";
  for await (const ch of client.chat([{ role: "user", content: "hi" }])) {
    if (ch.delta) text += ch.delta;
  }
  assert.equal(text, "hello from b");
  assert.deepEqual(
    calls.map((c) => new URL(c.url).hostname),
    ["a.test", "b.test"],
  );
});

test("the workspace never-send-to-cloud policy refuses the rotation before any request", async () => {
  const calls: Call[] = [];
  const ep = rotationEndpoint([member("a", "a.test")]);
  assert.ok(ep);
  const client = createAiClient(ep, { neverSendToCloud: true }, { fetch: fakeFetch({}, calls) });
  await assert.rejects(async () => {
    for await (const _ of client.chat([{ role: "user", content: "secret" }])) {
      // drain
    }
  });
  assert.equal(calls.length, 0);
});

test("a request-shaped 400 skips the member for THIS request; only repeated ones bench it", async () => {
  const state = createRotationState();
  const hosts: Record<string, number> = { "a.test": 400, "b.test": 200 };
  const calls: Call[] = [];
  const f = createRotatingFetch(fakeFetch(hosts, calls), {
    members: [member("a", "a.test"), member("b", "b.test")],
    resolveKey: keys,
    state,
  });
  for (let i = 0; i < BAD_REQUEST_STRIKES - 1; i += 1)
    await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  calls.length = 0;
  hosts["a.test"] = 200;
  await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(new URL(calls[0]?.url ?? "").hostname, "a.test", "two 400s did not bench a");
  hosts["a.test"] = 400;
  for (let i = 0; i < BAD_REQUEST_STRIKES; i += 1)
    await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  calls.length = 0;
  await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(new URL(calls[0]?.url ?? "").hostname, "b.test", "persistent 400s bench it");
});

test("a long prompt is routed to a member whose window holds it", async () => {
  const calls: Call[] = [];
  const small = member("s", "s.test", { contextWindow: 32_768 });
  const big = member("b", "b.test", { contextWindow: 1_000_000 });
  const f = createRotatingFetch(fakeFetch({ "s.test": 200, "b.test": 200 }, calls), {
    members: [small, big],
    resolveKey: keys,
    state: createRotationState(),
  });
  await f(
    `${ROTATION_BASE_URL}/chat/completions`,
    init({ messages: [{ role: "user", content: "x".repeat(200_000) }] }),
  );
  assert.deepEqual(
    calls.map((c) => new URL(c.url).hostname),
    ["b.test"],
  );
  calls.length = 0;
  await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(
    new URL(calls[0]?.url ?? "").hostname,
    "s.test",
    "a short prompt keeps priority order",
  );
});

test("all members benched by a TRANSIENT error → retried anyway, not refused", async () => {
  let t = 0;
  const hosts: Record<string, number> = { "a.test": 503 };
  const calls: Call[] = [];
  const f = createRotatingFetch(fakeFetch(hosts, calls), {
    members: [member("a", "a.test")],
    resolveKey: keys,
    state: createRotationState(),
    now: () => t,
  });
  assert.equal((await f(`${ROTATION_BASE_URL}/chat/completions`, init())).status, 503);
  hosts["a.test"] = 200;
  t += 1_000; // still inside the 15 s transient bench
  const r = await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(r.status, 200, "a blip must not turn into a synthetic all-exhausted 429");
});

test("a member that never sends headers is abandoned for the next one", async () => {
  const hung: FetchLike = (url, i) =>
    new URL(url).hostname === "h.test"
      ? new Promise((_res, rej) => {
          i.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          });
        })
      : Promise.resolve(response(200));
  const f = createRotatingFetch(hung, {
    members: [member("h", "h.test"), member("b", "b.test")],
    resolveKey: keys,
    state: createRotationState(),
    headerTimeoutMs: 20,
  });
  const r = await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.equal(r.status, 200);
});

test("onEvent hears only this fetch's switches", async () => {
  const mine: string[] = [];
  const f = createRotatingFetch(fakeFetch({ "a.test": 200 }, []), {
    members: [member("a", "a.test")],
    resolveKey: keys,
    state: createRotationState(),
    onEvent: (e) => mine.push(e.to.id),
  });
  const g = createRotatingFetch(fakeFetch({ "b.test": 200 }, []), {
    members: [member("b", "b.test")],
    resolveKey: keys,
    state: createRotationState(),
  });
  await f(`${ROTATION_BASE_URL}/chat/completions`, init());
  await g(`${ROTATION_BASE_URL}/chat/completions`, init());
  assert.deepEqual(mine, ["a:m-a"]);
});
