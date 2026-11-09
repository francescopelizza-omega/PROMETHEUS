// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/runtimes/registry.ts — every local model runtime and local-model agent Prometheus knows,
 * as DATA: how to detect it, install it through an official channel, start/stop it, where it
 * keeps weights, which weight formats it serves, and what to warn about.
 *
 * PURE. Nothing here spawns, fetches or touches disk — engine-bridge and the sidecars own
 * execution (C5). Facts were checked against each vendor's own docs on 2026-11-02; anything
 * that could not be confirmed is marked `verify` in its notes rather than guessed.
 *
 * Install policy (owner decision 2026-10-02, reused for runtimes): Prometheus installs only
 * through an official package channel whose artifacts carry a published checksum (Homebrew
 * core formulae/casks, isolated pip environments from PyPI). Vendor `curl | sh` installers are
 * NEVER executed — they are listed as `manual` steps, shown verbatim with their source URL.
 */

export type RuntimeId =
  | "ollama"
  | "lmstudio"
  | "llamacpp"
  | "mlx"
  | "vllm"
  | "koboldcpp"
  | "localai"
  | "jan"
  | "llamafile"
  | "gpt4all"
  | "sglang"
  | "airllm"
  | "colibri";

export type AgentId = "opencode" | "hermes" | "aider" | "goose" | "claude-code" | "codex";

export type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "win32-x64";

/** manage = full lifecycle · adopt = detect + use + stop, never install · detect = report only */
export type Tier = "manage" | "adopt" | "detect";

/** How a binary may arrive. Closed set — no free-text commands. */
export type InstallMethod =
  | { kind: "brew-formula"; name: string }
  | { kind: "brew-cask"; token: string }
  /** an isolated virtualenv under ~/.prometheus/runtimes/<id>, wheels gated before install */
  | { kind: "pip-venv"; pkg: string; python?: string }
  | { kind: "npm-global"; pkg: string }
  /** a PINNED source commit, scanned by nemesis, built locally (never a prebuilt binary) */
  | { kind: "source-build"; name: string; repo: string; commit: string }
  /** shown, never run: vendor scripts, GUI installers, anything needing sudo */
  | { kind: "manual"; steps: readonly string[]; url: string; why: string };

/** The weight formats a runtime can serve. */
export type ModelFormat = "ollama-registry" | "gguf" | "mlx" | "safetensors";

export interface RuntimeSpec {
  id: RuntimeId;
  name: string;
  tier: Tier;
  /** one line for pickers. */
  summary: string;
  platforms: readonly Platform[];
  docs: string;
  detect: {
    bins: readonly string[];
    appBundles?: readonly string[];
    versionArgv?: readonly string[];
    /** GET this path on the port; the runner is identified only when it answers like itself. */
    fingerprintPath: string;
  };
  install: Partial<Record<Platform, readonly InstallMethod[]>>;
  serve: {
    /** the port Prometheus passes explicitly when IT starts the server. */
    port: number;
    /** vendor defaults to probe when discovering a server someone else started. */
    probePorts: readonly number[];
    /** OpenAI-compatible path under the root. */
    openAiPath: string;
    /** argv to start with NO model loaded, when the runtime can (placeholders: {port}). */
    startArgv?: readonly string[];
    /** argv to start serving one admitted local model ({model} {port} {alias} {ctx}). */
    startWithModelArgv?: readonly string[];
    /** env applied to a server Prometheus starts — offline flags stop runtime-side downloads. */
    env?: Readonly<Record<string, string>>;
    /** argv for a graceful vendor stop (preferred over signalling the listener). */
    stopArgv?: readonly string[];
  };
  models: {
    formats: readonly ModelFormat[];
    /** where it keeps weights (`~` = home), and the env var that relocates it. */
    store?: string;
    storeEnv?: string;
  };
  /** shown at install / adopt time. */
  notes: readonly string[];
}

const MAC = ["darwin-arm64", "darwin-x64"] as const;
const LINUX = ["linux-x64", "linux-arm64"] as const;
const ALL: readonly Platform[] = [...MAC, ...LINUX, "win32-x64"];

const RUNTIME_ROWS: RuntimeSpec[] = [
  {
    id: "ollama",
    name: "Ollama",
    tier: "manage",
    summary: "One-command local models; pulls from its own registry, serves an OpenAI API.",
    platforms: ALL,
    docs: "https://docs.ollama.com",
    detect: {
      bins: ["ollama"],
      appBundles: ["/Applications/Ollama.app"],
      versionArgv: ["ollama", "--version"],
      fingerprintPath: "/api/version",
    },
    install: {
      "darwin-arm64": [
        { kind: "brew-cask", token: "ollama-app" },
        { kind: "brew-formula", name: "ollama" },
      ],
      "darwin-x64": [
        { kind: "brew-cask", token: "ollama-app" },
        { kind: "brew-formula", name: "ollama" },
      ],
      "linux-x64": [
        { kind: "brew-formula", name: "ollama" },
        {
          kind: "manual",
          steps: ["curl -fsSL https://ollama.com/install.sh | sh"],
          url: "https://docs.ollama.com/linux",
          why: "the vendor script installs a systemd service with sudo",
        },
      ],
      "linux-arm64": [
        {
          kind: "manual",
          steps: ["curl -fsSL https://ollama.com/install.sh | sh"],
          url: "https://docs.ollama.com/linux",
          why: "the vendor script installs a systemd service with sudo",
        },
      ],
      "win32-x64": [
        {
          kind: "manual",
          steps: ["Download OllamaSetup.exe from https://ollama.com/download"],
          url: "https://ollama.com/download",
          why: "GUI installer",
        },
      ],
    },
    serve: {
      port: 11434,
      probePorts: [11434],
      openAiPath: "/v1",
      startArgv: ["ollama", "serve"],
    },
    models: {
      formats: ["ollama-registry", "gguf"],
      store: "~/.ollama/models",
      storeEnv: "OLLAMA_MODELS",
    },
    notes: [
      "Registry pulls are scanned by nemesis after download and removed on a block.",
      "Install the app OR the formula, never both — two daemons fight for :11434.",
      "`:cloud` model tags run on Ollama's servers, not locally.",
    ],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    tier: "manage",
    summary: "Desktop app with a model browser; `lms` CLI and a local OpenAI server on :1234.",
    platforms: ["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"],
    docs: "https://lmstudio.ai/docs/cli",
    detect: {
      bins: ["lms"],
      appBundles: ["/Applications/LM Studio.app", "/Applications/Bionic.app"],
      versionArgv: ["lms", "version"],
      fingerprintPath: "/api/v1/models",
    },
    install: {
      "darwin-arm64": [{ kind: "brew-cask", token: "lm-studio" }],
      "linux-x64": [
        {
          kind: "manual",
          steps: ["curl -fsSL https://lmstudio.ai/install.sh | bash", "lms daemon up"],
          url: "https://lmstudio.ai/docs/developer/core/headless",
          why: "vendor script (headless llmster)",
        },
      ],
      "linux-arm64": [
        {
          kind: "manual",
          steps: ["curl -fsSL https://lmstudio.ai/install.sh | bash", "lms daemon up"],
          url: "https://lmstudio.ai/docs/developer/core/headless",
          why: "vendor script (headless llmster)",
        },
      ],
      "win32-x64": [
        {
          kind: "manual",
          steps: ["Download the installer from https://lmstudio.ai/download"],
          url: "https://lmstudio.ai/download",
          why: "GUI installer",
        },
      ],
    },
    serve: {
      port: 1234,
      probePorts: [1234],
      openAiPath: "/v1",
      startArgv: ["lms", "server", "start", "--port", "{port}"],
      stopArgv: ["lms", "server", "stop"],
    },
    models: { formats: ["gguf", "mlx"], store: "~/.lmstudio/models" },
    notes: [
      "`lms server stop` frees the port, not the weights — Prometheus unloads first.",
      "Unknown routes answer HTTP 200 with an error body: identify it by /api/v1/models.",
    ],
  },
  {
    id: "llamacpp",
    name: "llama.cpp (llama-server)",
    tier: "manage",
    summary: "The reference GGUF engine: fast, small, serves one admitted file per server.",
    platforms: ALL,
    docs: "https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md",
    detect: {
      bins: ["llama-server", "llama"],
      versionArgv: ["llama-server", "--version"],
      fingerprintPath: "/props",
    },
    install: {
      "darwin-arm64": [{ kind: "brew-formula", name: "llama.cpp" }],
      "darwin-x64": [{ kind: "brew-formula", name: "llama.cpp" }],
      "linux-x64": [{ kind: "brew-formula", name: "llama.cpp" }],
      "linux-arm64": [{ kind: "brew-formula", name: "llama.cpp" }],
      "win32-x64": [
        {
          kind: "manual",
          steps: ["winget install llama.cpp"],
          url: "https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md",
          why: "winget is run by you",
        },
      ],
    },
    serve: {
      // v0.7.0 moved the vendor default 8080 → 9931; Prometheus passes its port explicitly.
      port: 8080,
      probePorts: [8080, 9931],
      openAiPath: "/v1",
      startWithModelArgv: [
        "llama-server",
        "-m",
        "{model}",
        "--host",
        "127.0.0.1",
        "--port",
        "{port}",
        "-c",
        "{ctx}",
        "--jinja",
        "--alias",
        "{alias}",
        "--offline",
      ],
    },
    models: { formats: ["gguf"] },
    notes: [
      "Never started with -hf: it only serves files that passed the nemesis gate.",
      "Port 8080 is shared with mlx_lm, LocalAI and llamafile — identified by /props.",
    ],
  },
  {
    id: "mlx",
    name: "MLX-LM (Apple Silicon)",
    tier: "manage",
    summary: "Apple's MLX engine: fastest on M-series Macs, serves mlx-community safetensors.",
    platforms: ["darwin-arm64"],
    docs: "https://github.com/ml-explore/mlx-lm",
    detect: { bins: ["mlx_lm.server"], fingerprintPath: "/health" },
    install: {
      "darwin-arm64": [
        { kind: "brew-formula", name: "mlx-lm" },
        { kind: "pip-venv", pkg: "mlx-lm" },
      ],
    },
    serve: {
      port: 8090,
      probePorts: [8090, 8080],
      openAiPath: "/v1",
      startWithModelArgv: [
        "mlx_lm.server",
        "--model",
        "{model}",
        "--host",
        "127.0.0.1",
        "--port",
        "{port}",
      ],
      // no runtime-side downloads, ever: it serves the admitted directory only
      env: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    },
    models: { formats: ["mlx"], store: "~/.cache/huggingface/hub", storeEnv: "HF_HUB_CACHE" },
    notes: [
      "Never passed --trust-remote-code; a tokenizer that needs code fails closed.",
      "The vendor's `sysctl iogpu.wired_limit_mb` tip needs sudo — never applied automatically.",
    ],
  },
  {
    id: "vllm",
    name: "vLLM",
    tier: "adopt",
    summary: "High-throughput server for NVIDIA GPUs (Linux); adopted when already running.",
    platforms: ["linux-x64", "linux-arm64"],
    docs: "https://docs.vllm.ai",
    detect: { bins: ["vllm"], fingerprintPath: "/version" },
    install: {
      "linux-x64": [{ kind: "pip-venv", pkg: "vllm", python: "3.12" }],
      "linux-arm64": [{ kind: "pip-venv", pkg: "vllm", python: "3.12" }],
    },
    serve: {
      port: 8000,
      probePorts: [8000],
      openAiPath: "/v1",
      startWithModelArgv: [
        "vllm",
        "serve",
        "{model}",
        "--host",
        "127.0.0.1",
        "--port",
        "{port}",
        "--served-model-name",
        "{alias}",
        "--max-model-len",
        "{ctx}",
      ],
      env: { HF_HUB_OFFLINE: "1" },
    },
    models: { formats: ["safetensors"] },
    notes: ["Never --trust-remote-code; /collective_rpc is a dev endpoint — never exposed."],
  },
  {
    id: "koboldcpp",
    name: "KoboldCpp",
    tier: "adopt",
    summary: "Single-binary GGUF server with a story-writing UI; speaks OpenAI on :5001.",
    platforms: ALL,
    docs: "https://github.com/LostRuins/koboldcpp",
    detect: { bins: ["koboldcpp", "koboldcpp-mac-arm64"], fingerprintPath: "/api/extra/version" },
    install: {},
    serve: { port: 5001, probePorts: [5001], openAiPath: "/v1" },
    models: { formats: ["gguf"] },
    notes: ["Only from github.com/LostRuins — koboldcpp.com is a phishing site (vendor README)."],
  },
  {
    id: "localai",
    name: "LocalAI",
    tier: "adopt",
    summary: "Multi-backend OpenAI-compatible server; adopted, never installed by Prometheus.",
    platforms: ALL,
    docs: "https://localai.io",
    detect: { bins: ["local-ai"], fingerprintPath: "/readyz" },
    install: {},
    serve: { port: 8080, probePorts: [8080], openAiPath: "/v1" },
    models: { formats: ["gguf"] },
    notes: ["Downloads backends at run time, outside any gate — adopt only."],
  },
  {
    id: "jan",
    name: "Jan",
    tier: "adopt",
    summary: "Desktop chat app; its Local API Server (Settings) serves OpenAI on :1337.",
    platforms: ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"],
    docs: "https://docs.jan.ai/desktop/api-server",
    detect: { bins: [], appBundles: ["/Applications/Jan.app"], fingerprintPath: "/v1/models" },
    install: {
      "darwin-arm64": [{ kind: "brew-cask", token: "jan" }],
      "darwin-x64": [{ kind: "brew-cask", token: "jan" }],
    },
    serve: { port: 1337, probePorts: [1337], openAiPath: "/v1" },
    models: { formats: ["gguf", "mlx"], store: "~/Library/Application Support/Jan/data" },
    notes: ["The server is a GUI toggle; CORS is on by default."],
  },
  {
    id: "llamafile",
    name: "llamafile",
    tier: "adopt",
    summary: "Model + runtime in one executable; adopted when serving on :8080.",
    platforms: ALL,
    docs: "https://github.com/mozilla-ai/llamafile",
    detect: { bins: ["llamafile"], fingerprintPath: "/health" },
    install: {},
    serve: { port: 8080, probePorts: [8080], openAiPath: "/v1" },
    models: { formats: ["gguf"] },
    notes: ["A .llamafile IS an executable — never downloaded or run by Prometheus."],
  },
  {
    id: "gpt4all",
    name: "GPT4All",
    tier: "detect",
    summary: "Desktop app (no release since 2025-02); its API server is a GUI toggle on :4891.",
    platforms: ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"],
    docs: "https://docs.gpt4all.io/gpt4all_api_server/home.html",
    detect: { bins: [], appBundles: ["/Applications/gpt4all"], fingerprintPath: "/v1/models" },
    install: {},
    serve: { port: 4891, probePorts: [4891], openAiPath: "/v1" },
    models: { formats: ["gguf"] },
    notes: ["Detected and usable, not managed: the project looks unmaintained."],
  },
  {
    id: "sglang",
    name: "SGLang",
    tier: "adopt",
    summary: "NVIDIA-GPU serving engine; adopted on remote hosts only.",
    platforms: ["linux-x64"],
    docs: "https://docs.sglang.io",
    detect: { bins: ["sglang"], fingerprintPath: "/health" },
    install: {},
    serve: { port: 30000, probePorts: [30000], openAiPath: "/v1" },
    models: { formats: ["safetensors"] },
    notes: ["Use through `/remote` (ssh tunnel) to a GPU host."],
  },
  {
    id: "airllm",
    name: "AirLLM (layer streaming)",
    tier: "manage",
    summary:
      "Runs a dense model larger than RAM one layer at a time from disk — minutes per token; only when you insist.",
    platforms: ["darwin-arm64", "linux-x64"],
    docs: "https://github.com/lyogavin/airllm",
    detect: { bins: [], fingerprintPath: "/health" },
    install: {
      // gated pip into Prometheus's own venv: airllm==4.0.0 + torch>=2.6 (+ mlx on a Mac)
      "darwin-arm64": [{ kind: "pip-venv", pkg: "airllm" }],
      "linux-x64": [{ kind: "pip-venv", pkg: "airllm" }],
    },
    serve: {
      // Prometheus's own shim (python/sidecar/airllm_serve.py): AirLLM has no server
      port: 8094,
      probePorts: [8094],
      openAiPath: "/v1",
      env: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    },
    models: { formats: ["safetensors"] },
    notes: [
      "AirLLM loads config and tokenizer with trust_remote_code=True; it is only ever given a nemesis-admitted directory with no code and no auto_map, fully offline.",
      "On Apple Silicon only Llama- and Mistral-architecture models; elsewhere an NVIDIA GPU.",
    ],
  },
  {
    id: "colibri",
    name: "colibri (MoE expert streaming)",
    tier: "manage",
    summary:
      "C engine for huge Mixture-of-Experts models: dense part in RAM, experts streamed from NVMe; only when you insist.",
    platforms: ["darwin-arm64", "linux-x64"],
    docs: "https://github.com/JustVugg/colibri",
    detect: { bins: [], fingerprintPath: "/health" },
    install: {
      "darwin-arm64": [
        {
          kind: "source-build",
          name: "colibri",
          repo: "https://github.com/JustVugg/colibri",
          commit: "704a3f68184b78367a04cb5526e428dc2f90f05b",
        },
      ],
      "linux-x64": [
        {
          kind: "source-build",
          name: "colibri",
          repo: "https://github.com/JustVugg/colibri",
          commit: "704a3f68184b78367a04cb5526e428dc2f90f05b",
        },
      ],
    },
    serve: { port: 8000, probePorts: [8000], openAiPath: "/v1" },
    models: { formats: ["gguf"] },
    notes: [
      "The prebuilt release archive is refused by nemesis (native binaries); Prometheus builds the pinned source instead.",
      "Always served with a per-session COLI_API_KEY: on loopback without one it answers any local process.",
    ],
  },
];

/** Every runtime, frozen. Typed row by row (`RuntimeSpec[]`) so a field mistake is a type error. */
export const RUNTIMES: readonly RuntimeSpec[] = Object.freeze(RUNTIME_ROWS);

/** A local-model AGENT (a coding/chat front-end) Prometheus can point at a local server. */
export interface AgentSpec {
  id: AgentId;
  name: string;
  summary: string;
  bins: readonly string[];
  install: Partial<Record<Platform, readonly InstallMethod[]>>;
  /** below this served context the agent refuses or degrades badly. */
  minContext?: number;
  /** runtimes it can be wired to without writing any config file. */
  runtimes: "any-openai" | readonly RuntimeId[];
  docs: string;
}

const BREW_EVERYWHERE = (
  m: InstallMethod,
): Partial<Record<Platform, readonly InstallMethod[]>> => ({
  "darwin-arm64": [m],
  "darwin-x64": [m],
  "linux-x64": [m],
  "linux-arm64": [m],
});

const AGENT_ROWS: AgentSpec[] = [
  {
    id: "opencode",
    name: "OpenCode",
    summary: "Terminal coding agent; wired per run with OPENCODE_CONFIG_CONTENT (no file written).",
    bins: ["opencode"],
    install: BREW_EVERYWHERE({ kind: "npm-global", pkg: "opencode-ai" }),
    runtimes: "any-openai",
    docs: "https://opencode.ai/docs/providers/",
  },
  {
    id: "hermes",
    name: "Hermes Agent (Nous Research)",
    // No per-run endpoint flags are documented (verified against its quickstart, 2026-11-03):
    // it is pointed at a local server ONCE, by the user, with `hermes model` → Custom endpoint
    // (or Ollama's own `ollama launch hermes`). Prometheus launches it and says how; it never
    // writes ~/.hermes/config.yaml itself.
    summary:
      "Autonomous agent; point it at a local server once with `hermes model` → Custom endpoint.",
    bins: ["hermes"],
    install: {
      "darwin-arm64": [
        {
          kind: "manual",
          steps: ["curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"],
          url: "https://hermes-agent.nousresearch.com",
          why: "vendor script",
        },
      ],
      "linux-x64": [
        {
          kind: "manual",
          steps: ["curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"],
          url: "https://hermes-agent.nousresearch.com",
          why: "vendor script",
        },
      ],
    },
    // Hermes refuses windows smaller than 64K tokens at startup (vendor docs)
    minContext: 64_000,
    runtimes: "any-openai",
    docs: "https://hermes-agent.nousresearch.com",
  },
  {
    id: "aider",
    name: "aider",
    summary: "Pair-programming in git; OPENAI_API_BASE + --model openai/<id>.",
    bins: ["aider"],
    install: BREW_EVERYWHERE({ kind: "brew-formula", name: "aider" }),
    runtimes: "any-openai",
    docs: "https://aider.chat/docs/llms/openai-compat.html",
  },
  {
    id: "goose",
    name: "Goose (Block)",
    summary: "General agent; env-only wiring (GOOSE_PROVIDER/OPENAI_HOST/GOOSE_MODEL).",
    bins: ["goose"],
    // Homebrew `goose` is a database-migration tool; Block's agent is `block-goose-cli`.
    install: BREW_EVERYWHERE({ kind: "brew-formula", name: "block-goose-cli" }),
    runtimes: "any-openai",
    docs: "https://goose-docs.ai/docs/getting-started/installation",
  },
  {
    id: "claude-code",
    name: "Claude Code on a local model",
    summary: "Through Ollama's Anthropic-compatible API (ANTHROPIC_BASE_URL); Ollama only.",
    bins: ["claude"],
    install: BREW_EVERYWHERE({ kind: "npm-global", pkg: "@anthropic-ai/claude-code" }),
    minContext: 64_000,
    runtimes: ["ollama"],
    docs: "https://docs.ollama.com/integrations/claude-code",
  },
  {
    id: "codex",
    name: "Codex CLI on a local model",
    summary: "`codex --oss` against Ollama; Ollama only.",
    bins: ["codex"],
    install: BREW_EVERYWHERE({ kind: "npm-global", pkg: "@openai/codex" }),
    minContext: 64_000,
    runtimes: ["ollama"],
    docs: "https://docs.ollama.com/integrations/codex",
  },
];

export const AGENTS: readonly AgentSpec[] = Object.freeze(AGENT_ROWS);

export function runtimeById(id: string): RuntimeSpec | undefined {
  return RUNTIMES.find((r) => r.id === id);
}

export function agentById(id: string): AgentSpec | undefined {
  return AGENTS.find((a) => a.id === id);
}
