// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog/free-tier.ts — which providers give a free, RENEWING quota, and on what terms.
 *
 * Sources (checked 2026-10-12): github.com/mnfst/awesome-free-llm-apis (the list this feature was
 * asked to integrate), github.com/open-free-llm-api/awesome-freellm-apis,
 * github.com/amardeeplakshkar/awesome-free-llm-apis, a mirror of the now-removed
 * cheahjs/free-llm-api-resources, each vendor's own docs, and the NVIDIA NIM FAQ. Free tiers change monthly and the lists disagree with each other, so every number here is
 * a SNAPSHOT shown to the user as "about" — the rotation never relies on one. It reacts to what
 * the provider actually answers (429 / quota / 401), not to these figures.
 *
 * What is deliberately NOT here:
 *  - anything that works by scraping or reverse-engineering a consumer chat site (gpt4free and
 *    its many front-ends) — that violates those sites' terms and is not "free", it is unpaid;
 *  - anonymous gateways that do not say who serves the model (LLM7, Pollinations, AnyAPI …);
 *  - one-off trial credits (Fireworks $1, Nebius $1 …) — a rotation that runs dry after a day
 *    is not endless, and listing them as "free" would be a lie the user finds out mid-task;
 *  - tiers that need mainland-Chinese identity verification (SiliconFlow, ModelScope);
 *  - GitHub Models: its free tier caps a REQUEST at about 8K tokens, and Prometheus's own
 *    system prompt plus tool schemas is ~7.2K before the user types — every agent turn would be
 *    refused or truncated.
 *
 * One key per provider. Rotating ACROSS providers is fine; opening several accounts at the
 * same provider to dodge its quota breaks nearly every provider's terms, and nothing here
 * supports doing that.
 */
import type { FreeTierInfo } from "./types.js";

export const FREE_TIER_CHECKED_AT = "2026-10-12";

export const FREE_TIERS: readonly FreeTierInfo[] = Object.freeze([
  {
    providerId: "cerebras",
    kind: "renewing",
    limits: "about 30 req/min · 14,400 req/day · 1M tokens/day",
    dataUse: "unknown",
    signupUrl: "https://cloud.cerebras.ai/",
    priority: 10,
  },
  {
    providerId: "groq",
    kind: "renewing",
    limits: "about 30 req/min · 1,000 req/day per model",
    dataUse: "unknown",
    caveat: "Models retire often; the picker re-reads the live list once a key is set.",
    signupUrl: "https://console.groq.com/keys",
    priority: 20,
  },
  {
    providerId: "gemini",
    kind: "renewing",
    limits: "Flash about 15 req/min · 1,500 req/day; Pro far less",
    dataUse: "may-train",
    caveat:
      "Outside the EEA/UK/Switzerland, free-tier prompts may be used to improve Google's models.",
    signupUrl: "https://aistudio.google.com/apikey",
    rotationBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    priority: 30,
  },
  {
    providerId: "nvidia",
    kind: "renewing",
    limits: "about 40 req/min",
    dataUse: "logged",
    caveat: "Trial terms: for prototyping and testing, requests are logged — no confidential code.",
    signupUrl: "https://build.nvidia.com/",
    priority: 40,
  },
  {
    providerId: "mistral",
    kind: "renewing",
    limits: "about 1 req/sec (free 'Experiment' plan)",
    dataUse: "may-train",
    caveat: "Free-plan prompts may be used for training unless you opt out in the console.",
    signupUrl: "https://console.mistral.ai/api-keys",
    priority: 50,
  },
  {
    providerId: "openrouter",
    kind: "renewing",
    limits: "about 20 req/min · 50 req/day on `:free` models (1,000/day after a one-time $10)",
    dataUse: "may-train",
    caveat: "Some free hosts log prompts; check the model's provider page on openrouter.ai.",
    signupUrl: "https://openrouter.ai/keys",
    priority: 60,
  },
  {
    providerId: "sambanova",
    kind: "renewing",
    limits: "about 20 req/min · 200K tokens/day",
    dataUse: "unknown",
    signupUrl: "https://cloud.sambanova.ai/apis",
    priority: 70,
  },
  {
    providerId: "zai",
    kind: "renewing",
    limits: "GLM -flash models free · 1 concurrent request",
    dataUse: "unknown",
    caveat: "Served from China (privacy flag).",
    signupUrl: "https://z.ai/manage-apikey/apikey-list",
    priority: 90,
  },
  {
    providerId: "ollama-cloud",
    kind: "renewing",
    limits: "hourly and weekly allowance (figures not published)",
    dataUse: "unknown",
    signupUrl: "https://ollama.com/settings/keys",
    priority: 100,
  },
  {
    providerId: "huggingface",
    kind: "renewing",
    limits: "small monthly credit (about $0.10), then per-token",
    dataUse: "unknown",
    caveat: "Routes to third-party hosts; the credit runs out fast on big models.",
    signupUrl: "https://huggingface.co/settings/tokens",
    priority: 110,
  },
  {
    providerId: "ovhcloud",
    kind: "renewing",
    limits: "anonymous: about 2 req/min per model per IP — slow but needs no account",
    dataUse: "unknown",
    caveat: "EU-hosted (France). The anonymous tier is meant for trying things, not production.",
    signupUrl: "https://endpoints.ai.cloud.ovh.net/",
    keyless: true,
    priority: 900,
  },
]);

const BY_PROVIDER = new Map(FREE_TIERS.map((f) => [f.providerId, f]));

/** The free tier of a provider, or undefined when it has none worth listing. */
export function freeTierFor(providerId: string): FreeTierInfo | undefined {
  return BY_PROVIDER.get(providerId);
}

/** A one-line, user-facing summary of what a provider does with free-tier prompts. */
export function describeDataUse(info: FreeTierInfo): string {
  switch (info.dataUse) {
    case "no-training":
      return "prompts not used for training";
    case "may-train":
      return "free-tier prompts may be used for training";
    case "logged":
      return "requests are logged (trial terms)";
    default:
      return "data use not stated — assume prompts are retained";
  }
}
