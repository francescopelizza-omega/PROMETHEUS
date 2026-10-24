/**
 * lmstudio-listing.test.ts — LM Studio as it really answers, not as Ollama would.
 *
 * The bodies are the ones a real LM Studio (app bundle `Bionic.app`) returned on 2026-10-22, with
 * one downloaded 26 GB model and the bundled embedding model, nothing loaded. The loaded variants
 * are the same rows with an instance added.
 *
 * Every probe is a fake fetch: no server is contacted, nothing is loaded.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseLmStudioModels as bridgeParse } from "@prometheus/engine-bridge";

import { probeContextWindow } from "./context-window.js";
import {
  fetchLmStudioModels,
  isLmStudioUnknownRoute,
  lmStudioServedContext,
  parseLmStudioModels,
  rankLmStudioChatModels,
} from "./lmstudio-listing.js";
import { censusProbesFor, lmStudioCandidatesFrom, runnerIdForUrl } from "./lmstudio-models.js";
import { keepAliveSeconds, localKeepAliveField, runnerById } from "./local-runners.js";
import { inventoryCandidates } from "./ollama-inventory.js";
import { discoverRunners } from "./runner-discovery.js";

const NEMOTRON = "nvidia/nemotron-3-nano-omni";
const EMBED = "text-embedding-nomic-embed-text-v1.5";

/** `GET /api/v1/models`, verbatim apart from field order. */
function v1(loaded: unknown[] = []) {
  return {
    models: [
      {
        type: "llm",
        publisher: "nvidia",
        key: NEMOTRON,
        display_name: "Nemotron 3 Nano Omni",
        architecture: "nemotron_h_moe",
        quantization: { name: "Q4_K_M", bits_per_weight: 4 },
        size_bytes: 26104736555,
        params_string: "30B-A3B",
        loaded_instances: loaded,
        max_context_length: 262144,
        format: "gguf",
        capabilities: {
          vision: true,
          trained_for_tool_use: true,
          reasoning: { allowed_options: ["off", "on"], default: "on" },
        },
      },
      {
        type: "embedding",
        publisher: "nomic-ai",
        key: EMBED,
        size_bytes: 84106624,
        loaded_instances: [],
        max_context_length: 2048,
        format: "gguf",
      },
    ],
  };
}

/** `GET /api/v0/models`, verbatim. */
function v0(state = "not-loaded", loadedCtx?: number) {
  return {
    data: [
      {
        id: NEMOTRON,
        object: "model",
        type: "vlm",
        arch: "nemotron_h_moe",
        quantization: "Q4_K_M",
        state,
        max_context_length: 262144,
        ...(loadedCtx ? { loaded_context_length: loadedCtx } : {}),
        capabilities: ["tool_use"],
      },
      {
        id: EMBED,
        object: "model",
        type: "embeddings",
        state: "not-loaded",
        max_context_length: 2048,
      },
    ],
    object: "list",
  };
}

const OPENAI = {
  data: [
    { id: NEMOTRON, object: "model", owned_by: "organization_owner" },
    { id: EMBED, object: "model", owned_by: "organization_owner" },
  ],
  object: "list",
};
const UNKNOWN = { error: "Unexpected endpoint or method. (GET /api/tags)" };

/** A fake LM Studio on :1234. `routes` maps a path to a body; everything else gets LM Studio's 200-error. */
function lmStudio(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
    const body =
      u.pathname in routes
        ? routes[u.pathname]
        : { error: `Unexpected endpoint or method. (${init?.method ?? "GET"} ${u.pathname})` };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { f, calls };
}

test("v1 listing: type, size, context, capabilities — and nothing loaded means nothing loaded", () => {
  const ms = parseLmStudioModels(v1());
  assert.ok(ms);
  const n = ms.find((m) => m.id === NEMOTRON);
  assert.equal(n?.type, "llm");
  assert.equal(n?.vision, true);
  assert.equal(n?.sizeBytes, 26104736555);
  assert.equal(n?.maxContextLength, 262144);
  assert.equal(n?.toolUse, true);
  assert.equal(n?.reasoning, true);
  assert.deepEqual(n?.loaded, []);
  assert.equal(ms.find((m) => m.id === EMBED)?.type, "embedding");
});

test("v0 beta: state decides residency; vlm is a chat model, embeddings is not", () => {
  const ms = parseLmStudioModels(v0("loaded", 8192));
  assert.ok(ms);
  const n = ms.find((m) => m.id === NEMOTRON);
  assert.equal(n?.type, "llm");
  assert.deepEqual(n?.loaded, [{ instanceId: NEMOTRON, contextLength: 8192 }]);
  assert.equal(ms.find((m) => m.id === EMBED)?.type, "embedding");
});

test("not an LM Studio listing is null, never an empty list: the catalogue, an Ollama-route error", () => {
  assert.equal(parseLmStudioModels(OPENAI), null);
  assert.equal(parseLmStudioModels(UNKNOWN), null);
  assert.equal(parseLmStudioModels("<html>"), null);
  assert.equal(isLmStudioUnknownRoute(UNKNOWN), true);
  assert.equal(isLmStudioUnknownRoute({ models: [] }), false);
});

test("core and engine-bridge parse every body identically (two copies, one answer)", () => {
  const loaded = [{ id: NEMOTRON, config: { context_length: 32768 } }];
  for (const body of [v1(), v1(loaded), v0(), v0("loaded", 4096), OPENAI, UNKNOWN, {}]) {
    assert.deepEqual(parseLmStudioModels(body), bridgeParse(body));
  }
});

test("a picker gets chat models only, loaded first; the served context is the LOADED one", () => {
  const ms = parseLmStudioModels(v1([{ id: NEMOTRON, config: { context_length: 32768 } }]));
  assert.ok(ms);
  assert.deepEqual(
    rankLmStudioChatModels(ms).map((m) => m.id),
    [NEMOTRON],
    "the embedding model is never offered as a chat model",
  );
  const n = ms.find((m) => m.id === NEMOTRON);
  assert.ok(n);
  assert.equal(lmStudioServedContext(n), 32768);
  const idle = parseLmStudioModels(v1())?.find((m) => m.id === NEMOTRON);
  assert.ok(idle);
  // not loaded: planned at a bounded context, not the 262k architecture maximum
  assert.equal(lmStudioServedContext(idle), 32768);
});

test("fetch: /api/v1 first, /api/v0 when v1 is missing, null when it is not LM Studio at all", async () => {
  const both = lmStudio({ "/api/v1/models": v1(), "/api/v0/models": v0() });
  assert.equal(
    (await fetchLmStudioModels("http://localhost:1234/v1", { fetchFn: both.f }))?.length,
    2,
  );
  assert.deepEqual(both.calls, ["GET /api/v1/models"]);
  const old = lmStudio({ "/api/v0/models": v0("loaded", 4096) });
  const ms = await fetchLmStudioModels("http://localhost:1234/v1", { fetchFn: old.f });
  assert.equal(ms?.find((m) => m.id === NEMOTRON)?.loaded[0]?.contextLength, 4096);
  const none = lmStudio({ "/v1/models": OPENAI });
  assert.equal(await fetchLmStudioModels("http://localhost:1234/v1", { fetchFn: none.f }), null);
});

test("context window: LM Studio's loaded context is measured, not the 8192 floor", async () => {
  const loaded = lmStudio({
    "/api/v1/models": v1([{ id: NEMOTRON, config: { context_length: 32768 } }]),
    "/v1/models": OPENAI,
  });
  const r = await probeContextWindow("http://localhost:1234/v1", NEMOTRON, loaded.f);
  assert.equal(r.contextWindow, 32768);
  assert.equal(r.source, "lmstudio-loaded");
  assert.ok(r.capabilities?.includes("tools"));
  const idle = lmStudio({ "/api/v1/models": v1(), "/v1/models": OPENAI });
  const r2 = await probeContextWindow("http://localhost:1234/v1", NEMOTRON, idle.f);
  assert.deepEqual([r2.contextWindow, r2.source], [32768, "lmstudio"]);
});

test("discovery: LM Studio serves chat models only, never its embedding model as models[0]", async () => {
  const { f } = lmStudio({ "/api/v1/models": v1(), "/v1/models": OPENAI });
  const rows = await discoverRunners({ fetchFn: f, timeoutMs: 500 });
  const lms = rows.find((r) => r.id === "lmstudio");
  assert.equal(lms?.state, "serving");
  assert.deepEqual(lms?.models, [NEMOTRON]);
});

test("admission inventory: an LM Studio model is weighed by its real size, not waved through at 0", async () => {
  const { f, calls } = lmStudio({ "/api/v1/models": v1() });
  const c = await inventoryCandidates("http://localhost:1234/v1", 300_000, {
    fetchFn: f,
    runner: "lmstudio",
  });
  assert.deepEqual(
    c.map((x) => [x.id, x.weightsBytes, x.contextTokens, x.runner]),
    [[NEMOTRON, 26104736555, 262144, "lmstudio"]],
    "context clamped to what the model takes; embedding model excluded",
  );
  assert.ok(!calls.some((x) => x.includes("/api/tags") || x.includes("/api/show")));
  assert.deepEqual(lmStudioCandidatesFrom([], 8192), []);
});

test("census probes: each runner at its OWN port on the endpoint's host", () => {
  assert.deepEqual(censusProbesFor("http://localhost:1234/v1", {}), [
    { id: "ollama", baseUrl: "http://localhost:11434", api: "ollama" },
    { id: "lmstudio", baseUrl: "http://localhost:1234", api: "lmstudio" },
  ]);
  assert.deepEqual(censusProbesFor("http://gpu-box:11434/v1", {}), [
    { id: "ollama", baseUrl: "http://gpu-box:11434", api: "ollama" },
    { id: "lmstudio", baseUrl: "http://gpu-box:1234", api: "lmstudio" },
  ]);
  // a moved LM Studio is still LM Studio
  const env = { PROMETHEUS_RUNNER_LMSTUDIO_URL: "http://localhost:4321" };
  assert.equal(runnerIdForUrl("http://localhost:4321/v1", env), "lmstudio");
  assert.equal(
    censusProbesFor("http://localhost:4321/v1", env)[1]?.baseUrl,
    "http://localhost:4321",
  );
  assert.equal(runnerIdForUrl("http://localhost:11434/v1", {}), "ollama");
});

test("keep-alive: LM Studio gets `ttl` in seconds, Ollama keeps `keep_alive`, cloud gets nothing", () => {
  assert.deepEqual(
    [
      keepAliveSeconds("60s"),
      keepAliveSeconds("5m"),
      keepAliveSeconds("1h"),
      keepAliveSeconds("300"),
    ],
    [60, 300, 3600, 300],
  );
  assert.equal(keepAliveSeconds("-1"), undefined);
  assert.equal(keepAliveSeconds("0"), undefined);
  const prev = process.env.PROMETHEUS_LOCAL_KEEP_ALIVE;
  Reflect.deleteProperty(process.env, "PROMETHEUS_LOCAL_KEEP_ALIVE");
  try {
    assert.deepEqual(localKeepAliveField("local", "http://localhost:1234/v1"), { ttl: 60 });
    assert.deepEqual(localKeepAliveField("local", "http://localhost:11434/v1"), {
      keep_alive: "60s",
    });
    assert.deepEqual(localKeepAliveField("local"), { keep_alive: "60s" });
    assert.deepEqual(localKeepAliveField("cloud", "http://localhost:1234/v1"), {});
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "PROMETHEUS_LOCAL_KEEP_ALIVE");
    else process.env.PROMETHEUS_LOCAL_KEEP_ALIVE = prev;
  }
});

test("a moved LM Studio is STARTED on the port it is probed on", () => {
  const moved = runnerById("lmstudio", { PROMETHEUS_RUNNER_LMSTUDIO_URL: "http://localhost:4321" });
  assert.deepEqual(moved?.start, ["lms", "server", "start", "--port", "4321"]);
  assert.equal(moved?.baseUrl, "http://localhost:4321/v1");
  assert.deepEqual(runnerById("lmstudio", {})?.start, ["lms", "server", "start", "--port", "1234"]);
});
