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
import { CLOUD_MODELS } from "./cloud.js";
import { FREE_TIERS } from "./free-tier.js";
import { matchLiveModel } from "./live-models.js";
import { LOCAL_MODELS, findLocalModel } from "./local.js";
import { machineFromHost, nativeAlternatives, planLocalModel } from "./plan.js";
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

test("local catalogue figures match config/open-models.json (no silent drift)", () => {
  for (const m of LOCAL_MODELS) {
    const row = OPEN_MODELS.models.find((r) => r.id === (m.figuresFrom ?? m.id));
    if (m.figuresFrom)
      assert.ok(row, `${m.id}: figuresFrom ${m.figuresFrom} is not a catalogue row`);
    if (!row) {
      // colibri-only rows are not in the Ollama-centred catalogue
      assert.ok(m.colibri && !m.ollama, `${m.id} is missing from open-models.json`);
      continue;
    }
    assert.equal(m.q4Gb, row.resource?.q4_gb, `${m.id} q4Gb`);
    assert.equal(m.minRamGb, row.resource?.min_ram_gb, `${m.id} minRamGb`);
    assert.equal(m.context, row.context, `${m.id} context`);
    if (row.ollama && !m.figuresFrom) assert.equal(m.ollama, row.ollama, `${m.id} ollama tag`);
  }
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

test("plan: a small model runs natively; a 30B MoE on 16 GB needs colibri; 70B dense → AirLLM", () => {
  const q8 = findLocalModel("qwen3-8b");
  assert.ok(q8);
  assert.equal(planLocalModel(q8, mac36).kind, "native");

  const coder = findLocalModel("qwen3-coder:30b");
  assert.ok(coder, "lookup by ollama tag works");
  assert.equal(planLocalModel(coder, mac36).kind, "native");
  const onSixteen = planLocalModel(coder, mac16);
  assert.equal(onSixteen.kind, "offload");
  assert.equal(onSixteen.kind === "offload" && onSixteen.runtime.id, "colibri");
  assert.equal(onSixteen.kind === "offload" && onSixteen.interactive, true);

  const llama70 = findLocalModel("llama3.3-70b");
  assert.ok(llama70);
  const p = planLocalModel(llama70, mac36);
  assert.equal(p.kind, "offload");
  assert.equal(p.kind === "offload" && p.runtime.id, "airllm");
  assert.equal(
    p.kind === "offload" && p.interactive,
    false,
    "AirLLM is never offered as interactive",
  );
});

test("plan: a big MoE colibri does not ship is simply too big", () => {
  const big = findLocalModel("gpt-oss-120b");
  assert.ok(big);
  assert.equal(planLocalModel(big, mac36).kind, "too-big");
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
  assert.deepEqual(m, { ramGb: 36, vramGb: 0, unified: true });
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

test("prepare: too big → blocked WITH alternatives; offload → install first, warn when slow", () => {
  const big = preparePlan(
    { section: "local", id: "gpt-oss-120b" },
    { machine: mac16, keyFor: () => undefined, ollamaInstalled: true, ollamaServing: true },
  );
  assert.ok(big.blocked);
  assert.ok((big.alternatives ?? []).length > 0);
  const air = preparePlan(
    { section: "local", id: "llama3.3-70b" },
    { machine: mac36, keyFor: () => undefined, ollamaInstalled: true, ollamaServing: true },
  );
  assert.equal(air.actions[0]?.kind, "install-offload");
  assert.ok(air.warnings.some((w) => /too slow/.test(w)));
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
