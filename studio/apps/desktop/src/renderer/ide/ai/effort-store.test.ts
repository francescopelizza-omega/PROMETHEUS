/**
 * effort-store.test.ts — the composer chip has to resolve against a MEASURED endpoint.
 *
 * The regression pinned here: `effortFor` used to call `resolveCapability` without
 * `probedCapabilities`. `ai/effort/rules.ts` scores a probe-backed match above every model-name
 * match on purpose — model ids are unstable and reasoning support is version-scoped (Gemma 2/3
 * cannot think, Gemma 4 can) — so omitting the probe meant those rules could never fire, EVERY
 * locally-served model fell through to `UNKNOWN_CAPABILITY`, and the chip reported
 * "not available" for models that report `thinking` in as many words.
 *
 * Both models below are real: `qwen3.6:latest` and `gemma4:12b` each answer Ollama's
 * `/api/show` with `capabilities` containing `thinking`, and neither matches any name rule.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RendererEndpoint } from "./ai-client.js";
import { effortFor, useEffortStore } from "./effort-store.js";

const OLLAMA = "http://127.0.0.1:11434/v1";

function local(model: string, capabilities?: readonly string[]): RendererEndpoint {
  return {
    id: `ollama · ${model}`,
    baseUrl: OLLAMA,
    locality: "local",
    model,
    ...(capabilities ? { probedCapabilities: capabilities } : {}),
  };
}

test("a probed thinking model resolves to a REAL request parameter, not 'not available'", () => {
  for (const model of ["qwen3.6:latest", "gemma4:12b"]) {
    const r = effortFor("high", local(model, ["completion", "vision", "tools", "thinking"]));
    assert.equal(r?.applied, "high", `${model} did not apply the tier`);
    assert.equal(r?.mechanism, "effort-enum");
    assert.deepEqual(r?.patch, { kind: "body", path: "reasoning_effort", value: "high" });
    assert.equal(r?.degraded, null);
  }
});

test("the SAME model with no probe data sends NO parameter — the wire guarantee", () => {
  // Not a bug: unprobed genuinely IS unknown, and guessing a knob that a model does not have
  // is a 400 on some providers and a silent no-op on others. What was broken is that the
  // probe result existed and never travelled this far.
  const r = effortFor("high", local("qwen3.6:latest"));
  assert.equal(r?.mechanism, "none");
  assert.deepEqual(r?.patch, { kind: "none" }, "nothing may go on the wire for an unknown knob");
  // …but the tier is still honoured, by instruction rather than by parameter. The chip shows
  // the tier and warn-tints it; it does NOT claim "not available", which would be false about
  // the outcome even while true about the parameter.
  assert.equal(r?.applied, "high");
  assert.equal(r?.degraded?.reason, "emulated");
  assert.equal(r?.emulation?.via, "prompt-cot");
});

test("a probe that reports NO thinking is definitive — it does not fall through to a name guess", () => {
  const r = effortFor("high", local("gemma3:12b", ["completion", "tools"]));
  assert.equal(r?.mechanism, "none", "the probe's answer is authoritative, not a name guess");
  assert.deepEqual(r?.patch, { kind: "none" });
  // The runner's own sentence survives into the message, so the chip's tooltip can tell this
  // apart from a model whose runtime merely swallows the setting.
  assert.match(r?.degraded?.message ?? "", /no reasoning mode/);
  assert.equal(r?.degraded?.reason, "emulated");
});

test("`off` on a knobless model reads 'not available' — there is nothing to turn off", () => {
  // The one case where the chip still says n/a for a model with no knob: asking for LESS
  // deliberation from something that never deliberates has no honest rendering as a tier.
  const r = effortFor("off", local("gemma3:12b", ["completion", "tools"]));
  assert.equal(r?.applied, null);
  assert.equal(r?.emulation, undefined);
});

test("`off` reaches the wire as the runner's own word for it, not as a dropped field", () => {
  const r = effortFor("off", local("qwen3.6:latest", ["completion", "tools", "thinking"]));
  assert.deepEqual(r?.patch, { kind: "body", path: "reasoning_effort", value: "none" });
});

test("no endpoint ⇒ undefined, and the chip renders 'not available' rather than a tier", () => {
  assert.equal(effortFor("high", null), undefined);
  assert.equal(effortFor("high", undefined), undefined);
});

test("a CLOUD endpoint is unaffected by the probe plumbing", () => {
  const r = effortFor("high", {
    id: "cloud:openai",
    baseUrl: "https://api.openai.com/v1",
    locality: "cloud",
    model: "gpt-5",
  });
  assert.equal(r?.applied, "high");
  assert.deepEqual(r?.patch, { kind: "body", path: "reasoning_effort", value: "high" });
});

/* ── V1: the chip must report the APPLIED tier, not the requested one ───────*/

test("a CLAMPED tier resolves to the level the model will really use", () => {
  // gpt-oss has three levels, so `max` is served as `high`. The chip renders
  // `EFFORT_SHORT[resolution.applied]`; rendering the requested tier there would be the same
  // misreport the CLI badge was fixed for — a confident "max" for something that was clamped.
  const r = effortFor("max", {
    id: "ollama · gpt-oss:20b",
    baseUrl: OLLAMA,
    locality: "local",
    model: "gpt-oss:20b",
  });
  assert.equal(r?.requested, "max");
  assert.equal(r?.applied, "high", "the chip would have shown `max`");
  assert.equal(r?.degraded?.reason, "tier-clamped");
});

test("an EMULATED tier reports the tier — it is in force, just not as a parameter", () => {
  const r = effortFor("high", local("gemma3:12b", ["completion", "tools"]));
  assert.equal(r?.applied, "high");
  assert.equal(r?.degraded?.reason, "emulated");
  assert.deepEqual(r?.patch, { kind: "none" }, "and still nothing on the wire");
});

test("an ALWAYS-ON model is the one case the chip reads `n/a`", () => {
  // UNPROBED on purpose. With a probe reporting `thinking`, Ollama's shim rule wins on
  // specificity and R1 gets a real `reasoning_effort` — which is correct, and is why the
  // always-on verdict only stands where no probe contradicts it.
  const r = effortFor("high", local("deepseek-r1:8b"));
  assert.equal(r?.applied, null);
  assert.equal(r?.degraded?.reason, "always-on");
});

test("…and a PROBE overrules that verdict, because the runner is the authority", () => {
  const r = effortFor("high", local("deepseek-r1:8b", ["completion", "thinking"]));
  assert.equal(r?.applied, "high");
  assert.deepEqual(r?.patch, { kind: "body", path: "reasoning_effort", value: "high" });
});

/* ── V3: the desktop finally READS ai.effort / ai.effortForce ───────────────*/

test("force sends the knob where the table says there is none, and marks it forced", () => {
  // `ai.effortForce` existed in the schema with no reader at all — validated on write and
  // ignored on read. (And until it was registered in SETTINGS_TREE, `settings-ipc` refused to
  // write it either, since get/set gate on `findNodeBySchemaKey`.)
  const ep = local("gemma3:12b", ["completion", "tools"]);
  const plain = effortFor("high", ep);
  assert.deepEqual(plain?.patch, { kind: "none" }, "unforced, nothing goes on the wire");
  assert.equal(plain?.degraded?.reason, "emulated");

  const forced = effortFor("high", ep, { force: true });
  assert.deepEqual(forced?.patch, { kind: "body", path: "reasoning_effort", value: "high" });
  assert.equal(forced?.degraded?.reason, "forced");
});

test("force is a NO-OP where the tier already works — it never rewrites a good mechanism", () => {
  const ep = local("qwen3.6:latest", ["completion", "tools", "thinking"]);
  const forced = effortFor("high", ep, { force: true });
  assert.equal(forced?.degraded, null);
  assert.deepEqual(forced?.patch, { kind: "body", path: "reasoning_effort", value: "high" });
});

test("hydrate adopts the configured tier only when the user has NOT chosen one", () => {
  // A click on the chip is a decision about THIS session; a settings read landing a moment
  // later must not overwrite it. With no stored choice (no localStorage in node), the
  // configured default lands.
  const store = useEffortStore.getState();
  store.hydrate("low", true);
  assert.equal(useEffortStore.getState().tier, "low");
  assert.equal(useEffortStore.getState().force, true);

  // an explicit choice, then a second hydrate: the choice stands, force still follows settings
  useEffortStore.getState().setTier("max");
  useEffortStore.getState().hydrate("low", false);
  assert.equal(useEffortStore.getState().tier, "max", "an explicit choice was overwritten");
  assert.equal(useEffortStore.getState().force, false);
});

test("hydrate ignores absent keys rather than resetting to a default", () => {
  useEffortStore.getState().setTier("high");
  useEffortStore.getState().hydrate(undefined, undefined);
  assert.equal(useEffortStore.getState().tier, "high");
});
