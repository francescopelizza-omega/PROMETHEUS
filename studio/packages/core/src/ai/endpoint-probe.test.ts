/**
 * endpoint-probe.test.ts — the seam that keeps a measured endpoint measured across a rebind.
 *
 * The bug this module closes is not "the probe is wrong", it is "the probe is thrown away":
 * `/model`, `/worker` and `/setup` each rebind the session endpoint to a freshly built object
 * that carries the 8192 floor and no `probedCapabilities`, and nothing re-measured. The tests
 * below therefore care most about the things a naive "just call probeContextWindow again"
 * would get wrong — a failed probe being cached as if it were an answer, a cloud endpoint being
 * probed at all, and two concurrent rebinds firing two identical POSTs.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { AiEndpoint } from "./client.js";
import type { EndpointProbeDeps } from "./endpoint-probe.js";
import { PROBE_CACHE_TTL_MS, createEndpointProbe } from "./endpoint-probe.js";

const LOCAL: AiEndpoint = {
  id: "local:ollama:qwen3.6:latest",
  baseUrl: "http://127.0.0.1:11434/v1",
  locality: "local",
  contextWindow: 8192,
  supportsTools: true,
  model: "qwen3.6:latest",
};

const CLOUD: AiEndpoint = {
  id: "cloud:anthropic",
  baseUrl: "https://api.anthropic.com",
  locality: "cloud",
  contextWindow: 200_000,
  supportsTools: true,
  model: "claude-opus-4-1",
};

/** An Ollama `/api/show` payload, shaped exactly as the real daemon returns it. */
function showPayload(
  contextLength: number,
  capabilities: string[],
  modifiedAt = "2026-07-24T05:25:11.337173291+02:00",
): unknown {
  return {
    model_info: { "qwen3moe.context_length": contextLength },
    capabilities,
    modified_at: modifiedAt,
    details: { family: "qwen35moe" },
  };
}

/** A `fetch` stub that answers `/api/show` and counts calls. */
function stub(
  payload: unknown,
  opts: { ok?: boolean } = {},
): {
  fetchLike: never;
  calls: () => number;
} {
  let calls = 0;
  const fetchLike = (async (url: string) => {
    calls += 1;
    if (url.endsWith("/api/show")) {
      return { ok: opts.ok ?? true, json: async () => payload };
    }
    return { ok: false, json: async () => ({}) };
  }) as unknown as never;
  return { fetchLike, calls: () => calls };
}

test("attach: a local endpoint comes back MEASURED — window and capabilities both", async () => {
  const { fetchLike } = stub(showPayload(262_144, ["completion", "tools", "thinking"]));
  const probe = createEndpointProbe({ fetch: fetchLike });
  const r = await probe.attach(LOCAL);
  assert.equal(r.measured, true);
  assert.equal(r.failed, false);
  assert.equal(r.endpoint.contextWindow, 262_144);
  assert.deepEqual(r.endpoint.probedCapabilities, ["completion", "tools", "thinking"]);
});

test("attach: the input endpoint is never mutated — the caller decides when to adopt", async () => {
  const { fetchLike } = stub(showPayload(262_144, ["thinking"]));
  const probe = createEndpointProbe({ fetch: fetchLike });
  const r = await probe.attach(LOCAL);
  assert.equal(LOCAL.contextWindow, 8192, "the input object was mutated");
  assert.equal(LOCAL.probedCapabilities, undefined);
  assert.notEqual(r.endpoint, LOCAL);
});

test("attach: a CLOUD endpoint is never probed — no request leaves the machine", async () => {
  const { fetchLike, calls } = stub(showPayload(262_144, ["thinking"]));
  const probe = createEndpointProbe({ fetch: fetchLike });
  const r = await probe.attach(CLOUD);
  assert.equal(calls(), 0, "a cloud endpoint must not be probed");
  assert.equal(r.endpoint, CLOUD, "a cloud endpoint passes through untouched");
  assert.equal(r.measured, false);
  assert.equal(r.failed, false, "not-probed is not a failure — it is a policy");
});

test("attach: an endpoint with no model name is not probed (there is nothing to ask about)", async () => {
  const { fetchLike, calls } = stub(showPayload(262_144, ["thinking"]));
  const probe = createEndpointProbe({ fetch: fetchLike });
  const { model: _model, ...noModel } = LOCAL;
  const r = await probe.attach(noModel as AiEndpoint);
  assert.equal(calls(), 0);
  assert.equal(r.measured, false);
  assert.equal(r.failed, false);
});

test("attach: a FAILED probe reports `failed` and leaves the endpoint alone", async () => {
  const { fetchLike } = stub({ nothing: "useful" });
  const probe = createEndpointProbe({ fetch: fetchLike });
  const r = await probe.attach(LOCAL);
  assert.equal(r.measured, false);
  assert.equal(r.failed, true);
  assert.equal(r.endpoint, LOCAL, "a failed probe must not hand back a half-filled copy");
});

test("a failure is NOT cached — the next attach retries (a runner still booting must recover)", async () => {
  let payload: unknown = { nothing: "useful" };
  let calls = 0;
  const fetchLike = (async (url: string) => {
    calls += 1;
    return url.endsWith("/api/show")
      ? { ok: true, json: async () => payload }
      : { ok: false, json: async () => ({}) };
  }) as unknown as never;
  const probe = createEndpointProbe({ fetch: fetchLike });

  const first = await probe.attach(LOCAL);
  assert.equal(first.failed, true);

  payload = showPayload(262_144, ["thinking"]);
  const second = await probe.attach(LOCAL);
  assert.equal(second.measured, true, "a cached failure would have pinned this to `failed`");
  assert.equal(second.endpoint.contextWindow, 262_144);
  assert.ok(calls >= 2);
});

test("a SUCCESS is cached — a second attach for the same model makes no request", async () => {
  const { fetchLike } = stub(showPayload(262_144, ["thinking"]));
  const probe = createEndpointProbe({ fetch: fetchLike });
  await probe.attach(LOCAL);
  const again = await probe.attach(LOCAL);
  assert.equal(probe.probeCount(), 1, "the cache did not hold");
  assert.equal(again.fromCache, true);
  assert.equal(again.endpoint.contextWindow, 262_144);
});

test("the cache is keyed on the MODEL, not just the runner — one daemon serves many", async () => {
  // Only the /api/show POSTs carry a model; the probe also GETs /api/ps to learn what the
  // daemon actually SERVES (which may be less than the weights allow).
  const seen: string[] = [];
  const fetchLike = (async (url: string, init?: { body?: string }) => {
    const model = JSON.parse(init?.body ?? "{}").model as string;
    if (url.endsWith("/api/show")) seen.push(model);
    return {
      ok: true,
      json: async () => showPayload(model === "gemma4:12b" ? 8192 : 262_144, ["tools", "thinking"]),
    };
  }) as unknown as never;
  const probe = createEndpointProbe({ fetch: fetchLike });

  const a = await probe.attach(LOCAL);
  const b = await probe.attach({ ...LOCAL, id: "local:ollama:gemma4:12b", model: "gemma4:12b" });
  assert.equal(a.endpoint.contextWindow, 262_144);
  assert.equal(b.endpoint.contextWindow, 8192, "the second model got the first model's window");
  assert.deepEqual(seen, ["qwen3.6:latest", "gemma4:12b"]);
});

test("the cache expires — a revision-less runner's answer is time-bounded, not permanent", async () => {
  let clock = 0;
  const { fetchLike } = stub(showPayload(262_144, ["thinking"]));
  const probe = createEndpointProbe({ fetch: fetchLike, now: () => clock, ttlMs: 1000 });
  await probe.attach(LOCAL);
  clock = 999;
  await probe.attach(LOCAL);
  assert.equal(probe.probeCount(), 1, "inside the TTL this must be a cache hit");
  clock = 1001;
  await probe.attach(LOCAL);
  assert.equal(probe.probeCount(), 2, "past the TTL the answer must be re-measured");
});

test("invalidate() drops one endpoint; invalidate() with no argument drops everything", async () => {
  const { fetchLike } = stub(showPayload(262_144, ["thinking"]));
  const probe = createEndpointProbe({ fetch: fetchLike });
  await probe.attach(LOCAL);
  probe.invalidate(LOCAL);
  await probe.attach(LOCAL);
  assert.equal(probe.probeCount(), 2);
  probe.invalidate();
  await probe.attach(LOCAL);
  assert.equal(probe.probeCount(), 3);
});

test("two concurrent attaches for the same model share ONE request", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const fetchLike = (async (url: string) => {
    // the /api/ps question is part of one probe; count the /api/show POSTs, which are the
    // expensive, dedupable ones
    if (url.endsWith("/api/show")) calls += 1;
    await gate;
    return { ok: true, json: async () => showPayload(262_144, ["thinking"]) };
  }) as unknown as never;
  const probe = createEndpointProbe({ fetch: fetchLike });

  const both = Promise.all([probe.attach(LOCAL), probe.attach(LOCAL)]);
  release?.();
  const [a, b] = await both;
  assert.equal(calls, 1, "a rebind burst must not fan out into N identical POSTs");
  assert.equal(a.endpoint.contextWindow, 262_144);
  assert.equal(b.endpoint.contextWindow, 262_144);
});

test("a runner that reports a window but NO capabilities does not erase an earlier answer", async () => {
  const { fetchLike } = stub({
    model_info: { "qwen3moe.context_length": 262_144 },
    modified_at: "x",
  });
  const probe = createEndpointProbe({ fetch: fetchLike });
  const carried = { ...LOCAL, probedCapabilities: ["completion", "tools", "thinking"] as const };
  const r = await probe.attach(carried);
  assert.deepEqual(
    r.endpoint.probedCapabilities,
    ["completion", "tools", "thinking"],
    "a capability-less answer overwrote a richer one",
  );
});

test("a rejecting fetch is a failure, not a throw — a probe may never take a session down", async () => {
  const fetchLike = (async () => {
    throw new Error("connection refused");
  }) as unknown as never;
  const probe = createEndpointProbe({ fetch: fetchLike });
  const r = await probe.attach(LOCAL);
  assert.equal(r.failed, true);
  assert.equal(r.endpoint, LOCAL);
});

test("a re-pulled model does not inherit the OLD weights' capabilities", () => {
  // `revision` was captured in three places and read by nobody, while three comments described
  // a revision-aware cache that `fresh()` did not implement. This is the use that is actually
  // sound: a changed digest means different weights, so the capability fallback — right for the
  // same model, since a runner can answer with a window and no `capabilities` array — must not
  // carry a stale list forward. Those capabilities are what decide whether `/think` works.
  let revision = "sha256:aaa";
  let capabilities: string[] | undefined = ["completion", "tools", "thinking"];
  let clock = 0;
  const probe = createEndpointProbe({
    now: () => clock,
    fetch: (async () =>
      new Response(
        JSON.stringify({
          model_info: { "general.context_length": 8192 },
          ...(capabilities ? { capabilities } : {}),
          digest: revision,
          details: { parent_model: "", family: "x" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as EndpointProbeDeps["fetch"],
  });
  return (async (): Promise<void> => {
    const base: AiEndpoint = {
      id: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
      locality: "local",
    };
    const first = await probe.attach(base);
    if (first.measured && first.endpoint.probedCapabilities) {
      assert.deepEqual([...first.endpoint.probedCapabilities], ["completion", "tools", "thinking"]);
    }
    // The user re-pulls: new digest, and this build of the runner answers with no
    // `capabilities` array at all.
    clock += PROBE_CACHE_TTL_MS + 1;
    revision = "sha256:bbb";
    capabilities = undefined;
    const second = await probe.attach(first.endpoint);
    assert.equal(
      second.endpoint.probedCapabilities,
      undefined,
      "the previous weights' capabilities survived a re-pull",
    );
  })();
});
