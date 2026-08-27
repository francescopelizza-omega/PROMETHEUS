/**
 * model-candidates.test.ts — the switchable chat-model list behind `/model` (alias `/worker`).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type CloudCandidateSource,
  modelCandidates,
  renderModelCandidates,
  resolveModelCandidate,
} from "./model-candidates.js";
import type { Backends } from "./onboarding.js";

const BACKENDS: Backends = {
  liveRunners: [
    {
      name: "ollama",
      baseUrl: "http://localhost:11434/v1",
      models: ["qwen2.5-coder:7b", "llama3.1:8b"],
    },
    { name: "lmstudio", baseUrl: "http://localhost:1234/v1", models: ["phi4-mini"] },
  ],
  localRunner: {
    name: "ollama",
    baseUrl: "http://localhost:11434/v1",
    models: ["qwen2.5-coder:7b", "llama3.1:8b"],
  },
  localEndpoint: {
    id: "local:ollama:qwen2.5-coder:7b",
    baseUrl: "http://localhost:11434/v1",
    locality: "local",
    contextWindow: 8192,
    supportsTools: true,
    model: "qwen2.5-coder:7b",
  },
  paidClis: ["claude"],
};

const CLOUD: CloudCandidateSource[] = [
  {
    endpoint: {
      id: "cloud:anthropic:claude-opus",
      baseUrl: "https://api.anthropic.com",
      locality: "cloud",
      contextWindow: 200_000,
      supportsTools: true,
      model: "claude-opus",
      apiKeyRef: "env:ANTHROPIC_API_KEY",
    },
    label: "claude-opus (anthropic)",
    providerId: "anthropic",
  },
];

test("modelCandidates: every served local model is its own candidate, never just liveRunners[0].models[0]", () => {
  const cands = modelCandidates(BACKENDS, [], undefined);
  assert.deepEqual(
    cands.map((c) => c.label),
    ["qwen2.5-coder:7b", "llama3.1:8b", "phi4-mini"],
  );
  assert.equal(cands[0]?.model.provider, "ollama");
  assert.equal(cands[2]?.model.provider, "lmstudio");
});

test("modelCandidates: paid CLIs are excluded — they launch a separate nested chat, not a model swap", () => {
  const cands = modelCandidates(BACKENDS, [], undefined);
  assert.ok(!cands.some((c) => c.label === "claude"));
});

test("modelCandidates: cloud endpoints are included, carrying the real providerId", () => {
  const cands = modelCandidates(BACKENDS, CLOUD, undefined);
  const cloud = cands.find((c) => c.detail === "cloud");
  assert.ok(cloud, "expected a cloud candidate");
  assert.equal(cloud?.model.provider, "anthropic");
  assert.equal(cloud?.model.modelId, "claude-opus");
});

test("modelCandidates: the active endpoint id is marked current", () => {
  const cands = modelCandidates(BACKENDS, [], "local:ollama:llama3.1:8b");
  assert.equal(cands.find((c) => c.label === "llama3.1:8b")?.current, true);
  assert.equal(cands.find((c) => c.label === "qwen2.5-coder:7b")?.current, false);
});

test("resolveModelCandidate: exact id, then exact label, then a substring match", () => {
  const cands = modelCandidates(BACKENDS, CLOUD, undefined);
  assert.equal(resolveModelCandidate(cands, "local:ollama:llama3.1:8b")?.label, "llama3.1:8b");
  assert.equal(resolveModelCandidate(cands, "phi4-mini")?.label, "phi4-mini");
  assert.equal(resolveModelCandidate(cands, "claude")?.detail, "cloud");
  assert.equal(resolveModelCandidate(cands, "no-such-model"), undefined);
  assert.equal(resolveModelCandidate(cands, ""), undefined);
});

test("renderModelCandidates: numbers the list and marks the current one", () => {
  const cands = modelCandidates(BACKENDS, [], "local:ollama:qwen2.5-coder:7b");
  const text = renderModelCandidates(cands);
  assert.match(text, /1\) qwen2\.5-coder:7b.*← current/);
  assert.match(text, /2\) llama3\.1:8b/);
});

test("renderModelCandidates: an empty list points at /setup instead of printing nothing", () => {
  assert.match(renderModelCandidates([]), /\/setup/);
});
