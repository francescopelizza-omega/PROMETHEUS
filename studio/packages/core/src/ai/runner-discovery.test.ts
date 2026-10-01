// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * runner-discovery.test.ts — the machine scan, with no machine.
 *
 * Every case here injects `fetch` and `which`, so this suite reaches no daemon and consults no
 * PATH. That is not just hygiene: a probe suite that could touch `:11434` is exactly the shape
 * that cost 23 GB of resident weights in `session-bridge.test.ts` (CLAUDE.md §2.3), and the
 * fixtures below double as the proof that discovery only ever issues metadata reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type DiscoveredRunner,
  describeProbeFailure,
  discoverRunners,
  modelsFromOpenAiList,
  modelsFromTags,
  nextStepHint,
  servedModelOptions,
} from "./runner-discovery.js";

const NO_ENV: Record<string, string | undefined> = {};

/** A fetch that answers only the URLs in `routes`; everything else behaves like a closed port. */
function fetchFor(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (!(url in routes)) throw new Error("connect ECONNREFUSED");
    return {
      ok: true,
      status: 200,
      json: async () => routes[url],
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const DEAD: typeof fetch = (async () => {
  throw new Error("connect ECONNREFUSED");
}) as unknown as typeof fetch;

/* ── parsers ─────────────────────────────────────────────────────────────── */

test("modelsFromTags reads ollama's NATIVE shape, tag included", () => {
  assert.deepEqual(
    modelsFromTags({ models: [{ name: "qwen3.6:latest" }, { name: "gemma4:27b" }] }),
    ["qwen3.6:latest", "gemma4:27b"],
  );
});

test("modelsFromTags falls back to `model` when a build omits `name`", () => {
  assert.deepEqual(modelsFromTags({ models: [{ model: "qwen3.6:latest" }] }), ["qwen3.6:latest"]);
});

test("the parsers yield [] on any unexpected shape rather than throwing", () => {
  for (const junk of [undefined, null, {}, { models: "nope" }, { data: 7 }, "text", 42]) {
    assert.deepEqual(modelsFromTags(junk), []);
    assert.deepEqual(modelsFromOpenAiList(junk), []);
  }
});

test("modelsFromOpenAiList reads the /v1/models shape", () => {
  assert.deepEqual(modelsFromOpenAiList({ data: [{ id: "a" }, { id: "b" }, { id: "" }] }), [
    "a",
    "b",
  ]);
});

/* ── the scan ────────────────────────────────────────────────────────────── */

test("discoverRunners returns a row for EVERY runner, including the absent ones", async () => {
  // A missing row and an absent runner render identically to a user who cannot see the code.
  // "vLLM: absent" is the information; silence is the static table again.
  const rows = await discoverRunners({ fetchFn: DEAD, env: NO_ENV });
  assert.deepEqual(rows.map((r) => r.id).sort(), ["llamacpp", "lmstudio", "ollama", "vllm"]);
  assert.ok(rows.every((r) => r.state === "absent"));
  assert.ok(rows.every((r) => r.models.length === 0));
});

test("a runner that answers is `serving` and carries its real model list", async () => {
  const rows = await discoverRunners({
    env: NO_ENV,
    fetchFn: fetchFor({
      "http://localhost:11434/api/tags": { models: [{ name: "qwen3.6:latest" }] },
    }),
  });
  const ollama = rows.find((r) => r.id === "ollama");
  assert.equal(ollama?.state, "serving");
  assert.deepEqual(ollama?.models, ["qwen3.6:latest"]);
  assert.equal(ollama?.detail, undefined);
  // The others are untouched by one runner being up.
  assert.ok(rows.filter((r) => r.id !== "ollama").every((r) => r.state === "absent"));
});

test("ollama is probed on its NATIVE /api/tags, never on a route that loads weights", async () => {
  const seen: string[] = [];
  const spy: typeof fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;

  await discoverRunners({ fetchFn: spy, env: NO_ENV });

  assert.ok(seen.includes("http://localhost:11434/api/tags"), seen.join(", "));
  // The three routes that make ollama page in the weights before it can answer. If one of them
  // ever shows up here, a "liveness check" has started costing gigabytes — see CLAUDE.md §2.3.
  for (const forbidden of ["/chat/completions", "/api/generate", "/api/embeddings"]) {
    assert.ok(
      !seen.some((u) => u.includes(forbidden)),
      `discovery must never request ${forbidden} — saw ${seen.join(", ")}`,
    );
  }
  // And every request is a GET-shaped metadata read of a listing route.
  assert.ok(
    seen.every((u) => u.endsWith("/api/tags") || u.endsWith("/models")),
    seen.join(", "),
  );
});

test("a binary on PATH with nothing listening is `installed`, not `absent`", async () => {
  // These need different UI: "Start" versus "Install". Collapsing them is how a user ends up
  // reinstalling something they already have.
  const rows = await discoverRunners({
    fetchFn: DEAD,
    env: NO_ENV,
    whichFn: async (bin) => (bin === "ollama" ? "/opt/homebrew/bin/ollama" : undefined),
  });
  const ollama = rows.find((r) => r.id === "ollama");
  assert.equal(ollama?.state, "installed");
  assert.equal(ollama?.binPath, "/opt/homebrew/bin/ollama");
  assert.equal(ollama?.canStart, true);
  assert.equal(rows.find((r) => r.id === "vllm")?.state, "absent");
});

test("canStart needs BOTH a start argv and the binary — an argv we cannot find is not a button", async () => {
  const rows = await discoverRunners({
    fetchFn: DEAD,
    env: NO_ENV,
    // llama-server IS present, but its spec has no `start` (it needs `-m <model>`).
    whichFn: async (bin) => (bin === "llama-server" ? "/opt/homebrew/bin/llama-server" : undefined),
  });
  const llamacpp = rows.find((r) => r.id === "llamacpp");
  assert.equal(llamacpp?.state, "installed");
  assert.equal(llamacpp?.canStart, false, "no start argv ⇒ no start button, however installed");
  assert.equal(llamacpp?.canInstall, true);
  // And the reverse: ollama HAS a start argv but is not on PATH.
  assert.equal(rows.find((r) => r.id === "ollama")?.canStart, false);
});

test("with no whichFn the scan still works — it just cannot tell `installed` from `absent`", async () => {
  const rows = await discoverRunners({ fetchFn: DEAD, env: NO_ENV });
  assert.ok(rows.every((r) => r.state === "absent" && r.canStart === false));
});

test("a whichFn that throws degrades to `absent` instead of failing the whole scan", async () => {
  const rows = await discoverRunners({
    fetchFn: DEAD,
    env: NO_ENV,
    whichFn: async () => {
      throw new Error("spawn EPERM");
    },
  });
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.state === "absent"));
});

test("an HTTP error is reported as a detail, not swallowed into a bare `absent`", async () => {
  const fetch403: typeof fetch = (async () =>
    ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response) as never;
  const rows = await discoverRunners({ fetchFn: fetch403, env: NO_ENV });
  assert.match(String(rows.find((r) => r.id === "ollama")?.detail), /HTTP 403/);
});

test("undici's generic `fetch failed` is unwrapped into the actual reason", () => {
  // Every transport failure arrives as `TypeError: fetch failed`; the reason is in `cause`.
  // Reading only the top-level message collapsed "nothing is installed", "the daemon is
  // wedged" and "you typed the hostname wrong" into one useless string — measured on a real
  // stopped LM Studio, which reported `fetch failed` while `lms` sat on PATH.
  const at = { host: "localhost", port: 1234 };
  const wrap = (code: string, message = code): unknown =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error(message), { code }),
    });

  assert.equal(
    describeProbeFailure(wrap("ECONNREFUSED"), at, 900),
    "nothing listening on localhost:1234",
  );
  assert.equal(describeProbeFailure(wrap("ENOTFOUND"), at, 900), "host localhost does not resolve");
  assert.equal(
    describeProbeFailure(wrap("EHOSTUNREACH"), at, 900),
    "localhost is unreachable from here",
  );
  assert.equal(
    describeProbeFailure(wrap("ETIMEDOUT"), at, 900),
    "localhost:1234 did not answer in time",
  );
});

test("an abort beats every cause code — the budget is the reason, whatever undici says", () => {
  const err = Object.assign(new Error("This operation was aborted"), {
    cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
  });
  assert.equal(
    describeProbeFailure(err, { host: "localhost", port: 1234 }, 42),
    "no answer within 42ms",
  );
});

test("an unrecognised failure keeps its text AND gains the address it was talking to", () => {
  const at = { host: "gpu-box", port: 11434 };
  assert.equal(
    describeProbeFailure(
      Object.assign(new TypeError("fetch failed"), { cause: new Error("TLS alert") }),
      at,
      900,
    ),
    "TLS alert (gpu-box:11434)",
  );
  // No cause at all: the top-level message still gets the address appended.
  assert.equal(describeProbeFailure(new Error("boom"), at, 900), "boom (gpu-box:11434)");
});

test("a probe that outruns its budget says so, and does not hang the scan", async () => {
  const slow: typeof fetch = ((_u: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
    })) as unknown as typeof fetch;
  const rows = await discoverRunners({ fetchFn: slow, env: NO_ENV, timeoutMs: 10 });
  assert.equal(rows.length, 4);
  assert.match(String(rows[0]?.detail), /no answer within 10ms/);
});

test("OLLAMA_HOST moves the probe — the Python side has honoured it all along, TS did not", async () => {
  const seen: string[] = [];
  const spy: typeof fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  const rows = await discoverRunners({
    fetchFn: spy,
    env: { OLLAMA_HOST: "gpu-box:11435" },
  });
  assert.ok(seen.includes("http://gpu-box:11435/api/tags"), seen.join(", "));
  assert.ok(!seen.includes("http://localhost:11434/api/tags"), "must not also probe the default");
  assert.equal(rows.find((r) => r.id === "ollama")?.baseUrl, "http://gpu-box:11435/v1");
});

/* ── projections ─────────────────────────────────────────────────────────── */

const SERVING: DiscoveredRunner = {
  id: "ollama",
  name: "Ollama",
  baseUrl: "http://localhost:11434/v1",
  host: "localhost",
  port: 11434,
  state: "serving",
  models: ["qwen3.6:latest", "gemma4:27b"],
  canStart: true,
  canInstall: true,
};

test("servedModelOptions offers only models something can actually answer with", () => {
  const stopped: DiscoveredRunner = {
    ...SERVING,
    id: "lmstudio",
    name: "LM Studio",
    state: "installed",
    // A stopped runner with a stale list is the exact trap: offering a model that cannot reply.
    models: ["ghost-model"],
  };
  assert.deepEqual(
    servedModelOptions([SERVING, stopped]).map((o) => `${o.runnerId}:${o.model}`),
    ["ollama:qwen3.6:latest", "ollama:gemma4:27b"],
  );
});

test("nextStepHint stays silent when something is serving", () => {
  assert.equal(nextStepHint([SERVING]), undefined);
});

test("nextStepHint prefers starting what is installed over installing something new", () => {
  const installed: DiscoveredRunner = {
    ...SERVING,
    state: "installed",
    models: [],
    canStart: true,
  };
  const absent: DiscoveredRunner = {
    ...SERVING,
    id: "lmstudio",
    name: "LM Studio",
    state: "absent",
    models: [],
    canStart: false,
  };
  assert.match(String(nextStepHint([absent, installed])), /installed but not running/);
});

test("nextStepHint falls back to an install offer, then to plain honesty", () => {
  const absent: DiscoveredRunner = {
    ...SERVING,
    state: "absent",
    models: [],
    canStart: false,
  };
  assert.match(String(nextStepHint([absent])), /can be installed for you/);
  assert.equal(
    nextStepHint([{ ...absent, canInstall: false }]),
    "No local model server found on this machine.",
  );
});
