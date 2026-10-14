/**
 * endpoint-wizard-merge.test.ts — the guided picker's cloud endpoints reach the chat menu,
 * with locality taken from the URL, never from the label.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeEndpoints, wizardToEndpoints } from "./endpoint-hook.js";

test("locality is re-derived from the URL (a 'local' label on a cloud host stays cloud)", () => {
  const eps = wizardToEndpoints([
    {
      id: "cloud:groq:x",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "x",
      locality: "local",
    },
    {
      id: "cloud:rotation:free",
      baseUrl: "https://free-rotation.prometheus.invalid/v1",
      model: "free-rotation",
      locality: "cloud",
      contextWindow: 131072,
    },
  ]);
  assert.deepEqual(
    eps.map((e) => e.locality),
    ["cloud", "cloud"],
  );
  assert.equal(eps[1]?.contextWindow, 131072);
});

test("merge keeps the engine's rows first and drops duplicate ids", () => {
  const base = [
    {
      id: "ollama · qwen3:8b",
      baseUrl: "http://localhost:11434/v1",
      locality: "local" as const,
      model: "qwen3:8b",
    },
  ];
  const extra = [
    { id: "ollama · qwen3:8b", baseUrl: "http://x/v1", locality: "cloud" as const },
    {
      id: "cloud:groq:x",
      baseUrl: "https://api.groq.com/openai/v1",
      locality: "cloud" as const,
      model: "x",
    },
  ];
  const out = mergeEndpoints(base, extra);
  assert.deepEqual(
    out.map((e) => e.id),
    ["ollama · qwen3:8b", "cloud:groq:x"],
  );
  assert.equal(out[0]?.baseUrl, "http://localhost:11434/v1");
  assert.deepEqual(wizardToEndpoints(undefined), []);
});
