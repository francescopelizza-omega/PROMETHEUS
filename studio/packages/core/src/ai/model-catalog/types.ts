// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog/types.ts — the shapes behind the `/models` guided picker.
 *
 * The picker asks two questions before it shows a single model — where should it run (this
 * machine, or a provider's servers) and, for the cloud, on what terms (free quota, paid per
 * token, or an endless rotation across free quotas). Every row it then shows carries two short
 * lines: what the model is good at, and what will bite you. These types are that contract,
 * shared by the CLI, the TUI and the desktop app so the three cannot drift into three catalogues.
 */

/** The four sections the picker offers. */
export type ModelSection = "local" | "free" | "paid" | "rotation";

/** The two lines every model row shows. Kept short: a picker row, not a review. */
export interface ModelBlurb {
  /** what it is good at — one line. */
  strengths: string;
  /** what will bite you — one line (quota, speed, licence, data use). */
  limits: string;
}

/** A model served by a cloud provider, as the picker lists it. */
export interface CloudModelEntry {
  section: "free" | "paid";
  /** an `API_PROVIDERS` id. */
  providerId: string;
  /** the model id sent on the wire. */
  model: string;
  /** a human name for the row. */
  label: string;
  blurb: ModelBlurb;
  /** native tool calling — the agent loop needs it for anything beyond chat. */
  tools: boolean;
  /** the documented window when it differs from the provider row's. */
  contextWindow?: number;
  /** eligible to be a member of the endless free rotation. */
  rotation?: boolean;
}

/** A model that runs on this machine, as the picker lists it. */
export interface LocalModelEntry {
  /** `config/open-models.json` id — the same key the sidecar's `model.search` uses. */
  id: string;
  label: string;
  /** the `ollama pull` tag; absent when only colibri can run it on ordinary hardware. */
  ollama?: string;
  /** Hugging Face repo, for runtimes that load safetensors (AirLLM) or LM Studio. */
  hfRepo?: string;
  /** colibri's model id, when colibri ships a build of this model. */
  colibri?: string;
  /** the RAM colibri needs for it (GiB), from colibri's own model table. */
  colibriMinRamGb?: number;
  blurb: ModelBlurb;
  /** total params (B), when published. */
  paramsB?: number;
  /** active params (B) — set only for Mixture-of-Experts models whose figure is published. */
  activeB?: number;
  /** Q4_K_M weights on disk (GiB) — `resource.q4_gb`. */
  q4Gb: number;
  /** RAM it wants at short context (GiB) — `resource.min_ram_gb`. */
  minRamGb: number;
  /** the catalogue says it overflows even a 128 GB box at Q4. */
  needsOffload?: boolean;
  /** native context window (tokens). */
  context: number;
  tools: boolean;
  /**
   * The `open-models.json` row whose figures this entry shares, when it has no row of its own —
   * a fine-tune of a catalogued base (Hermes 3 8B is Llama 3.1 8B underneath). The drift test
   * checks the numbers against THAT row.
   */
  figuresFrom?: string;
  /** SPDX-ish licence id. */
  license: string;
  /** coding / reasoning / vision / nvidia / tiny … — used for grouping and filters. */
  tags: readonly string[];
}

/** What the free tier of a provider looks like — a dated snapshot, never a promise. */
export type DataUse =
  /** the provider states free-tier traffic is not used for training. */
  | "no-training"
  /** free-tier prompts may be used to train or improve models. */
  | "may-train"
  /** requests are logged / reviewed (trial terms), training not stated. */
  | "logged"
  | "unknown";

export interface FreeTierInfo {
  /** an `API_PROVIDERS` id. */
  providerId: string;
  /** "renewing" quota (endless-rotation material) vs one-off "trial" credit. */
  kind: "renewing" | "trial";
  /** human limits, e.g. "30 req/min · 1,000 req/day per model". */
  limits: string;
  dataUse: DataUse;
  /** extra warning shown with the row (region locks, non-commercial terms …). */
  caveat?: string;
  /** where a user gets the (free) key. */
  signupUrl: string;
  /** usable with NO key at all (an anonymous tier). */
  keyless?: boolean;
  /**
   * An OpenAI-compatible base URL to use INSTEAD of the registry's, for the rotation.
   *
   * The rotation speaks one wire (OpenAI chat/completions) to every member. Gemini's registry
   * row is its native `generateContent` root; Google also serves an OpenAI-compatible surface,
   * and that is the one a rotation member must use.
   */
  rotationBaseUrl?: string;
  /** rotation order: lower is tried first. Generous, fast quotas first. */
  priority: number;
}

/** A runtime that lets a model too big for this machine run anyway, slowly. */
export interface OffloadRuntime {
  id: "airllm" | "colibri";
  name: string;
  repo: string;
  /** one line: how it works. */
  mechanism: string;
  /** one line: what it costs in speed — said plainly. */
  speed: string;
  /** does it serve an OpenAI-compatible endpoint a session can adopt? */
  servesOpenAi: boolean;
  /** where it serves, when it does. */
  serveUrl?: string;
  /** usable for an interactive agent session (vs offline/batch jobs only). */
  interactive: boolean;
  /** Dense or MoE — which kind of model it helps. */
  helps: "dense" | "moe";
  /** the Prometheus command that installs it, when the engine can do it gated. */
  installCommand?: string;
  /** the steps to run when the install is manual — shown verbatim, never executed blindly. */
  manualSteps?: readonly string[];
  license: string;
}

/** The machine a local model has to fit on. */
export interface MachineProfile {
  /** total system RAM (GiB). */
  ramGb: number;
  /** largest discrete GPU's VRAM (GiB); 0 when there is none. */
  vramGb: number;
  /** Apple Silicon unified memory: RAM doubles as VRAM. */
  unified: boolean;
  /** free disk where models land (GiB), when known. */
  freeDiskGb?: number;
}
