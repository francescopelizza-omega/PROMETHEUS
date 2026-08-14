/**
 * api-backend.test.ts — the kind:"api" invoker (own-key OpenAI-compatible providers).
 * No network: the AI client factory is injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { orchestration as orch } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import { type InvokerDeps, makeInvoker } from "./backends.js";

const fakeEngine = (): EngineClient =>
  ({ runPrometheus: async () => ({ ok: true, response: "" }) }) as unknown as EngineClient;

/** A fake OpenAI-compatible client that records the endpoint + streams a canned reply. */
function fakeClientFactory(seen: { baseUrl?: string; model?: string; key?: string }) {
  return ((endpoint, _policy, deps) => {
    seen.baseUrl = endpoint.baseUrl;
    seen.model = endpoint.model;
    return {
      async *chat() {
        // resolve the key the way the real client would (proves the bearer wiring).
        if (deps?.resolveKey) seen.key = await deps.resolveKey(endpoint.apiKeyRef ?? "");
        yield { delta: "hello " };
        yield { delta: "from api", done: true };
      },
    };
  }) as unknown as NonNullable<InvokerDeps["aiClientFactory"]>;
}

function req(backend: orch.BackendRef) {
  return {
    agent: { name: "w", role: "work", backend },
    prompt: "do the thing",
    taskId: "t1",
    turn: 1,
  };
}

test("api backend streams via the injected client with the resolved key + endpoint", async () => {
  const seen: { baseUrl?: string; model?: string; key?: string } = {};
  const invoke = makeInvoker({
    client: fakeEngine(),
    aiClientFactory: fakeClientFactory(seen),
  });
  const backend = orch.apiBackendFor("together") as orch.BackendRef;
  // supply the key on the agent env (a dedicated per-agent key, never patches anything).
  backend.env = { TOGETHER_API_KEY: "sk-together-xyz" };
  const out = await invoke(req(backend));
  assert.equal(out.text, "hello from api");
  assert.match(seen.baseUrl ?? "", /together\.xyz/);
  assert.equal(seen.key, "sk-together-xyz");
});

test("api backend falls back to a process-env key var", async () => {
  const seen: { baseUrl?: string; model?: string; key?: string } = {};
  const prev = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "sk-groq-env";
  try {
    const invoke = makeInvoker({ client: fakeEngine(), aiClientFactory: fakeClientFactory(seen) });
    const out = await invoke(req(orch.apiBackendFor("groq") as orch.BackendRef));
    assert.equal(out.text, "hello from api");
    assert.equal(seen.key, "sk-groq-env");
  } finally {
    // NOTE: `env.X = undefined` would store the STRING "undefined" (a non-empty key);
    // use Reflect.deleteProperty to truly remove the var.
    if (prev === undefined) Reflect.deleteProperty(process.env, "GROQ_API_KEY");
    else process.env.GROQ_API_KEY = prev;
  }
});

test("api backend throws a helpful error when no key is set", async () => {
  const seen: { baseUrl?: string } = {};
  const invoke = makeInvoker({ client: fakeEngine(), aiClientFactory: fakeClientFactory(seen) });
  const backend = orch.apiBackendFor("fireworks") as orch.BackendRef;
  // ensure no ambient key leaks in (truly remove it, not set it to "undefined").
  const prev = process.env.FIREWORKS_API_KEY;
  Reflect.deleteProperty(process.env, "FIREWORKS_API_KEY");
  try {
    await assert.rejects(() => invoke(req(backend)), /no API key|FIREWORKS_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.FIREWORKS_API_KEY = prev;
  }
});

/* ── the run budget can only count what the invoker reports ────────────────*/

/**
 * `Coordinator` has always called `budget.addCost(out.costUsd)` — but this invoker returned a
 * bare `{ text }`, so `costUsd` was never a number, the counter never moved, and `overBudget()`
 * compared a permanent 0 against `RunLimits.maxCostUsd`. The ceiling read as enforced in review
 * and enforced nothing. This is the lane that spends real money, so both halves matter.
 */

/** A client that reports a usage frame, as a real provider does on the terminal chunk. */
function usageClientFactory(usage: { inputTokens: number; outputTokens: number }) {
  return ((endpoint, _policy, deps) => ({
    async *chat() {
      if (deps?.resolveKey) await deps.resolveKey(endpoint.apiKeyRef ?? "");
      yield { delta: "out" };
      yield { delta: "", done: true, usage: { ...usage, totalTokens: 0 } };
    },
  })) as unknown as NonNullable<InvokerDeps["aiClientFactory"]>;
}

const apiBackend = (model: string): orch.BackendRef => ({
  kind: "api",
  service: "groq",
  baseUrl: "https://api.example/v1",
  apiKeyEnv: "TEST_API_KEY",
  model,
});

test("a priced api call reports costUsd, so the run budget can count it", async () => {
  process.env.TEST_API_KEY = "k";
  try {
    const invoke = makeInvoker({
      client: fakeEngine(),
      // 1M in + 1M out on a model the shipped pricing table knows.
      aiClientFactory: usageClientFactory({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    });
    const out = await invoke(req(apiBackend("claude-opus-4")) as never);
    assert.equal(out.text, "out");
    assert.equal(typeof out.costUsd, "number", "the cost was dropped — the budget counts zero");
    assert.ok((out.costUsd ?? 0) > 0, `expected a positive cost, got ${String(out.costUsd)}`);
  } finally {
    Reflect.deleteProperty(process.env, "TEST_API_KEY");
  }
});

test("an UNPRICED model reports no cost rather than a free one", async () => {
  // Reporting 0 would be a measurement — "this call cost nothing". Absent keeps the counter
  // honest about what it cannot price.
  process.env.TEST_API_KEY = "k";
  try {
    const invoke = makeInvoker({
      client: fakeEngine(),
      aiClientFactory: usageClientFactory({ inputTokens: 100, outputTokens: 100 }),
    });
    const out = await invoke(req(apiBackend("some-model-nobody-priced")) as never);
    assert.equal(out.costUsd, undefined);
  } finally {
    Reflect.deleteProperty(process.env, "TEST_API_KEY");
  }
});
