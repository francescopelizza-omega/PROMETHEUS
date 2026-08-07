import assert from "node:assert/strict";
/**
 * effort.test.ts — the cross-model reasoning-effort ladder.
 *
 * The single most important property under test is NEGATIVE: a model with no reasoning
 * control must put NOTHING extra on the wire. Before this module existed, `/effort max`
 * was stored, echoed, displayed in `/status` — and silently discarded by the transport, so
 * the user was told a knob had turned when it had not. Half of these tests exist to make
 * that regression loud.
 *
 * The Ollama enum vocabularies below are not guesses: both were read back from a live
 * Ollama 0.32.6 error message, which enumerates the accepted set on rejection.
 */
import { test } from "node:test";

import { applyEffort, applyEffortToMessages, describeEffort, resolveEffort } from "./apply.js";
import { builtinRules, resolveCapability, runtimeFromBaseUrl } from "./rules.js";
import type { EffortCapability } from "./types.js";
import { EFFORT_TIERS, isEffortTier, nearestTier } from "./types.js";

/* ── the ladder ───────────────────────────────────────────────────────────── */

test("the ladder is ascending and off is the floor", () => {
  assert.deepEqual([...EFFORT_TIERS], ["off", "low", "medium", "high", "max"]);
  assert.ok(isEffortTier("off"));
  assert.ok(isEffortTier("max"));
  assert.equal(isEffortTier("xhigh"), false);
  assert.equal(isEffortTier("minimal"), false); // Ollama rejects this too
});

test("nearestTier clamps to the closest supported tier, breaking ties downward", () => {
  // gpt-oss has no `max`; asking for it must land on `high`, never invent a level.
  assert.equal(nearestTier("max", ["low", "medium", "high"]), "high");
  // equidistant between low and high → the CHEAPER one, because silently spending more of
  // the user's battery/money is the worse surprise.
  assert.equal(nearestTier("medium", ["low", "high"]), "low");
  assert.equal(nearestTier("low", ["low", "high"]), "low");
  assert.equal(nearestTier("off", []), null);
});

/* ── the negative case: knobless models ───────────────────────────────────── */

test("a model with no reasoning control adds NOTHING to the body", () => {
  const cap: EffortCapability = { mechanism: "none", supported: [] };
  for (const tier of EFFORT_TIERS) {
    const r = resolveEffort(tier, cap);
    assert.equal(r.applied, null, `${tier} must not apply`);
    assert.equal(r.patch.kind, "none");
    assert.ok(r.degraded, "an unapplied effort MUST be reported as degraded");
    const before = { model: "m", messages: [] };
    assert.deepEqual(applyEffort(before, r), before, "body must be byte-identical");
  }
});

test("the three 'nothing happened' reasons stay distinct", () => {
  // They mean different things to a user deciding whether to switch models, so collapsing
  // them into one "unsupported" would destroy the only actionable part of the message.
  const none = resolveEffort("high", { mechanism: "none", supported: [] });
  const always = resolveEffort("high", { mechanism: "always-on", supported: [] });
  const ignores = resolveEffort("high", {
    mechanism: "none",
    supported: [],
    note: "LM Studio ignores per-request reasoning settings",
  });
  assert.equal(none.degraded?.reason, "no-capability");
  assert.equal(always.degraded?.reason, "always-on");
  assert.equal(ignores.degraded?.reason, "runtime-ignores");
});

/* ── the honesty invariant ────────────────────────────────────────────────── */

test("applied !== requested always carries a degraded explanation", () => {
  const caps: EffortCapability[] = [
    { mechanism: "none", supported: [] },
    { mechanism: "always-on", supported: [] },
    {
      mechanism: "effort-enum",
      field: "reasoning_effort",
      supported: ["low", "medium", "high"],
      enumMap: { low: "low", medium: "medium", high: "high" },
    },
  ];
  for (const cap of caps) {
    for (const tier of EFFORT_TIERS) {
      const r = resolveEffort(tier, cap);
      if (r.applied !== tier) {
        assert.ok(r.degraded, `${tier} on ${cap.mechanism}: silent divergence is a lie`);
        assert.ok((r.degraded?.message.length ?? 0) > 0, "the message must say something");
      }
    }
  }
});

/* ── per-mechanism wire shapes ────────────────────────────────────────────── */

test("effort-enum writes the provider's own vocabulary", () => {
  // verified live: Ollama's /v1 shim accepts exactly high|medium|low|max|none.
  const { cap } = resolveCapability({
    modelId: "gemma4:12b",
    runtime: "ollama",
    probedCapabilities: ["completion", "tools", "thinking"],
  });
  const r = resolveEffort("high", cap);
  assert.equal(r.applied, "high");
  assert.equal(r.degraded, null);
  assert.deepEqual(applyEffort({ model: "gemma4:12b" }, r), {
    model: "gemma4:12b",
    reasoning_effort: "high",
  });
  // `off` maps to the shim's "none", NOT to a dropped field — the user asked for something.
  assert.equal(
    (applyEffort({}, resolveEffort("off", cap)) as { reasoning_effort?: string }).reasoning_effort,
    "none",
  );
});

test("native-graded puts `think` at the TOP level, never inside options", () => {
  // Ollama's native /api/chat takes `think` as a sibling of `messages`; nesting it under
  // `options` (where sampling params live) silently does nothing.
  const { cap } = resolveCapability({
    modelId: "qwen3.6:latest",
    runtime: "ollama-native",
    probedCapabilities: ["thinking"],
  });
  const body = applyEffort(
    { model: "q", options: { temperature: 0.2 } },
    resolveEffort("max", cap),
  );
  assert.equal((body as { think?: unknown }).think, "max");
  assert.deepEqual((body as { options: unknown }).options, { temperature: 0.2 });
  // off is a boolean here, not a string — the enum and the disable value differ in TYPE.
  const off = applyEffort({}, resolveEffort("off", cap));
  assert.equal((off as { think?: unknown }).think, false);
});

test("token-budget clamps to provider bounds and stays under max_tokens", () => {
  const cap: EffortCapability = {
    mechanism: "token-budget",
    field: "thinking.budget_tokens",
    supported: ["off", "low", "medium", "high"],
    budgetMap: { low: 1024, medium: 2048, high: 32000 },
    budgetBounds: { min: 1024, max: 8192, disableWith: 0 },
    constraints: { budgetUnderMaxTokens: true },
  };
  // 32000 exceeds the provider max → clamp to 8192.
  const hi = applyEffort({}, resolveEffort("high", cap, {}));
  assert.deepEqual(hi, { thinking: { budget_tokens: 8192 } });
  // Anthropic 400s when budget >= max_tokens, so the budget must yield.
  const tight = applyEffort({ max_tokens: 2000 }, resolveEffort("high", cap, { maxTokens: 2000 }));
  assert.deepEqual(tight, { max_tokens: 2000, thinking: { budget_tokens: 1999 } });
});

test("template-kwarg nests under chat_template_kwargs and admits it may be ignored", () => {
  const { cap } = resolveCapability({ modelId: "qwen3:8b", runtime: "llamacpp" });
  const r = resolveEffort("off", cap);
  assert.deepEqual(applyEffort({ model: "q" }, r), {
    model: "q",
    chat_template_kwargs: { enable_thinking: false },
  });
  // llama.cpp forwards the kwarg but the template may not branch on it — say so.
  assert.equal(r.degraded?.reason, "runtime-ignores");
});

test("system-prompt-line folds Reasoning: into the system message, not the body", () => {
  const { cap } = resolveCapability({ modelId: "gpt-oss:20b" });
  const r = resolveEffort("high", cap);
  assert.equal(r.patch.kind, "prompt");
  // nothing goes in the body — this knob is literally a line of English.
  assert.deepEqual(applyEffort({ model: "gpt-oss:20b" }, r), { model: "gpt-oss:20b" });
  const msgs = applyEffortToMessages(
    [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ],
    r,
  );
  assert.equal(msgs[0]?.content, "You are helpful.\nReasoning: high");
  assert.equal(msgs[1]?.content, "hi");
});

test("gpt-oss clamps max to high because it only has three levels", () => {
  const { cap } = resolveCapability({ modelId: "gpt-oss:120b" });
  const r = resolveEffort("max", cap);
  assert.equal(r.applied, "high");
  assert.equal(r.degraded?.reason, "tier-clamped");
});

test("system-prompt-line creates a system message when none exists", () => {
  const { cap } = resolveCapability({ modelId: "gpt-oss:20b" });
  const msgs = applyEffortToMessages([{ role: "user", content: "hi" }], resolveEffort("low", cap));
  assert.deepEqual(msgs[0], { role: "system", content: "Reasoning: low" });
});

/* ── side-constraints that would otherwise break the request ──────────────── */

test("DeepSeek R1 is always-on, suppresses temperature, and sends no knob", () => {
  const { cap } = resolveCapability({ modelId: "deepseek-r1:70b" });
  const r = resolveEffort("max", cap);
  assert.equal(r.mechanism, "always-on");
  assert.equal(r.applied, null);
  // R1 ACCEPTS temperature and then ignores it; sending one implies a control we lack.
  const body = applyEffort({ model: "deepseek-r1:70b", temperature: 0.7 }, r);
  assert.equal("temperature" in body, false);
  assert.equal("reasoning_effort" in body, false);
});

test("Kimi K2-Thinking raises a max_tokens floor so the answer is not truncated", () => {
  const { cap } = resolveCapability({ modelId: "kimi-k2-thinking" });
  const body = applyEffort({ max_tokens: 4096 }, resolveEffort("high", cap));
  assert.equal((body as { max_tokens?: number }).max_tokens, 16000);
});

/* ── capability resolution: a probe must beat a name guess ────────────────── */

test("a runtime probe outranks any name-based rule", () => {
  // Gemma 3 has no reasoning mode; Gemma 4 does. A family-level hardcode is wrong within
  // one generation, which is exactly why the probe has to win.
  const g3 = resolveCapability({ modelId: "gemma3:12b" });
  assert.equal(g3.cap.mechanism, "none");

  const g4Probed = resolveCapability({
    modelId: "gemma4:12b",
    runtime: "ollama",
    probedCapabilities: ["completion", "vision", "audio", "tools", "thinking"],
  });
  assert.equal(g4Probed.cap.mechanism, "effort-enum");

  // and a probe that reports NO thinking is equally authoritative
  const probedOff = resolveCapability({
    modelId: "mystery-model",
    runtime: "ollama",
    probedCapabilities: ["completion", "tools"],
  });
  assert.equal(probedOff.cap.mechanism, "none");
});

test("an unmatched model defaults to no knob rather than risking a 400", () => {
  const { cap } = resolveCapability({ modelId: "some-未知-model-v9" });
  assert.equal(cap.mechanism, "none");
  assert.equal(cap.supported.length, 0);
});

test("GPT-4-class models are explicitly knobless (reasoning_effort is a hard 400 there)", () => {
  for (const id of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4-turbo"]) {
    assert.equal(resolveCapability({ modelId: id }).cap.mechanism, "none", id);
  }
  // …while the reasoning line does take the enum.
  assert.equal(resolveCapability({ modelId: "gpt-5.2" }).cap.mechanism, "effort-enum");
  assert.equal(resolveCapability({ modelId: "o3-mini" }).cap.mechanism, "effort-enum");
});

test("user rules appended after the builtins win a specificity tie", () => {
  const rules = [
    ...builtinRules(),
    {
      id: "user-override",
      match: { modelIdRegex: "(^|[/:_-])gemma-?(2|3)([^0-9]|$)" },
      cap: {
        mechanism: "effort-enum" as const,
        field: "reasoning_effort",
        supported: ["low", "high"] as const,
        enumMap: { low: "low", high: "high" },
      },
    },
  ];
  assert.equal(resolveCapability({ modelId: "gemma3:12b" }, rules).cap.mechanism, "effort-enum");
});

test("runtimeFromBaseUrl separates the local runners by port", () => {
  assert.equal(runtimeFromBaseUrl("http://localhost:11434/v1"), "ollama");
  assert.equal(runtimeFromBaseUrl("http://localhost:1234/v1"), "lmstudio");
  assert.equal(runtimeFromBaseUrl("http://127.0.0.1:8080"), "llamacpp");
  assert.equal(runtimeFromBaseUrl("http://127.0.0.1:8000/v1"), "vllm");
  assert.equal(runtimeFromBaseUrl("https://api.openai.com/v1"), "openai");
});

test("LM Studio is treated as unusable per-request rather than optimistically supported", () => {
  // It accepts reasoning_effort on /v1 and does nothing with it across several releases.
  // Claiming support would be the precise silent lie this module exists to prevent.
  const { cap } = resolveCapability({ modelId: "qwen3-8b", runtime: "lmstudio" });
  const r = resolveEffort("high", cap);
  assert.equal(r.applied, null);
  assert.equal(r.degraded?.reason, "runtime-ignores");
});

/* ── the human-readable summary ───────────────────────────────────────────── */

test("describeEffort reports the APPLIED tier and names the unavailable case", () => {
  const enumCap = resolveCapability({
    modelId: "x",
    runtime: "ollama",
    probedCapabilities: ["thinking"],
  }).cap;
  assert.equal(describeEffort(resolveEffort("high", enumCap)), "high");
  // `max` on gpt-oss clamps to `high`, and the summary shows the tier that was APPLIED —
  // with no marker. `~` is already the "estimated" glyph in the same chrome, so degradation
  // travels via the warn tint and the `/effort` prose instead.
  const clamped = resolveEffort("max", resolveCapability({ modelId: "gpt-oss" }).cap);
  assert.equal(clamped.degraded?.reason, "tier-clamped"); // still reported structurally
  assert.equal(describeEffort(clamped), "high");
  assert.equal(
    describeEffort(resolveEffort("high", { mechanism: "none", supported: [] })),
    "not available",
  );
  assert.equal(describeEffort(undefined), "not available");
});

test("describeEffort never emits a tilde for any tier/mechanism combination", () => {
  const caps: EffortCapability[] = [
    resolveCapability({ modelId: "gpt-oss" }).cap,
    resolveCapability({ modelId: "x", runtime: "ollama", probedCapabilities: ["thinking"] }).cap,
    resolveCapability({ modelId: "qwen3:8b", runtime: "llamacpp" }).cap,
    { mechanism: "none", supported: [] },
    { mechanism: "always-on", supported: [] },
  ];
  for (const cap of caps) {
    for (const tier of EFFORT_TIERS) {
      assert.equal(describeEffort(resolveEffort(tier, cap)).includes("~"), false);
    }
  }
});
