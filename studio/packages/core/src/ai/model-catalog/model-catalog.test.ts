/**
 * model-catalog.test.ts — the `/models` picker's data and planning.
 *
 * The drift test is the one that matters most: `local.ts` copies its figures from
 * `config/open-models.json`, and a number that silently diverges would tell a user a model fits
 * their machine when the sidecar's own catalogue says it does not.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { API_PROVIDERS } from "../../orchestration/api-providers.js";
import { CATALOG_MODELS } from "./catalog.generated.js";
import { CLOUD_MODELS } from "./cloud.js";
import { FREE_TIERS } from "./free-tier.js";
import { matchLiveModel } from "./live-models.js";
import { LOCAL_MODELS, findLocalModel } from "./local.js";
import {
  diskFits,
  machineFromHost,
  nativeAlternatives,
  planLocalModel,
  streamingOptions,
} from "./plan.js";
import type { MachineProfile } from "./types.js";
import {
  cloudModelsStep,
  cloudStep,
  formatRef,
  localStep,
  parseRef,
  preparePlan,
  rootStep,
  rotationStep,
} from "./wizard.js";

const here = dirname(fileURLToPath(import.meta.url));
const OPEN_MODELS = JSON.parse(
  readFileSync(join(here, "../../../../../config/open-models.json"), "utf8"),
) as {
  models: {
    id: string;
    ollama?: string;
    context?: number;
    resource?: { q4_gb?: number; min_ram_gb?: number };
  }[];
};

const mac16: MachineProfile = { ramGb: 16, vramGb: 0, unified: true };
const mac36: MachineProfile = { ramGb: 36, vramGb: 0, unified: true, freeDiskGb: 200 };
const tiny8: MachineProfile = { ramGb: 8, vramGb: 0, unified: false };

test("generated TS catalogue and config/open-models.json are the same rows (no silent drift)", () => {
  // both are written by build_model_catalog.py; a hand edit to either shows up here
  const ts = new Map(CATALOG_MODELS.map((m) => [m.id, m]));
  assert.equal(ts.size, OPEN_MODELS.models.length);
  for (const row of OPEN_MODELS.models) {
    const m = ts.get(row.id);
    assert.ok(m, `${row.id} missing from catalog.generated.ts`);
    assert.equal(m.resource.q4_gb, row.resource?.q4_gb, `${row.id} q4_gb`);
    assert.equal(m.resource.min_ram_gb, row.resource?.min_ram_gb, `${row.id} min_ram_gb`);
    assert.equal(m.context, row.context, `${row.id} context`);
    assert.equal(m.ollama, row.ollama, `${row.id} ollama tag`);
  }
  for (const m of LOCAL_MODELS) {
    const row = ts.get(m.id);
    assert.ok(row, m.id);
    assert.equal(m.q4Gb, row.resource.q4_gb);
    assert.equal(m.minRamGb, row.resource.min_ram_gb);
  }
});

test("catalogue spans 2 GB machines to 1.5 TB+ servers, every row vetted and two-line", () => {
  const ram = CATALOG_MODELS.map((m) => m.resource.min_ram_gb);
  assert.ok(Math.min(...ram) <= 4, "something runs on a 2–4 GB machine");
  assert.ok(Math.max(...ram) >= 512, "frontier models needing 500 GB+ are listed");
  assert.ok(CATALOG_MODELS.length >= 300, `a rich catalogue (got ${CATALOG_MODELS.length})`);
  for (const m of CATALOG_MODELS) {
    assert.equal(m.blurb.length, 2, m.id);
    assert.ok(
      m.blurb.every((l) => l.trim().length > 0 && l.length <= 72),
      `${m.id} blurb`,
    );
    assert.ok(/^[\w.-]+\/[\w.-]+$/.test(m.repo), `${m.id} official repo`);
    assert.ok(m.gate.formats.length > 0, `${m.id} has a safe weight format`);
    assert.ok(m.license.length > 0, `${m.id} licence`);
    // never a pickle file as the thing Prometheus downloads
    assert.ok(!m.gguf || m.gguf.file.endsWith(".gguf"), `${m.id} gguf file`);
    // an ollama tag in the LOCAL column is never a host-qualified or cloud tag
    if (m.ollama) assert.ok(!m.ollama.includes("hf.co/") && !/(:|-)cloud\b/.test(m.ollama), m.id);
  }
  const ids = CATALOG_MODELS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
});

test("every cloud model names a registered provider; every free model has a free tier", () => {
  const ids = new Set(API_PROVIDERS.map((p) => p.id));
  const tiers = new Set(FREE_TIERS.map((t) => t.providerId));
  for (const m of CLOUD_MODELS) {
    assert.ok(ids.has(m.providerId), `${m.providerId} not in API_PROVIDERS`);
    if (m.section === "free")
      assert.ok(tiers.has(m.providerId), `${m.providerId} has no FREE_TIERS row`);
    assert.ok(m.blurb.strengths.length > 0 && m.blurb.limits.length > 0, `${m.model} blurb`);
    assert.ok(
      m.blurb.strengths.length <= 90 && m.blurb.limits.length <= 90,
      `${m.model} blurb too long for a row`,
    );
  }
  for (const t of FREE_TIERS) assert.ok(ids.has(t.providerId), `tier ${t.providerId} unregistered`);
});

test("local blurbs are short enough for one terminal row", () => {
  for (const m of LOCAL_MODELS) {
    assert.ok(m.blurb.strengths.length <= 90, `${m.id} strengths`);
    assert.ok(m.blurb.limits.length <= 90, `${m.id} limits`);
  }
});

test("plan: fits → native; over budget → refused, with the disk-streaming runtimes that could run it", () => {
  const q8 = findLocalModel("qwen3-8b");
  assert.ok(q8);
  assert.equal(planLocalModel(q8, mac36).kind, "native");

  const coder = findLocalModel("qwen3-coder:30b");
  assert.ok(coder, "lookup by ollama tag works");
  assert.equal(planLocalModel(coder, mac36).kind, "native");
  const onSixteen = planLocalModel(coder, mac16);
  assert.equal(
    onSixteen.kind,
    "too-big",
    "a model over the RAM budget is never planned as runnable",
  );
  if (onSixteen.kind === "too-big") {
    assert.equal(onSixteen.streaming[0]?.runtime.id, "colibri", "colibri first for a MoE it reads");
    assert.equal(onSixteen.streaming[0]?.interactive, true);
    assert.ok(onSixteen.streaming.some((o) => o.runtime.id === "llamacpp-stream"));
  }

  const llama70 = findLocalModel("llama3.3-70b");
  assert.ok(llama70);
  const p = planLocalModel(llama70, mac36);
  assert.equal(p.kind, "too-big");
  if (p.kind === "too-big") {
    const ids = p.streaming.map((o) => o.runtime.id);
    assert.ok(ids.includes("airllm") && ids.includes("llamacpp-stream"), ids.join());
    assert.ok(!ids.includes("colibri"), "colibri is MoE-only");
    assert.ok(
      p.streaming.every((o) => !o.interactive),
      "a dense model streamed from disk is never interactive",
    );
    assert.ok(p.needGb > mac36.ramGb);
  }
});

test("plan: colibri is offered only for the architectures it reads; AirLLM only where it runs", () => {
  const big = findLocalModel("gpt-oss-120b");
  assert.ok(big);
  const p = planLocalModel(big, mac36);
  assert.equal(p.kind, "too-big");
  if (p.kind === "too-big") assert.ok(!p.streaming.some((o) => o.runtime.id === "colibri"));
  // AirLLM: Llama/Mistral on Apple Silicon only; an NVIDIA GPU elsewhere
  const llama70 = findLocalModel("llama3.3-70b");
  assert.ok(llama70);
  const linuxCpu = planLocalModel(llama70, { ramGb: 32, vramGb: 0, unified: false });
  assert.ok(
    linuxCpu.kind === "too-big" && !linuxCpu.streaming.some((o) => o.runtime.id === "airllm"),
  );
  const linuxGpu = planLocalModel(llama70, { ramGb: 32, vramGb: 24, unified: false });
  assert.ok(
    linuxGpu.kind === "too-big" && linuxGpu.streaming.some((o) => o.runtime.id === "airllm"),
  );
});

test("plan: when Q4 is too big but the small quant fits, the small quant is planned", () => {
  const glm = findLocalModel("glm-4.6");
  assert.ok(glm?.ggufSmall && glm.smallMinRamGb !== undefined);
  const box: MachineProfile = { ramGb: 192, vramGb: 0, unified: true, freeDiskGb: 4000 };
  const p = planLocalModel(glm, box);
  assert.equal(p.kind, "native");
  assert.equal(p.kind === "native" && p.quant, "small");
  const prep = preparePlan(
    { section: "local", id: glm.id },
    { machine: box, keyFor: () => undefined, ollamaInstalled: true, ollamaServing: true },
  );
  assert.ok(!prep.blocked, prep.blocked);
  assert.equal(prep.runtime, "llamacpp");
  const fetch = prep.actions.find((a) => a.kind === "fetch-gguf");
  assert.equal(fetch?.kind === "fetch-gguf" && fetch.file, glm.ggufSmall.file);
});

test("declining the offload → alternatives that DO fit, same purpose first", () => {
  const coder = findLocalModel("qwen3-coder-30b");
  assert.ok(coder);
  const alts = nativeAlternatives(mac16, { wanted: coder });
  assert.ok(alts.length > 0);
  for (const a of alts) assert.equal(planLocalModel(a, mac16).kind, "native");
  assert.ok(alts[0]?.tags.includes("coding"), "a coding model first for a coding pick");
});

test("machineFromHost: Apple Silicon is unified memory", () => {
  const m = machineFromHost({ totalMemBytes: 36 * 1024 ** 3, platform: "darwin", arch: "arm64" });
  assert.deepEqual(m, { platform: "darwin", arch: "arm64", ramGb: 36, vramGb: 0, unified: true });
  assert.equal(
    machineFromHost({ totalMemBytes: 1, platform: "linux", arch: "x64" }).unified,
    false,
  );
});

test("refs round-trip, including model ids that contain ':'", () => {
  const refs = [
    { section: "local", id: "qwen3-8b" },
    { section: "served", runner: "ollama", model: "qwen3:8b" },
    { section: "free", providerId: "openrouter", model: "qwen/qwen3-coder:free" },
    { section: "paid", providerId: "anthropic", model: "claude-sonnet-5-5" },
    { section: "rotation" },
  ] as const;
  for (const r of refs) assert.deepEqual(parseRef(formatRef(r)), r);
  assert.equal(parseRef("nonsense"), null);
  assert.equal(parseRef("free:groq:"), null);
  assert.deepEqual(parseRef("rotate"), { section: "rotation" });
});

test("steps: root → local|cloud, cloud → free|paid|rotation", () => {
  assert.deepEqual(
    rootStep().rows.map((r) => r.next),
    ["local", "cloud"],
  );
  const cloud = cloudStep({ machine: mac36, keyFor: () => undefined });
  assert.deepEqual(
    cloud.rows.map((r) => r.next),
    ["free", "paid", "rotation"],
  );
  for (const r of [...rootStep().rows, ...cloud.rows]) assert.ok(r.lines.length >= 2);
});

test("local step: served models first, too-big hidden (and counted) unless asked", () => {
  const step = localStep({
    machine: tiny8,
    keyFor: () => undefined,
    served: [{ runner: "ollama", model: "qwen3:4b" }],
    installedOllama: ["qwen3:4b"],
  });
  assert.equal(step.rows[0]?.badge, "ready");
  assert.equal(step.rows[0]?.ref, "served:ollama:qwen3:4b");
  assert.ok(
    !step.rows.slice(1).some((r) => r.ref === "local:qwen3-4b"),
    "served model not listed twice",
  );
  assert.ok(step.intro.some((l) => /hidden/.test(l)));
  assert.ok(step.rows.every((r) => r.badge !== "too-big"));
  const all = localStep({ machine: tiny8, keyFor: () => undefined, showAll: true });
  assert.ok(all.rows.some((r) => r.badge === "too-big" && r.disabled));
});

test("free step: rows with a key come first and say where the key lives", () => {
  const step = cloudModelsStep("free", {
    machine: mac36,
    keyFor: (id) => (id === "nvidia" ? "keychain" : undefined),
  });
  assert.equal(step.rows[0]?.badge, "ready");
  assert.match(step.rows[0]?.detail ?? "", /keychain/);
  assert.ok(
    step.rows.some((r) => r.badge === "needs-key" && /https:\/\//.test(r.detail)),
    "sign-up URL shown",
  );
  assert.ok(step.rows.some((r) => r.badge === "keyless"));
});

test("rotation step: empty rotation explains how to start; members are not pickable rows", () => {
  const empty = rotationStep({ machine: mac36, keyFor: () => undefined, rotation: [] });
  assert.match(empty.intro[0] ?? "", /add a free key/i);
  assert.ok(empty.rows.every((r) => r.ref?.startsWith("free:")));
  const withOne = rotationStep({
    machine: mac36,
    keyFor: () => undefined,
    rotation: [
      {
        id: "groq:x",
        providerId: "groq",
        label: "x",
        baseUrl: "https://g/v1",
        model: "x",
        contextWindow: 131_072,
      },
    ],
  });
  assert.equal(withOne.rows[0]?.ref, "rotation");
  assert.ok(withOne.rows[1]?.disabled, "a member row cannot be picked on its own");
});

test("prepare: local pick on a machine without Ollama → install, pull, adopt", () => {
  const plan = preparePlan(
    { section: "local", id: "qwen3-8b" },
    { machine: mac36, keyFor: () => undefined, ollamaInstalled: false, ollamaServing: false },
  );
  assert.deepEqual(
    plan.actions.map((a) => a.kind),
    ["install-runner", "pull", "adopt"],
  );
  assert.equal(plan.localTag, "qwen3:8b", "the tag the runner will list it under");
  const served = preparePlan(
    { section: "local", id: "qwen3-8b" },
    {
      machine: mac36,
      keyFor: () => undefined,
      ollamaInstalled: true,
      ollamaServing: false,
      installedOllama: ["qwen3:8b"],
    },
  );
  assert.deepEqual(
    served.actions.map((a) => a.kind),
    ["start-runner", "adopt"],
  );
});

test("prepare: too big → refused WITH alternatives and the run-it-anyway refs; insisting needs a typed confirm", () => {
  const big = preparePlan(
    { section: "local", id: "gpt-oss-120b" },
    { machine: mac16, keyFor: () => undefined, ollamaInstalled: true, ollamaServing: true },
  );
  assert.ok(big.blocked);
  assert.equal(big.actions.length, 0, "nothing is downloaded for a refused pick");
  assert.ok((big.alternatives ?? []).length > 0);
  const base = {
    machine: { ...mac36, freeDiskGb: 2000 },
    keyFor: () => undefined,
    ollamaInstalled: true,
    ollamaServing: true,
  };
  const refused = preparePlan({ section: "local", id: "llama3.3-70b" }, base);
  assert.ok(refused.blocked);
  assert.ok((refused.insist ?? []).some((i) => i.ref === "local:llama3.3-70b@airllm"));
  const air = preparePlan({ section: "local", id: "llama3.3-70b", runtime: "airllm" }, base);
  assert.ok(!air.blocked, air.blocked);
  assert.deepEqual(
    air.actions.map((a) => a.kind),
    ["confirm-insist", "install-runtime", "fetch-snapshot", "serve-stream", "adopt"],
  );
  assert.ok(air.warnings.some((w) => /too slow/.test(w)));
  assert.equal(
    air.switchDefault,
    undefined,
    "a streaming runtime never becomes the default server",
  );
  const ssd = preparePlan(
    { section: "local", id: "llama3.3-70b", runtime: "llamacpp-stream" },
    base,
  );
  assert.deepEqual(
    ssd.actions.map((a) => a.kind),
    ["confirm-insist", "install-runtime", "fetch-gguf", "serve-gguf", "adopt"],
  );
  const serve = ssd.actions.find((a) => a.kind === "serve-gguf");
  assert.equal(serve?.kind === "serve-gguf" && serve.stream, true);
  // streaming a model that fits is refused: it would only be slower
  const fits = preparePlan({ section: "local", id: "qwen3-8b", runtime: "llamacpp-stream" }, base);
  assert.match(fits.blocked ?? "", /fits this machine/);
  // colibri: an MoE it reads, on a 16 GB machine
  const col = preparePlan(
    { section: "local", id: "qwen3-coder-30b", runtime: "colibri" },
    { ...base, machine: { ...mac16, freeDiskGb: 500 } },
  );
  assert.deepEqual(
    col.actions.map((a) => a.kind),
    ["confirm-insist", "install-runtime", "fetch-gguf", "serve-colibri", "adopt"],
  );
  const noCol = preparePlan(
    { section: "local", id: "gpt-oss-120b", runtime: "colibri" },
    { ...base, machine: { ...mac16, freeDiskGb: 2000 } },
  );
  assert.match(noCol.blocked ?? "", /colibri cannot load/);
});

test("prepare: the runtime is chosen per model, and the default server follows the pick", () => {
  const base = {
    machine: mac36,
    keyFor: () => undefined,
    ollamaInstalled: true,
    ollamaServing: true,
  };
  const gg = LOCAL_MODELS.find(
    (x) => !x.ollama && x.gguf && (x.gguf.shards ?? 1) === 1 && x.minRamGb <= 16 && !x.needsOffload,
  );
  assert.ok(gg);
  // no Ollama build, LM Studio installed → LM Studio, and the default moves there
  const lm = preparePlan(
    { section: "local", id: gg.id },
    { ...base, runtimeInstalled: { lmstudio: true } },
  );
  assert.equal(lm.runtime, "lmstudio");
  assert.deepEqual(lm.switchDefault, { from: "ollama", to: "lmstudio" });
  // nothing installed → llama.cpp, installed through Homebrew first
  const ll = preparePlan({ section: "local", id: gg.id }, base);
  assert.equal(ll.runtime, "llamacpp");
  assert.equal(ll.actions[0]?.kind, "install-runtime");
  assert.deepEqual(ll.switchDefault, { from: "ollama", to: "llamacpp" });
  // an Ollama model with Ollama as the default: no switch
  const ol = preparePlan({ section: "local", id: "qwen3-8b" }, base);
  assert.equal(ol.runtime, "ollama");
  assert.equal(ol.switchDefault, undefined);
  // the default is LM Studio and the model has a GGUF too: it stays on LM Studio
  const q8 = findLocalModel("qwen3-8b");
  if (q8?.gguf) {
    const stay = preparePlan(
      { section: "local", id: "qwen3-8b" },
      { ...base, defaultServer: "lmstudio", runtimeInstalled: { lmstudio: true } },
    );
    assert.equal(stay.runtime, "lmstudio");
    assert.equal(stay.switchDefault, undefined);
  }
  // the default is LM Studio but the model has ONLY an Ollama build: back to Ollama
  const onlyTag = LOCAL_MODELS.find((x) => x.ollama && !x.gguf && x.minRamGb <= 16);
  if (onlyTag) {
    const back = preparePlan(
      { section: "local", id: onlyTag.id },
      { ...base, defaultServer: "lmstudio" },
    );
    assert.equal(back.runtime, "ollama");
    assert.deepEqual(back.switchDefault, { from: "lmstudio", to: "ollama" });
  }
});

test("prepare: free pick without a key asks for one; keyless does not; data-use warned", () => {
  const nv = preparePlan(
    { section: "free", providerId: "nvidia", model: "nvidia/llama-3.3-nemotron-super-49b-v1.5" },
    { machine: mac36, keyFor: () => undefined, ollamaInstalled: false, ollamaServing: false },
  );
  assert.equal(nv.actions[0]?.kind, "set-key");
  assert.ok(nv.warnings.some((w) => /logged/.test(w)));
  const ovh = preparePlan(
    { section: "free", providerId: "ovhcloud", model: "gpt-oss-120b" },
    { machine: mac36, keyFor: () => undefined, ollamaInstalled: false, ollamaServing: false },
  );
  assert.deepEqual(
    ovh.actions.map((a) => a.kind),
    ["adopt"],
  );
  const rot = preparePlan(
    { section: "rotation" },
    {
      machine: mac36,
      keyFor: () => undefined,
      ollamaInstalled: false,
      ollamaServing: false,
      rotation: [],
    },
  );
  assert.ok(rot.blocked);
});

test("live models: exact, renamed (dated build / case), missing; empty list is unknown", () => {
  assert.deepEqual(matchLiveModel("a", ["a"]), { kind: "exact", model: "a" });
  assert.deepEqual(matchLiveModel("x", []), { kind: "exact", model: "x" });
  assert.deepEqual(matchLiveModel("Llama-3.3-70B", ["llama-3.3-70b"]), {
    kind: "renamed",
    model: "llama-3.3-70b",
  });
  assert.deepEqual(
    matchLiveModel("moonshotai/kimi-k2-instruct", ["moonshotai/kimi-k2-instruct-0905"]),
    {
      kind: "renamed",
      model: "moonshotai/kimi-k2-instruct-0905",
    },
  );
  assert.deepEqual(matchLiveModel("gone-model", ["other"]), { kind: "missing" });
});

test("runtime refs round-trip and plan a gated download for llama.cpp / LM Studio", () => {
  const m = LOCAL_MODELS.find((x) => x.gguf && x.minRamGb <= 16 && !x.needsOffload);
  assert.ok(m);
  assert.deepEqual(parseRef(`local:${m.id}@llamacpp`), {
    section: "local",
    id: m.id,
    runtime: "llamacpp",
  });
  assert.equal(
    formatRef({ section: "local", id: m.id, runtime: "lmstudio" }),
    `local:${m.id}@lmstudio`,
  );
  assert.deepEqual(parseRef("local:x@nonsense"), { section: "local", id: "x@nonsense" });
  const base = {
    machine: mac36,
    keyFor: () => undefined,
    ollamaInstalled: true,
    ollamaServing: false,
  };
  const ll = preparePlan({ section: "local", id: m.id, runtime: "llamacpp" }, base);
  assert.deepEqual(
    ll.actions.map((a) => a.kind),
    ["install-runtime", "fetch-gguf", "serve-gguf", "adopt"],
  );
  const lm = preparePlan(
    { section: "local", id: m.id, runtime: "lmstudio" },
    { ...base, runtimeInstalled: { lmstudio: true }, runtimeServing: { lmstudio: true } },
  );
  assert.deepEqual(
    lm.actions.map((a) => a.kind),
    ["fetch-gguf", "link-lmstudio", "start-runtime", "adopt"],
  );
  // never a runtime-side download: no action names a remote reference
  for (const a of [...ll.actions, ...lm.actions]) assert.ok(!JSON.stringify(a).includes("hf.co/"));
  const noGguf = LOCAL_MODELS.find((x) => !x.gguf && x.ollama);
  if (noGguf) {
    const b = preparePlan({ section: "local", id: noGguf.id, runtime: "llamacpp" }, base);
    assert.match(b.blocked ?? "", /GGUF/);
  }
});

test("review fixes: giant MoE via colibri is never interactive; an Ollama import needs room for one copy", () => {
  const glm = findLocalModel("glm-5.2");
  if (glm) {
    const p = planLocalModel(glm, { ramGb: 64, vramGb: 0, unified: true });
    assert.equal(p.kind, "too-big");
    if (p.kind === "too-big") {
      const c = p.streaming.find((o) => o.runtime.id === "colibri");
      assert.ok(c, "glm-5.2 is a colibri architecture");
      assert.equal(c?.interactive, false);
    }
  }
  const gg = LOCAL_MODELS.find(
    (x) => !x.ollama && x.gguf && (x.gguf.shards ?? 1) === 1 && x.minRamGb <= 16,
  );
  assert.ok(gg);
  const tight = { ...mac36, freeDiskGb: gg.q4Gb * 1.5 };
  const ctx = {
    machine: tight,
    keyFor: () => undefined,
    ollamaInstalled: true,
    ollamaServing: true,
  };
  // imported into Ollama: zero-copy now (the admitted GGUF becomes Ollama's blob), so 1.5×
  // the model is enough — exactly as for llama.cpp serving it in place
  assert.ok(!preparePlan({ section: "local", id: gg.id, runtime: "ollama" }, ctx).blocked);
  assert.ok(!preparePlan({ section: "local", id: gg.id }, ctx).blocked);
  // and below one copy + 10% it is refused for every runtime
  const full = { ...ctx, machine: { ...mac36, freeDiskGb: gg.q4Gb * 1.05 } };
  assert.match(
    preparePlan({ section: "local", id: gg.id, runtime: "ollama" }, full).blocked ?? "",
    /disk/,
  );
});

test("review fixes: split GGUF goes to llama.cpp; an MLX-only build goes to MLX on Apple Silicon", () => {
  const split = LOCAL_MODELS.find((x) => !x.ollama && (x.gguf?.shards ?? 1) > 1);
  const ctx = {
    machine: { ramGb: 2048, vramGb: 0, unified: true, freeDiskGb: 100000 },
    keyFor: () => undefined,
    ollamaInstalled: true,
    ollamaServing: true,
  };
  if (split) {
    const auto = preparePlan({ section: "local", id: split.id }, ctx);
    assert.ok(!auto.blocked, auto.blocked);
    assert.equal(auto.runtime, "llamacpp");
    assert.match(
      preparePlan({ section: "local", id: split.id, runtime: "ollama" }, ctx).blocked ?? "",
      /llamacpp/,
    );
  }
  const mlxOnly = LOCAL_MODELS.find(
    (x) => !x.ollama && !x.gguf && x.mlx && !x.remoteCode && x.minRamGb <= 16,
  );
  assert.ok(mlxOnly, "the catalogue has MLX-only models");
  const mac = preparePlan({ section: "local", id: mlxOnly.id }, ctx);
  assert.equal(mac.runtime, "mlx");
  assert.deepEqual(
    mac.actions.map((a) => a.kind),
    ["install-runtime", "fetch-snapshot", "serve-mlx", "adopt"],
  );
  const viaLm = preparePlan(
    { section: "local", id: mlxOnly.id },
    { ...ctx, runtimeInstalled: { lmstudio: true } },
  );
  assert.equal(viaLm.runtime, "lmstudio");
  assert.ok(viaLm.actions.some((a) => a.kind === "link-lmstudio" && a.format === "mlx"));
  const linux = preparePlan(
    { section: "local", id: mlxOnly.id },
    { ...ctx, machine: { ...ctx.machine, unified: false } },
  );
  assert.match(linux.blocked ?? "", /Apple Silicon/);
});

test("every download names the runtime folder it lands in, and needs room for ONE copy", () => {
  const base = {
    machine: mac36,
    keyFor: () => undefined,
    ollamaInstalled: true,
    ollamaServing: true,
  };
  const gg = LOCAL_MODELS.find(
    (x) => !x.ollama && x.gguf && (x.gguf.shards ?? 1) === 1 && x.minRamGb <= 16 && !x.needsOffload,
  );
  assert.ok(gg);
  const placeOf = (p: ReturnType<typeof preparePlan>) =>
    p.actions.flatMap((a) =>
      a.kind === "fetch-gguf" || a.kind === "fetch-snapshot" ? [a.place] : [],
    );
  assert.deepEqual(placeOf(preparePlan({ section: "local", id: gg.id }, base)), ["hf"]);
  assert.deepEqual(
    placeOf(
      preparePlan(
        { section: "local", id: gg.id },
        { ...base, runtimeInstalled: { lmstudio: true } },
      ),
    ),
    ["lmstudio"],
  );
  assert.deepEqual(placeOf(preparePlan({ section: "local", id: gg.id, runtime: "ollama" }, base)), [
    "ollama",
  ]);
  // one copy (+10%) for every runtime — an Ollama import is zero-copy now
  const tight = { ...mac36, freeDiskGb: gg.q4Gb * 1.5 };
  assert.equal(diskFits(gg, tight, "llamacpp"), true);
  assert.equal(diskFits(gg, tight, "ollama"), true);
  assert.equal(diskFits(gg, { ...mac36, freeDiskGb: gg.q4Gb * 1.05 }, "ollama"), false);
  // measured on the store the pick writes to: a full internal disk does not refuse a model
  // bound for LM Studio's folder on a big external drive
  const split = {
    ...mac36,
    freeDiskGb: 0.01,
    freeDiskGbByStore: { lmstudio: gg.q4Gb * 3, ollama: 0.01 },
  };
  assert.equal(diskFits(gg, split, "lmstudio"), true);
  assert.equal(diskFits(gg, split, "ollama"), false);
  const ollamaPlan = preparePlan({ section: "local", id: gg.id, runtime: "ollama" }, base);
  assert.ok(ollamaPlan.warnings.some((w) => /no second copy/.test(w)));
  assert.ok(!ollamaPlan.warnings.some((w) => /twice the disk|transit copy/.test(w)));
});

test("one headroom table: every catalogue model runs on a machine of exactly its RAM tier", () => {
  // The builder assigns min_ram_gb = the smallest tier T whose usable share holds the model;
  // the runtime must agree, or a 16 GB model is refused on a 16 GB machine (it was: ~160 rows).
  const refused: string[] = [];
  for (const m of LOCAL_MODELS) {
    if (m.needsOffload || m.minRamGb > 2048) continue;
    const plan = planLocalModel(m, { ramGb: m.minRamGb, vramGb: 0, unified: true });
    if (plan.kind !== "native") refused.push(`${m.id}@${m.minRamGb}`);
  }
  assert.deepEqual(refused.slice(0, 10), []);
});

test("streaming offers match what each runtime can load, where it has a build", () => {
  const mac = { ramGb: 64, vramGb: 0, unified: true, platform: "darwin", arch: "arm64" };
  const ids = (id: string, m = mac) =>
    streamingOptions(LOCAL_MODELS.find((x) => x.id === id) ?? assert.fail(id), m).map(
      (o) => o.runtime.id,
    );
  // a DENSE 405B (active == total in the catalogue) is AirLLM's flagship case, not a MoE
  const dense = LOCAL_MODELS.find((x) => x.id === "llama3.1-405b");
  if (dense?.hfRepo && !dense.remoteCode) assert.ok(ids("llama3.1-405b").includes("airllm"));
  // a vision model passes the family regex but AirLLM cannot load it
  for (const v of LOCAL_MODELS.filter((x) => x.vision && /llama|mistral/i.test(x.family ?? x.id)))
    assert.ok(!ids(v.id).includes("airllm"), v.id);
  // no build for Windows: neither colibri nor AirLLM is offered there
  const win = { ...mac, unified: false, platform: "win32", arch: "x64", vramGb: 24 };
  for (const m of LOCAL_MODELS.slice(0, 400))
    for (const o of streamingOptions(m, win))
      assert.ok(
        o.runtime.id !== "colibri" && o.runtime.id !== "airllm",
        `${m.id} → ${o.runtime.id}`,
      );
});
