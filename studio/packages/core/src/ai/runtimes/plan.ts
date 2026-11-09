// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/runtimes/plan.ts — pure decisions over the runtime registry: which runtime should serve a
 * model on this machine, how its weights are acquired (always through a nemesis-gated path),
 * what an install would run, and how an agent is pointed at the local server.
 *
 * No I/O. Callers pass the machine's state in (what is installed, what is serving).
 */
import type { CatalogGguf } from "../model-catalog/catalog-types.js";
import {
  AGENTS,
  type AgentId,
  type InstallMethod,
  type Platform,
  RUNTIMES,
  type RuntimeId,
  type RuntimeSpec,
  runtimeById,
} from "./registry.js";

/** The weight coordinates a model offers (a slice of the catalogue row). */
export interface ModelSources {
  id: string;
  /** official safetensors repo. */
  repo?: string;
  ollama?: string;
  gguf?: CatalogGguf;
  mlx?: string;
  remoteCode?: boolean;
  /** Q4 size (GiB) for messages and disk checks. */
  q4Gb: number;
}

/** What is known about one runtime on this machine. */
export interface RuntimeState {
  id: RuntimeId;
  installed: boolean;
  serving: boolean;
  baseUrl?: string;
}

export function platformOf(os: string, arch: string): Platform | undefined {
  const a =
    arch === "x64" || arch === "x86_64" || arch === "amd64"
      ? "x64"
      : arch === "arm64" || arch === "aarch64"
        ? "arm64"
        : undefined;
  if (!a) return undefined;
  if (os === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (os === "linux") return a === "arm64" ? "linux-arm64" : "linux-x64";
  if (os === "win32" && a === "x64") return "win32-x64";
  return undefined;
}

/** Install choices for a runtime here: `auto` runs through an official channel (still gated);
 *  `manual` is only ever shown. */
export function installChoices(
  rt: RuntimeSpec,
  platform: Platform,
): { auto: InstallMethod[]; manual: Extract<InstallMethod, { kind: "manual" }>[] } {
  const all = rt.install[platform] ?? [];
  const auto: InstallMethod[] = [];
  const manual: Extract<InstallMethod, { kind: "manual" }>[] = [];
  for (const m of all) {
    if (m.kind === "manual") manual.push(m);
    else if (rt.tier === "manage" || m.kind !== "pip-venv") auto.push(m);
  }
  return { auto, manual };
}

/** The exact argv an automatic install method runs — shown to the human before it runs. */
export function installArgv(m: InstallMethod): readonly string[] | undefined {
  switch (m.kind) {
    case "brew-formula":
      return ["brew", "install", "--formula", m.name];
    case "brew-cask":
      return ["brew", "install", "--cask", "--require-sha", m.token];
    case "pip-venv":
      // Two commands (create the venv, then install INTO it) are not one argv: the old array
      // carried a literal "&&" and an unexpanded "~", and its `pip` was whichever pip came
      // first on PATH, not the venv's. There is no single process to spawn, so there is no argv.
      return undefined;
    case "npm-global":
      return ["npm", "install", "-g", m.pkg];
    case "source-build":
      // clone → nemesis → make is several steps run by the sidecar, never one argv
      return undefined;
    case "manual":
      return undefined;
  }
}

/** How a model's weights reach a runtime. Every method is nemesis-gated:
 *  - ollama-pull: scanned after the pull, removed on a block (modelhub ollama-gate);
 *  - hf-gguf / hf-mlx / hf-snapshot: staged, sha256-verified, scanned, admitted (stage-hf). */
export type AcquirePlan =
  | { method: "ollama-pull"; tag: string; sizeGb: number }
  | {
      method: "hf-gguf";
      repo: string;
      file: string;
      sizeGb: number;
      quant?: string;
      importToOllama: boolean;
    }
  | { method: "hf-mlx"; repo: string; sizeGb: number }
  | { method: "hf-snapshot"; repo: string; sizeGb: number };

const GGUF_SERVERS: readonly RuntimeId[] = [
  "llamacpp",
  "lmstudio",
  "koboldcpp",
  "jan",
  "llamafile",
  "localai",
];

export function acquireFor(m: ModelSources, runtime: RuntimeId): AcquirePlan | undefined {
  const sizeGb = m.gguf?.bytes ? Math.round((m.gguf.bytes / 1024 ** 3) * 100) / 100 : m.q4Gb;
  if (runtime === "ollama") {
    if (m.ollama) return { method: "ollama-pull", tag: m.ollama, sizeGb: m.q4Gb };
    if (m.gguf) return ggufPlan(m.gguf, sizeGb, true);
    return undefined;
  }
  if (GGUF_SERVERS.includes(runtime)) return m.gguf ? ggufPlan(m.gguf, sizeGb, false) : undefined;
  if (runtime === "mlx")
    return m.mlx ? { method: "hf-mlx", repo: m.mlx, sizeGb: m.q4Gb } : undefined;
  if (runtime === "vllm" || runtime === "sglang") {
    // the full-precision weights, never with repository code
    return m.repo && !m.remoteCode
      ? { method: "hf-snapshot", repo: m.repo, sizeGb: m.q4Gb * 3.4 }
      : undefined;
  }
  return undefined;
}

function ggufPlan(g: CatalogGguf, sizeGb: number, importToOllama: boolean): AcquirePlan {
  return {
    method: "hf-gguf",
    repo: g.repo,
    file: g.file,
    sizeGb,
    ...(g.quant ? { quant: g.quant } : {}),
    importToOllama,
  };
}

/** Preference order when nothing is installed or chosen yet. */
export function defaultRuntimeOrder(platform: Platform): RuntimeId[] {
  if (platform === "darwin-arm64") return ["ollama", "lmstudio", "llamacpp", "mlx"];
  if (platform.startsWith("darwin")) return ["ollama", "llamacpp", "lmstudio"];
  if (platform.startsWith("linux")) return ["ollama", "llamacpp", "lmstudio", "vllm"];
  return ["ollama", "lmstudio", "llamacpp"];
}

export interface RuntimeChoice {
  runtime: RuntimeId;
  acquire: AcquirePlan;
  /** why this runtime: "you chose it" / "already serving" / "installed" / "default here". */
  reason: string;
  installed: boolean;
  serving: boolean;
}

/**
 * Pick the runtime for a model. Order: the user's preference (when it can serve the model) →
 * a runtime already serving that can → an installed one that can → the platform default that
 * can be installed here. Adopt-tier runtimes are used only when they are already running.
 * `undefined` = nothing on this platform can serve any of the model's formats.
 */
export function chooseRuntime(
  m: ModelSources,
  states: readonly RuntimeState[],
  platform: Platform,
  preferred?: RuntimeId,
): RuntimeChoice | undefined {
  const state = (id: RuntimeId) => states.find((s) => s.id === id);
  const usable = (id: RuntimeId): boolean => {
    const rt = runtimeById(id);
    if (!rt || !rt.platforms.includes(platform)) return false;
    const st = state(id);
    if (rt.tier !== "manage" && !st?.serving) return false;
    return acquireFor(m, id) !== undefined;
  };
  const pick = (id: RuntimeId, reason: string): RuntimeChoice => ({
    runtime: id,
    acquire: acquireFor(m, id) as AcquirePlan,
    reason,
    installed: state(id)?.installed ?? false,
    serving: state(id)?.serving ?? false,
  });
  if (preferred && usable(preferred)) return pick(preferred, "your chosen runtime");
  for (const s of states) if (s.serving && usable(s.id)) return pick(s.id, "already serving");
  for (const s of states) if (s.installed && usable(s.id)) return pick(s.id, "already installed");
  for (const id of defaultRuntimeOrder(platform)) {
    const rt = runtimeById(id);
    if (rt && usable(id) && installChoices(rt, platform).auto.length > 0)
      return pick(id, "the default here");
  }
  for (const id of defaultRuntimeOrder(platform))
    if (usable(id)) return pick(id, "install it yourself");
  return undefined;
}

/** Every runtime that could serve this model on this platform (for "serve with…" menus). */
export function runtimesFor(m: ModelSources, platform: Platform): RuntimeId[] {
  return RUNTIMES.filter((r) => r.platforms.includes(platform) && acquireFor(m, r.id)).map(
    (r) => r.id,
  );
}

export interface AgentWiring {
  /** environment for the agent process only — nothing is written to the agent's config. */
  env: Record<string, string>;
  /** argv prefix (the prompt is appended by the caller). */
  argv: string[];
}

/**
 * Point an agent at a local OpenAI-compatible server, per run, through env/argv only.
 *
 * The LAUNCHER is the engine's `prometheus chat --cli <agent> --model <m> [--runner …]`
 * (prometheus.py `_local_agent_cmd` / `build_terminal_cmd`), which the CLI's `/models runtimes`
 * points at. This is the same wiring as data, for surfaces that describe it;
 * tests/test_local_runners_engine.py pins that the two agree.
 */
export function agentWiring(
  agent: AgentId,
  serverRoot: string,
  model: string,
  runtime: RuntimeId,
): AgentWiring | { unsupported: string } {
  const spec = AGENTS.find((a) => a.id === agent);
  if (!spec) return { unsupported: `unknown agent ${agent}` };
  if (spec.runtimes !== "any-openai" && !spec.runtimes.includes(runtime)) {
    return { unsupported: `${spec.name} works with ${spec.runtimes.join(", ")} only` };
  }
  const root = serverRoot.replace(/\/+$/, "").replace(/\/v1$/, "");
  const v1 = `${root}/v1`;
  switch (agent) {
    case "opencode":
      return {
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: {
              "prometheus-local": {
                npm: "@ai-sdk/openai-compatible",
                name: "Prometheus local",
                options: { baseURL: v1 },
                models: { [model]: { name: model } },
              },
            },
          }),
        },
        argv: ["opencode", "run", "-m", `prometheus-local/${model}`, "--"],
      };
    case "hermes":
      // Hermes documents no per-run endpoint flags (only `hermes model` / its config file), so
      // there is no env/argv wiring to give: the user configures the endpoint once, and the
      // launcher prints exactly how. Inventing flags made the agent fail to start.
      return {
        unsupported: `Hermes is pointed at ${v1} once with \`hermes model\` → Custom endpoint (no per-run flags exist)`,
      };
    case "aider":
      return {
        env: { OPENAI_API_BASE: v1, OPENAI_API_KEY: "local" },
        argv: ["aider", "--model", `openai/${model}`, "--message"],
      };
    case "goose":
      return {
        env: {
          GOOSE_PROVIDER: "openai",
          OPENAI_HOST: root,
          OPENAI_BASE_PATH: "v1/chat/completions",
          OPENAI_API_KEY: "local",
          GOOSE_MODEL: model,
        },
        // the model rides GOOSE_MODEL (documented); `run -t <prompt>` is the one-shot form
        argv: ["goose", "run", "-t"],
      };
    case "claude-code":
      return {
        env: { ANTHROPIC_BASE_URL: root, ANTHROPIC_AUTH_TOKEN: "ollama", ANTHROPIC_API_KEY: "" },
        // `--`: a prompt that starts with "-" is the prompt, never a flag
        argv: ["claude", "--model", model, "-p", "--"],
      };
    case "codex":
      return { env: {}, argv: ["codex", "exec", "--oss", "-m", model, "--"] };
  }
}

/** A context-window precondition the agent states (Hermes refuses < 64K). */
export function agentContextWarning(
  agent: AgentId,
  servedContext: number | undefined,
): string | undefined {
  const spec = AGENTS.find((a) => a.id === agent);
  if (!spec?.minContext || servedContext === undefined || servedContext >= spec.minContext)
    return undefined;
  return `${spec.name} needs a ${Math.round(spec.minContext / 1000)}K-token context; this server gives ${Math.round(servedContext / 1000)}K.`;
}
