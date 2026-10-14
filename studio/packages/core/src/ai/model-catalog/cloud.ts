// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog/cloud.ts — the cloud models the picker lists, with their two lines.
 *
 * A snapshot (2026-10-12) of ids each provider documents. Ids rot: once the user has a key the
 * picker asks the provider's live `GET /models` and `live-models.ts` reconciles the two, so a
 * retired id here degrades to "use the closest live one", never to a 404 in the middle of a
 * turn. `rotation: true` marks the free models that are tool-capable and generous enough to be
 * members of the endless free rotation.
 *
 * Blurbs are kept to claims that hold across reviews and vendor pages — no benchmark numbers,
 * which would be stale before this file ships.
 */
import type { CloudModelEntry } from "./types.js";

const free = (
  providerId: string,
  model: string,
  label: string,
  strengths: string,
  limits: string,
  opts: { tools?: boolean; rotation?: boolean; contextWindow?: number } = {},
): CloudModelEntry => ({
  section: "free",
  providerId,
  model,
  label,
  blurb: { strengths, limits },
  tools: opts.tools ?? true,
  ...(opts.rotation !== false ? { rotation: true } : {}),
  ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
});

const paid = (
  providerId: string,
  model: string,
  label: string,
  strengths: string,
  limits: string,
  opts: { tools?: boolean; contextWindow?: number } = {},
): CloudModelEntry => ({
  section: "paid",
  providerId,
  model,
  label,
  blurb: { strengths, limits },
  tools: opts.tools ?? true,
  ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
});

export const CLOUD_MODELS: readonly CloudModelEntry[] = Object.freeze([
  /* ------------------------------ free ------------------------------ */
  free(
    "cerebras",
    "gpt-oss-120b",
    "gpt-oss 120B on Cerebras",
    "Very fast output (wafer-scale chips); solid reasoning and tool use.",
    "Free daily token cap; long agent sessions can exhaust it.",
  ),
  free(
    "cerebras",
    "llama-3.3-70b",
    "Llama 3.3 70B on Cerebras",
    "Fast, dependable general model with tool calling.",
    "Older generation — weaker at hard coding than newer open models.",
  ),
  free(
    "groq",
    "openai/gpt-oss-120b",
    "gpt-oss 120B on Groq",
    "Low-latency LPU inference; good reasoning with adjustable effort.",
    "Per-model daily request cap on the free plan.",
  ),
  free(
    "groq",
    "moonshotai/kimi-k2-instruct-0905",
    "Kimi K2 on Groq",
    "Strong agentic coder with long context, served very fast.",
    "Tight free token limits for a model this large.",
  ),
  free(
    "groq",
    "llama-3.3-70b-versatile",
    "Llama 3.3 70B on Groq",
    "Fast all-rounder; reliable tool calls.",
    "Not the strongest coder in this list.",
  ),
  free(
    "gemini",
    "gemini-2.5-flash",
    "Gemini 2.5 Flash",
    "Fast, 1M-token context, multimodal; generous free daily quota.",
    "Free-tier prompts may train Google models outside EEA/UK/CH.",
    { contextWindow: 1_048_576 },
  ),
  free(
    "gemini",
    "gemini-2.5-pro",
    "Gemini 2.5 Pro",
    "Google's stronger reasoning model with a huge context window.",
    "Very few free requests per day; may train on free-tier prompts.",
    { contextWindow: 1_048_576, rotation: false },
  ),
  free(
    "nvidia",
    "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    "Nemotron Super 49B v1.5",
    "NVIDIA's efficient reasoning model; good tool use for its size.",
    "Trial terms (prototyping only); requests are logged.",
  ),
  free(
    "nvidia",
    "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "Nemotron Ultra 253B",
    "NVIDIA's largest dense Nemotron; strong reasoning and science.",
    "Slower per token; trial terms, logged.",
  ),
  free(
    "nvidia",
    "nvidia/nvidia-nemotron-nano-9b-v2",
    "Nemotron Nano 9B v2",
    "Small hybrid Mamba-Transformer: quick answers, toggleable reasoning.",
    "A small model — not for large multi-file changes.",
  ),
  free(
    "nvidia",
    "qwen/qwen3-coder-480b-a35b-instruct",
    "Qwen3 Coder 480B (NVIDIA)",
    "Top open agentic coder, repo-scale context.",
    "Busy at peak hours; trial terms, logged.",
  ),
  free(
    "nvidia",
    "moonshotai/kimi-k2-instruct",
    "Kimi K2 (NVIDIA)",
    "Strong agentic coding and long-context work.",
    "Trial terms, logged.",
  ),
  free(
    "nvidia",
    "deepseek-ai/deepseek-v3.1",
    "DeepSeek V3.1 (NVIDIA)",
    "Capable generalist with hybrid thinking mode.",
    "Trial terms, logged; can queue at peak.",
  ),
  free(
    "mistral",
    "mistral-small-latest",
    "Mistral Small",
    "Fast, multilingual, good tool use; EU-hosted.",
    "Free plan may train on prompts unless you opt out.",
  ),
  free(
    "mistral",
    "codestral-latest",
    "Codestral",
    "Code-specialised, excellent at completion and edits.",
    "Free plan may train on prompts unless you opt out.",
  ),
  free(
    "openrouter",
    "qwen/qwen3-coder:free",
    "Qwen3 Coder (OpenRouter free)",
    "Strong open agentic coder at zero cost.",
    "About 50 free requests/day; free hosts may log prompts.",
    { contextWindow: 262_144 },
  ),
  free(
    "openrouter",
    "moonshotai/kimi-k2:free",
    "Kimi K2 (OpenRouter free)",
    "Agentic coding and long context, free.",
    "Shared free capacity — slow or busy at times.",
    { contextWindow: 32_768 },
  ),
  free(
    "openrouter",
    "z-ai/glm-4.5-air:free",
    "GLM-4.5 Air (OpenRouter free)",
    "Light, fast GLM with good tool calling.",
    "Free daily cap; hosts may log prompts.",
    { contextWindow: 131_072 },
  ),
  free(
    "sambanova",
    "Meta-Llama-3.3-70B-Instruct",
    "Llama 3.3 70B on SambaNova",
    "Fast RDU inference, dependable tool calls.",
    "Low free daily token budget.",
  ),
  free(
    "zai",
    "glm-4.7-flash",
    "GLM-4.7 Flash",
    "Zhipu's free fast GLM; good at tools and Chinese/English.",
    "One request at a time; served from China.",
  ),
  free(
    "ollama-cloud",
    "gpt-oss:120b",
    "gpt-oss 120B (Ollama Cloud)",
    "Big open model hosted by Ollama, same tags as local.",
    "Hourly/weekly free allowance, figures unpublished.",
  ),
  free(
    "ollama-cloud",
    "qwen3-coder:480b",
    "Qwen3 Coder 480B (Ollama Cloud)",
    "Repo-scale open coder without the hardware.",
    "Hourly/weekly allowance runs out quickly on long tasks.",
  ),
  free(
    "huggingface",
    "openai/gpt-oss-120b",
    "gpt-oss 120B (HF router)",
    "One token reaches many hosts; good reasoning.",
    "Tiny monthly free credit — a fallback, not a workhorse.",
  ),
  free(
    "ovhcloud",
    "gpt-oss-120b",
    "gpt-oss 120B (OVHcloud, no key)",
    "Works with no account at all; EU-hosted.",
    "About 2 requests/min — the rotation's last resort.",
  ),

  /* ------------------------------ paid ------------------------------ */
  paid(
    "anthropic",
    "claude-opus-5-5",
    "Claude Opus 5.5",
    "Anthropic's most capable model: hard coding, long agentic tasks.",
    "Highest per-token price in this list.",
  ),
  paid(
    "anthropic",
    "claude-sonnet-5-5",
    "Claude Sonnet 5.5",
    "Best balance of coding strength, speed and cost from Anthropic.",
    "Metered per token; costs add up on long sessions.",
  ),
  paid(
    "anthropic",
    "claude-haiku-5-5",
    "Claude Haiku 5.5",
    "Fast and cheap Claude for quick edits and triage.",
    "Less depth on hard multi-step problems.",
  ),
  paid(
    "openai",
    "gpt-5",
    "GPT-5",
    "OpenAI's flagship reasoning model; strong at code and tools.",
    "Metered; reasoning tokens are billed too.",
  ),
  paid(
    "openai",
    "gpt-5-codex",
    "GPT-5 Codex",
    "Tuned for agentic coding (the model behind Codex).",
    "Metered per token; coding-focused.",
  ),
  paid(
    "openai",
    "gpt-5-mini",
    "GPT-5 mini",
    "Cheaper, faster GPT-5 for everyday tasks.",
    "Less capable on hard problems.",
  ),
  paid(
    "gemini",
    "gemini-2.5-pro",
    "Gemini 2.5 Pro (paid)",
    "1M-token context, strong reasoning; paid tier does not train on prompts.",
    "Metered; long contexts get expensive.",
    { contextWindow: 1_048_576 },
  ),
  paid(
    "deepseek",
    "deepseek-chat",
    "DeepSeek V3 (chat)",
    "Very cheap, capable coder.",
    "Data processed in China (privacy flag).",
  ),
  paid(
    "deepseek",
    "deepseek-reasoner",
    "DeepSeek R (reasoner)",
    "Cheap deep reasoning.",
    "Slower; data processed in China.",
  ),
  paid(
    "moonshot",
    "kimi-k2-0711-preview",
    "Kimi K2 (Moonshot)",
    "First-party Kimi: agentic coding, long context.",
    "Data may be processed in China.",
  ),
  paid(
    "mistral",
    "devstral-medium-latest",
    "Devstral Medium",
    "Mistral's agentic software-engineering model; EU-hosted.",
    "Metered on the paid plan.",
  ),
  paid(
    "mistral",
    "mistral-large-latest",
    "Mistral Large",
    "Mistral's flagship generalist; EU data residency.",
    "Metered; not the strongest pure coder.",
  ),
  paid(
    "together",
    "Qwen/Qwen2.5-Coder-32B-Instruct",
    "Qwen2.5 Coder 32B (Together)",
    "Cheap hosted open coder.",
    "Older generation coder.",
  ),
  paid(
    "openrouter",
    "anthropic/claude-sonnet-4.5",
    "Claude via OpenRouter",
    "One key, hundreds of models, automatic host fallback.",
    "Small markup over the vendor's price.",
  ),
]);

/** The catalogued models of one section, optionally for one provider. */
export function cloudModelsFor(section: "free" | "paid", providerId?: string): CloudModelEntry[] {
  return CLOUD_MODELS.filter(
    (m) => m.section === section && (providerId === undefined || m.providerId === providerId),
  );
}

/** Find a catalogued cloud model by provider + model id. */
export function findCloudModel(providerId: string, model: string): CloudModelEntry | undefined {
  return CLOUD_MODELS.find((m) => m.providerId === providerId && m.model === model);
}
