// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * model-browser-data.test.ts — the browser's rows say what `/models use` would do.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ai } from "@prometheus/core";

import { browserStartFor, buildModelBrowser, describeAction } from "./model-browser-data.js";
import type { ModelsHost } from "./models-host.js";

const mac36: ai.MachineProfile = {
  ramGb: 36,
  vramGb: 0,
  unified: true,
  freeDiskGb: 2000,
  freeRamGb: 20,
};

function host(over: Partial<ai.PrepareContext> = {}): ModelsHost {
  return {
    context: async () => ({
      machine: mac36,
      keyFor: () => undefined,
      installedOllama: [],
      served: [],
      rotation: [],
      ollamaInstalled: true,
      ollamaServing: true,
      ...over,
    }),
    connectKey: async () => ({ ok: true, live: [] }),
    liveModels: async () => [],
    installOllama: async () => ({ ok: true }),
    startOllama: async () => ({ ok: true }),
    pull: async () => ({ ok: true }),
    adopt: async () => ({ ok: true, label: "x" }),
    restore: () => undefined,
    restoreHint: () => undefined,
    rotationMembers: () => [],
    saveChoice: () => {},
  };
}

const text = (lines: readonly (string | { text: string })[]): string =>
  lines.map((l) => (typeof l === "string" ? l : l.text)).join("\n");

test("layers: serving, fits, all, one per RAM tier, cloud free/paid, spinner, servers", async () => {
  const d = await buildModelBrowser(host(), {
    servers: [
      {
        id: "ollama",
        name: "Ollama",
        state: "running",
        models: [],
        current: true,
        lines: ["a", "b"],
      },
    ],
  });
  const ids = d.layers.map((l) => l.id);
  for (const id of [
    "serving",
    "fits",
    "local",
    "tier:tiny",
    "tier:datacenter",
    "free",
    "paid",
    "rotation",
    "servers",
  ])
    assert.ok(ids.includes(id), `${id} missing from ${ids.join(",")}`);
  assert.equal(d.start, "fits", "opens on what fits when nothing is serving");
  assert.equal(d.ram?.totalGb, 36);
  assert.equal(d.ram?.freeGb, 20);
  assert.match(d.server, /Ollama · running/);
  const all = d.layers.find((l) => l.id === "local");
  assert.equal(
    all?.items.length,
    ai.LOCAL_MODELS.length,
    "every local model is listed, too-big ones included",
  );
});

test("every row in 'Fits this machine' can be chosen; a too-big row is disabled with its run-anyway ref", async () => {
  const d = await buildModelBrowser(host());
  const fits = d.layers.find((l) => l.id === "fits")?.items ?? [];
  assert.ok(fits.length > 50);
  assert.ok(fits.every((i) => i.submit?.startsWith("/models use local:") && !i.disabled));
  const all = d.layers.find((l) => l.id === "local")?.items ?? [];
  const big = all.find((i) => i.key === "llama3.3-70b");
  assert.ok(big);
  assert.equal(big.badge, "too-big");
  assert.equal(big.submit, undefined);
  assert.match(big.disabled ?? "", /Too big/);
  assert.equal(big.insist?.submit, "/models use local:llama3.3-70b@llamacpp-stream");
  const details = text(big.details());
  assert.match(details, /! runs it anyway/);
  assert.match(details, /AirLLM/);
  assert.match(details, /type the model's id/);
});

test("a row names the server that will run it, and its details say the default server will move", async () => {
  const d = await buildModelBrowser(host({ runtimeInstalled: { lmstudio: true } }));
  const m = ai.LOCAL_MODELS.find(
    (x) => !x.ollama && x.gguf && (x.gguf.shards ?? 1) === 1 && x.minRamGb <= 16 && !x.needsOffload,
  );
  assert.ok(m);
  const row = d.layers.find((l) => l.id === "local")?.items.find((i) => i.key === m.id);
  assert.equal(row?.runner, "LM Studio");
  const details = text(row?.details() ?? []);
  assert.match(details, /Runs on LM Studio — no Ollama build — LM Studio is installed/);
  assert.match(details, /default server moves from Ollama to LM Studio/);
  assert.match(details, /Enter will:/);
  const ollamaRow = d.layers.find((l) => l.id === "local")?.items.find((i) => i.key === "qwen3-8b");
  assert.equal(ollamaRow?.runner, "Ollama");
});

test("served models come first and are chosen without any download", async () => {
  const d = await buildModelBrowser(host({ served: [{ runner: "ollama", model: "qwen3:8b" }] }));
  assert.equal(d.start, "serving");
  const served = d.layers.find((l) => l.id === "serving")?.items ?? [];
  assert.equal(served[0]?.submit, "/models use served:ollama:qwen3:8b");
  assert.equal(served[0]?.badge, "serving");
});

test("describeAction words every prepare step; browserStartFor maps /models words to layers", () => {
  assert.match(
    describeAction({ kind: "serve-gguf", runtime: "llamacpp", id: "x", ctx: 8192, stream: true }),
    /paged from disk/,
  );
  assert.match(describeAction({ kind: "install-runtime", runtime: "colibri" }), /pinned source/);
  assert.match(describeAction({ kind: "install-runtime", runtime: "airllm" }), /gated pip/);
  assert.equal(browserStartFor("free"), "free");
  assert.equal(browserStartFor("local"), "fits");
  assert.equal(browserStartFor("all"), "local");
  assert.equal(browserStartFor(""), undefined);
});
