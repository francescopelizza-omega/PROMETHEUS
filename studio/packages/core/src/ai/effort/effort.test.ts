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
  // The wire guarantee is unchanged and is the load-bearing one: a knobless model must never
  // receive a field it does not understand — that is a hard 400 on GPT-4o and a silent no-op
  // on LM Studio.
  const cap: EffortCapability = { mechanism: "none", supported: [] };
  for (const tier of EFFORT_TIERS) {
    const r = resolveEffort(tier, cap);
    assert.equal(r.patch.kind, "none", `${tier} must put nothing on the wire`);
    assert.ok(r.degraded, "an effort that no parameter carried MUST be reported as degraded");
    const before = { model: "m", messages: [] };
    assert.deepEqual(applyEffort(before, r), before, "body must be byte-identical");
  }
});

test("…but the TIER is still in force, by instruction — `applied` is not `null`", () => {
  // The behaviour this pins used to be a misreport. `resolveEffort` returned `applied: null`
  // ("not available") for these models while `agent/protocol/contributors/effort-text.ts`
  // injected a graded instruction into the preamble on every single turn. Both statements
  // cannot be true; the injection is the one that was actually happening.
  const cap: EffortCapability = { mechanism: "none", supported: [] };
  for (const tier of ["low", "medium", "high", "max"] as const) {
    const r = resolveEffort(tier, cap);
    assert.equal(r.applied, tier, `${tier} is carried by prose, so it IS applied`);
    assert.equal(r.degraded?.reason, "emulated");
    assert.equal(r.emulation?.via, "prompt-cot");
    assert.ok((r.emulation?.text.length ?? 0) > 0, "an emulated tier must carry its instruction");
    assert.match(r.degraded?.message ?? "", /step-by-step prompting/);
    // `mechanism` still answers the OTHER question — "does a knob exist?" — unchanged.
    assert.equal(r.mechanism, "none");
  }
});

test("`off` on a knobless model is NOT emulated — silence, not a plea to think less", () => {
  // Asking a model to deliberate less costs tokens and can degrade strict-format output. The
  // honest emulation of "answer directly" is to say nothing at all.
  const r = resolveEffort("off", { mechanism: "none", supported: [] });
  assert.equal(r.applied, null);
  assert.equal(r.emulation, undefined);
  assert.equal(r.degraded?.reason, "no-capability");
});

test("an ALWAYS-ON model is never emulated — the dial does not exist to be talked to", () => {
  // DeepSeek R1 already reasons at a fixed depth. A "think harder" line cannot move it, so
  // injecting one would spend tokens implying a control we do not have.
  for (const tier of EFFORT_TIERS) {
    const r = resolveEffort(tier, { mechanism: "always-on", supported: [] });
    assert.equal(r.applied, null);
    assert.equal(r.emulation, undefined, `${tier}: always-on must not be emulated`);
    assert.equal(r.degraded?.reason, "always-on");
  }
});

test("the 'no parameter went out' reasons stay distinct", () => {
  // They mean different things to a user deciding whether to switch models, so collapsing
  // them into one "unsupported" would destroy the only actionable part of the message.
  //
  // Two of these now report `emulated` rather than `no-capability`/`runtime-ignores`, because
  // that is what actually happens to the tier. The DISTINCTION they carried has not been lost:
  // it moved into the message, which quotes the capability's own sentence verbatim, so
  // "this runtime swallows the request" still reads differently from "this model cannot think".
  const none = resolveEffort("high", {
    mechanism: "none",
    supported: [],
    note: "Gemma 2/3 have no reasoning mode (Gemma 4 does)",
  });
  const always = resolveEffort("high", { mechanism: "always-on", supported: [] });
  const ignores = resolveEffort("high", {
    mechanism: "none",
    supported: [],
    note: "LM Studio ignores per-request reasoning settings",
  });

  assert.equal(none.degraded?.reason, "emulated");
  assert.match(none.degraded?.message ?? "", /no reasoning mode/);

  assert.equal(always.degraded?.reason, "always-on");
  assert.equal(always.emulation, undefined);

  assert.equal(ignores.degraded?.reason, "emulated");
  assert.match(ignores.degraded?.message ?? "", /LM Studio ignores per-request/);

  assert.notEqual(
    none.degraded?.message,
    ignores.degraded?.message,
    "the two emulated cases must remain tellable apart",
  );
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
  // Claiming the PARAMETER works would be the precise silent lie this module exists to prevent.
  // A model with no rule of its own, so this is the RUNTIME's verdict and nothing else.
  const { cap } = resolveCapability({ modelId: "some-local-thinker", runtime: "lmstudio" });
  const r = resolveEffort("high", cap);
  // The guarantee that matters: nothing goes on the wire, so nothing is silently swallowed.
  assert.equal(r.patch.kind, "none");
  assert.deepEqual(applyEffort({ model: "m" }, r), { model: "m" });
  // …and the tier is carried by instruction instead, with the runtime's own sentence kept.
  assert.equal(r.degraded?.reason, "emulated");
  assert.match(r.degraded?.message ?? "", /LM Studio ignores per-request reasoning settings/);
  assert.equal(r.applied, "high");
});

test("…but a model whose knob is its OWN token still works on LM Studio", () => {
  // The runtime swallowing `reasoning_effort` says nothing about a switch the WEIGHTS read.
  // Qwen3's `/think` rides in the user turn, so it reaches the model whatever the server does
  // with body fields — which makes the name rule the right winner over the runtime rule here,
  // and the exact opposite of the llama.cpp/vLLM case below.
  const { rule, cap } = resolveCapability({ modelId: "qwen3-8b", runtime: "lmstudio" });
  assert.equal(rule?.id, "qwen3-soft-switch");
  const r = resolveEffort("high", cap);
  assert.deepEqual(r.patch, { kind: "prompt", slot: "user-append", text: "/think" });
});

test("on llama.cpp / vLLM the RUNTIME knob wins over the model's own token", () => {
  // Qwen3's template is the canonical one that branches on `enable_thinking`, so there the
  // "optimistic" kwarg is not a guess and is strictly better than appending a literal to the
  // user's message. Runtime + name (5) outranks the bare name match (3) — that ordering is the
  // whole mechanism, and without the two paired rules every llama.cpp Qwen3 would silently
  // lose its kwarg the moment the name rule was added.
  for (const runtime of ["llamacpp", "vllm"] as const) {
    const { rule, cap } = resolveCapability({ modelId: "qwen3:8b", runtime });
    assert.equal(rule?.id, `${runtime}-qwen3-template`);
    assert.deepEqual(applyEffort({ model: "q" }, resolveEffort("off", cap)), {
      model: "q",
      chat_template_kwargs: { enable_thinking: false },
    });
  }
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
  // "not available" is now a NARROWER claim than it was, and correctly so. A model with no
  // request parameter gets the tier by instruction, so it reports the tier; the phrase is
  // reserved for the cases where genuinely nothing is in force.
  assert.equal(describeEffort(resolveEffort("high", { mechanism: "none", supported: [] })), "high");
  assert.equal(
    describeEffort(resolveEffort("high", { mechanism: "always-on", supported: [] })),
    "not available",
    "always-on cannot be moved, so there is no tier to report",
  );
  assert.equal(
    describeEffort(resolveEffort("off", { mechanism: "none", supported: [] })),
    "not available",
    "there is nothing to turn off on a model that cannot reason",
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

/* ── the long tail of mechanisms (P2) ───────────────────────────────────────*/

/**
 * Resolve the way a real cloud endpoint reaches this table: model id AND runtime.
 *
 * The runtime is not optional decoration. Every Anthropic and Gemini rule is pinned to its own
 * runtime because the effort dialect belongs to the ENDPOINT — an aggregator serving
 * `claude-opus-4-8` over an OpenAI-compatible API takes a different field entirely — so a
 * lookup without one is a different question with a different (and correct) answer.
 */
function cloud(modelId: string, runtime: "anthropic" | "gemini") {
  return resolveCapability({ modelId, runtime, locality: "cloud" });
}

test("Anthropic 4.7+ takes output_config.effort and REJECTS temperature", () => {
  // Two hard 400s live in this row, not one: `thinking.budget_tokens` is removed on this
  // generation, and so are the sampling parameters. A transport that forwards a temperature
  // here fails the request outright — which is why `noTemperature` is a constraint and not a
  // note. Verified against the published contract for Fable 5 / Opus 5 / 4.8 / 4.7 / Sonnet 5.
  for (const id of [
    "claude-opus-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5",
  ]) {
    const { rule, cap } = cloud(id, "anthropic");
    assert.equal(rule?.id, "anthropic-effort-current", id);
    const r = resolveEffort("high", cap);
    assert.deepEqual(applyEffort({ model: id, temperature: 0.7 }, r), {
      model: id,
      output_config: { effort: "high" },
    });
    assert.equal(r.constraints?.noTemperature, true);
  }
});

test("Anthropic `off` CLAMPS rather than pretending thinking can be switched off", () => {
  // `thinking:{type:"disabled"}` is a different parameter with model-dependent validity (a 400
  // on Fable 5; on Opus 5 only at effort <= high). A single patch cannot express that
  // honestly, so `off` becomes the lowest real level and says so.
  const r = resolveEffort("off", cloud("claude-opus-5", "anthropic").cap);
  assert.equal(r.applied, "low");
  assert.equal(r.degraded?.reason, "tier-clamped");
  assert.match(r.degraded?.message ?? "", /cannot be disabled/);
});

test("Anthropic 4.6 keeps temperature; 4.5 splits into effort-only and budget-only", () => {
  // The version bounds are load-bearing — each generation's wrong shape is an error, not a
  // no-op, so a family-level regex would break exactly the models it was meant to serve.
  const four6 = resolveEffort("max", cloud("claude-opus-4-6", "anthropic").cap);
  assert.equal(four6.constraints?.noTemperature, undefined, "4.6 still accepts temperature");
  assert.deepEqual(applyEffort({ temperature: 0.7 }, four6), {
    temperature: 0.7,
    output_config: { effort: "max" },
  });

  // Opus 4.5 has three levels — `max` there is a 400, so it clamps.
  const opus45 = resolveEffort("max", cloud("claude-opus-4-5", "anthropic").cap);
  assert.equal(opus45.applied, "high");

  // Sonnet/Haiku 4.5 reject `effort` entirely and take a token budget instead.
  const { rule, cap } = cloud("claude-sonnet-4-5", "anthropic");
  assert.equal(rule?.id, "anthropic-budget-4-5");
  assert.equal(cap.mechanism, "token-budget");
});

test("a thinking budget is clamped UNDER a CALLER's max_tokens, leaving room for the answer", () => {
  // `budget_tokens >= max_tokens` is a 400. The clamp lives in `applyEffort` because that is
  // the first place the real number exists. A caller-pinned ceiling is a hard cost limit, so
  // the BUDGET yields to it — but it now yields by the answer's headroom rather than by 1,
  // which used to leave the reply a single token.
  const cap = cloud("claude-haiku-4-5", "anthropic").cap;
  const tight = applyEffort(
    { max_tokens: 8000 },
    resolveEffort("max", cap, { maxTokens: 8000 }),
  ) as {
    max_tokens: number;
    thinking: { budget_tokens: number };
  };
  assert.equal(tight.max_tokens, 8000, "a caller's ceiling is never raised");
  assert.equal(tight.thinking.budget_tokens, 8000 - 4096);
  const roomy = applyEffort(
    { max_tokens: 64000 },
    resolveEffort("max", cap, { maxTokens: 64000 }),
  ) as { thinking: { budget_tokens: number } };
  assert.equal(roomy.thinking.budget_tokens, 32000, "a roomy ceiling must not inflate the budget");
});

test("with NO caller ceiling the tiers stay distinct: the library default is raised, not the budget capped", () => {
  // Regression: the agentic transport passes no maxTokens, so `ai/wire.ts` substitutes 4096 and
  // the old `max_tokens - 1` clamp turned medium (4096), high (16384) and max (32000) into ONE
  // request — `budget_tokens: 4095`, one token left for the reply. Measured against the real
  // rule, not a synthetic capability.
  const cap = cloud("claude-sonnet-4-5", "anthropic").cap;
  const seen = new Set<number>();
  for (const tier of ["low", "medium", "high", "max"] as const) {
    const body = applyEffort({ max_tokens: 4096 }, resolveEffort(tier, cap)) as {
      max_tokens: number;
      thinking: { budget_tokens: number };
    };
    const budget = body.thinking.budget_tokens;
    seen.add(budget);
    assert.equal(budget, cap.budgetMap?.[tier], `${tier} did not get the budget its rule declares`);
    assert.ok(
      body.max_tokens - budget >= 4096,
      `${tier} left only ${body.max_tokens - budget} tokens for the answer`,
    );
    assert.ok(body.max_tokens > budget, "budget must stay strictly under max_tokens");
  }
  assert.equal(seen.size, 4, `four tiers must produce four budgets, got ${[...seen].join(",")}`);
});

test("Claude 3.x is knobless — and is therefore emulated, not silently ignored", () => {
  const { rule } = cloud("claude-3-5-sonnet", "anthropic");
  assert.equal(rule?.id, "anthropic-claude-3");
  const r = resolveEffort("high", cloud("claude-3-5-sonnet", "anthropic").cap);
  assert.equal(r.degraded?.reason, "emulated");
  assert.deepEqual(r.patch, { kind: "none" });
});

test("Gemini 3 takes a LEVEL; 2.5 takes a BUDGET — both nested under generationConfig", () => {
  const g3 = resolveEffort("high", cloud("gemini-3-pro", "gemini").cap);
  assert.deepEqual(applyEffort({}, g3), {
    generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
  });
  const g25 = resolveEffort("medium", cloud("gemini-2.5-flash", "gemini").cap);
  assert.deepEqual(applyEffort({}, g25), {
    generationConfig: { thinkingConfig: { thinkingBudget: 4096 } },
  });
});

test("the Gemini patch MERGES into generationConfig — it never replaces the wire's own", () => {
  // `ai/wire.ts` already puts temperature/maxOutputTokens there. `setPath` creating a fresh
  // object would drop both and change the request in a way nothing would report.
  const g = resolveEffort("high", cloud("gemini-3-pro", "gemini").cap);
  const body = applyEffort(
    { generationConfig: { temperature: 0.4, maxOutputTokens: 1024 } },
    g,
  ) as { generationConfig: Record<string, unknown> };
  assert.deepEqual(body.generationConfig, {
    temperature: 0.4,
    maxOutputTokens: 1024,
    thinkingConfig: { thinkingLevel: "high" },
  });
});

test("Gemini 2.5 PRO cannot disable thinking; Flash can — and ordering is what decides", () => {
  // Both rules match on `modelIdRegex` alone, so they tie on specificity and the LATER one
  // wins. The Pro rule is declared last for exactly that reason; moving it up would hand Pro
  // an `off` tier that 400s.
  assert.equal(cloud("gemini-2.5-pro", "gemini").rule?.id, "gemini-2-5-pro-budget");
  assert.equal(cloud("gemini-2.5-flash", "gemini").rule?.id, "gemini-2-5-budget");
  const pro = resolveEffort("off", cloud("gemini-2.5-pro", "gemini").cap);
  assert.notEqual(pro.applied, "off", "Pro has no off tier");
  const flash = resolveEffort("off", cloud("gemini-2.5-flash", "gemini").cap);
  assert.deepEqual(applyEffort({}, flash), {
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  });
});

test("Qwen3's switch is a trained-on TOKEN on the user turn, not a body field", () => {
  // `types.ts` has named Qwen3 the `prompt-soft-switch` exemplar since the mechanism existed,
  // and the table had no rule for it — so every qwen3 id fell to UNKNOWN_CAPABILITY unless a
  // runtime probe rescued it.
  const { rule, cap } = resolveCapability({ modelId: "qwen3:8b" });
  assert.equal(rule?.id, "qwen3-soft-switch");
  const on = resolveEffort("high", cap);
  assert.deepEqual(on.patch, { kind: "prompt", slot: "user-append", text: "/think" });
  assert.deepEqual(applyEffort({ model: "qwen3:8b" }, on), { model: "qwen3:8b" });
  const off = resolveEffort("off", cap);
  assert.deepEqual(off.patch, { kind: "prompt", slot: "user-append", text: "/no_think" });
});

test("the Qwen3 rule is VERSION- and VARIANT-bounded — no stray token in a user's message", () => {
  // Same discipline as the gemma rule. `qwen3.6` falls through to "unknown", which is honest;
  // appending a stale `/think` literal to its user turn would not be.
  assert.equal(resolveCapability({ modelId: "qwen3.6:latest" }).rule, null);
  // The variant bound was MEASURED, not reasoned: `orchestration/api-providers.ts` ships
  // `qwen-3-coder-480b` and `qwen-3-235b-a22b-instruct`, and both used to match. Those are the
  // explicitly non-thinking halves of the Qwen3 split, so `/think` would land in the user's own
  // message on every turn for a switch the weights do not implement.
  for (const id of ["qwen-3-coder-480b", "qwen-3-235b-a22b-instruct", "qwen3-8b-instruct"]) {
    assert.equal(resolveCapability({ modelId: id }).rule, null, id);
  }
  // …while the hybrids that DO implement it still match.
  for (const id of ["qwen3:8b", "qwen3-8b", "Qwen/Qwen3-8B", "qwen3-235b-a22b-thinking"]) {
    assert.equal(resolveCapability({ modelId: id }).rule?.id, "qwen3-soft-switch", id);
  }
});

test("a runtime PROBE still outranks the new name rules", () => {
  // The whole point of the probe arm: qwen3.6 served by a runner that says `thinking` gets the
  // real parameter, not a guess and not a prose fallback.
  const { rule, cap } = resolveCapability({
    modelId: "qwen3:8b",
    runtime: "ollama",
    probedCapabilities: ["completion", "tools", "thinking"],
  });
  assert.equal(rule?.id, "ollama-openai-shim-thinking");
  assert.equal(cap.mechanism, "effort-enum");
});

test("Nemotron's knob is a literal system line; GLM/Granite/DeepSeek-V3.2 are toggles", () => {
  const nemo = resolveEffort("high", resolveCapability({ modelId: "nemotron-4-340b" }).cap);
  assert.deepEqual(nemo.patch, {
    kind: "prompt",
    slot: "system-append",
    text: "detailed thinking on",
  });

  const glm = resolveEffort("high", resolveCapability({ modelId: "glm-4-plus" }).cap);
  assert.deepEqual(applyEffort({}, glm), { thinking: { type: "enabled" } });

  const granite = resolveEffort("off", resolveCapability({ modelId: "granite-3-8b" }).cap);
  assert.deepEqual(applyEffort({}, granite), { thinking: false });

  // V3.2 is a TOGGLE; R1 above is ALWAYS-ON. Collapsing the two would misreport both.
  const v32 = resolveCapability({ modelId: "deepseek-v3.2" });
  assert.equal(v32.cap.mechanism, "binary-toggle");
  assert.equal(resolveCapability({ modelId: "deepseek-r1" }).cap.mechanism, "always-on");
});

test("`ollama-native` is never GUESSED from a URL, but is reachable when declared", () => {
  // Port 11434 answers both the `/v1` shim and the native `/api/chat`, and they take different
  // knobs. Guessing would put a top-level `think` on an OpenAI-shaped body.
  assert.notEqual(runtimeFromBaseUrl("http://127.0.0.1:11434"), "ollama-native");
  assert.notEqual(runtimeFromBaseUrl("http://127.0.0.1:11434/v1"), "ollama-native");
  const { rule, cap } = resolveCapability({
    modelId: "qwen3:8b",
    runtime: "ollama-native",
    probedCapabilities: ["thinking"],
  });
  assert.equal(rule?.id, "ollama-native-thinking");
  assert.deepEqual(applyEffort({}, resolveEffort("high", cap)), { think: "high" });
  assert.deepEqual(applyEffort({}, resolveEffort("off", cap)), { think: false });
});

/* ── --force-effort: the escape hatch, and its receipt (P3) ─────────────────*/

test("force sends the knob over the table's objection, and SAYS it forced it", () => {
  // The escape hatch for a model released after these rules were written. It re-opens exactly
  // the failure this module closes — `reasoning_effort` is a hard 400 on a GPT-4-class model —
  // so the resolution must never look like ordinary support.
  const cap: EffortCapability = { mechanism: "none", supported: [], note: "no knob known" };
  const r = resolveEffort("high", cap, { force: true });
  assert.equal(r.applied, "high");
  assert.equal(r.degraded?.reason, "forced");
  assert.match(r.degraded?.message ?? "", /no knob known/);
  assert.match(r.degraded?.message ?? "", /may reject this request/);
  assert.deepEqual(applyEffort({ model: "m" }, r), { model: "m", reasoning_effort: "high" });
});

test("force maps `off` to the vocabulary a shim actually takes, not the literal 'off'", () => {
  const r = resolveEffort("off", { mechanism: "none", supported: [] }, { force: true });
  assert.deepEqual(applyEffort({}, r), { reasoning_effort: "none" });
});

test("force overrides ALWAYS-ON too — 'send it anyway' means anyway", () => {
  const cap = resolveCapability({ modelId: "deepseek-r1" }).cap;
  const plain = resolveEffort("high", cap);
  assert.equal(plain.applied, null, "unforced, an always-on model still reports no dial");
  const r = resolveEffort("high", cap, { force: true });
  assert.equal(r.degraded?.reason, "forced");
  assert.deepEqual(applyEffort({}, r), { reasoning_effort: "high" });
});

test("force is a NO-OP where the tier already works — it never rewrites a good mechanism", () => {
  // Forcing something that works must not replace a provider's real field with the generic
  // one. Anthropic takes `output_config.effort`; a forced `reasoning_effort` there would be a
  // 400 introduced by the very flag meant to avoid one.
  const cap = resolveCapability({
    modelId: "claude-opus-5",
    runtime: "anthropic",
    locality: "cloud",
  }).cap;
  const forcedRes = resolveEffort("high", cap, { force: true });
  assert.equal(forcedRes.degraded, null);
  assert.deepEqual(applyEffort({}, forcedRes), { output_config: { effort: "high" } });
});

test("a forced resolution REPORTS the prose the turn will actually carry", () => {
  // This test used to assert the opposite — that forcing suppresses the emulation — on the
  // reasoning that prose on top of a forced parameter would double the ask. The assertion held;
  // the behaviour it described never did. `effort-text.ts` gates on `mechanism` alone, and a
  // forced resolution still reports `mechanism: "none"`, so the contributor went on injecting
  // the instruction on every forced turn while the resolution said `emulation: undefined`.
  //
  // Suppressing the prose would be the wrong half to change. Forcing means "send it by every
  // route available": the forced parameter is a coin flip by construction (the table says this
  // model has no such knob), and on a server that ignores it the prose is the ONLY thing that
  // delivers the tier. There is no trained-on literal to duplicate either — the mechanisms that
  // own a prompt path of their own are excluded by `emulationApplies`. So the behaviour stands
  // and the REPORT is what gets fixed.
  const r = resolveEffort("high", { mechanism: "none", supported: [] }, { force: true });
  assert.equal(r.emulation?.via, "prompt-cot");
  assert.ok(r.emulation?.text.startsWith("Think carefully"));

  // ...and the exclusion still holds where it matters: `always-on` cannot be talked into
  // thinking harder, so forcing it sends the parameter and says nothing on top.
  const alwaysOn = resolveEffort(
    "high",
    { mechanism: "always-on", supported: [] },
    { force: true },
  );
  assert.equal(alwaysOn.emulation, undefined);
});

/* ── V2: the dialect belongs to the ENDPOINT, not to the model name ─────────*/

test("a Claude model served by an AGGREGATOR does NOT get Anthropic's field", () => {
  // `orchestration/api-providers.ts` ships half a dozen OpenAI-compatible aggregators, and a
  // user can point any of them at a Claude model. Matching on the name alone would post
  // `output_config.effort` at a server that has never heard of it. Unmatched here means the
  // tier is emulated instead — the safe failure, and the one this module is built around.
  const viaProxy = resolveCapability({
    modelId: "claude-opus-4-8",
    runtime: "openai-compatible",
    locality: "cloud",
  });
  assert.equal(viaProxy.rule, null);
  assert.equal(viaProxy.cap.mechanism, "none");
  assert.deepEqual(applyEffort({ model: "m" }, resolveEffort("high", viaProxy.cap)), {
    model: "m",
  });

  // …while the real endpoint still resolves.
  const direct = resolveCapability({
    modelId: "claude-opus-4-8",
    runtime: "anthropic",
    locality: "cloud",
  });
  assert.equal(direct.rule?.id, "anthropic-effort-current");
});

test("the same holds for Gemini — its fields are Google's own wire shape", () => {
  const viaProxy = resolveCapability({
    modelId: "gemini-2.5-pro",
    runtime: "openai-compatible",
    locality: "cloud",
  });
  assert.equal(viaProxy.rule, null);
  const direct = resolveCapability({
    modelId: "gemini-2.5-pro",
    runtime: "gemini",
    locality: "cloud",
  });
  assert.equal(direct.rule?.id, "gemini-2-5-pro-budget");
});

test("every model this repo actually SHIPS resolves to a defensible verdict", () => {
  // A rule table that does not match the ids in `orchestration/api-providers.ts` is decoration.
  // These five are the real configured Anthropic/Gemini entries, reached through the same
  // `runtimeFromBaseUrl` the transports use.
  const cases: Array<[string, "anthropic" | "gemini", string, string]> = [
    ["claude-sonnet-4-6", "anthropic", "anthropic-effort-4-6", "effort-enum"],
    ["claude-opus-4-8", "anthropic", "anthropic-effort-current", "effort-enum"],
    ["claude-haiku-4-5", "anthropic", "anthropic-budget-4-5", "token-budget"],
    ["gemini-2.5-pro", "gemini", "gemini-2-5-pro-budget", "token-budget"],
    ["gemini-2.5-flash", "gemini", "gemini-2-5-budget", "token-budget"],
  ];
  for (const [modelId, runtime, expectRule, expectMechanism] of cases) {
    const { rule, cap } = resolveCapability({ modelId, runtime, locality: "cloud" });
    assert.equal(rule?.id, expectRule, modelId);
    assert.equal(cap.mechanism, expectMechanism, modelId);
    assert.notEqual(resolveEffort("high", cap).applied, null, modelId);
  }
});

/* ── V5: the values we emit must be inside the vocabularies we CLAIM ────────*/

test("every Ollama value this table emits is in the daemon's MEASURED accepted set", () => {
  // Re-measured live against the daemon by sending an invalid value and reading the 400:
  //   /v1  reasoning_effort: minimal|low|medium|high|xhigh|ultra|max|none
  //   native /api/chat think: high|medium|low|max|true|false
  // The set is WIDER than this ladder — `minimal`/`xhigh`/`ultra` have no tier here, which is
  // a deliberate ladder choice. What must never drift is the other direction: a value we emit
  // that the daemon would reject. An older comment in rules.ts asserted the shim "rejects
  // minimal and enumerates exactly these five"; both halves were false, so this pins the claim
  // that actually matters instead of the one that read well.
  const SHIM_ACCEPTS = new Set([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "ultra",
    "max",
    "none",
  ]);
  const NATIVE_ACCEPTS = new Set<unknown>(["high", "medium", "low", "max", true, false]);

  const shim = resolveCapability({
    modelId: "qwen3.6:latest",
    runtime: "ollama",
    probedCapabilities: ["thinking"],
  }).cap;
  for (const tier of EFFORT_TIERS) {
    const patch = resolveEffort(tier, shim).patch;
    if (patch.kind !== "body") continue;
    assert.ok(
      SHIM_ACCEPTS.has(String(patch.value)),
      `/v1 would 400 on reasoning_effort=${JSON.stringify(patch.value)} (tier ${tier})`,
    );
  }

  const native = resolveCapability({
    modelId: "qwen3.6:latest",
    runtime: "ollama-native",
    probedCapabilities: ["thinking"],
  }).cap;
  for (const tier of EFFORT_TIERS) {
    const patch = resolveEffort(tier, native).patch;
    if (patch.kind !== "body") continue;
    assert.ok(
      NATIVE_ACCEPTS.has(patch.value),
      `/api/chat would 400 on think=${JSON.stringify(patch.value)} (tier ${tier})`,
    );
  }
});

/* ── V6: evidence level is DECLARED, not implied by tone ────────────────────*/

test("every builtin rule declares how well-evidenced it is", () => {
  // A comment can drift from the truth silently — `ollama-openai-shim-thinking` carried
  // "verified: Ollama rejects `minimal` and enumerates exactly these five" for months, and
  // both halves were false. A required field cannot drift: a new rule with no provenance fails
  // here, so nobody can add a guess that reads like a measurement.
  const missing = builtinRules().filter((r) => r.provenance === undefined);
  assert.deepEqual(
    missing.map((r) => r.id),
    [],
    "these rules do not say how their vocabulary was established",
  );
});

test("the rules claiming to be verified against a LIVE server are exactly the Ollama arms", () => {
  // `measured` is the strongest claim in the file and has to stay honest: it means the values
  // were sent at a real server and the accepted set read back out of its error response.
  const measured = builtinRules()
    .filter((r) => r.provenance === "measured")
    .map((r) => r.id)
    .sort();
  assert.deepEqual(measured, [
    "ollama-native-no-thinking",
    "ollama-native-thinking",
    "ollama-no-thinking",
    "ollama-openai-shim-thinking",
  ]);
});

test("most of this table is INFERRED, and says so", () => {
  // Not a defect — it is the honest state of a capability table covering two dozen backends
  // nobody here has keys for. Pinned so the ratio cannot quietly rot: if a provider is ever
  // properly verified, this number moves and the test makes you say so out loud.
  const counts = { measured: 0, published: 0, inferred: 0 };
  for (const r of builtinRules()) counts[r.provenance as keyof typeof counts] += 1;
  assert.deepEqual(counts, { measured: 4, published: 7, inferred: 23 });
});

/* ── the adversarial sweep: four ways a tier reported as applied sent nothing ─────────── */

test("`off` is a MODE, not the bottom of the ladder — `low` never turns thinking off", () => {
  // The two-value switches are the whole point: Qwen3 is `/think` vs `/no_think`, Nemotron is
  // `detailed thinking on|off`. `low` sits exactly one step from each end, and a plain downward
  // tie-break resolved that to `off` — so `/think low` DISABLED thinking, while the rule's own
  // comment promised it clamped to the middle.
  assert.equal(nearestTier("low", ["off", "medium"]), "medium");
  assert.equal(nearestTier("low", ["off", "high"]), "high");
  // Asking for `off` still gets `off`, and a capability that offers ONLY `off` still resolves.
  assert.equal(nearestTier("off", ["off", "medium"]), "off");
  assert.equal(nearestTier("high", ["off"]), "off");
  // Among degrees of thinking, distance is still the right metric and ties still go downward.
  assert.equal(nearestTier("medium", ["low", "high"]), "low");
});

test("the Qwen3 switch honours that: /think low is /think, not /no_think", () => {
  const { cap } = resolveCapability({ modelId: "qwen3:8b" });
  const low = resolveEffort("low", cap);
  assert.deepEqual(low.patch, { kind: "prompt", slot: "user-append", text: "/think" });
  assert.equal(low.applied, "medium");
});

test("the max_tokens re-clamp cannot push the budget under the provider's floor", () => {
  // Claude 4.5's minimum thinking budget is 1024 and its budget must be < max_tokens. With
  // `max_tokens: 512` the clamp alone produced `budget_tokens: 511` — under the floor, and a
  // 400 from the very clamp that exists to prevent one.
  const { cap } = resolveCapability({
    modelId: "claude-sonnet-4-5",
    runtime: "anthropic",
    locality: "cloud",
  });
  const r = resolveEffort("high", cap);
  const body = applyEffort({ max_tokens: 512 }, r) as {
    max_tokens: number;
    thinking: { budget_tokens: number };
  };
  assert.ok(body.thinking.budget_tokens >= 1024, "budget fell under the provider minimum");
  assert.ok(
    body.max_tokens > body.thinking.budget_tokens,
    "budget must stay strictly under max_tokens",
  );
  // A roomy max_tokens is left exactly as the caller set it.
  const roomy = applyEffort({ max_tokens: 64_000 }, r) as { max_tokens: number };
  assert.equal(roomy.max_tokens, 64_000);
});

test("a prompt-shaped mechanism with an empty `supported` is not reported as emulated", () => {
  // An override can produce one. It lands in the knobless branch, `emulationFor` returns text,
  // and the resolution would claim `emulated` — while `effort-text.ts` declines to inject it,
  // because that mechanism owns a prompt path of its own. Tier reported in force, nothing in
  // front of the model.
  const r = resolveEffort("high", { mechanism: "prompt-soft-switch", supported: [] });
  assert.equal(r.applied, null);
  assert.notEqual(r.degraded?.reason, "emulated");
  assert.equal(r.emulation, undefined);
});

test("runtimeFromBaseUrl matches the PORT against the port and the HOST against the host", () => {
  /**
   * This answer picks the WIRE PROTOCOL (`ai/wire.ts`'s `selectWire`), so getting it wrong means
   * every SSE frame parses to `{}` and the model appears to answer with silence.
   *
   * The old implementation was a list of `String.includes` tests over the whole lowercased URL,
   * with the local-runner PORT numbers checked FIRST. A substring matches anywhere — path, query
   * string, even the model name — so a real Anthropic endpoint whose URL merely CONTAINED "8000"
   * was classified as vllm.
   */
  // a port number appearing anywhere but the port must not decide anything
  assert.equal(runtimeFromBaseUrl("https://api.anthropic.com:443/v1?x=8000", "cloud"), "anthropic");
  assert.equal(runtimeFromBaseUrl("https://api.mycorp.com/v1/model-8080", "cloud"), "unknown");
  assert.equal(runtimeFromBaseUrl("https://api.mycorp.com/v1234/chat", "cloud"), "unknown");

  // a known provider host wins over a port that happens to collide
  assert.equal(runtimeFromBaseUrl("https://api.openai.com:8080/v1", "cloud"), "openai");

  // subdomains of a provider still resolve to that provider
  assert.equal(runtimeFromBaseUrl("https://eu.api.anthropic.com/v1", "cloud"), "anthropic");
  assert.equal(
    runtimeFromBaseUrl("https://generativelanguage.googleapis.com/v1", "cloud"),
    "gemini",
  );

  // a schemeless `host:port` — which `new URL()` parses as a SCHEME, not a host — still works
  assert.equal(runtimeFromBaseUrl("localhost:11434", "local"), "ollama");
  assert.equal(runtimeFromBaseUrl("127.0.0.1:1234", "local"), "lmstudio");
  assert.equal(runtimeFromBaseUrl("api.anthropic.com/v1", "cloud"), "anthropic");

  // and nothing at all is "unknown", not a crash
  assert.equal(runtimeFromBaseUrl("", "cloud"), "unknown");
  assert.equal(runtimeFromBaseUrl("not a url at all", "local"), "openai-compatible");
});
