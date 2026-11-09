// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * server-cmd.test.ts — `/server`, the default local model server. Nothing real is probed: the
 * models host is a fake whose context says what is installed and served.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ai } from "@prometheus/core";

import { makeFakeSlashCtx } from "./__fixtures__/slash-ctx.js";
import type { ModelsHost } from "./models-host.js";
import { runServer, serverOverlayItems, serverRows } from "./server-cmd.js";

function harness(served: { runner: string; model: string }[] = [], answers: string[] = []) {
  const f = makeFakeSlashCtx();
  let saved = "ollama";
  const adopted: string[] = [];
  f.ctx.defaultServerSetting = {
    get: () => saved,
    set: (id) => {
      if (!["ollama", "lmstudio", "llamacpp", "mlx", "vllm"].includes(id)) return false;
      saved = id;
      return true;
    },
  };
  f.ctx.models = {
    context: async () =>
      ({
        machine: { ramGb: 32, vramGb: 0, unified: true },
        keyFor: () => undefined,
        installedOllama: [],
        served,
        rotation: [],
        ollamaInstalled: true,
        ollamaServing: served.some((s) => s.runner === "ollama"),
        runtimeInstalled: { llamacpp: true, lmstudio: false },
      }) as ai.PrepareContext,
    adopt: async (ref: ai.WizardRef) => {
      adopted.push(JSON.stringify(ref));
      return { ok: true, label: "x" };
    },
  } as unknown as ModelsHost;
  const queue = [...answers];
  f.ctx.ask = async () => queue.shift() ?? "";
  return { f, adopted, saved: () => saved };
}

test("Ollama is the default and is marked current; every server has two description lines", async () => {
  const h = harness();
  const rows = await serverRows(h.f.ctx);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["ollama", "lmstudio", "llamacpp", "mlx", "vllm"],
  );
  assert.equal(rows.find((r) => r.current)?.id, "ollama");
  assert.equal(rows.find((r) => r.id === "lmstudio")?.state, "not installed");
  assert.equal(rows.find((r) => r.id === "llamacpp")?.state, "installed");
  const items = serverOverlayItems(rows);
  assert.equal(items[0]?.current, true);
  assert.equal(items[0]?.submitText, "/server ollama");
  assert.ok(
    items.every((i) => i.columns?.length === 2),
    "two right-hand lines per server",
  );
});

test("/server llamacpp saves the default; aliases work; unknown ids are refused", async () => {
  const h = harness();
  await runServer("llama.cpp", h.f.ctx);
  assert.equal(h.saved(), "llamacpp");
  await runServer("bogus", h.f.ctx);
  assert.equal(h.saved(), "llamacpp", "an unknown id never replaces the saved one");
  assert.match(h.f.calls.writes.join("\n"), /unknown server/);
});

test("picking a server that is serving a model switches the session to it", async () => {
  const h = harness([
    { runner: "ollama", model: "qwen3:8b" },
    { runner: "lmstudio", model: "prometheus/qwen3-8b" },
  ]);
  await runServer("lmstudio", h.f.ctx);
  assert.deepEqual(h.adopted, [
    JSON.stringify({ section: "served", runner: "lmstudio", model: "prometheus/qwen3-8b" }),
  ]);
});

test("a bare /server in line mode lists and asks; Enter keeps the current one", async () => {
  const keep = harness([], [""]);
  await runServer("", keep.f.ctx);
  assert.equal(keep.saved(), "ollama");
  const pick = harness([], ["3"]);
  await runServer("", pick.f.ctx);
  assert.equal(pick.saved(), "llamacpp");
  const bad = harness([], ["9"]);
  await runServer("", bad.f.ctx);
  assert.equal(bad.saved(), "ollama");
});
