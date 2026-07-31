/**
 * endpoints.test.ts — node:test for the PURE Model-Hub endpoint helpers (file 07 §7.5).
 *
 * Pins the PRIVACY-critical locality classification (only loopback/unix/.local are
 * "local"; an unparseable URL fails safe to "cloud") and the defensive flattening that
 * must survive an ok-but-partial endpoints payload. Pure — no react — runs under node.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { localityOf, toEndpoints } from "./endpoints.js";

test("localityOf: loopback / unix / .local are local, the rest is cloud", () => {
  assert.equal(localityOf("http://localhost:11434"), "local");
  assert.equal(localityOf("http://127.0.0.1:8080"), "local");
  assert.equal(localityOf("http://[::1]:1234"), "local");
  assert.equal(localityOf("http://0.0.0.0:5000"), "local");
  assert.equal(localityOf("unix:/tmp/sock"), "local");
  assert.equal(localityOf("http://box.local:1234"), "local");
  assert.equal(localityOf("https://api.openai.com"), "cloud");
  assert.equal(localityOf("https://example.com/v1"), "cloud");
});

test("localityOf: an unparseable URL fails safe to cloud", () => {
  assert.equal(localityOf("not a url"), "cloud");
  assert.equal(localityOf(""), "cloud");
});

test("toEndpoints: flattens local + openApi, derives locality, local first", () => {
  const res = {
    ok: true as const,
    local: [{ name: "qwen3:8b", baseUrl: "http://localhost:11434" }],
    openApi: [{ name: "remote-gpt", baseUrl: "https://api.openai.com" }],
  };
  const eps = toEndpoints(res as never);
  assert.equal(eps.length, 2);
  assert.equal(eps[0]?.id, "qwen3:8b");
  assert.equal(eps[0]?.locality, "local");
  assert.equal(eps[1]?.locality, "cloud");
});

test("toEndpoints: ok-but-partial / not-ok payloads don't throw", () => {
  assert.deepEqual(toEndpoints({ ok: true } as never), []);
  assert.deepEqual(toEndpoints({ ok: false } as never), []);
  assert.deepEqual(toEndpoints(undefined), []);
});

/* ── APP-092: model-picker metadata ──────────────────────────────────────────*/

import {
  type CatalogModelLite,
  endpointMeta,
  formatContextWindow,
  matchCatalog,
} from "./endpoints.js";

const CATALOG: CatalogModelLite[] = [
  { id: "qwen2.5-coder-7b", family: "qwen2.5", contextLen: 131072, tags: ["coding", "tool-use"] },
  { id: "llava-1.6", family: "llava", contextLen: 4096, tags: ["vision", "multimodal"] },
  { id: "llama-3.1-8b", family: "llama3", contextLen: 128000, tags: ["chat"] },
];

test("matchCatalog: exact id, then family/substring on the served name", () => {
  assert.equal(
    matchCatalog({ id: "x", baseUrl: "u", locality: "local", model: "qwen2.5-coder-7b" }, CATALOG)
      ?.id,
    "qwen2.5-coder-7b",
  );
  // a served name like "qwen2.5-coder:7b-instruct" matches by family substring.
  assert.equal(
    matchCatalog({ id: "qwen2.5-coder:7b-instruct", baseUrl: "u", locality: "local" }, CATALOG)
      ?.family,
    "qwen2.5",
  );
  assert.equal(
    matchCatalog({ id: "unknown-model", baseUrl: "u", locality: "cloud" }, CATALOG),
    undefined,
  );
});

test("endpointMeta: locality + context + caps (tools/vision/fim) from the catalog", () => {
  const coder = endpointMeta(
    { id: "qwen2.5-coder-7b", baseUrl: "http://localhost:11434", locality: "local" },
    CATALOG,
  );
  assert.equal(coder.locality, "local");
  assert.equal(coder.contextWindow, 131072);
  assert.equal(coder.caps.tools, true); // tool-use tag
  assert.equal(coder.caps.fim, true); // qwen family → FIM
  assert.equal(coder.caps.vision, false);

  const vlm = endpointMeta(
    { id: "llava-1.6", baseUrl: "https://api.x.com", locality: "cloud" },
    CATALOG,
  );
  assert.equal(vlm.caps.vision, true);
  assert.equal(vlm.caps.fim, false); // llava is not a FIM family

  // no catalog match → still returns a meta (caps from name heuristics), no throw.
  const bare = endpointMeta(
    { id: "mystery", baseUrl: "http://localhost:1", locality: "local" },
    [],
  );
  assert.equal(bare.locality, "local");
  assert.equal(bare.contextWindow, undefined);
});

test("formatContextWindow: K/M compaction", () => {
  assert.equal(formatContextWindow(32768), "33K");
  assert.equal(formatContextWindow(128000), "128K");
  assert.equal(formatContextWindow(1_000_000), "1M");
  assert.equal(formatContextWindow(0), undefined);
  assert.equal(formatContextWindow(undefined), undefined);
});
