/**
 * model-check.test.ts — the network seam for upstream model updates.
 *
 * Core decides; this file only fetches. So the tests are about the things a fetch layer gets
 * wrong: how many requests it makes, what it does when a response is missing/slow/malformed,
 * and whether a single bad model can take the whole sweep down.
 *
 * The request count is asserted rather than described, because the two-stage design (HEAD
 * everything, GET only what moved) is the entire reason this is cheap enough to run at every
 * launch. A refactor that quietly starts GETting every manifest would still pass every
 * behavioural test and would cost a kilobyte per model per startup.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as u from "../updates/index.js";

import {
  type FetchLike,
  PROBE_CONCURRENCY,
  checkModelUpdates,
  fetchBuild,
  fetchOllamaVersion,
  headManifest,
} from "./model-check.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const CONFIG_DIGEST = `sha256:${"c".repeat(64)}`;

/** A manifest body whose SHA-256 is irrelevant here — the header path supplies the digest. */
const manifestBody = (totalBytes: number): string =>
  JSON.stringify({
    schemaVersion: 2,
    config: { digest: CONFIG_DIGEST, size: 220 },
    layers: [
      { mediaType: "application/vnd.ollama.image.model", digest: "sha256:l1", size: totalBytes },
    ],
  });

const CONFIG_BODY = JSON.stringify({
  file_type: "Q4_K_M",
  model_type: "35.5B",
  model_family: "qwen35moe",
  requires: "0.30.0",
});

interface Call {
  url: string;
  method: string;
}

/** A scripted fetch that records every call. `routes` maps a URL substring to a response. */
function fakeFetch(
  routes: Record<string, { status?: number; headers?: Record<string, string>; body?: string }>,
): { impl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key] : undefined;
    const status = r?.status ?? (r ? 200 : 404);
    const headers = r?.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => r?.body ?? "",
    };
  };
  return { impl, calls };
}

const installed = (name: string, digest: string, extra: Partial<u.InstalledModel> = {}) =>
  ({ name, digest, size: 24e9, ...extra }) as u.InstalledModel;

/* ── the request budget ─────────────────────────────────────────────────────────────────────*/

test("an UP-TO-DATE model costs exactly ONE request, and it is a HEAD", () => {
  // The whole point of the two-stage design. If this ever becomes 2, every launch pays a
  // manifest download per model for an answer the header already gave.
  const { impl, calls } = fakeFetch({
    "/manifests/": { headers: { "ollama-content-digest": DIGEST_A } },
  });
  return checkModelUpdates([installed("gemma4:12b", DIGEST_A)], { fetchImpl: impl }).then((out) => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "HEAD");
    assert.equal(out[0]?.ok, true);
    assert.equal(out[0]?.ok === true && out[0].update.changed, false);
  });
});

test("a CHANGED model costs a HEAD plus the manifest and its config blob", async () => {
  const { impl, calls } = fakeFetch({
    "/manifests/": { headers: { "ollama-content-digest": DIGEST_B }, body: manifestBody(22e9) },
    "/blobs/": { body: CONFIG_BODY },
  });
  const out = await checkModelUpdates([installed("qwen3.6:latest", DIGEST_A)], {
    fetchImpl: impl,
    ollamaVersion: "0.34.1",
  });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["HEAD", "GET", "GET"],
    "HEAD to detect, then manifest + config for the detail",
  );
  assert.equal(out[0]?.ok, true);
  if (out[0]?.ok !== true) return;
  assert.equal(out[0].update.changed, true);
  assert.equal(out[0].update.remoteBytes, 22e9);
  assert.equal(out[0].update.delta.quantization, undefined);
  assert.deepEqual(out[0].update.delta.parameters, undefined, "no local parameterSize to compare");
  assert.equal(out[0].update.requiresOllama, "0.30.0");
  assert.equal(out[0].update.satisfiable, true);
});

test("ten up-to-date models cost ten requests, not twenty", async () => {
  const { impl, calls } = fakeFetch({
    "/manifests/": { headers: { "ollama-content-digest": DIGEST_A } },
  });
  const models = Array.from({ length: 10 }, (_, i) => installed(`m${i}:latest`, DIGEST_A));
  await checkModelUpdates(models, { fetchImpl: impl });
  assert.equal(calls.length, 10);
  assert.ok(calls.every((c) => c.method === "HEAD"));
});

test("concurrency is bounded — a user with 30 models does not open 30 sockets", async () => {
  let inFlight = 0;
  let peak = 0;
  const impl: FetchLike = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return {
      ok: true,
      status: 200,
      headers: { get: () => DIGEST_A },
      text: async () => "",
    };
  };
  const models = Array.from({ length: 30 }, (_, i) => installed(`m${i}:latest`, DIGEST_A));
  await checkModelUpdates(models, { fetchImpl: impl });
  assert.ok(peak <= PROBE_CONCURRENCY, `peak in-flight was ${peak}, cap is ${PROBE_CONCURRENCY}`);
});

test("results keep INPUT ORDER, so a caller can zip them against its own list", async () => {
  const { impl } = fakeFetch({ "/manifests/": { headers: { "ollama-content-digest": DIGEST_A } } });
  const names = ["a:1", "b:2", "c:3", "d:4", "e:5"];
  const out = await checkModelUpdates(
    names.map((n) => installed(n, DIGEST_A)),
    { fetchImpl: impl },
  );
  assert.deepEqual(
    out.map((r) => (r.ok ? r.update.model : r.model)),
    names,
  );
});

/* ── every model is accounted for, including the ones not checked ───────────────────────────*/

test("a side-loaded model is SKIPPED, not silently dropped and not fetched", async () => {
  // "This model was not checked" is information the user is entitled to; an omission reads as
  // "up to date".
  const { impl, calls } = fakeFetch({});
  const out = await checkModelUpdates([installed("../nope", DIGEST_A)], { fetchImpl: impl });
  assert.equal(calls.length, 0, "an unparseable ref must never reach the network");
  assert.deepEqual(out, [{ ok: false, model: "../nope", reason: "unparseable-ref" }]);
});

test("a 404 is a normal outcome — a withdrawn or private tag, not a failure", async () => {
  const { impl } = fakeFetch({ "/manifests/": { status: 404 } });
  const out = await checkModelUpdates([installed("gone:latest", DIGEST_A)], { fetchImpl: impl });
  assert.deepEqual(out, [{ ok: false, model: "gone:latest", reason: "not-found" }]);
});

test("ONE broken model does not take down the sweep", async () => {
  const impl: FetchLike = async (url, init) => {
    if (url.includes("boom")) throw new Error("socket hang up");
    return {
      ok: true,
      status: 200,
      headers: { get: () => (init?.method === "HEAD" ? DIGEST_A : null) },
      text: async () => "",
    };
  };
  const out = await checkModelUpdates(
    [
      installed("ok1:latest", DIGEST_A),
      installed("boom:latest", DIGEST_A),
      installed("ok2:latest", DIGEST_A),
    ],
    { fetchImpl: impl },
  );
  assert.equal(out[0]?.ok, true);
  assert.deepEqual(out[1], { ok: false, model: "boom:latest", reason: "unreachable" });
  assert.equal(out[2]?.ok, true);
});

test("a proxy that STRIPS the digest header falls back to the body instead of giving up", async () => {
  // A mirror or corporate proxy may drop `ollama-content-digest`. That must degrade to the GET
  // path, not read as "unreachable" — which would make the feature look broken on those networks.
  const body = manifestBody(22e9);
  const { impl, calls } = fakeFetch({
    "/manifests/": { body }, // 200 with NO digest header
    "/blobs/": { body: CONFIG_BODY },
  });
  const out = await checkModelUpdates([installed("qwen3.6:latest", DIGEST_A)], { fetchImpl: impl });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["HEAD", "GET", "GET"],
  );
  assert.equal(out[0]?.ok, true);
  // the digest now comes from hashing the body, and differs from the local one
  assert.equal(out[0]?.ok === true && out[0].update.changed, true);
  assert.equal(out[0]?.ok === true && out[0].update.remoteDigest, u.manifestDigest(body));
});

test("a missing CONFIG blob loses detail but keeps the verdict", async () => {
  // Partial beats nothing: the size and the digest still stand, `requires` is simply unknown,
  // and core treats unknown as satisfiable.
  const { impl } = fakeFetch({
    "/manifests/": { headers: { "ollama-content-digest": DIGEST_B }, body: manifestBody(22e9) },
    "/blobs/": { status: 500 },
  });
  const out = await checkModelUpdates([installed("qwen3.6:latest", DIGEST_A)], {
    fetchImpl: impl,
    ollamaVersion: "0.1.0",
  });
  assert.equal(out[0]?.ok, true);
  if (out[0]?.ok !== true) return;
  assert.equal(out[0].update.changed, true);
  assert.equal(out[0].update.requiresOllama, undefined);
  assert.equal(out[0].update.satisfiable, true, "unknown requirement must not block");
});

test("garbage in the manifest body is reported as bad-manifest, never as an update", async () => {
  const { impl } = fakeFetch({ "/manifests/": { body: "<html>502</html>" } });
  const out = await checkModelUpdates([installed("x:latest", DIGEST_A)], { fetchImpl: impl });
  assert.deepEqual(out, [{ ok: false, model: "x:latest", reason: "bad-manifest" }]);
});

/* ── the push-time pass-through ─────────────────────────────────────────────────────────────*/

/**
 * The push time is carried from the HEAD, because the GET does not send it.
 *
 * MEASURED against the live registry: `ollama-push-time` comes back on `HEAD /manifests/...`
 * and is ABSENT from the `GET`. The first version of this seam read it only from the build it
 * fetched, so it was `undefined` for every model that had changed — the only models the
 * question is ever asked about.
 *
 * Every test here passed through that bug, because a hand-written fake serves whatever headers
 * it is given on both verbs. So this one deliberately does NOT: the header exists on the HEAD
 * and is missing from the GET, exactly as the real registry behaves.
 */
test("push time is taken from the HEAD even though the GET omits it", async () => {
  const pushed = String(Math.floor(Date.parse("2026-09-01") / 1000));
  const calls: string[] = [];
  const impl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push(method);
    const isManifest = url.includes("/manifests/");
    const headers: Record<string, string> =
      isManifest && method === "HEAD"
        ? { "ollama-content-digest": DIGEST_B, "ollama-push-time": pushed }
        : {}; // ← the GET carries NEITHER, like the real thing
    return {
      ok: true,
      status: 200,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => (isManifest ? manifestBody(22e9) : CONFIG_BODY),
    };
  };
  const out = await checkModelUpdates(
    [installed("qwen3.6:latest", DIGEST_A, { modifiedAt: "2026-07-24T05:25:11Z" })],
    { fetchImpl: impl, ollamaVersion: "0.34.1" },
  );
  assert.deepEqual(calls, ["HEAD", "GET", "GET"]);
  assert.equal(out[0]?.ok === true && out[0].update.pushedAt, Date.parse("2026-09-01"));
  assert.equal(
    out[0]?.ok === true && out[0].update.newer,
    true,
    "the HEAD's push time must survive the fall-through to the GET",
  );
});

test("push time on the manifest GET is still honoured if the registry ever sends it", async () => {
  const { impl } = fakeFetch({
    "/manifests/": {
      headers: {
        "ollama-content-digest": DIGEST_B,
        "ollama-push-time": String(Math.floor(Date.parse("2026-09-01") / 1000)),
      },
      body: manifestBody(22e9),
    },
    "/blobs/": { body: CONFIG_BODY },
  });
  const out = await checkModelUpdates(
    [installed("qwen3.6:latest", DIGEST_A, { modifiedAt: "2026-07-24T05:25:11Z" })],
    { fetchImpl: impl, ollamaVersion: "0.34.1" },
  );
  assert.equal(out[0]?.ok === true && out[0].update.newer, true);
});

/* ── the individual seams ───────────────────────────────────────────────────────────────────*/

test("headManifest reports each failure shape distinctly", async () => {
  const ref = u.parseModelRef("gemma4:12b") as u.ModelRef;
  const cases: [
    Record<string, never> | { status?: number; headers?: Record<string, string> },
    unknown,
  ][] = [
    [{ status: 404 }, { skip: "not-found" }],
    [{ status: 500 }, { skip: "unreachable" }],
    [{ status: 200 }, { skip: "bad-manifest" }],
    [{ status: 200, headers: { "ollama-content-digest": DIGEST_A } }, { digest: DIGEST_A }],
  ];
  for (const [route, want] of cases) {
    const { impl } = fakeFetch({ "/manifests/": route as never });
    assert.deepEqual(await headManifest(ref, { fetchImpl: impl }), want);
  }
});

test("fetchBuild returns the manifest even when the config blob digest is malformed", async () => {
  const body = JSON.stringify({
    schemaVersion: 2,
    config: { digest: "not-a-digest" },
    layers: [{ mediaType: "m", digest: "sha256:l", size: 5 }],
  });
  const { impl, calls } = fakeFetch({ "/manifests/": { body } });
  const ref = u.parseModelRef("gemma4:12b") as u.ModelRef;
  const out = await fetchBuild(ref, { fetchImpl: impl });
  assert.ok(!("skip" in out));
  assert.equal(calls.length, 1, "a malformed config digest must not produce a blob request");
});

test("fetchOllamaVersion reads the daemon, and is undefined when it cannot", async () => {
  const ok = fakeFetch({ "/api/version": { body: '{"version":"0.34.1"}' } });
  assert.equal(await fetchOllamaVersion(undefined, { fetchImpl: ok.impl }), "0.34.1");

  for (const route of [
    { status: 500 },
    { body: "not json" },
    { body: '{"version":""}' },
    { body: "{}" },
  ]) {
    const bad = fakeFetch({ "/api/version": route as never });
    assert.equal(await fetchOllamaVersion(undefined, { fetchImpl: bad.impl }), undefined);
  }
});
