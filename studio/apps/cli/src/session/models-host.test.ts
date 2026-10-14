/**
 * models-host.test.ts — the IO behind `/models`, with every seam injected.
 *
 * No keychain, no network, no Ollama: the secrets store, the fetch and the three Ollama calls
 * are fakes. What matters most: a key is VERIFIED before it is stored, a keyless provider sends
 * no credential, and a remembered pick is only restored when it can answer right now.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type AiEndpoint, type FetchLike, ai } from "@prometheus/core";

import { createModelsHost, modelChoicePath, readModelChoice } from "./models-host.js";
import type { Backends } from "./onboarding.js";

function backends(runners: Backends["liveRunners"] = []): Backends {
  return {
    liveRunners: runners,
    paidClis: [],
    startedRunners: new Set(),
    unavailableRunners: [],
  } as unknown as Backends;
}

function make(
  opts: { fetch?: FetchLike; env?: Record<string, string>; runners?: Backends["liveRunners"] } = {},
) {
  const stored = new Map<string, string>();
  const adopted: { ep: AiEndpoint; model: { provider: string; modelId: string } }[] = [];
  const cloudEndpoints: ai.CloudEndpointInfo[] = [];
  const keychain = new Set<string>();
  const home = mkdtempSync(join(tmpdir(), "models-host-"));
  const be = backends(opts.runners);
  const host = createModelsHost({
    home,
    env: opts.env ?? { PATH: "" },
    backends: be,
    cloudEndpoints,
    keychainProviders: keychain,
    adoptEndpoint: async (ep, model) => {
      adopted.push({ ep, model });
    },
    activeId: () => undefined,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    secretsStore: {
      set: async (_s, a, v) => {
        stored.set(a, v);
      },
      get: async (_s, a) => stored.get(a),
      delete: async (_s, a) => {
        stored.delete(a);
      },
    },
    machine: () => ({ ramGb: 36, vramGb: 0, unified: true }),
    ollamaTags: async () => [],
    ensureOllama: async () => ({ started: true }),
    pullTag: async () => ({ ok: true }),
    onPath: () => false,
  });
  return { host, stored, adopted, cloudEndpoints, keychain, home, be };
}

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  body: null,
  text: async () => JSON.stringify(body),
});

test("connectKey: a refused key is NOT stored (verify before write)", async () => {
  const { host, stored, keychain } = make({ fetch: async () => res(401, { error: "bad" }) });
  const r = await host.connectKey("groq", "gsk_wrong");
  assert.equal(r.ok, false);
  assert.equal(stored.size, 0);
  assert.equal(keychain.has("groq"), false);
});

test("connectKey: a good key is stored, discovery refreshed in place, live list returned", async () => {
  const seen: string[] = [];
  const { host, stored, cloudEndpoints, keychain } = make({
    fetch: async (url, init) => {
      seen.push(`${url} ${init.headers.authorization ?? ""}`);
      return res(200, { data: [{ id: "llama-3.3-70b-versatile" }] });
    },
  });
  const r = await host.connectKey("groq", "  gsk_ok  ");
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.live, ["llama-3.3-70b-versatile"]);
  assert.equal(stored.get("provider:groq"), "gsk_ok", "trimmed");
  assert.ok(keychain.has("groq"));
  assert.ok(
    cloudEndpoints.some((e) => e.providerId === "groq"),
    "the /model list sees it at once",
  );
  assert.equal(seen[0], "https://api.groq.com/openai/v1/models Bearer gsk_ok");
});

test("adopt: a keyless free tier gets an endpoint with NO apiKeyRef", async () => {
  const { host, adopted } = make();
  const r = await host.adopt({ section: "free", providerId: "ovhcloud", model: "gpt-oss-120b" });
  assert.equal(r.ok, true);
  assert.equal(adopted[0]?.ep.apiKeyRef, undefined);
  assert.equal(adopted[0]?.ep.locality, "cloud");
});

test("adopt: an env key is referenced by name, never copied", async () => {
  const { host, adopted } = make({ env: { PATH: "", NVIDIA_API_KEY: "nvapi-secret" } });
  await host.adopt({
    section: "free",
    providerId: "nvidia",
    model: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  });
  assert.equal(adopted[0]?.ep.apiKeyRef, "env:NVIDIA_API_KEY");
  assert.ok(!JSON.stringify(adopted[0]?.ep).includes("nvapi-secret"));
  assert.deepEqual(adopted[0]?.model, {
    provider: "nvidia",
    modelId: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  });
});

test("adopt: a provider with no key is refused, not adopted", async () => {
  const { host, adopted } = make();
  const r = await host.adopt({
    section: "paid",
    providerId: "anthropic",
    model: "claude-sonnet-5-5",
  });
  assert.equal(r.ok, false);
  assert.equal(adopted.length, 0);
});

test("adopt: the rotation endpoint carries its members (keyless tier at least)", async () => {
  const { host, adopted } = make();
  const r = await host.adopt({ section: "rotation" });
  assert.equal(r.ok, true);
  assert.equal(adopted[0]?.ep.id, ai.ROTATION_ENDPOINT_ID);
  assert.ok((adopted[0]?.ep.rotation ?? []).length > 0);
});

test("restore: a local pick only when served NOW; a free pick only with a key", () => {
  const off = make();
  assert.equal(off.host.restore("local:qwen3-8b"), undefined, "nothing serving");
  const on = make({
    runners: [{ name: "ollama", baseUrl: "http://localhost:11434/v1", models: ["qwen3:8b"] }],
  });
  assert.equal(on.host.restore("local:qwen3-8b")?.endpoint.model, "qwen3:8b");
  assert.equal(on.host.restore("free:groq:llama-3.3-70b-versatile"), undefined, "no key");
  assert.equal(
    make({ env: { PATH: "", GROQ_API_KEY: "x" } }).host.restore("free:groq:llama-3.3-70b-versatile")
      ?.endpoint.model,
    "llama-3.3-70b-versatile",
  );
  assert.equal(on.host.restore(undefined), undefined);
  assert.equal(on.host.restore("garbage"), undefined);
});

test("restore: PAID and SPINNER picks never come back on their own — a hint says how", () => {
  const { host } = make({ env: { PATH: "", ANTHROPIC_API_KEY: "x" } });
  assert.equal(
    host.restore("paid:anthropic:claude-sonnet-5-5"),
    undefined,
    "metered: needs a fresh yes",
  );
  assert.equal(host.restore("rotation"), undefined, "several providers: needs a fresh yes");
  assert.match(
    host.restoreHint("paid:anthropic:claude-sonnet-5-5") ?? "",
    /\/models use paid:anthropic:claude-sonnet-5-5/,
  );
  assert.match(host.restoreHint("rotation") ?? "", /several providers/);
  assert.equal(host.restoreHint("local:qwen3-8b"), undefined);
});

test("saveChoice writes a private file readModelChoice reads back", () => {
  const { host, home } = make();
  host.saveChoice("free:groq:llama-3.3-70b-versatile");
  assert.equal(readModelChoice(home), "free:groq:llama-3.3-70b-versatile");
  const json = JSON.parse(readFileSync(modelChoicePath(home), "utf8"));
  assert.equal(json.ref, "free:groq:llama-3.3-70b-versatile");
  if (process.platform !== "win32") assert.equal(statSync(modelChoicePath(home)).mode & 0o077, 0);
});

test("pull: records the tag on the ollama runner so /model lists it without a restart", async () => {
  const { host, be } = make({
    runners: [{ name: "ollama", baseUrl: "http://localhost:11434/v1", models: [] }],
  });
  const r = await host.pull("qwen3:8b", () => {});
  assert.equal(r.ok, true);
  assert.deepEqual(be.liveRunners[0]?.models, ["qwen3:8b"]);
});

test("context: Ollama counts as installed only with evidence (runner, tags, or binary)", async () => {
  const { host } = make();
  const ctx = await host.context();
  assert.equal(ctx.ollamaInstalled, false);
  assert.equal(ctx.ollamaServing, false);
  assert.equal(ctx.machine.ramGb, 36);
});
