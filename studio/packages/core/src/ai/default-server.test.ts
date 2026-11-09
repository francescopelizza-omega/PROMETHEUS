// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SERVER,
  DEFAULT_SERVER_IDS,
  DEFAULT_SERVER_INFO,
  DEFAULT_SERVER_KEY,
  defaultServerAfterPick,
  defaultServerFrom,
  isDefaultServerId,
  pickServingRunner,
  preferFirst,
  runtimeForDefault,
} from "./default-server.js";
import { LOCAL_MODELS } from "./model-catalog/local.js";
import { preparePlan } from "./model-catalog/wizard.js";

test("Ollama is the default; anything unknown falls back to it", () => {
  assert.equal(DEFAULT_SERVER, "ollama");
  assert.equal(defaultServerFrom(undefined), "ollama");
  assert.equal(defaultServerFrom({ [DEFAULT_SERVER_KEY]: "nope" }), "ollama");
  assert.equal(defaultServerFrom({ [DEFAULT_SERVER_KEY]: "llamacpp" }), "llamacpp");
  for (const id of DEFAULT_SERVER_IDS) assert.equal(DEFAULT_SERVER_INFO[id].lines.length, 2);
});

test("the preferred server is adopted when it serves a model, else the first that does", () => {
  const runners = [
    { name: "ollama", models: ["qwen3:8b"] },
    { name: "lmstudio", models: ["prometheus/x"] },
    { name: "llamacpp", models: [] },
  ];
  assert.equal(pickServingRunner(runners, "lmstudio")?.name, "lmstudio");
  assert.equal(pickServingRunner(runners, "llamacpp")?.name, "ollama", "llamacpp serves nothing");
  assert.deepEqual(
    preferFirst(["ollama", "lmstudio", "llamacpp"], (s) => s, "llamacpp"),
    ["llamacpp", "ollama", "lmstudio"],
  );
});

test("a pick without a runtime is prepared for the default server when the model has a GGUF", () => {
  assert.equal(runtimeForDefault("llamacpp", true), "llamacpp");
  assert.equal(runtimeForDefault("llamacpp", false), undefined);
  assert.equal(runtimeForDefault("ollama", true), undefined);
  assert.equal(runtimeForDefault("vllm", true), undefined, "vLLM is adopted, never prepared");
  const m = LOCAL_MODELS.find((x) => x.gguf && (x.gguf.shards ?? 1) === 1 && x.q4Gb < 6);
  assert.ok(m, "catalogue has a small single-file GGUF model");
  const ctx = {
    machine: { ramGb: 64, vramGb: 0, unified: true, freeDiskGb: 500 },
    keyFor: () => undefined,
    installedOllama: [],
    served: [],
    rotation: [],
    ollamaInstalled: true,
    ollamaServing: true,
    runtimeInstalled: { llamacpp: true, lmstudio: true },
  };
  const onLlama = preparePlan(
    { section: "local", id: m.id },
    { ...ctx, defaultServer: "llamacpp" },
  );
  assert.equal(onLlama.runtime, "llamacpp");
  assert.ok(onLlama.actions.some((a) => a.kind === "serve-gguf"));
  const onOllama = preparePlan({ section: "local", id: m.id }, { ...ctx, defaultServer: "ollama" });
  // Ollama when the model has an Ollama build; otherwise the installed server that can run it
  assert.equal(onOllama.runtime, m.ollama ? "ollama" : "lmstudio");
  // an explicit runtime in the ref always wins over the default
  const explicit = preparePlan(
    { section: "local", id: m.id, runtime: "lmstudio" },
    { ...ctx, defaultServer: "llamacpp" },
  );
  assert.ok(explicit.actions.some((a) => a.kind === "link-lmstudio"));
});

test("defaultServerAfterPick: the default follows a pick onto another server, never onto a streaming one", () => {
  assert.deepEqual(defaultServerAfterPick("ollama", "lmstudio"), {
    next: "lmstudio",
    changed: true,
  });
  assert.deepEqual(defaultServerAfterPick(undefined, "mlx"), { next: "mlx", changed: true });
  assert.deepEqual(defaultServerAfterPick("llamacpp", "llamacpp"), {
    next: "llamacpp",
    changed: false,
  });
  // AirLLM / colibri / llama.cpp-from-SSD exist for one model: the default stays where it was
  assert.deepEqual(defaultServerAfterPick("ollama", "airllm"), { next: "ollama", changed: false });
  assert.deepEqual(defaultServerAfterPick("ollama", "colibri"), { next: "ollama", changed: false });
  assert.deepEqual(defaultServerAfterPick("bogus", "llamacpp-stream"), {
    next: "ollama",
    changed: false,
  });
  assert.ok(isDefaultServerId("mlx"), "MLX-LM can be the default server");
});
