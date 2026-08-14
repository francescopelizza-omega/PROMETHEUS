/**
 * orchestration/api-providers.ts — trustworthy OpenAI-compatible API providers as subagents.
 *
 * Beyond the agentic vendor CLIs (claude/codex/gemini/cursor) and local models, a swarm can
 * bind a subagent to a paid INFERENCE PROVIDER reached over an OpenAI-compatible HTTP endpoint
 * with the USER'S OWN API key (kind:"api"). This is the ToS-clean automation lane: you drive a
 * commercial API you pay for with your own key — no screen-scraping, no subscription-login
 * driving. The universal rules still hold (never share/resell a key, respect rate limits), and
 * EVERY row is verify-at-setup: the exact endpoint/terms are confirmed when the user wires it.
 *
 * Endpoints/key-env conventions below are from each provider's public API docs (knowledge
 * snapshot — `confidence: "known"`); the two user-named gateways (nexos/abacus) and a few
 * deployment-style hosts are `confidence: "verify"` (exact base path confirmed at setup, where
 * the generic OpenAI-compatible override applies). Pure data + lookups; the CLI does the IO.
 */
import type { BackendRef } from "./topology.js";

/** ToS stance for own-key programmatic orchestration. */
export type ApiAutomation = "allowed" | "verify-at-setup";

export interface ApiProvider {
  /** short id (also the BackendRef.service). */
  id: string;
  label: string;
  /** OpenAI-compatible base URL (chat/completions live under it). */
  baseUrl: string;
  /** env var(s) that may hold the API key — first non-empty wins. */
  apiKeyEnv: readonly string[];
  /** a sensible default coding model id. */
  defaultModel: string;
  /** a few coding-relevant model ids the provider serves. */
  models: readonly string[];
  /**
   * The context window of this provider's listed models, in tokens.
   *
   * Every cloud endpoint was built with the 8192-token FLOOR from `ai/context-window.ts`,
   * because that module's job is measuring a LOCAL runner (`/api/show`) and there is nothing
   * safe to probe on a cloud provider. The floor was harmless while it only sized the
   * compaction budget; once `preflightContext` began refusing requests that do not fit, it
   * started rejecting ordinary prompts on 200k- and 1M-token models before they were sent.
   *
   * These are the vendors' documented figures for the models listed above, so they are as
   * measured as a static registry can be. Where a provider's models genuinely disagree, the
   * SMALLEST is used: under-using a large window costs a compaction, while over-stating a
   * small one costs a provider 400 in the middle of a turn. Omitted ⇒ the floor, unchanged.
   */
  contextWindow?: number;
  /**
   * The path, relative to `baseUrl`, that lists models — used to VERIFY a key without billing.
   *
   * Defaults to `/models`, which is right for every OpenAI-compatible provider. The two
   * first-party vendors are not: Anthropic serves `/v1/models` and Gemini `/v1beta/models`,
   * because their `baseUrl` here is the API ROOT rather than a versioned chat path. Pinging
   * the wrong path 404s, and `provider connect` reads that as "your key is invalid" and
   * refuses to store it — so a correct Anthropic or Gemini key could not be saved at all.
   */
  verifyPath?: string;
  /** own-key automation stance. */
  automation: ApiAutomation;
  /** "known" = endpoint+stance from public docs; "verify" = confirm exact surface at setup. */
  confidence: "known" | "verify";
  tosUrl: string;
  /** company / trust note. */
  note: string;
  /** data-residency flag for privacy-sensitive users (US/EU/CN). */
  dataRegion?: "US" | "EU" | "CN" | "global";
}

/**
 * Curated, trustworthy OpenAI-compatible providers (2026 snapshot). Reputable companies only —
 * no anonymous resellers. Driving any of these with your OWN api key is their intended use, so
 * automation is "allowed" (subject to the universal no-share/no-resell/rate-limit rules); the
 * two named gateways + deployment hosts are "verify-at-setup" until the exact base path is set.
 */
export const API_PROVIDERS: readonly ApiProvider[] = Object.freeze([
  /**
   * --- the two first-party vendors that do NOT speak OpenAI's wire ---
   *
   * They were absent from this registry entirely, so nothing could resolve a key for them and
   * an interactive session had no way to reach either. The other catalogue
   * (`ai/providers/providers.config.json`) lists `claude` and `gemini` with tier and pricing
   * but no base URL, and its connector builders have no production callers — so between the
   * two catalogues, the two largest model vendors were unreachable.
   *
   * `ai/wire.ts` is what makes these usable: a request built for OpenAI hits
   * `/v1/chat/completions` on `api.anthropic.com`, which does not exist, and 404s.
   */
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    // The wire format appends `/v1/messages` — this is the API ROOT, not a chat path.
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-6",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
    contextWindow: 200_000,
    verifyPath: "/v1/models",
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://www.anthropic.com/legal/commercial-terms",
    note: "First-party Anthropic API. Speaks the Messages protocol, not OpenAI chat/completions — see ai/wire.ts, which carries tool calling for it natively (tool_use blocks, input_json_delta fragments, tool_result on the next user turn).",
    dataRegion: "US",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    defaultModel: "gemini-2.5-pro",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    contextWindow: 1_048_576,
    verifyPath: "/v1beta/models",
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://ai.google.dev/gemini-api/terms",
    note: "First-party Google API. Speaks generateContent with an SSE alt, not OpenAI chat/completions — see ai/wire.ts, which carries tool calling for it natively (functionDeclarations over Gemini's OpenAPI schema subset; results pair by name).",
    dataRegion: "US",
  },
  // --- the two user-named services ---
  {
    id: "nexos",
    label: "nexos.ai",
    baseUrl: "https://api.nexos.ai/v1",
    apiKeyEnv: ["NEXOS_API_KEY"],
    defaultModel: "auto",
    models: ["auto"],
    automation: "verify-at-setup",
    confidence: "verify",
    tosUrl: "https://nexos.ai/terms",
    note: "Lithuanian enterprise AI gateway/orchestration platform (Nord Security founders). Unified, governed multi-model access. Confirm the exact OpenAI-compatible base path + model ids at setup.",
    dataRegion: "EU",
  },
  {
    id: "abacus",
    label: "Abacus.AI (RouteLLM)",
    baseUrl: "https://routellm.abacus.ai/v1",
    apiKeyEnv: ["ABACUS_API_KEY", "ABACUSAI_API_KEY"],
    defaultModel: "route-llm",
    models: ["route-llm"],
    automation: "verify-at-setup",
    confidence: "verify",
    tosUrl: "https://abacus.ai/app/termsAndConditions",
    note: "Established US AI platform (ChatLLM/CodeLLM/DeepAgent). RouteLLM exposes an OpenAI-compatible endpoint that auto-routes across frontier models. Confirm endpoint + model ids at setup.",
    dataRegion: "US",
  },
  // --- reputable OpenAI-compatible inference hosts/gateways ---
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    defaultModel: "deepseek/deepseek-chat",
    models: [
      "deepseek/deepseek-chat",
      "qwen/qwen-2.5-coder-32b-instruct",
      "anthropic/claude-3.5-sonnet",
    ],
    contextWindow: 64_000,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://openrouter.ai/terms",
    note: "Aggregator routing one key across 300+ models from many hosts.",
    dataRegion: "global",
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: ["TOGETHER_API_KEY"],
    defaultModel: "Qwen/Qwen2.5-Coder-32B-Instruct",
    models: [
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    ],
    contextWindow: 32_768,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://www.together.ai/terms-of-service",
    note: "Well-funded US open-model inference cloud.",
    dataRegion: "US",
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: ["FIREWORKS_API_KEY"],
    defaultModel: "accounts/fireworks/models/qwen2p5-coder-32b-instruct",
    models: [
      "accounts/fireworks/models/qwen2p5-coder-32b-instruct",
      "accounts/fireworks/models/deepseek-v3",
      "accounts/fireworks/models/llama-v3p3-70b-instruct",
    ],
    contextWindow: 32_768,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://fireworks.ai/terms-of-service",
    note: "Fast US open-model inference (FireAttention).",
    dataRegion: "US",
  },
  {
    id: "groq",
    label: "Groq (GroqCloud)",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "qwen-2.5-coder-32b", "deepseek-r1-distill-llama-70b"],
    contextWindow: 131_072,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://groq.com/terms-of-use/",
    note: "Ultra-low-latency LPU inference (US).",
    dataRegion: "US",
  },
  {
    id: "deepinfra",
    label: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyEnv: ["DEEPINFRA_API_KEY", "DEEPINFRA_TOKEN"],
    defaultModel: "Qwen/Qwen2.5-Coder-32B-Instruct",
    models: [
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "meta-llama/Llama-3.3-70B-Instruct",
    ],
    contextWindow: 32_768,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://deepinfra.com/terms",
    note: "Low-cost US open-model inference, per-token.",
    dataRegion: "US",
  },
  {
    id: "hyperbolic",
    label: "Hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    apiKeyEnv: ["HYPERBOLIC_API_KEY"],
    defaultModel: "Qwen/Qwen2.5-Coder-32B-Instruct",
    models: [
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "meta-llama/Llama-3.3-70B-Instruct",
    ],
    contextWindow: 32_768,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://hyperbolic.xyz/terms",
    note: "Open-model + GPU marketplace (US).",
    dataRegion: "US",
  },
  {
    id: "novita",
    label: "Novita AI",
    baseUrl: "https://api.novita.ai/v3/openai",
    apiKeyEnv: ["NOVITA_API_KEY"],
    defaultModel: "qwen/qwen-2.5-coder-32b-instruct",
    models: [
      "qwen/qwen-2.5-coder-32b-instruct",
      "deepseek/deepseek-v3",
      "meta-llama/llama-3.3-70b-instruct",
    ],
    contextWindow: 32_768,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://novita.ai/legal/terms-of-service",
    note: "Open-model inference cloud.",
    dataRegion: "global",
  },
  {
    id: "nebius",
    label: "Nebius AI Studio",
    baseUrl: "https://api.studio.nebius.com/v1",
    apiKeyEnv: ["NEBIUS_API_KEY"],
    defaultModel: "Qwen/Qwen2.5-Coder-32B-Instruct",
    models: [
      "Qwen/Qwen2.5-Coder-32B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "meta-llama/Llama-3.3-70B-Instruct",
    ],
    contextWindow: 32_768,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://nebius.com/legal/aistudio-terms-of-service",
    note: "EU (Nebius/ex-Yandex) sovereign open-model cloud.",
    dataRegion: "EU",
  },
  {
    id: "mistral",
    label: "Mistral La Plateforme",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: ["MISTRAL_API_KEY"],
    defaultModel: "codestral-latest",
    models: ["codestral-latest", "mistral-large-latest", "devstral-medium-latest"],
    contextWindow: 256_000,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://mistral.ai/terms/",
    note: "French frontier lab; Codestral/Devstral are strong coders.",
    dataRegion: "EU",
  },
  {
    id: "deepseek",
    label: "DeepSeek Platform",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    contextWindow: 65_536,
    automation: "allowed",
    confidence: "known",
    tosUrl:
      "https://platform.deepseek.com/downloads/DeepSeek%20Open%20Platform%20Terms%20of%20Service.html",
    note: "Strong, cheap coder/reasoner — data processed in China (privacy flag).",
    dataRegion: "CN",
  },
  {
    id: "cerebras",
    label: "Cerebras Inference",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: ["CEREBRAS_API_KEY"],
    defaultModel: "llama-3.3-70b",
    models: ["llama-3.3-70b", "qwen-3-coder-480b", "qwen-3-235b-a22b-instruct"],
    contextWindow: 65_536,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://www.cerebras.ai/terms-of-service",
    note: "Wafer-scale ultra-fast inference (US).",
    dataRegion: "US",
  },
  {
    id: "sambanova",
    label: "SambaNova Cloud",
    baseUrl: "https://api.sambanova.ai/v1",
    apiKeyEnv: ["SAMBANOVA_API_KEY"],
    defaultModel: "Meta-Llama-3.3-70B-Instruct",
    models: ["Meta-Llama-3.3-70B-Instruct", "Qwen2.5-Coder-32B-Instruct", "DeepSeek-V3-0324"],
    contextWindow: 131_072,
    automation: "allowed",
    confidence: "known",
    tosUrl: "https://sambanova.ai/terms-and-conditions",
    note: "RDU-accelerated inference (US).",
    dataRegion: "US",
  },
  {
    id: "baseten",
    label: "Baseten Model APIs",
    baseUrl: "https://inference.baseten.co/v1",
    apiKeyEnv: ["BASETEN_API_KEY"],
    defaultModel: "deepseek-ai/DeepSeek-V3-0324",
    models: ["deepseek-ai/DeepSeek-V3-0324", "Qwen/Qwen2.5-Coder-32B-Instruct"],
    contextWindow: 65_536,
    automation: "verify-at-setup",
    confidence: "verify",
    tosUrl: "https://www.baseten.co/terms-and-conditions/",
    note: "US model-deployment platform; Model-APIs are OpenAI-compatible — confirm the model slug at setup.",
    dataRegion: "US",
  },
  {
    id: "moonshot",
    label: "Moonshot AI (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    defaultModel: "kimi-k2-0711-preview",
    models: ["kimi-k2-0711-preview", "moonshot-v1-128k"],
    contextWindow: 131_072,
    automation: "verify-at-setup",
    confidence: "verify",
    tosUrl: "https://platform.moonshot.ai/docs/agreement/modeluse",
    note: "Strong long-context Kimi models — data may be processed in China (privacy flag); confirm region/terms at setup.",
    dataRegion: "CN",
  },
]);

const BY_ID = new Map<string, ApiProvider>(API_PROVIDERS.map((p) => [p.id, p]));

/** Every known API-provider id. */
export const API_PROVIDER_IDS: readonly string[] = Object.freeze([...BY_ID.keys()]);

/** Look up an API provider (case-insensitive). */
export function apiProviderFor(id: string): ApiProvider | undefined {
  return BY_ID.get(id.toLowerCase());
}

/** Is `id` a known API provider? */
export function isApiProvider(id: string): boolean {
  return BY_ID.has(id.toLowerCase());
}

/** Build an `api` BackendRef for a provider (+ optional model override). null if unknown. */
export function apiBackendFor(id: string, model?: string): BackendRef | null {
  const p = apiProviderFor(id);
  if (!p) return null;
  return {
    kind: "api",
    service: p.id,
    baseUrl: p.baseUrl,
    apiKeyEnv: p.apiKeyEnv[0] ?? "",
    model: model && model.length > 0 ? model : p.defaultModel,
  };
}

/** Resolve the API key for a provider from a process/agent env (first non-empty of its vars). */
export function resolveApiKey(
  id: string,
  env: Record<string, string | undefined>,
): { env: string; key: string } | null {
  const p = apiProviderFor(id);
  if (!p) return null;
  for (const name of p.apiKeyEnv) {
    const val = env[name];
    if (val && val !== "") return { env: name, key: val };
  }
  return null;
}
