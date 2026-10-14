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
import { type RotationMember, rotationStatus } from "../free-rotation.js";
import { CLOUD_MODELS } from "./cloud.js";
import { describeDataUse, freeTierFor } from "./free-tier.js";
import { LOCAL_MODELS, findLocalModel } from "./local.js";
import { type LocalRunPlan, diskFits, nativeAlternatives, planLocalModel } from "./plan.js";
import type { CloudModelEntry, LocalModelEntry, MachineProfile } from "./types.js";

/* ------------------------------------------------------------------------- *
 * Refs — what `/models use <ref>` takes
 * ------------------------------------------------------------------------- */

export type WizardRef =
  /** a catalogued local model (by catalogue id). */
  | { section: "local"; id: string }
  /** a model already served by a running local runner. */
  | { section: "served"; runner: string; model: string }
  | { section: "free" | "paid"; providerId: string; model: string }
  | { section: "rotation" };

export function formatRef(ref: WizardRef): string {
  switch (ref.section) {
    case "local":
      return `local:${ref.id}`;
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
  if (head === "local") return rest ? { section: "local", id: rest } : null;
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

function planBadge(plan: LocalRunPlan, installed: boolean): RowBadge {
  if (plan.kind === "native") return installed ? "installed" : "needs-install";
  if (plan.kind === "offload") return plan.interactive ? "needs-offload" : "slow";
  return "too-big";
}

function planLine(m: LocalModelEntry, plan: LocalRunPlan, machine: MachineProfile): string {
  if (plan.kind === "native") {
    const disk = diskFits(m, machine);
    const diskNote = disk === false ? " — NOT enough free disk for the download" : "";
    return plan.tier === "fits"
      ? `✓ Runs natively here (Ollama), ${m.q4Gb} GB download${diskNote}.`
      : `≈ Tight on ${machine.ramGb} GB: works at reduced context; close other apps${diskNote}.`;
  }
  if (plan.kind === "offload") {
    return plan.interactive
      ? `⚠ Needs ${plan.runtime.name} first (streams from disk; slower than Ollama).`
      : `⚠ Only via ${plan.runtime.name}: ${plan.runtime.speed}`;
  }
  return `✗ ${plan.headline}`;
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
    if (m.ollama && servedTags.has(m.ollama.toLowerCase())) continue;
    const plan = planLocalModel(m, ctx.machine);
    if (plan.kind === "too-big" && !ctx.showAll) {
      hidden += 1;
      continue;
    }
    const isInstalled = m.ollama !== undefined && installed.has(m.ollama.toLowerCase());
    const size = m.paramsB !== undefined ? `${m.paramsB}B` : "MoE";
    rows.push({
      label: m.label,
      detail: `${size} · ${m.q4Gb} GB · ${m.tools ? "tools" : "chat only"}${isInstalled ? " · installed" : ""}`,
      lines: [m.blurb.strengths, m.blurb.limits, planLine(m, plan, ctx.machine)],
      badge: planBadge(plan, isInstalled),
      ref: formatRef({ section: "local", id: m.id }),
      ...(plan.kind === "too-big" ? { disabled: plan.headline } : {}),
    });
  }
  const intro = [
    `This machine: ${ctx.machine.ramGb} GB RAM${ctx.machine.unified ? " (unified, Apple Silicon)" : ""}${
      ctx.machine.vramGb > 0 ? ` · ${ctx.machine.vramGb} GB GPU` : ""
    }${ctx.machine.freeDiskGb !== undefined ? ` · ${ctx.machine.freeDiskGb} GB free disk` : ""}.`,
  ];
  if (hidden > 0) {
    intro.push(
      `${hidden} larger model${hidden === 1 ? " is" : "s are"} hidden — too big for this machine even with offloading (\`/models local all\` lists them; the free cloud runs them).`,
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

export type PrepareAction =
  /** Ollama is not installed — install it (gated, via the existing runner installer). */
  | { kind: "install-runner"; runner: "ollama" }
  /** Ollama is installed but not serving — start it. */
  | { kind: "start-runner"; runner: "ollama" }
  /** an offload runtime must be installed and serving first. */
  | {
      kind: "install-offload";
      model: LocalModelEntry;
      plan: Extract<LocalRunPlan, { kind: "offload" }>;
    }
  /** download the weights. */
  | { kind: "pull"; tag: string; sizeGb: number }
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
  /** for a local pick: the Ollama tag the runner will serve it under (to find its endpoint). */
  localTag?: string;
}

export interface PrepareContext extends WizardContext {
  ollamaInstalled: boolean;
  ollamaServing: boolean;
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
  if (plan.kind === "too-big") {
    return {
      ref,
      actions: [],
      warnings,
      blocked: plan.headline,
      alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    };
  }
  if (plan.kind === "offload") {
    actions.push({ kind: "install-offload", model: m, plan });
    if (!plan.interactive) {
      warnings.push(
        `${m.label} through ${plan.runtime.name} is far too slow for an agent session (${plan.runtime.speed}).`,
      );
    }
    return { ref, actions, warnings, alternatives: nativeAlternatives(ctx.machine, { wanted: m }) };
  }
  if (!m.ollama) return { ref, actions: [], warnings, blocked: `${m.label} has no Ollama build` };
  if (diskFits(m, ctx.machine) === false) {
    return {
      ref,
      actions: [],
      warnings,
      blocked: `not enough free disk: ${m.label} needs about ${Math.ceil(m.q4Gb * 1.1)} GB`,
      alternatives: nativeAlternatives(ctx.machine, { wanted: m }),
    };
  }
  if (plan.tier === "tight") warnings.push(plan.headline);
  if (!m.tools)
    warnings.push(`${m.label} has no native tool calling: chat works, agent tools may not.`);
  if (!ctx.ollamaInstalled) actions.push({ kind: "install-runner", runner: "ollama" });
  else if (!ctx.ollamaServing) actions.push({ kind: "start-runner", runner: "ollama" });
  const installed = (ctx.installedOllama ?? []).some(
    (t) => t.toLowerCase() === m.ollama?.toLowerCase(),
  );
  if (!installed) actions.push({ kind: "pull", tag: m.ollama, sizeGb: m.q4Gb });
  actions.push({ kind: "adopt" });
  return { ref, actions, warnings, localTag: m.ollama };
}
