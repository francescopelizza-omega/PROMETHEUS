// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * token-economy/techniques.ts — the curated TOKEN-SAVING toolkit Prometheus proposes
 * by default to new users. Cuts $ on paid closed models (the big win) and compute on
 * free local LLMs. From an 8-agent research sweep (caveman / repo-map / Cursor-style
 * indexing / prompt-caching / LLMLingua / context-pruning + Gemini-Nano feasibility).
 *
 * PURE data + a proposer (see ./propose.ts). Each tool is honest about its tradeoff,
 * maturity, and who it helps most. `defaultOn` = low-friction high-value → proposed
 * at onboarding by default; the rest are opt-in.
 */

export type TokenCategory =
  | "output-compression"
  | "context-compression"
  | "retrieval-rag"
  | "code-map"
  | "prompt-caching"
  | "context-pruning"
  | "local-model"
  | "experimental-local";

/** Which side of the bill it shrinks. */
export type Saves = "input" | "output" | "both";
/** Who benefits most: paid-closed (real $) · free-local (compute) · both. */
export type BestFor = "paid-closed" | "free-local" | "both";
export type Maturity = "production" | "stable" | "experimental";

export interface TokenTool {
  id: string;
  name: string;
  category: TokenCategory;
  saves: Saves;
  /** one-line pitch. */
  pitch: string;
  /** realistic saving (honest, with caveats baked in). */
  tokenSaving: string;
  bestFor: BestFor;
  /** how to install/enable (or "" for a zero-install technique). */
  install: string;
  /** how to apply it. */
  usage: string;
  /** integrates as an OpenAI-compatible / any-provider layer? */
  openaiCompatible: boolean;
  maturity: Maturity;
  /** proposed by default at onboarding (low-friction, broadly safe). */
  defaultOn: boolean;
  /**
   * CLI-088: does enabling this technique change RUNTIME behavior ("wired" — e.g. injects a terse
   * directive / sets prompt-caching) or is it advice the operator applies themselves ("advisory")?
   * Optional + defaults to "advisory" (see `tokenWiring`) so the frozen registry stays valid.
   */
  wiring?: "wired" | "advisory";
  /** the tradeoff / when NOT to use it. */
  notes: string;
}

/** CLI-088: the wiring class of a technique (default "advisory" — only the two wired ones opt in). */
export function tokenWiring(id: string): "wired" | "advisory" {
  return getTokenTool(id)?.wiring ?? "advisory";
}

export const TOKEN_TOOLS: readonly TokenTool[] = Object.freeze([
  {
    id: "terse-output",
    name: "Terse output (Caveman style)",
    category: "output-compression",
    saves: "output",
    pitch:
      "Ban preamble, hedging, and restating the question; force fragments/bullets while keeping code, identifiers, errors, and paths verbatim — the cheapest output cut there is.",
    tokenSaving:
      "~30–65% output on prose-heavy/agentic sessions (≈45% measured vs baseline). Near-zero or slightly negative on a single short query (the rules add input).",
    bestFor: "both",
    install:
      "Zero-install technique (system-prompt rule). Or the Claude-Code skill: curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash",
    usage:
      "System message: 'Output mode: terse. No preamble, no restating the question, no closing pleasantries, no hedging. Fragments + bullets. Preserve code, identifiers, errors, file paths verbatim. Answer first; explain only if asked.' Cache it across turns to amortize.",
    openaiCompatible: true,
    maturity: "production",
    defaultOn: true,
    wiring: "wired",
    notes:
      "Quality-neutral (code/errors preserved). Does NOT cut reasoning/thinking tokens (those dominate hard tasks). Cache the rule so the added instruction pays for itself.",
  },
  {
    id: "prompt-caching",
    name: "Native prompt caching",
    category: "prompt-caching",
    saves: "input",
    pitch:
      "Mark the stable prefix (system prompt, tool defs, repo/context docs) once; repeated input is billed at ~10% (Anthropic/Gemini 2.5) or 50% (OpenAI).",
    tokenSaving:
      "~90% off cached input (Anthropic/Gemini 2.5), ~50% (OpenAI). Net win when a prefix is reused >~2× inside the 5-min TTL.",
    bestFor: "paid-closed",
    install: "No install — built into the API.",
    usage:
      "Put STATIC content FIRST (instructions/tools/context), volatile/user content LAST. Anthropic: cache_control:{type:'ephemeral'} on the prefix's last block. OpenAI: automatic on ≥1024-token prefixes. Verify via usage.cache_read_input_tokens.",
    openaiCompatible: true,
    maturity: "production",
    defaultOn: true,
    wiring: "wired",
    notes:
      "Cache-miss writes cost MORE (+25% Anthropic) — don't cache volatile/rarely-reused prefixes. Multiplies with compression (compress the doc once, cache the result).",
  },
  {
    id: "subagent-offloading",
    name: "Sub-agent context offloading (Pattern A)",
    category: "context-pruning",
    saves: "input",
    pitch:
      "Run noisy exploration in a fresh isolated agent so dozens of file reads/search results stay in the child; only a distilled report returns to the parent.",
    tokenSaving:
      "Large on exploration-heavy work — the parent pays for a final summary instead of every byte the worker read; also enables parallelism.",
    bestFor: "both",
    install:
      "No install (Claude Code Agent/Task tool + .claude/agents/*.md). Generic: Claude Agent SDK, LangGraph subgraphs, CrewAI, AutoGen.",
    usage:
      "Delegate a focused subtask to a scout agent; pass everything it needs IN the prompt (it starts fresh). Orchestrator spawns scouts → receives only the final report.",
    openaiCompatible: true,
    maturity: "production",
    defaultOn: true,
    notes:
      "Each subagent re-sends its own system prompt — over-spawning trivial tasks ADDS tokens. Use only for large/noisy work. (This is Prometheus's own Pattern A.)",
  },
  {
    id: "aider-repo-map",
    name: "Repo map (built-in: file tree + exported symbols)",
    category: "code-map",
    saves: "input",
    pitch:
      "Hand the model a signature-only skeleton of the WHOLE repo in a fixed token budget instead of dumping files — so it answers 'where is X defined' without a grep. Built-in to `prometheus` (`/repomap`); aider's tree-sitter+PageRank map is the richer external option.",
    tokenSaving:
      "Whole-repo context collapsed to a fixed ~2k-token budget (`/repomap`, default OFF); 90%+ input vs sending full files for repo-wide context.",
    bestFor: "both",
    install:
      "Built-in — enable with `/repomap on` in a `prometheus` session. (External richer option: python -m pip install aider-install && aider-install.)",
    usage:
      "`/repomap on` injects a budgeted file+symbol map into the agent's system context; `/repomap refresh` rebuilds it (walking is the cost, so it's explicit-only). aider's map auto-injects with --map-tokens.",
    openaiCompatible: true,
    maturity: "production",
    defaultOn: true,
    notes:
      "Signatures only — the agent still reads bodies on demand. The built-in map is regex-based (deterministic, no deps, no PageRank ranking); aider's tree-sitter map is richer but pins parser coverage per language.",
  },
  {
    id: "local-code-rag",
    name: "Local code RAG (Cursor-style indexing)",
    category: "retrieval-rag",
    saves: "input",
    pitch:
      "A private, $0 Cursor-equivalent — AST-chunk the repo, embed locally, retrieve top-k chunks per turn instead of dumping whole files. Fixed budget regardless of repo size.",
    tokenSaving:
      "50–90% input on large repos; a fixed retrieval budget per turn no matter how big the repo grows.",
    bestFor: "both",
    install:
      "pip install llama-index-core tree-sitter tree-sitter-language-pack sqlite-vec (add lancedb for larger-than-RAM); ollama pull nomic-embed-text",
    usage:
      "Index: walk repo → CodeSplitter (AST) → Ollama /v1/embeddings → insert (vector,path,lines) into sqlite-vec/LanceDB. Query: embed the task, KNN top-k (+optional BM25 hybrid + rerank), inject only the hits.",
    openaiCompatible: true,
    maturity: "stable",
    defaultOn: false,
    notes:
      "Gaps vs Cursor: no managed reranker by default (add a cross-encoder); local embeddings are slightly weaker on code (nomic-embed-text / bge-m3 are the strong free picks).",
  },
  {
    id: "repomix-compress",
    name: "Repomix --compress (repo packer)",
    category: "code-map",
    saves: "input",
    pitch:
      "Pack an entire repo into one file with tree-sitter stripping function BODIES to keep only signatures/structure, plus gitignore/comment/secret pruning.",
    tokenSaving:
      "~70% reduction with --compress while preserving semantic structure; more via ignore/comment rules.",
    bestFor: "both",
    install: "npm install -g repomix  (or bunx repomix with no install)",
    usage:
      "repomix --compress -o repo.xml for a structural view; repomix --token-count-tree 1000 to find heavy files; scope with --include 'src/**/*.ts' --remove-comments. Ships an MCP server (repomix --mcp).",
    openaiCompatible: true,
    maturity: "production",
    defaultOn: false,
    notes:
      "Flat dump, not a ranked map (no PageRank) — less precise than the repo map for 'what matters most'. Even compressed, a large monorepo can blow the window.",
  },
  {
    id: "structured-output",
    name: "Structured outputs (strict JSON schema)",
    category: "output-compression",
    saves: "output",
    pitch:
      "Constrain the decoder to a flat, minified JSON schema so it emits only the fields you need — no prose wrapper, no 'Here is the JSON', no padding.",
    tokenSaving:
      "40%+ output on extract/classify/route; smaller or negative if the schema is deeply nested or pretty-printed.",
    bestFor: "both",
    install:
      "pip install openai (or any OpenAI-compatible endpoint; local: vLLM guided_json, Ollama/LM Studio response_format, outlines/xgrammar grammars)",
    usage:
      "response_format={'type':'json_schema','json_schema':{...,'strict':True}}. Keep the schema FLAT, field names SHORT, no 'explanation' fields, minified not pretty-printed.",
    openaiCompatible: true,
    maturity: "production",
    defaultOn: false,
    notes:
      "Over-nesting/pretty-print can ADD tokens — measure. Slightly less reasoning room can hurt hard tasks. Best on structured tasks, not open generation.",
  },
  {
    id: "llmlingua",
    name: "LLMLingua-2 (prompt compressor)",
    category: "context-compression",
    saves: "input",
    pitch:
      "A small LOCAL model scores every token and drops the low-information ones, shrinking RAG/long-context prompts 2–5× at near-parity quality before they hit any LLM.",
    tokenSaving:
      "2–5× input at near-parity (~3× with <2% task-score loss typical); up to 20× with degradation. LongLLMLingua reports +17–21% RAG accuracy at 1/4 tokens.",
    bestFor: "both",
    install: "pip install llmlingua",
    usage:
      "from llmlingua import PromptCompressor; c=PromptCompressor(use_llmlingua2=True); out=c.compress_prompt(context, rate=0.33, force_tokens=['\\n','?','.']); send out['compressed_prompt'].",
    openaiCompatible: true,
    maturity: "stable",
    defaultOn: false,
    notes:
      "Lossy token-dropping mangles exact strings/JSON/code — use force_tokens, keep rate≥0.5 for structured content, route code/errors verbatim. Adds local inference latency.",
  },
  {
    id: "anthropic-context-mgmt",
    name: "Server-side compaction + context editing (Anthropic)",
    category: "context-pruning",
    saves: "input",
    pitch:
      "On long agentic threads the API auto-clears the biggest token hogs — stale tool outputs (file reads, search dumps) become placeholders, older turns get summarized.",
    tokenSaving:
      "High on tool-heavy agents (old reads/search results are the largest blocks); caps a long thread near the trigger threshold.",
    bestFor: "paid-closed",
    install:
      "No install — Anthropic API. Compaction needs beta header anthropic-beta: compact-2026-01-12.",
    usage:
      "context_management edits: clear_tool_uses_20250919 (keep=recent N, exclude_tools) to GC stale tool output; and/or compact_20260112 (trigger input_tokens≥50000).",
    openaiCompatible: false,
    maturity: "stable",
    defaultOn: false,
    notes:
      "Both lossy: a cleared/summarized result must be re-fetched if needed — tune keep/exclude_tools and set a custom summary prompt to protect critical context.",
  },
  {
    id: "local-model-default",
    name: "Local ~4GB model (the legit 'Gemini Nano')",
    category: "local-model",
    saves: "both",
    pitch:
      "An account-free, fully-local, license-clean ~4GB on-device LLM serving an OpenAI-compatible endpoint — route cheap/bulk/offline work to a $0 local model instead of a paid API.",
    tokenSaving:
      "Compute/$ saving (not a context cut): bulk + offline + privacy work at $0; pair with model-routing (cheap local for easy turns, paid for hard ones).",
    bestFor: "free-local",
    install:
      "ollama pull qwen3:4b (Apache-2.0) · ollama run gemma3:4b (Gemma license) · phi4-mini (MIT). Or via Prometheus: prometheus setup → pick a local model.",
    usage:
      "Point any OpenAI client at base_url=http://localhost:11434/v1, api_key='ollama'. These are already in the Prometheus catalog with full RAM/feasibility data (prometheus model browse --free).",
    openaiCompatible: true,
    maturity: "production",
    defaultOn: true,
    notes:
      "The legitimate, license-clean answer to 'I want Gemini Nano locally' — see geminiNano for the actual-Nano feasibility (Chrome-only, fragile, weights not redistributable).",
  },
  {
    id: "gemini-nano-chrome",
    name: "Gemini Nano via Chrome Built-in AI (experimental)",
    category: "experimental-local",
    saves: "both",
    pitch:
      "Drive Chrome's OWN on-device Gemini Nano (Prompt API) locally behind an OpenAI-compatible localhost shim — no Google account, no external calls, no weight download.",
    tokenSaving:
      "$0 fully-local inference for light tasks (it's a ~2–4GB on-device model), offloading bulk/offline work from a paid API.",
    bestFor: "free-local",
    install:
      "Requires Chrome 138+ with Gemini Nano provisioned (chrome://flags → Prompt API for Gemini Nano + on-device model; the model is Chrome's managed component, auto-downloaded). NO account.",
    usage:
      "In a local page: const s = await LanguageModel.create(); await s.prompt('…'). Headless: drive it via CDP behind a localhost OpenAI-compatible shim. Prometheus surfaces this PATH + the honest feasibility ASSESSMENT via `prometheus tokens nano` — it documents the connector, it does not ship one yet.",
    openaiCompatible: true,
    maturity: "experimental",
    defaultOn: false,
    notes:
      "FRAGILE: flag names churn, create() needs a user gesture until cached, it's a browser API repurposed. Output is bound by Google's Generative AI Prohibited Use Policy. Prometheus NEVER downloads/redistributes Nano weights (proprietary; leaked dumps are ToS-unsafe). Prefer the open ~4GB default.",
  },
]);

/** Look up a token-saving tool by id. */
export function getTokenTool(id: string): TokenTool | undefined {
  return TOKEN_TOOLS.find((t) => t.id === id);
}
