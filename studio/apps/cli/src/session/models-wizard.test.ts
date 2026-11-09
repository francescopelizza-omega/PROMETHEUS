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
  browserLayerFor,
  overlayItems,
  parseModelsArgs,
  renderStep,
  runModelsCommand,
  runRuntimes,
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
  // two-column rows: the two description lines live in `columns`, the size/fit line in `body`
  assert.ok(items.every((i) => i.columns?.length === 2 && i.columns.every((l) => l.length > 0)));
  assert.ok(items.every((i) => i.body.length >= 1));
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

test("a nemesis WARN needs the model's name typed; anything else refuses, a match forces", async () => {
  for (const [typed, adopted] of [
    ["", false],
    ["y", false],
    ["qwen3:8b", true],
  ] as const) {
    const { host, log } = fakeHost();
    host.pull = async (tag, _show, opts) => {
      log.push(`pull:${tag}${opts?.force ? ":force" : ""}`);
      return opts?.force
        ? { ok: true }
        : { ok: false, reason: "nemesis WARN", needsConfirm: true, findings: ["TMPL-INJECT x"] };
    };
    host.discardOllama = async (tag) => {
      log.push(`discard:${tag}`);
      return { ok: true };
    };
    const f = scripted(host, { confirm: [true], ask: [typed] });
    await runUse("local:qwen3-8b", f.ctx, host);
    assert.equal(log.includes("pull:qwen3:8b:force"), adopted, typed);
    // a refusal removes the pulled model, so a later pick cannot adopt it unscanned
    assert.equal(log.includes("discard:qwen3:8b"), !adopted, typed);
    assert.equal(log.includes("adopt:local:qwen3-8b"), adopted, typed);
    assert.match(f.calls.writes.join("\n"), /TMPL-INJECT x/);
  }
});

test("a nemesis BLOCK is never offered for confirmation", async () => {
  const { host, log } = fakeHost();
  host.pull = async (tag, _show, opts) => {
    log.push(`pull:${tag}${opts?.force ? ":force" : ""}`);
    return { ok: false, reason: "nemesis BLOCKED qwen3:8b" };
  };
  const f = scripted(host, { confirm: [true], ask: ["qwen3:8b"] });
  await runUse("local:qwen3-8b", f.ctx, host);
  assert.deepEqual(log, ["pull:qwen3:8b"]);
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

test("a model too big for RAM is refused, with the run-it-anyway refs, then fitting models are offered", async () => {
  const { host, log } = fakeHost();
  const f = scripted(host, { ask: [""] });
  await runUse("local:llama3.3-70b", f.ctx, host);
  const out = f.calls.writes.join("\n");
  assert.match(out, /Too big for this machine/);
  assert.match(out, /\/models use local:llama3\.3-70b@llamacpp-stream/);
  assert.match(out, /\/models use local:llama3\.3-70b@airllm/);
  assert.match(out, /Models that DO run on this machine/);
  assert.ok(!log.some((l) => l.startsWith("adopt:")), "a refused pick is never adopted");
});

test("insisting on AirLLM: the model's id typed, gated install, gated snapshot, AirLLM server, adopt", async () => {
  const { host, log } = fakeHost();
  host.installRuntime = async (id, _show, opts) => {
    log.push(`install:${id}${opts?.acceptWarn ? ":accept" : ""}`);
    return { ok: true };
  };
  host.fetchSnapshot = async (id, repo) => {
    log.push(`snapshot:${id}:${repo}`);
    return { ok: true, path: `/lib/huggingface/${id}` };
  };
  host.serveStream = async (id, dir) => {
    log.push(`stream:${id}:${dir}`);
    return { ok: true };
  };
  // a wrong answer to the typed confirm installs and downloads nothing
  const no = scripted(host, { ask: ["yes", ""], confirm: [true, true] });
  await runUse("local:llama3.3-70b@airllm", no.ctx, host);
  assert.deepEqual(log, []);
  const f = scripted(host, { ask: ["llama3.3-70b"], confirm: [true, true] });
  await runUse("local:llama3.3-70b@airllm", f.ctx, host);
  const m = ai.findLocalModel("llama3.3-70b");
  assert.deepEqual(log, [
    "install:airllm",
    `snapshot:llama3.3-70b:${m?.hfRepo}`,
    "stream:llama3.3-70b:/lib/huggingface/llama3.3-70b",
    "adopt:local:llama3.3-70b@airllm",
    "save:local:llama3.3-70b@airllm",
  ]);
  const out = f.calls.writes.join("\n");
  assert.match(out, /needs about \d+ GB of RAM; this machine has 36 GB/);
  assert.match(out, /Speed:/);
});

test("a nemesis WARN on a runtime install needs the runtime's name typed before it is accepted", async () => {
  const { host, log } = fakeHost();
  let calls = 0;
  host.installRuntime = async (id, _show, opts) => {
    calls += 1;
    log.push(`install:${id}${opts?.acceptWarn ? ":accept" : ""}`);
    return opts?.acceptWarn
      ? { ok: true }
      : { ok: false, reason: "nemesis WARN", needsConfirm: true };
  };
  host.fetchGguf = async () => ({ ok: false, reason: "stop here" });
  const f = scripted(host, { ask: ["qwen3-coder-30b", "colibri"], confirm: [true, true] });
  await runUse("local:qwen3-coder-30b@colibri", f.ctx, host);
  // 36 GB fits it, so colibri is refused before anything is installed
  assert.equal(calls, 0);
  const small = fakeHost({ machine: { ramGb: 16, vramGb: 0, unified: true, freeDiskGb: 500 } });
  small.host.installRuntime = host.installRuntime;
  small.host.fetchGguf = host.fetchGguf;
  const g = scripted(small.host, {
    ask: ["qwen3-coder-30b", "colibri"],
    confirm: [true, true],
  });
  await runUse("local:qwen3-coder-30b@colibri", g.ctx, small.host);
  assert.deepEqual(log, ["install:colibri", "install:colibri:accept"]);
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

test("a catalogue model with no Ollama build, imported into Ollama when asked: gated GGUF → import → adopt", async () => {
  const m = ai.LOCAL_MODELS.find(
    (x) => !x.ollama && x.gguf && (x.gguf.shards ?? 1) === 1 && x.minRamGb <= 24 && !x.needsOffload,
  );
  assert.ok(m, "the catalogue has GGUF-only models that fit 36 GB");
  const { host, log } = fakeHost();
  host.fetchGguf = async (id, repo, file) => {
    log.push(`fetch:${id}:${repo}/${file}`);
    return { ok: true, path: `/lib/${id}.gguf` };
  };
  host.importToOllama = async (id, path) => {
    log.push(`import:${id}:${path}`);
    return { ok: true, tag: ai.localOllamaTag(m) };
  };
  const f = scripted(host, { confirm: [true] });
  await runUse(`local:${m.id}@ollama`, f.ctx, host);
  const tag = ai.localOllamaTag(m);
  assert.ok(tag.startsWith("prometheus/"));
  assert.deepEqual(log, [
    `fetch:${m.id}:${m.gguf?.repo}/${m.gguf?.file}`,
    `import:${m.id}:/lib/${m.id}.gguf`,
    `adopt:local:${m.id}@ollama@${tag}`,
    `save:local:${m.id}@ollama`,
  ]);
  assert.match(f.calls.writes.join("\n"), /nemesis/);
});

test("a model with no Ollama build goes to LM Studio when it is installed, and the default server follows", async () => {
  const m = ai.LOCAL_MODELS.find(
    (x) => !x.ollama && x.gguf && (x.gguf.shards ?? 1) === 1 && x.minRamGb <= 24 && !x.needsOffload,
  );
  assert.ok(m);
  const { host, log } = fakeHost({ runtimeInstalled: { lmstudio: true } });
  host.fetchGguf = async (id) => {
    log.push(`fetch:${id}`);
    return { ok: true, path: `/lib/${id}.gguf` };
  };
  host.linkLmstudio = async (id, path, format) => {
    log.push(`link:${id}:${path}:${format}`);
    return { ok: true };
  };
  host.startLmstudio = async (id) => {
    log.push(`start-lms:${id}`);
    return { ok: true, model: `prometheus/${id}` };
  };
  const f = scripted(host, { confirm: [true] });
  let saved = "ollama";
  f.ctx.defaultServerSetting = {
    get: () => saved,
    set: (id) => {
      saved = id;
      return true;
    },
  };
  await runUse(`local:${m.id}`, f.ctx, host);
  assert.deepEqual(log, [
    `fetch:${m.id}`,
    `link:${m.id}:/lib/${m.id}.gguf:gguf`,
    `start-lms:${m.id}`,
    `adopt:local:${m.id}@lmstudio@prometheus/${m.id}`,
    `save:local:${m.id}@lmstudio`,
  ]);
  assert.equal(saved, "lmstudio", "the default server moved to the engine this model needs");
  const out = f.calls.writes.join("\n");
  assert.match(out, /runs on LM Studio/);
  assert.match(out, /default server → LM Studio/);
});

test("declining the GGUF download stops before anything is fetched", async () => {
  const m = ai.LOCAL_MODELS.find((x) => !x.ollama && x.gguf && x.minRamGb <= 24 && !x.needsOffload);
  assert.ok(m);
  const { host, log } = fakeHost();
  host.fetchGguf = async () => {
    log.push("fetch");
    return { ok: true, path: "/x" };
  };
  host.importToOllama = async () => ({ ok: true, tag: "t" });
  const f = scripted(host, { confirm: [false] });
  await runUse(`local:${m.id}`, f.ctx, host);
  assert.deepEqual(log, []);
});

test("a failed nemesis admission is shown and nothing is adopted", async () => {
  const m = ai.LOCAL_MODELS.find((x) => !x.ollama && x.gguf && x.minRamGb <= 24 && !x.needsOffload);
  assert.ok(m);
  const { host, log } = fakeHost({ runtimeInstalled: { llamacpp: true } });
  host.fetchGguf = async () => ({ ok: false, reason: "nemesis BLOCK: GGUF-TEMPLATE" });
  host.serveGguf = async () => {
    log.push("serve");
    return { ok: true };
  };
  const f = scripted(host, { confirm: [true] });
  await runUse(`local:${m.id}`, f.ctx, host);
  assert.deepEqual(log, []);
  assert.match(f.calls.writes.join("\n"), /GGUF-TEMPLATE/);
});

test("/models runtimes lists every runtime and agent; install asks first and never runs a vendor script", async () => {
  assert.deepEqual(parseModelsArgs("runtimes"), { kind: "runtimes" });
  assert.deepEqual(parseModelsArgs("runtimes install LMStudio"), {
    kind: "runtimes",
    install: "lmstudio",
  });
  const { host } = fakeHost();
  const calls: string[] = [];
  host.runtimeStatus = async () => [
    { id: "ollama", installed: "/opt/homebrew/bin/ollama", auto: "brew-formula ollama" },
    { id: "lmstudio", installed: null, auto: "brew-cask lm-studio" },
    { id: "hermes", installed: null, auto: null, manual: "curl -fsSL https://x/install.sh | bash" },
  ];
  host.installRuntime = async (id) => {
    calls.push(id);
    return id === "hermes"
      ? { ok: false, reason: "manual", manual: "curl -fsSL https://x/install.sh | bash" }
      : { ok: true };
  };
  const list = scripted(host);
  await runRuntimes(undefined, list.ctx, host);
  const text = list.calls.writes.join("\n");
  for (const name of ["Ollama", "LM Studio", "llama.cpp", "MLX", "OpenCode", "Hermes", "Goose"]) {
    assert.match(text, new RegExp(name));
  }
  const no = scripted(host, { confirm: [false] });
  await runRuntimes("lmstudio", no.ctx, host);
  assert.deepEqual(calls, []); // declined → nothing installed
  const yes = scripted(host, { confirm: [true] });
  await runRuntimes("lmstudio", yes.ctx, host);
  assert.deepEqual(calls, ["lmstudio"]);
  const already = scripted(host, { confirm: [true] });
  await runRuntimes("ollama", already.ctx, host);
  assert.deepEqual(calls, ["lmstudio"]); // already installed → no installer run
});

test("llama.cpp pick: gated GGUF download, then llama-server on the ADMITTED file, then adopt", async () => {
  const m = ai.LOCAL_MODELS.find((x) => x.gguf && x.minRamGb <= 24 && !x.needsOffload);
  assert.ok(m);
  const { host, log } = fakeHost({ runtimeInstalled: { llamacpp: true } });
  host.fetchGguf = async (id) => {
    log.push(`fetch:${id}`);
    return { ok: true, path: `/lib/${id}.gguf` };
  };
  host.serveGguf = async (id, path, ctx) => {
    log.push(`serve:${id}:${path}:${ctx}`);
    return { ok: true };
  };
  const f = scripted(host, { confirm: [true] });
  await runUse(`local:${m.id}@llamacpp`, f.ctx, host);
  assert.equal(log[0], `fetch:${m.id}`);
  assert.match(log[1] ?? "", new RegExp(`^serve:${m.id}:/lib/${m.id}\\.gguf:\\d+$`));
  assert.equal(log[2], `adopt:local:${m.id}@llamacpp`);
});

test("no runtime question: an Ollama build stays on Ollama; the default server decides only between servers that can load it", async () => {
  const m = ai.LOCAL_MODELS.find((x) => x.gguf && x.ollama && x.minRamGb <= 24 && !x.needsOffload);
  assert.ok(m);
  const { host, log } = fakeHost({ runtimeInstalled: { llamacpp: true } });
  host.fetchGguf = async (id) => ({ ok: true, path: `/lib/${id}.gguf` });
  host.serveGguf = async (id) => {
    log.push(`serve:${id}`);
    return { ok: true };
  };
  const f = scripted(host, { confirm: [true] });
  await runUse(`local:${m.id}`, f.ctx, host);
  assert.ok(log.includes(`pull:${m.ollama}`), log.join(", "));
  assert.ok(!log.some((l) => l.startsWith("serve:")));
  // with llama.cpp as the default server the same pick is served by llama.cpp — still no question
  const d = fakeHost({ runtimeInstalled: { llamacpp: true }, defaultServer: "llamacpp" });
  d.host.fetchGguf = host.fetchGguf;
  d.host.serveGguf = async (id) => {
    d.log.push(`serve:${id}`);
    return { ok: true };
  };
  const g = scripted(d.host, { confirm: [true] });
  await runUse(`local:${m.id}`, g.ctx, d.host);
  assert.ok(d.log.includes(`serve:${m.id}`), d.log.join(", "));
  assert.ok(!d.log.some((l) => l.startsWith("pull:")));
});

test("every /models word opens the browser on its own layer", () => {
  const layer = (w: string): string | undefined => {
    const a = parseModelsArgs(w);
    return a.kind === "step" ? browserLayerFor(a.step, a.showAll) : undefined;
  };
  for (const w of ["endless", "rotate", "spin", "spinner", "rotation"])
    assert.equal(layer(w), "rotation", w);
  assert.equal(layer("free all"), "free", "`all` widens only the local list");
  assert.equal(layer("cloud all"), "free");
  assert.equal(layer("local all"), "local");
  assert.equal(layer("local"), "fits");
  assert.equal(browserLayerFor("servers", false), "servers");
});
