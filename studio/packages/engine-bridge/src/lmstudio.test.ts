/**
 * lmstudio.test.ts — what LM Studio holds, and freeing it.
 *
 * Fake fetch only: nothing is loaded, nothing is unloaded, no `lms` runs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  lmStudioPlanContext,
  lmsBinary,
  lmsEstimateBytes,
  parseLmsEstimate,
  ttlSecondsFromKeepAlive,
  unloadLmStudio,
} from "./lmstudio.js";
import { probeRunner } from "./runner-census.js";

const ID = "nvidia/nemotron-3-nano-omni";

function v1(loaded: unknown[]) {
  return {
    models: [
      {
        type: "llm",
        key: ID,
        size_bytes: 26104736555,
        max_context_length: 262144,
        loaded_instances: loaded,
      },
      {
        type: "embedding",
        key: "text-embedding-nomic-embed-text-v1.5",
        size_bytes: 84106624,
        loaded_instances: [],
      },
    ],
  };
}

function server(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });
    const h = routes[`${method} ${path}`];
    const r = h
      ? h(body)
      : { json: { error: `Unexpected endpoint or method. (${method} ${path})` } };
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

test("census: LM Studio's residency is KNOWN now — only loaded models, with their real size", async () => {
  const { f } = server({
    "GET /api/v1/models": () => ({ json: v1([{ id: ID, config: { context_length: 32768 } }]) }),
  });
  const s = await probeRunner(
    { id: "lmstudio", baseUrl: "http://127.0.0.1:1234", api: "lmstudio" },
    { fetchFn: f },
  );
  assert.equal(s.up, true);
  assert.equal(s.residencyKnown, true);
  assert.deepEqual(s.models, [{ id: ID, sizeBytes: 26104736555, contextTokens: 32768 }]);
  const idle = server({ "GET /api/v1/models": () => ({ json: v1([]) }) });
  const s2 = await probeRunner(
    { id: "lmstudio", baseUrl: "http://127.0.0.1:1234", api: "lmstudio" },
    { fetchFn: idle.f },
  );
  assert.deepEqual([s2.up, s2.residencyKnown, s2.models.length], [true, true, 0]);
});

test("census: an `ollama` probe answered by LM Studio's 200-error is NOT an Ollama that is up", async () => {
  const { f } = server({});
  const s = await probeRunner(
    { id: "ollama", baseUrl: "http://127.0.0.1:1234", api: "ollama" },
    { fetchFn: f },
  );
  assert.equal(s.up, false);
});

test("census: an LM Studio too old for the REST listing falls back to the catalogue (residency unknown)", async () => {
  const { f } = server({
    "GET /v1/models": () => ({ json: { data: [{ id: ID, object: "model" }] } }),
  });
  const s = await probeRunner(
    { id: "lmstudio", baseUrl: "http://127.0.0.1:1234", api: "lmstudio" },
    { fetchFn: f },
  );
  assert.deepEqual([s.up, s.residencyKnown], [true, false]);
});

test("unload: every loaded instance through REST — the weights go, not just the port", async () => {
  const { f, calls } = server({
    "GET /api/v1/models": () => ({ json: v1([{ id: ID }, { id: `${ID}:2` }]) }),
    "POST /api/v1/models/unload": () => ({ json: { instance_id: "x" } }),
  });
  const r = await unloadLmStudio("http://127.0.0.1:1234/v1", { fetchFn: f, lms: null });
  assert.deepEqual(r, { unloaded: [ID, `${ID}:2`], failed: [], via: "rest" });
  assert.deepEqual(
    calls.filter((c) => c.method === "POST").map((c) => c.body),
    [{ instance_id: ID }, { instance_id: `${ID}:2` }],
  );
});

test("unload: nothing loaded ⇒ nothing posted; an old server falls back to `lms unload --all`", async () => {
  const idle = server({ "GET /api/v1/models": () => ({ json: v1([]) }) });
  assert.deepEqual(await unloadLmStudio("http://127.0.0.1:1234", { fetchFn: idle.f, lms: null }), {
    unloaded: [],
    failed: [],
    via: "none",
  });
  // v0 only: the unload route answers with LM Studio's "Unexpected endpoint" 200
  const old = server({
    "GET /api/v0/models": () => ({ json: { data: [{ id: ID, type: "llm", state: "loaded" }] } }),
  });
  const ran: string[][] = [];
  const r = await unloadLmStudio("http://127.0.0.1:1234", {
    fetchFn: old.f,
    lms: "/Users/u/.lmstudio/bin/lms",
    run: async (bin, args) => {
      ran.push([bin, ...args]);
      return { code: 0, stderr: "" };
    },
  });
  assert.deepEqual(ran, [["/Users/u/.lmstudio/bin/lms", "unload", "--all"]]);
  assert.deepEqual(r, { unloaded: [ID], failed: [], via: "lms" });
});

test("lms is found off PATH, in the app's own ~/.lmstudio/bin", () => {
  const exists = (p: string) => p === "/Users/u/.lmstudio/bin/lms";
  assert.equal(
    lmsBinary({ PATH: "/usr/bin:/bin" }, { home: "/Users/u", exists }),
    "/Users/u/.lmstudio/bin/lms",
  );
  assert.equal(lmsBinary({ PATH: "/usr/bin" }, { home: "/Users/v", exists }), null);
});

test("ttl from keep_alive", () => {
  assert.deepEqual(
    ["60s", "5m", "1h", "90", "-1", "0", "soon", undefined].map((v) => ttlSecondsFromKeepAlive(v)),
    [60, 300, 3600, 90, undefined, undefined, undefined, undefined],
  );
});

test("LM Studio's own estimate is parsed; an unloaded model is planned at a bounded context", async () => {
  const out =
    "Model: nvidia/nemotron-3-nano-omni\nContext Length: 32,768\nEstimated GPU Memory:   24.31 GiB\nEstimated Total Memory: 24.31 GiB\nConfidence: LOW\n";
  assert.equal(parseLmsEstimate(out), Math.round(24.31 * 2 ** 30));
  assert.equal(parseLmsEstimate("nothing here"), null);
  const ran: string[][] = [];
  const bytes = await lmsEstimateBytes("nvidia/nemotron-3-nano-omni", 32768, {
    lms: "/x/lms",
    run: async (b, a) => {
      ran.push([b, ...a]);
      return { code: 0, stdout: out };
    },
  });
  assert.equal(bytes, Math.round(24.31 * 2 ** 30));
  assert.deepEqual(ran, [
    ["/x/lms", "load", "nvidia/nemotron-3-nano-omni", "-c", "32768", "--estimate-only", "-y"],
  ]);
  assert.equal(
    await lmsEstimateBytes("-x", 1, { lms: "/x/lms", run: async () => ({ code: 0, stdout: out }) }),
    null,
  );
  assert.equal(lmStudioPlanContext(262144, {}), 32768);
  assert.equal(lmStudioPlanContext(8192, {}), 8192);
  assert.equal(lmStudioPlanContext(262144, { PROMETHEUS_LMSTUDIO_CONTEXT: "65536" }), 65536);
});
