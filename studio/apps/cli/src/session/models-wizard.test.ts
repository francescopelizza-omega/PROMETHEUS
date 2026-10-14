/**
 * models-wizard.test.ts — `/models`: navigation, engine pass-through, and the prepare flow.
 *
 * Driven with a FAKE `ModelsHost` that records every action, so nothing here installs,
 * downloads, stores a key or reaches a provider. The rule under test throughout: nothing is
 * installed, downloaded or adopted without the user's yes, and a "no" stops the flow cleanly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ai } from "@prometheus/core";

import { makeFakeSlashCtx } from "./__fixtures__/slash-ctx.js";
import type { ModelsHost } from "./models-host.js";
import {
  overlayItems,
  parseModelsArgs,
  renderStep,
  runModelsCommand,
  runUse,
} from "./models-wizard.js";

const mac36: ai.MachineProfile = { ramGb: 36, vramGb: 0, unified: true, freeDiskGb: 500 };

function fakeHost(over: Partial<ai.PrepareContext> = {}, live: string[] = []) {
  const log: string[] = [];
  const keys = new Set<string>();
  const host: ModelsHost = {
    context: async () => ({
      machine: mac36,
      keyFor: (id) => (keys.has(id) ? "keychain" : undefined),
      installedOllama: [],
      served: [],
      rotation: [],
      ollamaInstalled: true,
      ollamaServing: true,
      ...over,
    }),
    connectKey: async (id, key) => {
      log.push(`key:${id}:${key}`);
      keys.add(id);
      return { ok: true, live };
    },
    liveModels: async () => live,
    installOllama: async () => {
      log.push("install-ollama");
      return { ok: true };
    },
    startOllama: async () => {
      log.push("start-ollama");
      return { ok: true };
    },
    pull: async (tag) => {
      log.push(`pull:${tag}`);
      return { ok: true };
    },
    adopt: async (ref, model) => {
      log.push(`adopt:${ai.formatRef(ref)}${model ? `@${model}` : ""}`);
      return { ok: true, label: "x" };
    },
    restore: () => undefined,
    rotationMembers: () => [
      {
        id: "groq:a",
        providerId: "groq",
        label: "A",
        baseUrl: "https://g/v1",
        model: "a",
        contextWindow: 131_072,
      },
    ],
    saveChoice: (ref) => log.push(`save:${ref}`),
  };
  return { host, log };
}

/** A fake ctx whose ask/confirm/askSecret answer from scripts, in order. */
function scripted(
  host: ModelsHost,
  answers: { ask?: string[]; confirm?: boolean[]; secret?: string[] } = {},
) {
  const f = makeFakeSlashCtx();
  const ask = [...(answers.ask ?? [])];
  const conf = [...(answers.confirm ?? [])];
  const sec = [...(answers.secret ?? [])];
  f.ctx.ask = async () => ask.shift() ?? "";
  f.ctx.confirm = async () => conf.shift() ?? false;
  if (answers.secret) f.ctx.askSecret = async () => sec.shift() ?? "";
  f.ctx.models = host;
  return f;
}

test("parse: steps, picks, current, and every engine action passed through", () => {
  assert.deepEqual(parseModelsArgs(""), { kind: "step", step: "root", showAll: false });
  assert.deepEqual(parseModelsArgs("local all"), { kind: "step", step: "local", showAll: true });
  assert.deepEqual(parseModelsArgs("rotate"), { kind: "step", step: "rotation", showAll: false });
  assert.deepEqual(parseModelsArgs("use free:groq:x"), { kind: "use", ref: "free:groq:x" });
  assert.deepEqual(parseModelsArgs("local:qwen3-8b"), { kind: "use", ref: "local:qwen3-8b" });
  assert.deepEqual(parseModelsArgs("current"), { kind: "current" });
  for (const a of ["install airllm", "list", "status", "pull qwen3:8b", "config --show", "run x"]) {
    const p = parseModelsArgs(a);
    assert.equal(p.kind, "engine", a);
  }
  assert.deepEqual(parseModelsArgs("tools"), { kind: "engine", args: ["list"] });
});

test("engine actions reach the engine unchanged (old /models behaviour preserved)", async () => {
  const { host } = fakeHost();
  const f = scripted(host);
  await runModelsCommand("install airllm --path /x", f.ctx);
  await runModelsCommand("tools", f.ctx);
  assert.deepEqual(f.calls.verbs, [
    ["models", "install", "airllm", "--path", "/x"],
    ["models", "list"],
  ]);
});

test("bare /models navigates root → cloud → free and renders every row's two lines", async () => {
  const { host } = fakeHost();
  const f = scripted(host, { ask: ["2", "1", ""] });
  await runModelsCommand("", f.ctx);
  const out = f.calls.writes.join("\n");
  assert.match(out, /Choose where your model runs/);
  assert.match(out, /Choose a kind of cloud model/);
  assert.match(out, /Free cloud models/);
  assert.match(out, /Nemotron/);
  assert.match(out, /\(cancelled\)/);
});

test("render: disabled rows get no number; overlay rows carry the next command", () => {
  const step = ai.rotationStep({
    machine: mac36,
    keyFor: () => undefined,
    rotation: [
      {
        id: "g:a",
        providerId: "groq",
        label: "A",
        baseUrl: "https://g/v1",
        model: "a",
        contextWindow: 131_072,
      },
    ],
  });
  const { pickable } = renderStep(step);
  assert.ok(pickable.every((r) => !r.disabled));
  const items = overlayItems(ai.rootStep());
  assert.deepEqual(
    items.map((i) => i.submitText),
    ["/models local", "/models cloud"],
  );
  assert.ok(items.every((i) => i.body.length >= 2));
});

test("local pick on a machine without Ollama: install → start → pull → adopt → remember", async () => {
  const { host, log } = fakeHost({ ollamaInstalled: false, ollamaServing: false });
  const f = scripted(host, { confirm: [true, true] });
  await runUse("local:qwen3-8b", f.ctx, host);
  assert.deepEqual(log, [
    "install-ollama",
    "start-ollama",
    "pull:qwen3:8b",
    "adopt:local:qwen3-8b",
    "save:local:qwen3-8b",
  ]);
});

test("declining the download stops cleanly — nothing adopted, nothing remembered", async () => {
  const { host, log } = fakeHost();
  const f = scripted(host, { confirm: [false] });
  await runUse("local:qwen3-8b", f.ctx, host);
  assert.deepEqual(log, []);
  assert.match(f.calls.writes.join("\n"), /nothing downloaded/);
});

test("too big → blocked, then the user is offered models that fit and can pick one", async () => {
  const { host, log } = fakeHost({
    machine: { ramGb: 16, vramGb: 0, unified: true, freeDiskGb: 500 },
  });
  const f = scripted(host, { ask: ["1"], confirm: [true] });
  await runUse("local:gpt-oss-120b", f.ctx, host);
  const out = f.calls.writes.join("\n");
  assert.match(out, /Models that DO run on this machine/);
  assert.ok(
    log.some((l) => l.startsWith("adopt:local:")),
    "an alternative was adopted",
  );
});

test("an offload pick explains the runtime; declining offers native alternatives", async () => {
  const { host } = fakeHost();
  const f = scripted(host, { confirm: [false], ask: [""] });
  await runUse("local:llama3.3-70b", f.ctx, host);
  const out = f.calls.writes.join("\n");
  assert.match(out, /AirLLM/);
  assert.match(out, /Speed:/);
  assert.match(out, /Models that DO run on this machine/);
});

test("accepting AirLLM runs the engine's gated installer, never adopts it as the chat model", async () => {
  const { host, log } = fakeHost();
  const f = scripted(host, { confirm: [true], ask: [""] });
  await runUse("local:llama3.3-70b", f.ctx, host);
  assert.deepEqual(f.calls.verbs, [["models", "install", "airllm"]]);
  assert.ok(!log.some((l) => l.startsWith("adopt:")));
});

test("free pick with no key: masked prompt → verified store → live rename → adopt", async () => {
  const { host, log } = fakeHost({}, [
    "moonshotai/kimi-k2-instruct-0905",
    "llama-3.3-70b-versatile",
  ]);
  const f = scripted(host, { secret: ["gsk_secret"] });
  await runUse("free:groq:moonshotai/kimi-k2-instruct", f.ctx, host);
  assert.deepEqual(log, [
    "key:groq:gsk_secret",
    "adopt:free:groq:moonshotai/kimi-k2-instruct@moonshotai/kimi-k2-instruct-0905",
    "save:free:groq:moonshotai/kimi-k2-instruct-0905",
  ]);
  assert.ok(!f.calls.writes.join("\n").includes("gsk_secret"), "the key is never written back");
  assert.match(f.calls.writes.join("\n"), /console\.groq\.com/);
});

test("a host that cannot hide typing never asks for the key in the clear", async () => {
  const { host, log } = fakeHost();
  const f = scripted(host); // no askSecret
  await runUse("free:nvidia:nvidia/llama-3.3-nemotron-super-49b-v1.5", f.ctx, host);
  assert.deepEqual(log, []);
  assert.match(f.calls.writes.join("\n"), /prometheus provider connect nvidia/);
});

test("the rotation needs an explicit yes before prompts go to several providers", async () => {
  const { host, log } = fakeHost({
    rotation: [
      {
        id: "groq:a",
        providerId: "groq",
        label: "A",
        baseUrl: "https://g/v1",
        model: "a",
        contextWindow: 131_072,
      },
    ],
  });
  const no = scripted(host, { confirm: [false] });
  await runUse("rotation", no.ctx, host);
  assert.deepEqual(log, []);
  const yes = scripted(host, { confirm: [true] });
  await runUse("rotation", yes.ctx, host);
  assert.deepEqual(log, ["adopt:rotation", "save:rotation"]);
});

test("a host without the picker says so instead of pretending", async () => {
  const f = makeFakeSlashCtx();
  await runModelsCommand("", f.ctx);
  assert.match(f.calls.writes.join("\n"), /isn't available/);
});
