// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog/wizard.ts — the steps of the `/models` picker, as data.
 *
 *   /models            → Local (always free)  |  Cloud
 *   /models cloud      → Free cloud  |  Paid cloud  |  Endless free rotation
 *   /models local      → models for THIS machine, each with its run plan
 *   /models free|paid  → provider models, each with key status
 *   /models spinner    → the endless free spinner (rotation): members and their state
 *   /models use <ref>  → prepare (install / pull / key) and adopt
 *
 * The readline host prints these rows numbered, the TUI opens them as an arrow-key overlay, and
 * the desktop renders them as cards — but all three call these functions, so a model's two lines
 * or a key's status cannot read one way in the terminal and another in the app. Pure.
 */
import { API_PROVIDERS, type ApiProvider } from "../../orchestration/api-providers.js";
import type { KeySource } from "../cloud-endpoints.js";
import { type DefaultServerId, isDefaultServerId } from "../default-server.js";
import { type RotationMember, rotationStatus } from "../free-rotation.js";
import { CLOUD_MODELS } from "./cloud.js";
import { describeDataUse, freeTierFor } from "./free-tier.js";
import { LOCAL_MODELS, findLocalModel } from "./local.js";
import { offloadRuntime as offloadRuntimeById } from "./offload.js";
import {
  type LocalRunPlan,
  type StreamingOption,
  airllmCanLoad,
  colibriSupports,
  diskFits,
  isMoe,
  nativeAlternatives,
  planLocalModel,
} from "./plan.js";
import type { CloudModelEntry, LocalModelEntry, MachineProfile, OffloadRuntime } from "./types.js";

/* ------------------------------------------------------------------------- *
 * Refs — what `/models use <ref>` takes
 * ------------------------------------------------------------------------- */

/**
 * Runtimes a local pick can be served by. The first four are ordinary model servers (and can be
 * the user's default server); the last three stream an over-budget model from disk and are only
 * ever used when the user asks for them by name.
 */
export type ServeRuntime =
  | "ollama"
  | "llamacpp"
  | "lmstudio"
  | "mlx"
  | "llamacpp-stream"
  | "airllm"
  | "colibri";
export const SERVE_RUNTIMES: readonly ServeRuntime[] = [
  "ollama",
  "llamacpp",
  "lmstudio",
  "mlx",
  "llamacpp-stream",
  "airllm",
  "colibri",
];
/** The disk-streaming runtimes ("run it anyway"). */
export type StreamRuntime = Extract<ServeRuntime, "llamacpp-stream" | "airllm" | "colibri">;
export const STREAM_RUNTIMES: readonly StreamRuntime[] = ["llamacpp-stream", "airllm", "colibri"];
export function isStreamRuntime(rt: string | undefined): rt is StreamRuntime {
  return rt !== undefined && (STREAM_RUNTIMES as readonly string[]).includes(rt);
}

/** Human names, for every surface that says which server will run a model. */
export const SERVE_RUNTIME_NAMES: Readonly<Record<ServeRuntime, string>> = {
  ollama: "Ollama",
  llamacpp: "llama.cpp",
  lmstudio: "LM Studio",
  mlx: "MLX-LM",
  "llamacpp-stream": "llama.cpp from SSD",
  airllm: "AirLLM",
  colibri: "colibri",
};

export type WizardRef =
  /** a catalogued local model (by catalogue id), optionally on a non-default runtime. */
  | { section: "local"; id: string; runtime?: ServeRuntime }
  /** a model already served by a running local runner. */
  | { section: "served"; runner: string; model: string }
  | { section: "free" | "paid"; providerId: string; model: string }
  | { section: "rotation" };

export function formatRef(ref: WizardRef): string {
  switch (ref.section) {
    case "local":
      return `local:${ref.id}${ref.runtime ? `@${ref.runtime}` : ""}`;
    case "served":
      return `served:${ref.runner}:${ref.model}`;
    case "rotation":
      return "rotation";
    default:
      return `${ref.section}:${ref.providerId}:${ref.model}`;
  }
}

/** Parse a ref. Model ids may themselves contain `:` (`qwen3:8b`, `qwen/qwen3-coder:free`). */
export function parseRef(raw: string): WizardRef | null {
  const s = raw.trim();
  if (s === "rotation" || s === "rotate") return { section: "rotation" };
  const i = s.indexOf(":");
  if (i < 0) return null;
  const head = s.slice(0, i);
  const rest = s.slice(i + 1);
  if (head === "local") {
    if (!rest) return null;
    // `local:<id>@llamacpp` — catalogue ids are kebab-case and never contain `@`
    const at = rest.lastIndexOf("@");
    const rt = at > 0 ? rest.slice(at + 1) : "";
    if (at > 0 && (SERVE_RUNTIMES as readonly string[]).includes(rt)) {
      return { section: "local", id: rest.slice(0, at), runtime: rt as ServeRuntime };
    }
    return { section: "local", id: rest };
  }
  if (head === "served" || head === "free" || head === "paid") {
    const j = rest.indexOf(":");
    if (j <= 0 || j === rest.length - 1) return null;
    const a = rest.slice(0, j);
    const b = rest.slice(j + 1);
    return head === "served"
      ? { section: "served", runner: a, model: b }
      : { section: head, providerId: a, model: b };
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Steps
 * ------------------------------------------------------------------------- */

export type WizardStepId = "root" | "cloud" | "local" | "free" | "paid" | "rotation";

export type RowBadge =
  | "ready"
  | "installed"
  | "needs-install"
  | "needs-key"
  | "keyless"
  | "needs-offload"
  | "slow"
  | "tight"
  | "too-big";

export interface WizardRow {
  label: string;
  /** one dim line after the label. */
  detail: string;
  /** the two blurb lines, then any notes. */
  lines: readonly string[];
  badge?: RowBadge;
  /** picking it goes to this step… */
  next?: WizardStepId;
  /** …or prepares + adopts this ref. */
  ref?: string;
  /** the active model. */
  current?: boolean;
  /** shown in place of the lines; the row cannot be picked. */
  disabled?: string;
}

export interface WizardStep {
  id: WizardStepId;
  title: string;
  /** lines shown above the rows. */
  intro: readonly string[];
  rows: readonly WizardRow[];
}

export interface WizardContext {
  machine: MachineProfile;
  /** Ollama tags already pulled on this machine. */
  installedOllama?: readonly string[];
  /** models a running local runner is serving right now. */
  served?: readonly { runner: string; model: string }[];
  /** where a provider's key lives, if anywhere. */
  keyFor: (providerId: string) => KeySource | undefined;
  /** the rotation's members on this machine (from `rotationMembers`). */
  rotation?: readonly RotationMember[];
  /** the active endpoint id, to mark the current row. */
  activeId?: string;
  /** include models that will not run here at all (default: hide them, say how many). */
  showAll?: boolean;
}

export function rootStep(): WizardStep {
  return {
    id: "root",
    title: "Choose where your model runs",
    intro: [],
    rows: [
      {
        label: "Local model — always free",
        detail: "runs on this machine · private · works offline",
        lines: [
          "Your code never leaves the machine; no account, no quota.",
          "Speed and size depend on your RAM; Prometheus checks the fit for you.",
        ],
        next: "local",
      },
      {
        label: "Cloud model",
        detail: "free quotas · paid frontier models · endless free rotation",
        lines: [
          "Bigger and faster models on a provider's servers.",
          "Your prompts are sent to that provider; some free tiers log or train on them.",
        ],
        next: "cloud",
      },
    ],
  };
}

export function cloudStep(ctx: WizardContext): WizardStep {
  const members = ctx.rotation ?? [];
  const keyed = members.filter((m) => m.apiKeyRef).length;
  return {
    id: "cloud",
    title: "Choose a kind of cloud model",
    intro: [],
    rows: [
      {
        label: "Free cloud models",
        detail: "Nemotron · Kimi · GLM · Qwen Coder · gpt-oss · Llama · Gemini Flash",
        lines: [
          "Strong open models on free quotas (NVIDIA NIM, Groq, Cerebras, OpenRouter …).",
          "Each provider needs a free key; daily limits apply.",
        ],
        next: "free",
      },
      {
        label: "Paid cloud models",
        detail: "Claude · GPT-5 / Codex · Gemini Pro · DeepSeek · Mistral",
        lines: [
          "Frontier quality for the hardest work, billed per token on your own key.",
          "Prometheus warns before metered spend and enforces your budget.",
        ],
        next: "paid",
      },
      {
        // The user's own name for it: an "endless spinner" over free LLM APIs.
        label: "Endless free spinner — free LLM APIs, auto-rotating",
        detail:
          members.length > 0
            ? `${members.length} free model${members.length === 1 ? "" : "s"} ready (${keyed} with your keys)`
            : "add one or more free keys to start",
        lines: [
          "One model that never runs dry: when a free quota ends, the next provider takes over.",
          "Answers can come from different models turn to turn; prompts go to several providers.",
        ],
        next: "rotation",
      },
    ],
  };
}

/* ---------------------------------- local --------------------------------- */

/**
 * The runtime a local pick is served by when the ref names none, and why — chosen per MODEL.
 *
 * A model with an Ollama build goes to Ollama (or to the user's default server when that server
 * can load the same model). A model WITHOUT one goes to the server that can run it — LM Studio
 * when it is installed, else llama.cpp (a Homebrew formula Prometheus installs), MLX-LM / LM
 * Studio for an MLX-only build on Apple Silicon — and the pick then makes that server the
 * default, so the user never has to know which engine a model needs.
 */
export interface RuntimeChoice {
  runtime?: Exclude<ServeRuntime, StreamRuntime>;
  reason: string;
  /** set when no ordinary server here can load the model. */
  blocked?: string;
}

export function autoRuntime(
  m: LocalModelEntry,
  ctx: Pick<PrepareContext, "machine" | "defaultServer" | "runtimeInstalled" | "runtimeServing">,
  opts: { small?: boolean } = {},
): RuntimeChoice {
  const def = ctx.defaultServer ?? "ollama";
  const inst = ctx.runtimeInstalled ?? {};
  const live = ctx.runtimeServing ?? {};
  const has = (rt: ServeRuntime): boolean => inst[rt] === true || live[rt] === true;
  const apple = ctx.machine.unified;
  // the small quant is a GGUF only llama.cpp / LM Studio load (Ollama's tag is the Q4 build)
  const gguf = opts.small ? m.ggufSmall : m.gguf;
  const ollama = opts.small ? undefined : m.ollama;
  if (ollama) {
    if ((def === "lmstudio" || def === "llamacpp") && gguf)
      return { runtime: def, reason: `${SERVE_RUNTIME_NAMES[def]} is your default server` };
    if (def === "mlx" && m.mlx && apple)
      return { runtime: "mlx", reason: "MLX-LM is your default server" };
    return { runtime: "ollama", reason: "it has an Ollama build" };
  }
  if (gguf) {
    if (def === "lmstudio" || def === "llamacpp")
      return {
        runtime: def,
        reason: `no Ollama build — ${SERVE_RUNTIME_NAMES[def]} is your default server`,
      };
    if (has("lmstudio"))
      return { runtime: "lmstudio", reason: "no Ollama build — LM Studio is installed" };
    if (has("llamacpp"))
      return { runtime: "llamacpp", reason: "no Ollama build — llama.cpp is installed" };
    if (apple && m.mlx && has("mlx") && !opts.small)
      return { runtime: "mlx", reason: "no Ollama build — MLX-LM is installed" };
    return {
      runtime: "llamacpp",
      reason: "no Ollama build — llama.cpp serves the GGUF (installed from Homebrew)",
    };
  }
  if (m.mlx && apple) {
    if (def === "mlx")
      return { runtime: "mlx", reason: "MLX-only build — MLX-LM is your default server" };
    if (has("lmstudio"))
      return { runtime: "lmstudio", reason: "MLX-only build — LM Studio's MLX engine runs it" };
    return {
      runtime: "mlx",
      reason: "MLX-only build — MLX-LM serves it (installed from Homebrew)",
    };
  }
  if (m.mlx) {
    return { reason: "", blocked: `${m.label} has only an MLX build, which needs Apple Silicon` };
  }
  return {
    reason: "",
    blocked: `${m.label} has no GGUF, Ollama or MLX build — only its safetensors, which vLLM serves on a Linux GPU box`,
  };
}

/** What the picker shows for one local model on this machine. Shared by every surface. */
export interface LocalVerdict {
  plan: LocalRunPlan;
  /** the server a plain pick (no `@runtime`) goes to; absent when nothing here can load it. */
  choice?: RuntimeChoice;
  badge: RowBadge;
  /** one line: what happens on this machine. */
  line: string;
  /** why the row cannot be picked (it stays visible). */
  disabled?: string;
  /** "run it anyway": the disk-streaming runtimes that could, best first. */
  insist: readonly StreamingOption[];
}

export function localVerdict(
  m: LocalModelEntry,
  ctx: Pick<PrepareContext, "machine" | "defaultServer" | "runtimeInstalled" | "runtimeServing">,
): LocalVerdict {
  const plan = planLocalModel(m, ctx.machine);
  if (plan.kind === "too-big") {
    return {
      plan,
      badge: "too-big",
      line: `✗ ${plan.headline}`,
      disabled: plan.headline,
      insist: plan.streaming,
    };
  }
  const choice = autoRuntime(m, ctx, plan.quant === "small" ? { small: true } : {});
  if (choice.blocked) {
    // fits, but no ordinary server here loads it: a dense safetensors model can still go
    // through AirLLM (slowly) if the user insists
    const insist = plan.quant === "small" ? [] : streamingOptionsForUnbuilt(m, ctx.machine);
    return {
      plan,
      choice,
      badge: "needs-install",
      line: `– ${choice.blocked}`,
      disabled: choice.blocked,
      insist,
    };
  }
  const rtName = choice.runtime ? SERVE_RUNTIME_NAMES[choice.runtime] : "Ollama";
  const disk = diskFits(
    m,
    ctx.machine,
    choice.runtime,
    plan.quant === "small" ? (m.smallGb ?? m.q4Gb) : m.q4Gb,
  );
  const diskNote = disk === false ? " — NOT enough free disk for the download" : "";
  const line =
    plan.quant === "small"
      ? `↓ ${plan.headline} Runs on ${rtName}${diskNote}.`
      : plan.tier === "fits"
        ? `✓ Runs here on ${rtName} (${choice.reason}), ${m.q4Gb} GB download${diskNote}.`
        : `≈ Tight on ${ctx.machine.ramGb} GB: works at reduced context on ${rtName}; close other apps${diskNote}.`;
  return {
    plan,
    choice,
    badge: plan.quant === "small" || plan.tier === "tight" ? "tight" : "needs-install",
    line,
    insist: [],
  };
}

function streamingOptionsForUnbuilt(
  m: LocalModelEntry,
  machine: MachineProfile,
): StreamingOption[] {
  const moe = isMoe(m);
  if (moe || !m.hfRepo || m.remoteCode || !airllmCanLoad(m, machine)) return [];
  return [
    {
      runtime: offloadRuntimeById("airllm"),
      interactive: false,
      why: "AirLLM loads the safetensors one layer at a time — slow, but no GGUF is needed.",
    },
  ];
}

export function localStep(ctx: WizardContext): WizardStep {
  const installed = new Set((ctx.installedOllama ?? []).map((t) => t.toLowerCase()));
  const rows: WizardRow[] = [];
  // 1. what is already serving — instant, nothing to prepare.
  for (const s of ctx.served ?? []) {
    const known = findLocalModel(s.model);
    const id = `local:${s.runner}:${s.model}`;
    rows.push({
      label: known ? `${known.label} (${s.model})` : s.model,
      detail: `${s.runner} · serving now`,
      lines: known
        ? [known.blurb.strengths, known.blurb.limits]
        : [
            "Already loaded by your local runner — ready instantly.",
            "Not in the Prometheus catalogue: no fit data.",
          ],
      badge: "ready",
      ref: formatRef({ section: "served", runner: s.runner, model: s.model }),
      ...(ctx.activeId === id ? { current: true } : {}),
    });
  }
  const servedTags = new Set((ctx.served ?? []).map((s) => s.model.toLowerCase()));
  // 2. the catalogue, with this machine's verdict on each.
  let hidden = 0;
  for (const m of LOCAL_MODELS) {
    if (
      servedTags.has(localOllamaTag(m).toLowerCase()) ||
      (m.ollama && servedTags.has(m.ollama.toLowerCase()))
    )
      continue;
    const v = localVerdict(m, ctx);
    if (v.plan.kind === "too-big" && !ctx.showAll) {
      hidden += 1;
      continue;
    }
    const isInstalled =
      installed.has(localOllamaTag(m).toLowerCase()) ||
      (m.ollama !== undefined && installed.has(m.ollama.toLowerCase()));
    const size = m.paramsB !== undefined ? `${m.paramsB}B` : "MoE";
    const rt = v.choice?.runtime;
    rows.push({
      label: m.label,
      detail: `${size} · ${m.q4Gb} GB · ${m.tools ? "tools" : "chat only"}${rt ? ` · ${SERVE_RUNTIME_NAMES[rt]}` : ""}${isInstalled ? " · installed" : ""}`,
      lines: [m.blurb.strengths, m.blurb.limits, v.line],
      badge: v.badge === "needs-install" && isInstalled ? "installed" : v.badge,
      ref: formatRef({ section: "local", id: m.id }),
      ...(v.disabled
        ? {
            disabled: v.insist[0]
              ? `${v.disabled} — run it anyway: /models use local:${m.id}@${v.insist[0].runtime.id}`
              : v.disabled,
          }
        : {}),
    });
  }
  const intro = [
    `This machine: ${ctx.machine.ramGb} GB RAM${ctx.machine.unified ? " (unified, Apple Silicon)" : ""}${
      ctx.machine.vramGb > 0 ? ` · ${ctx.machine.vramGb} GB GPU` : ""
    }${ctx.machine.freeDiskGb !== undefined ? ` · ${ctx.machine.freeDiskGb} GB free disk` : ""}.`,
  ];
  if (hidden > 0) {
    intro.push(
      `${hidden} larger model${hidden === 1 ? " is" : "s are"} hidden — too big for this machine's RAM (\`/models local all\` lists them; streaming from disk or the free cloud runs them).`,
    );
  }
  return { id: "local", title: "Local models for this machine", intro, rows };
}

/* ---------------------------------- cloud --------------------------------- */

function providerRow(id: string): ApiProvider | undefined {
  return API_PROVIDERS.find((p) => p.id === id);
}

function cloudRow(e: CloudModelEntry, ctx: WizardContext): WizardRow {
  const p = providerRow(e.providerId);
  const tier = freeTierFor(e.providerId);
  const key = ctx.keyFor(e.providerId);
  const label = p?.label ?? e.providerId;
  const keyless = e.section === "free" && tier?.keyless === true;
  const keyNote = key
    ? `key: ${key === "env" ? "from environment" : "in keychain"} ✓`
    : keyless
      ? "no key needed"
      : e.section === "free"
        ? `needs a free key — ${tier?.signupUrl ?? p?.tosUrl ?? "see provider"}`
        : "needs your API key";
  const notes: string[] = [];
  if (e.section === "free" && tier) {
    notes.push(`Free tier: ${tier.limits} · ${describeDataUse(tier)}.`);
    if (tier.caveat) notes.push(tier.caveat);
  }
  if (p?.dataRegion === "CN") notes.push("Data processed in China (privacy flag).");
  const id = `cloud:${e.providerId}:${e.model}`;
  return {
    label: e.label,
    detail: `${label} · ${keyNote}`,
    lines: [e.blurb.strengths, e.blurb.limits, ...notes],
    badge: key ? "ready" : keyless ? "keyless" : "needs-key",
    ref: formatRef({ section: e.section, providerId: e.providerId, model: e.model }),
    ...(ctx.activeId === id ? { current: true } : {}),
  };
}

export function cloudModelsStep(section: "free" | "paid", ctx: WizardContext): WizardStep {
  const entries = CLOUD_MODELS.filter((m) => m.section === section);
  // Ready-to-use first (a key exists), then keyless, then the rest — inside each, catalogue order.
  const rank = (e: CloudModelEntry): number =>
    ctx.keyFor(e.providerId) ? 0 : freeTierFor(e.providerId)?.keyless ? 1 : 2;
  const rows = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map(({ e }) => cloudRow(e, ctx));
  return {
    id: section,
    title: section === "free" ? "Free cloud models" : "Paid cloud models",
    intro:
      section === "free"
        ? [
            "Free quotas are snapshots (checked 2026-10-12) — providers change them often.",
            "Picking one without a key opens the provider's free sign-up and stores the key in your OS keychain.",
          ]
        : ["Billed per token to your own account. Prometheus's budget guard applies (`/budget`)."],
    rows,
  };
}

/* -------------------------------- rotation -------------------------------- */

export function rotationStep(ctx: WizardContext, now: number = Date.now()): WizardStep {
  const members = ctx.rotation ?? [];
  const status = rotationStatus(members, undefined, now);
  const rows: WizardRow[] = [];
  if (members.length > 0) {
    rows.push({
      label: "Use the endless free spinner",
      detail: `${members.length} member${members.length === 1 ? "" : "s"} · starts with ${members[0]?.label ?? "?"}`,
      lines: [
        "Prompts go to the first free model with quota left; on a rate limit the next one answers.",
        "Members have different strengths, so answer quality can vary between turns.",
      ],
      badge: "ready",
      ref: "rotation",
      ...(ctx.activeId === "cloud:rotation:free" ? { current: true } : {}),
    });
  }
  for (const s of status) {
    const cooling =
      s.coolingForMs !== undefined ? `cooling ${Math.ceil(s.coolingForMs / 60_000)} min` : "ready";
    rows.push({
      label: `  ${s.member.label}`,
      detail: `${s.member.apiKeyRef ? "your key" : "no key"} · ${cooling}${s.serving ? " · serving" : ""}`,
      lines: s.lastReason ? [`Last refusal: ${s.lastReason}.`] : ["In rotation."],
      disabled: "a member of the rotation — pick the rotation itself above",
    });
  }
  // Providers that could join with a free key.
  const joined = new Set(members.map((m) => m.providerId));
  const seen = new Set<string>();
  for (const e of CLOUD_MODELS) {
    if (e.section !== "free" || !e.rotation || joined.has(e.providerId) || seen.has(e.providerId))
      continue;
    const tier = freeTierFor(e.providerId);
    if (!tier || tier.keyless) continue;
    seen.add(e.providerId);
    rows.push({
      label: `+ Add ${providerRow(e.providerId)?.label ?? e.providerId}`,
      detail: `free key · ${tier.limits}`,
      lines: [`Sign up: ${tier.signupUrl}`, describeDataUse(tier)],
      badge: "needs-key",
      ref: formatRef({ section: "free", providerId: e.providerId, model: e.model }),
    });
  }
  return {
    id: "rotation",
    title: "Endless free spinner (rotates across free LLM APIs)",
    intro: [
      members.length === 0
        ? "No free provider is reachable yet. Add a free key below (each takes a minute) — the more you add, the longer the rotation lasts."
        : "Every key you add extends the rotation. One key per provider — never several accounts at one provider.",
      "Privacy: prompts can reach any member. Don't use the rotation for confidential code.",
    ],
    rows,
  };
}

/** Build any step by id. */
export function wizardStep(id: WizardStepId, ctx: WizardContext): WizardStep {
  switch (id) {
    case "root":
      return rootStep();
    case "cloud":
      return cloudStep(ctx);
    case "local":
      return localStep(ctx);
    case "free":
    case "paid":
      return cloudModelsStep(id, ctx);
    case "rotation":
      return rotationStep(ctx);
  }
}

/* ------------------------------------------------------------------------- *
 * Preparing a pick
 * ------------------------------------------------------------------------- */

/** Where admitted weights are placed: a runtime's own folder (see `fetch-gguf`). */
export type ModelPlace = "hf" | "lmstudio" | "ollama";

export type PrepareAction =
  /** Ollama is not installed — install it (gated, via the existing runner installer). */
  | { kind: "install-runner"; runner: "ollama" }
  /** Ollama is installed but not serving — start it. */
  | { kind: "start-runner"; runner: "ollama" }
  /**
   * The model does not fit this machine and the user asked to run it anyway. The session asks
   * them to TYPE the model's name before anything is installed or downloaded.
   */
  | {
      kind: "confirm-insist";
      id: string;
      label: string;
      runtime: StreamRuntime;
      runtimeName: string;
      speed: string;
      needGb: number;
      ramGb: number;
      interactive: boolean;
    }
  /** colibri: a native engine from a GitHub checkout — its steps are shown, never run. */
  | {
      kind: "install-offload";
      model: LocalModelEntry;
      runtime: OffloadRuntime;
    }
  /** download the weights. */
  | { kind: "pull"; tag: string; sizeGb: number }
  /**
   * download a GGUF from Hugging Face into the stage dir, verify it against Hugging Face's own
   * sha256 and scan it with nemesis before it enters the model library (modelhub stage-hf).
   */
  | {
      kind: "fetch-gguf";
      id: string;
      repo: string;
      file: string;
      sizeGb: number;
      quant?: string;
      /**
       * Where the admitted file ends up — the serving software's OWN folder, never a
       * Prometheus one: `hf` (the Hugging Face cache, read in place by llama.cpp / colibri),
       * `lmstudio` (LM Studio's models folder), `ollama` (a transit copy `ollama create` takes
       * into Ollama's store, deleted afterwards).
       */
      place: ModelPlace;
    }
  /**
   * download a safetensors / MLX snapshot (weights + config + tokenizer only — never code or
   * pickles) the same gated way: Hugging Face sha256, then nemesis, then the library.
   */
  | {
      kind: "fetch-snapshot";
      id: string;
      repo: string;
      include: readonly string[];
      sizeGb?: number;
      purpose: "mlx" | "airllm";
      place: ModelPlace;
    }
  /** serve the admitted GGUF through Ollama (`ollama create` from the gated file). */
  | { kind: "import-ollama"; id: string; tag: string }
  /**
   * install a runtime through its official package channel — AirLLM through gated pip into
   * Prometheus's own venv, colibri from its pinned source (scanned, built here).
   */
  | { kind: "install-runtime"; runtime: "llamacpp" | "lmstudio" | "mlx" | "airllm" | "colibri" }
  /**
   * start llama-server on the ADMITTED file (never `-hf`), offline, alias = catalogue id.
   * `stream` = the model is larger than RAM: no `--mlock`, experts on the CPU, a short window.
   */
  | { kind: "serve-gguf"; runtime: "llamacpp"; id: string; ctx: number; stream?: boolean }
  /** start MLX-LM's server on the admitted MLX directory, offline. */
  | { kind: "serve-mlx"; id: string }
  /** start Prometheus's AirLLM server on the admitted safetensors directory, offline. */
  | { kind: "serve-stream"; runtime: "airllm"; id: string }
  /** `coli import` the admitted GGUF (link mode, no copy), then `coli serve` it on loopback. */
  | { kind: "serve-colibri"; id: string; ctx: number }
  /** link the admitted GGUF (every shard) or MLX directory into LM Studio's models folder. */
  | { kind: "link-lmstudio"; id: string; format?: "gguf" | "mlx" }
  /** start LM Studio's local server. */
  | { kind: "start-runtime"; runtime: "lmstudio" }
  /** a provider key is needed. */
  | { kind: "set-key"; providerId: string; signupUrl?: string; envVars: readonly string[] }
  /** hand the endpoint to the session. */
  | { kind: "adopt" };

export interface PreparePlan {
  ref: WizardRef;
  actions: PrepareAction[];
  /** shown before anything runs. */
  warnings: string[];
  /** the pick cannot work here; `alternatives` lists what can. */
  blocked?: string;
  alternatives?: LocalModelEntry[];
  /** for a local pick: the tag / alias the runner will serve it under (to find its endpoint). */
  localTag?: string;
  /** for a local pick: the server that will run it, and why that one. */
  runtime?: ServeRuntime;
  runtimeReason?: string;
  /**
   * The pick needs a different server than the user's default: once it is adopted, the
   * default becomes this one (`localModels.defaultServer`), so the next pick, the next launch
   * and the desktop app all use the engine this model needs.
   */
  switchDefault?: { from: DefaultServerId; to: DefaultServerId };
  /**
   * A blocked local pick that can still run by streaming from disk: the refs that do it, best
   * first. Offered as "run it anyway", never taken without the user asking.
   */
  insist?: readonly {
    ref: string;
    runtime: StreamRuntime;
    name: string;
    speed: string;
    interactive: boolean;
  }[];
}

export interface PrepareContext extends WizardContext {
  ollamaInstalled: boolean;
  ollamaServing: boolean;
  /** runtimes installed here (absent = unknown → treated as not installed). */
  runtimeInstalled?: Partial<Record<ServeRuntime, boolean>>;
  runtimeServing?: Partial<Record<ServeRuntime, boolean>>;
  /** the user's default local server (`/server`, settings `localModels.defaultServer`). */
  defaultServer?: string;
}

const gb = (bytes: number | undefined, fallback: number): number =>
  bytes ? Math.round((bytes / 1024 ** 3) * 10) / 10 : fallback;

function insistRefs(m: LocalModelEntry, opts: readonly StreamingOption[]): PreparePlan["insist"] {
  return opts.map((o) => ({
    ref: formatRef({ section: "local", id: m.id, runtime: o.runtime.id }),
    runtime: o.runtime.id,
    name: o.runtime.name,
    speed: o.runtime.speed,
    interactive: o.interactive,
  }));
}

export function preparePlan(ref: WizardRef, ctx: PrepareContext): PreparePlan {
  const actions: PrepareAction[] = [];
  const warnings: string[] = [];
  if (ref.section === "served") return { ref, actions: [{ kind: "adopt" }], warnings };
  if (ref.section === "rotation") {
    if ((ctx.rotation ?? []).length === 0) {
      return {
        ref,
        actions: [],
        warnings,
        blocked: "No free provider is reachable yet — add a free key first (`/models rotation`).",
      };
    }
    warnings.push(
      "Prompts may be sent to any rotation member; some free tiers log or train on them.",
    );
    return { ref, actions: [{ kind: "adopt" }], warnings };
  }
  if (ref.section === "free" || ref.section === "paid") {
    const p = providerRow(ref.providerId);
    if (!p) return { ref, actions: [], warnings, blocked: `unknown provider "${ref.providerId}"` };
    const tier = freeTierFor(ref.providerId);
    if (!ctx.keyFor(ref.providerId) && !(ref.section === "free" && tier?.keyless)) {
      actions.push({
        kind: "set-key",
        providerId: p.id,
        ...(tier?.signupUrl ? { signupUrl: tier.signupUrl } : {}),
        envVars: p.apiKeyEnv,
      });
    }
    if (ref.section === "free" && tier) {
      if (tier.dataUse === "may-train" || tier.dataUse === "logged") {
        warnings.push(`${p.label}: ${describeDataUse(tier)}.`);
      }
      if (tier.caveat) warnings.push(tier.caveat);
    }
    if (p.dataRegion === "CN") warnings.push(`${p.label}: data processed in China.`);
    actions.push({ kind: "adopt" });
    return { ref, actions, warnings };
  }
  if (ref.section !== "local") return { ref, actions: [], warnings, blocked: "unsupported pick" };
  const m = findLocalModel(ref.id);
  if (!m)
    return { ref, actions: [], warnings, blocked: `"${ref.id}" is not in the local catalogue` };
  const plan = planLocalModel(m, ctx.machine);
  const alternatives = (): LocalModelEntry[] => nativeAlternatives(ctx.machine, { wanted: m });

  // ── "run it anyway": the user named a disk-streaming runtime ──
  if (isStreamRuntime(ref.runtime)) return streamPlan(ref, ref.runtime, m, plan, ctx);

  // ── does not fit RAM: refused, with the streaming runtimes that could run it anyway ──
  if (plan.kind === "too-big") {
    const insist = insistRefs(m, plan.streaming);
    const hint = insist?.[0]
      ? ` It can only run by streaming from disk (${insist[0].name}: ${insist[0].speed}) — /models use ${insist[0].ref} if you insist.`
      : " No disk-streaming runtime can run it here either — pick a smaller model or a cloud one.";
    return {
      ref,
      actions: [],
      warnings,
      blocked: `${plan.headline}${hint}`,
      alternatives: alternatives(),
      ...(insist?.length ? { insist } : {}),
    };
  }
  const small = plan.quant === "small";
  const choice: RuntimeChoice = ref.runtime
    ? { runtime: ref.runtime as RuntimeChoice["runtime"], reason: "you chose it" }
    : autoRuntime(m, ctx, small ? { small: true } : {});
  if (choice.blocked || !choice.runtime) {
    const insist = small ? [] : insistRefs(m, streamingOptionsForUnbuilt(m, ctx.machine));
    return {
      ref,
      actions: [],
      warnings,
      blocked: `${choice.blocked ?? `${m.label} has no build this machine can serve`}${
        insist?.[0]
          ? ` — or run it slowly through ${insist[0].name}: /models use ${insist[0].ref}`
          : ""
      }`,
      alternatives: alternatives(),
      ...(insist?.length ? { insist } : {}),
    };
  }
  const rt = choice.runtime;
  // Only the SMALL quant fits here, and only llama.cpp / LM Studio load that GGUF. An explicit
  // `@ollama` / `@mlx` used to slip past the RAM refusal: it pulled the Q4 tag or the 4-bit MLX
  // build — the size that does NOT fit (a ~90 GB download for glm-4.6 on a 64 GB machine).
  if (small && rt !== "llamacpp" && rt !== "lmstudio") {
    return {
      ref,
      actions: [],
      warnings,
      blocked: `only the ${m.ggufSmall?.quant ?? "smaller"} GGUF of ${m.label} fits this machine, and ${
        SERVE_RUNTIME_NAMES[rt as keyof typeof SERVE_RUNTIME_NAMES] ?? rt
      } cannot load it — use llama.cpp: /models use local:${m.id}@llamacpp`,
      alternatives: alternatives(),
    };
  }
  if (plan.tier === "tight") warnings.push(plan.headline);
  if (small) warnings.push(plan.headline);
  if (!m.tools)
    warnings.push(
      `${m.label} has no native tool calling: chat works, agent tools drive it through text.`,
    );
  if (m.gate?.status === "caution")
    for (const n of m.gate.notes) warnings.push(`${m.label}: ${n}.`);
  const def = isDefaultServerId(ctx.defaultServer) ? ctx.defaultServer : "ollama";
  const common = {
    runtime: rt as ServeRuntime,
    runtimeReason: choice.reason,
    ...(rt !== def && isDefaultServerId(rt) ? { switchDefault: { from: def, to: rt } } : {}),
  };
  const done = (p: PreparePlan): PreparePlan => (p.blocked ? p : { ...p, ...common });
  if (rt === "mlx") return done(mlxPlan(ref, m, ctx, actions, warnings));
  if (rt === "lmstudio" && !m.gguf && !small && m.mlx)
    return done(mlxPlan(ref, m, ctx, actions, warnings, "lmstudio"));
  if (rt === "llamacpp" || rt === "lmstudio")
    return done(runtimePlan(ref, m, rt, ctx, actions, warnings, small));
  return done(ollamaPlan(ref, m, ctx, actions, warnings));
}

/** A pick served by Ollama: its registry tag, or the gated GGUF imported into it. */
function ollamaPlan(
  ref: Extract<WizardRef, { section: "local" }>,
  m: LocalModelEntry,
  ctx: PrepareContext,
  actions: PrepareAction[],
  warnings: string[],
): PreparePlan {
  if (!m.ollama && !m.gguf) {
    return {
      ref,
      actions: [],
      warnings,
      blocked: `${m.label} has no Ollama build and no GGUF to import into Ollama`,
      alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    };
  }
  // A split GGUF (several shard files) cannot be imported into Ollama from one FROM line.
  if (!m.ollama && (m.gguf?.shards ?? 1) > 1) {
    return {
      ref,
      actions: [],
      warnings,
      blocked: `${m.label} is a split GGUF (${m.gguf?.shards} files), which Ollama cannot import — serve it with llama.cpp: /models use local:${m.id}@llamacpp`,
      alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    };
  }
  const tag = localOllamaTag(m);
  const installed = (ctx.installedOllama ?? []).some((t) => sameTag(t, tag));
  // An installed model needs no download: it used to be refused for "not enough free disk"
  // because this check ran before the installed check.
  if (!installed && diskFits(m, ctx.machine, "ollama") === false) {
    return {
      ref,
      actions: [],
      warnings,
      blocked: `not enough free disk where Ollama keeps models: ${m.label} needs about ${Math.ceil(m.q4Gb * 1.1)} GB`,
      alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    };
  }
  if (!ctx.ollamaInstalled) actions.push({ kind: "install-runner", runner: "ollama" });
  else if (!ctx.ollamaServing) actions.push({ kind: "start-runner", runner: "ollama" });
  if (!installed) {
    if (m.ollama) {
      actions.push({ kind: "pull", tag: m.ollama, sizeGb: m.q4Gb });
    } else if (m.gguf) {
      // no Ollama-registry build: the GGUF comes through the gated Hugging Face path and is
      // imported into Ollama from the admitted file — never `ollama pull hf.co/…`
      actions.push({
        kind: "fetch-gguf",
        id: m.id,
        place: "ollama",
        repo: m.gguf.repo,
        file: m.gguf.file,
        sizeGb: gb(m.gguf.bytes, m.q4Gb),
        ...(m.gguf.quant ? { quant: m.gguf.quant } : {}),
      });
      actions.push({ kind: "import-ollama", id: m.id, tag });
      warnings.push(
        "The scanned GGUF is moved straight into Ollama's own store and the model is created from it — no second copy, not even while importing.",
      );
    }
  }
  actions.push({ kind: "adopt" });
  return { ref, actions, warnings, localTag: tag };
}

/**
 * A local pick on llama.cpp or LM Studio. Both serve the SAME gated file: the GGUF is downloaded,
 * sha256-verified against Hugging Face and admitted by nemesis first (fetch-gguf); llama.cpp then
 * serves that file offline, LM Studio gets a link to it (every shard of a split GGUF). Neither
 * runtime ever downloads by itself.
 */
function runtimePlan(
  ref: Extract<WizardRef, { section: "local" }>,
  m: LocalModelEntry,
  rt: "llamacpp" | "lmstudio",
  ctx: PrepareContext,
  actions: PrepareAction[],
  warnings: string[],
  small = false,
): PreparePlan {
  const g = small ? m.ggufSmall : m.gguf;
  if (!g) {
    return {
      ref,
      actions: [],
      warnings,
      blocked: `${m.label} has no GGUF build, which ${SERVE_RUNTIME_NAMES[rt]} needs`,
      alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    };
  }
  const sizeGb = gb(g.bytes, small ? (m.smallGb ?? m.q4Gb) : m.q4Gb);
  // the exact size, not the one-decimal display figure: rounding a 55 MB file up to 0.1 GB
  // refused it on a disk with 75 MB free
  const exactGb = g.bytes ? g.bytes / 1024 ** 3 : sizeGb;
  if (ctx.machine.freeDiskGb !== undefined && ctx.machine.freeDiskGb < exactGb * 1.1) {
    return {
      ref,
      actions: [],
      warnings,
      blocked: `not enough free disk: ${m.label} needs about ${Math.ceil(exactGb * 1.1)} GB`,
      alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    };
  }
  if (!ctx.runtimeInstalled?.[rt] && !ctx.runtimeServing?.[rt])
    actions.push({ kind: "install-runtime", runtime: rt });
  actions.push({
    kind: "fetch-gguf",
    id: m.id,
    place: rt === "lmstudio" ? "lmstudio" : "hf",
    repo: g.repo,
    file: g.file,
    sizeGb,
    ...(g.quant ? { quant: g.quant } : {}),
  });
  if (rt === "llamacpp") {
    // a short default window keeps the KV cache small; the agent can ask for more later
    actions.push({
      kind: "serve-gguf",
      runtime: "llamacpp",
      id: m.id,
      ctx: Math.min(m.context, 32_768),
    });
  } else {
    actions.push({ kind: "link-lmstudio", id: m.id, format: "gguf" });
    // always: it starts the server only when needed, and it is what resolves the key LM Studio
    // lists for the linked file — skipping it left the adopt step with no model name
    actions.push({ kind: "start-runtime", runtime: "lmstudio" });
  }
  if (ctx.ollamaServing) {
    warnings.push(
      "Ollama is running too: only one model server should hold a model at a time — unload Ollama's model if memory is tight.",
    );
  }
  actions.push({ kind: "adopt" });
  return { ref, actions, warnings, localTag: m.id };
}

/** An MLX build on Apple Silicon: the gated snapshot, served by MLX-LM or linked into LM Studio. */
function mlxPlan(
  ref: Extract<WizardRef, { section: "local" }>,
  m: LocalModelEntry,
  ctx: PrepareContext,
  actions: PrepareAction[],
  warnings: string[],
  via: "mlx" | "lmstudio" = "mlx",
): PreparePlan {
  if (!m.mlx || !ctx.machine.unified) {
    return {
      ref,
      actions: [],
      warnings,
      blocked: !m.mlx
        ? `${m.label} has no MLX build, which MLX-LM needs`
        : "MLX runs only on Apple Silicon",
      alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    };
  }
  if (m.remoteCode) {
    return {
      ref,
      actions: [],
      warnings,
      blocked: `${m.label} needs custom model code (trust_remote_code), which Prometheus never runs`,
      alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    };
  }
  if (ctx.machine.freeDiskGb !== undefined && ctx.machine.freeDiskGb < m.q4Gb * 1.1) {
    return {
      ref,
      actions: [],
      warnings,
      blocked: `not enough free disk: ${m.label} needs about ${Math.ceil(m.q4Gb * 1.1)} GB`,
      alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    };
  }
  if (!ctx.runtimeInstalled?.[via] && !ctx.runtimeServing?.[via])
    actions.push({ kind: "install-runtime", runtime: via });
  actions.push({
    kind: "fetch-snapshot",
    id: m.id,
    place: via === "lmstudio" ? "lmstudio" : "hf",
    repo: m.mlx,
    include: SNAPSHOT_INCLUDES,
    sizeGb: m.q4Gb,
    purpose: "mlx",
  });
  if (via === "mlx") actions.push({ kind: "serve-mlx", id: m.id });
  else {
    actions.push({ kind: "link-lmstudio", id: m.id, format: "mlx" });
    actions.push({ kind: "start-runtime", runtime: "lmstudio" });
  }
  actions.push({ kind: "adopt" });
  return { ref, actions, warnings, localTag: m.id };
}

/** Weights, config and tokenizer only: never code, never pickles (the sidecar re-checks). */
export const SNAPSHOT_INCLUDES: readonly string[] = [
  "*.safetensors",
  "*.json",
  "tokenizer*",
  "*.model",
  "*.tiktoken",
  "*.txt",
  "*.jinja",
];

/** "Run it anyway" on a disk-streaming runtime the user named. */
function streamPlan(
  ref: Extract<WizardRef, { section: "local" }>,
  rt: StreamRuntime,
  m: LocalModelEntry,
  plan: LocalRunPlan,
  ctx: PrepareContext,
): PreparePlan {
  const actions: PrepareAction[] = [];
  const warnings: string[] = [];
  const runtime = offloadRuntimeById(rt);
  const tooBig = plan.kind === "too-big";
  const offered =
    plan.kind === "too-big"
      ? plan.streaming
      : rt === "airllm"
        ? streamingOptionsForUnbuilt(m, ctx.machine)
        : [];
  const option = offered.find((o) => o.runtime.id === rt);
  const no = (why: string): PreparePlan => ({
    ref,
    actions: [],
    warnings,
    blocked: why,
    alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    ...(tooBig && plan.kind === "too-big" ? { insist: insistRefs(m, plan.streaming) } : {}),
  });
  if (rt === "colibri" && !colibriSupports(m))
    return no(
      `colibri cannot load ${m.label} (it reads Qwen3/3.5/3.6/3.8 MoE, DeepSeek V4, GLM-5, Kimi K3, MiMo-V2 GGUFs)`,
    );
  if (rt === "llamacpp-stream" && !m.gguf)
    return no(`${m.label} has no GGUF for llama.cpp to stream`);
  if (rt === "airllm") {
    if (isMoe(m))
      return no(`AirLLM streams dense models only; ${m.label} is a Mixture-of-Experts model`);
    if (!airllmCanLoad(m, ctx.machine))
      return no(
        ctx.machine.unified
          ? `AirLLM on Apple Silicon runs only Llama- and Mistral-architecture models; ${m.label} is neither`
          : "AirLLM needs an NVIDIA GPU on this platform",
      );
    if (!m.hfRepo) return no(`${m.label} has no Hugging Face repo for AirLLM to load`);
    if (m.remoteCode)
      return no(
        `${m.label} needs custom model code (trust_remote_code), which Prometheus never runs`,
      );
  }
  if (rt !== "airllm" && !tooBig) {
    // it fits: streaming it would only make it slower
    return no(`${m.label} fits this machine — pick it normally: /models use local:${m.id}`);
  }
  // the weights live on disk in full: the room is for the file, not the RAM
  const diskGb = rt === "airllm" ? airllmDiskGb(m) : m.q4Gb * 1.1;
  if (ctx.machine.freeDiskGb !== undefined && ctx.machine.freeDiskGb < diskGb) {
    return no(`not enough free disk to stream ${m.label}: about ${Math.ceil(diskGb)} GB needed`);
  }
  warnings.push(`${runtime.name}: ${runtime.speed}`);
  if (!(option?.interactive ?? runtime.interactive))
    warnings.push(
      `${m.label} through ${runtime.name} is too slow for interactive agent turns — use it for offline jobs.`,
    );
  if (m.gate?.status === "caution")
    for (const n of m.gate.notes) warnings.push(`${m.label}: ${n}.`);
  if (tooBig) {
    actions.push({
      kind: "confirm-insist",
      id: m.id,
      label: m.label,
      runtime: rt,
      runtimeName: runtime.name,
      speed: runtime.speed,
      needGb: m.minRamGb,
      ramGb: ctx.machine.ramGb,
      interactive: option?.interactive ?? false,
    });
  }
  if (rt === "colibri" && m.gguf) {
    if (!ctx.runtimeInstalled?.colibri)
      actions.push({ kind: "install-runtime", runtime: "colibri" });
    actions.push({
      kind: "fetch-gguf",
      id: m.id,
      place: "hf",
      repo: m.gguf.repo,
      file: m.gguf.file,
      sizeGb: gb(m.gguf.bytes, m.q4Gb),
      ...(m.gguf.quant ? { quant: m.gguf.quant } : {}),
    });
    actions.push({ kind: "serve-colibri", id: m.id, ctx: 8192 });
    actions.push({ kind: "adopt" });
    return {
      ref,
      actions,
      warnings,
      localTag: m.id,
      runtime: rt,
      runtimeReason: "you asked to stream it from disk",
    };
  }
  if (rt === "llamacpp-stream" && m.gguf) {
    if (!ctx.runtimeInstalled?.llamacpp && !ctx.runtimeServing?.llamacpp)
      actions.push({ kind: "install-runtime", runtime: "llamacpp" });
    actions.push({
      kind: "fetch-gguf",
      id: m.id,
      place: "hf",
      repo: m.gguf.repo,
      file: m.gguf.file,
      sizeGb: gb(m.gguf.bytes, m.q4Gb),
      ...(m.gguf.quant ? { quant: m.gguf.quant } : {}),
    });
    actions.push({ kind: "serve-gguf", runtime: "llamacpp", id: m.id, ctx: 8192, stream: true });
    actions.push({ kind: "adopt" });
    return {
      ref,
      actions,
      warnings,
      localTag: m.id,
      runtime: rt,
      runtimeReason: "you asked to stream it from disk",
    };
  }
  // AirLLM
  if (!ctx.runtimeInstalled?.airllm) actions.push({ kind: "install-runtime", runtime: "airllm" });
  actions.push({
    kind: "fetch-snapshot",
    id: m.id,
    place: "hf",
    repo: m.hfRepo as string,
    include: SNAPSHOT_INCLUDES,
    sizeGb: airllmDiskGb(m) / 2,
    purpose: "airllm",
  });
  actions.push({ kind: "serve-stream", runtime: "airllm", id: m.id });
  actions.push({ kind: "adopt" });
  warnings.push(
    "AirLLM splits the model into one file per layer beside the download: about twice the model's size on disk.",
  );
  return {
    ref,
    actions,
    warnings,
    localTag: m.id,
    runtime: rt,
    runtimeReason: "you asked to stream it from disk",
  };
}

/** Disk for AirLLM: the bf16 safetensors (2 bytes/param) plus its per-layer split copy. */
function airllmDiskGb(m: LocalModelEntry): number {
  const weights = m.paramsB !== undefined ? m.paramsB * 2 : m.q4Gb * 4;
  return Math.ceil(weights * 2.1);
}

/**
 * The Ollama tag a catalogue model is served under: its registry tag, or — for a model
 * imported from a gated GGUF — `prometheus/<id>:latest`. Deterministic, so a remembered pick
 * resolves to the same tag in the next session. Mirrors modelhub `import-ollama`'s naming.
 */
export function localOllamaTag(m: Pick<LocalModelEntry, "id" | "ollama" | "gguf">): string {
  if (m.ollama) return m.ollama;
  const safe =
    m.id
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "model";
  return `prometheus/${safe}:latest`;
}

function sameTag(a: string, b: string): boolean {
  const norm = (t: string) => (t.includes(":") ? t : `${t}:latest`).toLowerCase();
  return norm(a) === norm(b);
}
