/**
 * runner-census.test.ts — who is up, and what are they holding?
 *
 * Every probe is over HTTP with an injected fetch, which is also why the same code answers for
 * a remote host: there is nothing local in it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type RunnerProbe,
  parseOllamaPs,
  parseOpenAiModels,
  probeRunner,
  residentBytes,
  runnerCensus,
} from "./runner-census.js";

/** A real `/api/ps` row shape. */
const PS = {
  models: [
    {
      name: "qwen3.6:latest",
      model: "qwen3.6:latest",
      size: 26_843_545_600,
      size_vram: 26_843_545_600,
      context_length: 262144,
    },
  ],
};

const okFetch = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

test("ollama /api/ps yields the resident model with its size and context", () => {
  const [m] = parseOllamaPs(PS);
  assert.equal(m?.id, "qwen3.6:latest");
  assert.equal(m?.sizeBytes, 26_843_545_600);
  assert.equal(m?.vramBytes, 26_843_545_600);
  assert.equal(m?.contextTokens, 262144);
});

test("an idle ollama answers with an empty list, which is not the same as being down", () => {
  assert.deepEqual(parseOllamaPs({ models: [] }), []);
  assert.deepEqual(parseOllamaPs({}), []);
  assert.deepEqual(parseOllamaPs(null), []);
});

test("a row missing its size still counts as resident", () => {
  // The one-server rule only needs to know something is loaded; a missing size must not make a
  // loaded model invisible.
  const [m] = parseOllamaPs({ models: [{ name: "x" }] });
  assert.equal(m?.id, "x");
  assert.equal(m?.sizeBytes, 0);
});

test("an OpenAI-shaped runner reports ids but no sizes, and says so by reporting 0", () => {
  const rows = parseOpenAiModels({ data: [{ id: "a" }, { id: "b" }, { nope: 1 }] });
  assert.deepEqual(rows, [
    { id: "a", sizeBytes: 0 },
    { id: "b", sizeBytes: 0 },
  ]);
});

test("a runner that does not answer is ABSENT, never an error", async () => {
  const dead: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const s = await probeRunner(
    { id: "ollama", baseUrl: "http://127.0.0.1:11434", api: "ollama" },
    {
      fetchFn: dead,
    },
  );
  assert.equal(s.up, false);
  assert.deepEqual(s.models, []);
});

test("a non-200 is also absent — a census must not block the load it exists to permit", async () => {
  const bad: typeof fetch = (async () => ({
    ok: false,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  assert.equal(
    (await probeRunner({ id: "x", baseUrl: "http://h", api: "ollama" }, { fetchFn: bad })).up,
    false,
  );
});

test("a /v1 suffix on the baseUrl is stripped before the probe path is appended", async () => {
  let asked = "";
  const spy: typeof fetch = (async (u: string) => {
    asked = String(u);
    return { ok: true, json: async () => PS };
  }) as unknown as typeof fetch;
  await probeRunner(
    { id: "ollama", baseUrl: "http://h:11434/v1", api: "ollama" },
    { fetchFn: spy },
  );
  assert.equal(asked, "http://h:11434/api/ps", "never http://h:11434/v1/api/ps");
});

test("the census returns only runners that answered, and can be aimed at a REMOTE host", async () => {
  const probes: RunnerProbe[] = [
    { id: "ollama", baseUrl: "http://gpu-box.lan:11434", api: "ollama" },
    { id: "lmstudio", baseUrl: "http://gpu-box.lan:1234", api: "openai" },
  ];
  let n = 0;
  const half: typeof fetch = (async (u: string) => {
    n++;
    if (String(u).includes(":1234")) throw new Error("down");
    return { ok: true, json: async () => PS };
  }) as unknown as typeof fetch;
  const census = await runnerCensus(probes, { fetchFn: half, host: "gpu-box.lan" });
  assert.equal(n, 2, "both were asked");
  assert.equal(census.length, 1, "only the one that answered is reported");
  assert.equal(census[0]?.runner, "ollama");
  assert.equal(census[0]?.host, "gpu-box.lan", "the census is labelled with the host it describes");
  assert.equal(residentBytes(census), 26_843_545_600);
});

test("residentBytes sums across runners", () => {
  assert.equal(
    residentBytes([
      { runner: "a", baseUrl: "", up: true, models: [{ id: "1", sizeBytes: 10 }] },
      {
        runner: "b",
        baseUrl: "",
        up: true,
        models: [
          { id: "2", sizeBytes: 5 },
          { id: "3", sizeBytes: 1 },
        ],
      },
    ]),
    16,
  );
  assert.equal(residentBytes([]), 0);
});
