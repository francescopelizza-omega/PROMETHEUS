/**
 * model-admission.test.ts — the two rules, and what a refusal owes the user.
 *
 * Written against this machine's real numbers (64 GB, qwen3.6 23.94 GB, gemma4:12b 7.56 GB) so
 * the scenarios are ones that actually occur rather than round invented ones.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ModelCandidate,
  admitModelLoad,
  affordableModels,
  reclaimableBytes,
  renderRefusal,
} from "./model-admission.js";
import { type MemoryBudget, parseKvGeometry } from "./model-footprint.js";

const GIB = 1024 ** 3;

const QWEN_INFO: Record<string, unknown> = {
  "qwen35moe.attention.head_count_kv": Array.from({ length: 40 }, (_, i) =>
    (i + 1) % 4 === 0 ? 2 : 0,
  ),
  "qwen35moe.attention.key_length": 256,
  "qwen35moe.attention.value_length": 256,
};

const qwen: ModelCandidate = {
  id: "qwen3.6:latest",
  weightsBytes: 23.94e9,
  contextTokens: 262144,
  geometry: parseKvGeometry(QWEN_INFO),
  runner: "ollama",
};
/** gemma4:12b — 5 of every 6 layers windowed at 1024, which is what keeps its cache small. */
const GEMMA_INFO: Record<string, unknown> = {
  "gemma4.attention.head_count_kv": Array.from({ length: 48 }, (_, i) =>
    (i + 1) % 6 === 0 ? 1 : 8,
  ),
  "gemma4.attention.key_length": 256,
  "gemma4.attention.value_length": 256,
  "gemma4.attention.sliding_window": 1024,
  "gemma4.attention.sliding_window_pattern": Array.from(
    { length: 48 },
    (_, i) => (i + 1) % 6 !== 0,
  ),
};

const gemma: ModelCandidate = {
  id: "gemma4:12b",
  weightsBytes: 7.56e9,
  contextTokens: 262144,
  geometry: parseKvGeometry(GEMMA_INFO),
  runner: "ollama",
};

const budget = (availableGiB: number, headroomGiB = 6): MemoryBudget => ({
  totalBytes: 64 * GIB,
  availableBytes: availableGiB * GIB,
  headroomBytes: headroomGiB * GIB,
});

test("a model that fits is admitted, with the spare room reported", () => {
  const d = admitModelLoad({ candidate: qwen, budget: budget(55) });
  assert.equal(d.ok, true);
  assert.ok(d.ok && d.spareBytes > 0);
  assert.equal(d.ok && d.footprint.source, "computed");
});

test("a model that does not fit is refused, naming the shortfall in plain units", () => {
  const d = admitModelLoad({ candidate: qwen, budget: budget(12), alternatives: [qwen, gemma] });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.code, "too-big");
  assert.match(d.reason, /qwen3\.6:latest needs about/);
  assert.match(d.reason, /of weights plus/, "the breakdown says WHERE the memory goes");
  assert.match(d.reason, /262,144 tokens/, "and at what context");
  assert.match(d.reason, /more than is free/);
  assert.ok(d.shortfallBytes > 0);
});

test("a refusal LISTS what fits — the answer to 'then what can I run?'", () => {
  const d = admitModelLoad({ candidate: qwen, budget: budget(20), alternatives: [qwen, gemma] });
  assert.equal(d.ok, false);
  if (d.ok) return;
  const out = renderRefusal(d).join("\n");
  assert.match(out, /Models that fit right now:/);
  assert.match(out, /gemma4:12b/);
  assert.match(out, /too large: qwen3\.6:latest/, "the one that does not fit is still shown");
  assert.match(out, /\/context window/, "and the knob that would shrink the cache");
});

test("when nothing fits, it says so instead of printing an empty list", () => {
  const d = admitModelLoad({ candidate: qwen, budget: budget(8), alternatives: [qwen, gemma] });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.match(renderRefusal(d).join("\n"), /Nothing installed fits/);
});

test("ONE SERVER: a second runner is refused even when the model itself would fit", () => {
  const d = admitModelLoad({
    candidate: { ...gemma, runner: "lmstudio" },
    budget: budget(55),
    resident: [{ runner: "ollama", models: [{ id: "qwen3.6:latest", sizeBytes: 26e9 }] }],
    alternatives: [gemma],
  });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.code, "second-server");
  assert.match(d.reason, /ollama is already serving a model/);
  assert.match(d.reason, /one model server running at a time/);
});

test("…but an explicit opt-in allows it", () => {
  const d = admitModelLoad({
    candidate: { ...gemma, runner: "lmstudio" },
    budget: budget(55),
    resident: [{ runner: "ollama", models: [{ id: "qwen3.6:latest", sizeBytes: 26e9 }] }],
    allowSecondServer: true,
  });
  assert.equal(d.ok, true);
});

test("swapping models on the SAME runner counts the evicted one as reclaimable", () => {
  // The machine has 20 GiB free with qwen (26 GB) resident. Loading gemma must succeed: ollama
  // evicts qwen first. Refusing here would refuse every swap on a machine sized for one model.
  const d = admitModelLoad({
    candidate: gemma,
    budget: budget(20),
    resident: [{ runner: "ollama", models: [{ id: "qwen3.6:latest", sizeBytes: 26e9 }] }],
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.ok ? d.evicting : [], ["qwen3.6:latest"], "and it says what it will evict");
});

test("reclaimable memory is same-runner only — another runner's RAM is not ours to plan with", () => {
  const resident = [
    { runner: "ollama", models: [{ id: "a", sizeBytes: 10e9 }] },
    { runner: "lmstudio", models: [{ id: "b", sizeBytes: 5e9 }] },
  ];
  assert.equal(reclaimableBytes(resident, "ollama"), 10e9);
  assert.equal(reclaimableBytes(resident, "lmstudio"), 5e9);
  assert.equal(reclaimableBytes(resident, "vllm"), 0);
  assert.equal(reclaimableBytes(undefined, "ollama"), 0);
});

test("the affordable list is biggest-first, and keeps the ones that do not fit", () => {
  const list = affordableModels([gemma, qwen], budget(20));
  assert.equal(list.length, 2, "a model that does not fit is shown, not hidden");
  assert.equal(list[0]?.candidate.id, "gemma4:12b", "fitting models come first");
  assert.equal(list[0]?.fits, true);
  assert.equal(list[1]?.fits, false);
  assert.ok((list[1]?.spareBytes ?? 0) < 0, "a shortfall is a negative spare");
});

test("the budget's host is used verbatim — a remote model is never judged by local RAM", () => {
  const remote: MemoryBudget = {
    totalBytes: 24 * GIB,
    availableBytes: 20 * GIB,
    headroomBytes: 4 * GIB,
    host: "gpu-box.lan",
  };
  const d = admitModelLoad({ candidate: qwen, budget: remote, alternatives: [gemma] });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.match(d.reason, /on gpu-box\.lan/, "the refusal names WHICH machine ran out");
});

test("a second-server refusal on a remote host names that host too", () => {
  const d = admitModelLoad({
    candidate: { ...gemma, runner: "lmstudio" },
    budget: {
      totalBytes: 64 * GIB,
      availableBytes: 60 * GIB,
      headroomBytes: 4 * GIB,
      host: "gpu-box.lan",
    },
    resident: [{ runner: "ollama", models: [{ id: "x", sizeBytes: 1e9 }] }],
  });
  assert.equal(d.ok === false && /on gpu-box\.lan/.test(d.reason), true);
});

test("an idle runner with no models loaded is not 'already serving'", () => {
  // A daemon that is up but holding nothing costs no weights, so it must not block a load.
  const d = admitModelLoad({
    candidate: { ...gemma, runner: "lmstudio" },
    budget: budget(55),
    resident: [{ runner: "ollama", models: [] }],
  });
  assert.equal(d.ok, true);
});
