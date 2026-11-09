// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog/plan.ts — can THIS machine run that local model, and how?
 *
 * Built on `stretch.assessFeasibility`, which already turns a model's compute demand and a
 * machine into fits / tight / stretch / no-go. What it does not do is answer the picker's real
 * question: "if I pick this, what happens next?" — run it natively, at a smaller quant, or
 * not at all unless the user insists on streaming it from disk (colibri, llama.cpp from SSD,
 * AirLLM). That is this module. Pure: no IO, no clock.
 */
import { type FitTier, assessFeasibility } from "../../stretch/suggest.js";
import { LOCAL_MODELS } from "./local.js";
import { offloadRuntime } from "./offload.js";
import type { LocalModelEntry, MachineProfile, OffloadRuntime } from "./types.js";

export type LocalRunPlan =
  /**
   * Loads in an ordinary server on this machine. `quant: "small"` = only the catalogue's small
   * quant (`ggufSmall`) fits, so the pick is prepared with that file on llama.cpp / LM Studio.
   */
  | {
      kind: "native";
      tier: Extract<FitTier, "fits" | "tight">;
      headline: string;
      quant?: "small";
    }
  /**
   * Does NOT fit this machine's RAM, so a pick is refused. `streaming` lists the runtimes that
   * can still run it by moving weights between disk and RAM, best first — the "run it anyway"
   * path, which the user must ask for explicitly (`local:<id>@<runtime>`) and confirm by typing
   * the model's name. It is never chosen on the user's behalf: at seconds-to-minutes per token
   * an agent turn effectively never finishes, and the user asked to be stopped, not surprised.
   */
  | {
      kind: "too-big";
      headline: string;
      /** RAM the model needs at Q4 (GiB), and what this machine can give it. */
      needGb: number;
      budgetGb: number;
      streaming: readonly StreamingOption[];
    };

/** One way to run an over-budget model by streaming it from disk. */
export interface StreamingOption {
  runtime: OffloadRuntime;
  /** usable for an interactive agent session (vs offline/batch jobs only). */
  interactive: boolean;
  /** one line: why this runtime fits this model. */
  why: string;
}

// A MoE activates FEWER parameters than it holds. Two dense rows (Llama-3.1-405B, Nemotron
// Ultra 253B) carry active == total, and used to count as MoE: AirLLM — 405B is its flagship
// case — was never offered, and streaming refused them as "a Mixture-of-Experts model".
export const isMoe = (m: LocalModelEntry): boolean =>
  (m.activeB !== undefined && (m.paramsB === undefined || m.activeB < m.paramsB)) ||
  m.tags.includes("moe");

/** Where each streaming runtime has a build (runtimes/registry.ts): offering it elsewhere made
 *  the user type the model's name to confirm, then `install-runtime` failed. */
function platformHas(id: "colibri" | "airllm", machine: MachineProfile): boolean {
  if (!machine.platform) return true; // a host that does not say: unchanged behaviour
  const p = `${machine.platform}-${machine.arch ?? ""}`;
  if (id === "colibri") return p === "darwin-arm64" || p === "linux-x64";
  return p === "darwin-arm64" || (machine.platform === "linux" && machine.vramGb > 0);
}

function verdictFor(m: LocalModelEntry, machine: MachineProfile, minRamGb = m.minRamGb) {
  return assessFeasibility(
    {
      q4Gb: m.q4Gb,
      minRamGb,
      isMoe: isMoe(m),
      ...(m.activeB !== undefined ? { activeB: m.activeB } : {}),
      // the catalogue's "overflows 128 GB" flag is about Q4; it must not veto a small quant
      ...(m.needsOffload && minRamGb === m.minRamGb ? { needsOffload: true } : {}),
    },
    machine,
  );
}

/**
 * The disk-streaming runtimes that can run `m` on `machine`, best first.
 *
 *  - colibri: MoE models it ships a build of — keeps the dense part in RAM and streams experts
 *    from NVMe; interactive for mid-size MoE.
 *  - llama.cpp from SSD: any GGUF. llama-server memory-maps the file, so the kernel pages
 *    weights in from disk as they are used; with `--cpu-moe` a MoE model keeps only its
 *    experts on the paging path. Same gated GGUF, no new software beyond llama.cpp.
 *  - AirLLM: dense models with safetensors and no custom code — loads one transformer layer at
 *    a time, so peak RAM is about one layer; minutes per token, offline jobs only.
 */
export function streamingOptions(m: LocalModelEntry, machine: MachineProfile): StreamingOption[] {
  const out: StreamingOption[] = [];
  const moe = isMoe(m);
  if (
    colibriSupports(m) &&
    platformHas("colibri", machine) &&
    machine.ramGb >= (m.colibriMinRamGb ?? 16)
  ) {
    out.push({
      runtime: offloadRuntime("colibri"),
      // a mid-size MoE (≈3B active) streams at a few tokens/s; a giant one (GLM-5, Kimi K3)
      // at well under one — too slow for an agent session
      interactive: (m.activeB ?? Number.POSITIVE_INFINITY) <= 12,
      why: "colibri reads this MoE model's GGUF in place and streams its experts from disk.",
    });
  }
  if (m.gguf) {
    out.push({
      runtime: offloadRuntime("llamacpp-stream"),
      // a MoE model touches only its active experts per token, so paging stays bearable
      interactive: moe && (m.activeB ?? Number.POSITIVE_INFINITY) <= 40,
      why: moe
        ? "llama.cpp memory-maps the GGUF and keeps the experts on the disk-paging path."
        : "llama.cpp memory-maps the GGUF; the kernel pages the weights in from disk.",
    });
  }
  if (
    !moe &&
    m.hfRepo &&
    !m.remoteCode &&
    platformHas("airllm", machine) &&
    airllmCanLoad(m, machine)
  ) {
    out.push({
      runtime: offloadRuntime("airllm"),
      interactive: false,
      why: "AirLLM runs one transformer layer at a time from the safetensors on disk.",
    });
  }
  return out;
}

/**
 * Model families colibri's `coli import` accepts (its GGUF `general.architecture` allowlist,
 * v2.1.0): Qwen3 MoE and Qwen3.5/3.6/3.8, DeepSeek V4/V4.1, GLM-5.x, Kimi K3, MiMo-V2, OLMoE,
 * Mistral-Large-4, Flint, Muse Spark. A GGUF of any other architecture is refused by colibri, so
 * the picker must not offer it. Matched on catalogue ids — Qwen3-VL/Omni and DeepSeek V3 are
 * different architectures and stay out.
 */
const COLIBRI_IDS =
  /^(qwen3-(30b-a3b|coder-30b|235b-a22b|coder-480b)|qwen3\.[568]-|deepseek-v4|glm-5|kimi-k3|mimo-v2|olmoe|mistral-large-4|flint|muse-spark)/;

export function colibriSupports(m: LocalModelEntry): boolean {
  return m.gguf !== undefined && isMoe(m) && COLIBRI_IDS.test(m.id);
}

/**
 * AirLLM's limits (v4.0.0 source): on Apple Silicon it runs only Llama- and Mistral-architecture
 * models (its MLX class refuses the rest before loading); elsewhere it needs an NVIDIA GPU.
 */
export function airllmCanLoad(m: LocalModelEntry, machine: MachineProfile): boolean {
  // vision / multimodal rows (Llama-3.2-Vision is Mllama, Pixtral, Mistral-Small 3.x) pass the
  // family regex but AirLLM's Llama/Mistral classes cannot load them: a ~180 GB download for
  // a model that then refuses to start
  if (m.vision || m.tags.includes("vision")) return false;
  if (machine.unified)
    return /llama|mistral|hermes/i.test(m.family ?? m.id) && !/llama4/i.test(m.family ?? m.id);
  return machine.vramGb > 0;
}

/**
 * The plan for one model on one machine: native (maybe at the small quant), or too big — with
 * the disk-streaming runtimes that could run it anyway.
 */
export function planLocalModel(m: LocalModelEntry, machine: MachineProfile): LocalRunPlan {
  const verdict = verdictFor(m, machine);
  if (verdict.tier === "fits" || verdict.tier === "tight") {
    return { kind: "native", tier: verdict.tier, headline: verdict.headline };
  }
  // Q4 does not fit: the catalogue's small quant (IQ1–IQ2 of a giant MoE) may.
  if (m.ggufSmall && m.smallMinRamGb !== undefined) {
    const small = verdictFor(m, machine, m.smallMinRamGb);
    if (small.tier === "fits" || small.tier === "tight") {
      return {
        kind: "native",
        tier: small.tier,
        quant: "small",
        headline: `Q4 is too big for ${machine.ramGb} GB; the ${m.ggufSmall.quant ?? "small"} quant fits (lower quality).`,
      };
    }
  }
  const budgetGb = verdict.budgetGb;
  return {
    kind: "too-big",
    headline: `Too big for this machine: needs about ${Math.ceil(m.minRamGb)} GB of RAM, ${machine.ramGb} GB here.`,
    needGb: m.minRamGb,
    budgetGb,
    streaming: streamingOptions(m, machine),
  };
}

/**
 * Is there a build some local server here can load? An Ollama tag or a GGUF anywhere; an MLX
 * build only on Apple Silicon (LM Studio's MLX engine, MLX-LM). Safetensors alone are served by
 * vLLM on a Linux GPU box, which Prometheus adopts but never sets up — so they do not count.
 */
export function hasLocalBuild(m: LocalModelEntry, machine: MachineProfile): boolean {
  return m.ollama !== undefined || m.gguf !== undefined || (m.mlx !== undefined && machine.unified);
}

/** Which runtime store a pick for `runtime` writes its bytes into (see ai/model-stores.ts). */
export const STORE_FOR_RUNTIME: Readonly<Record<string, string>> = {
  ollama: "ollama",
  lmstudio: "lmstudio",
  mlx: "hf",
  airllm: "hf",
  colibri: "hf",
  "llamacpp-stream": "hf",
  llamacpp: "hf",
  vllm: "hf",
};

/**
 * Is there room on disk for the weights? `undefined` when free space is unknown.
 *
 * Weights are stored ONCE, in the folder of the software that serves them, so one copy (plus
 * 10% — a pull writes a blob and then links it, and an exactly-full disk is a failed download
 * and a filesystem nothing else can write to) — measured on the store `runtime` writes to
 * (`machine.freeDiskGbByStore`), else the least free of all. There is no two-copy exception
 * any more: an Ollama import renames or hard-links the admitted GGUF into Ollama's store.
 * `sizeGb` is the size of the quant actually fetched (the small quant when only it fits).
 */
export function diskFits(
  m: LocalModelEntry,
  machine: MachineProfile,
  runtime?: string,
  sizeGb: number = m.q4Gb,
): boolean | undefined {
  const store = runtime ? STORE_FOR_RUNTIME[runtime] : undefined;
  const free =
    (store !== undefined ? machine.freeDiskGbByStore?.[store] : undefined) ?? machine.freeDiskGb;
  if (free === undefined) return undefined;
  // One copy, always: an Ollama import of a GGUF used to need room for two (`ollama create`
  // copied the transit file into its blob store); the sidecar now renames or hard-links the
  // admitted file INTO the store (zero-copy import), so every runtime needs size + 10%.
  return free >= sizeGb * 1.1;
}

/** Does the model fit this machine at all (ignoring whether a local build exists)? */
export function fitsNatively(m: LocalModelEntry, machine: MachineProfile): boolean {
  return planLocalModel(m, machine).kind === "native";
}

/** The usable model budget on `machine` (GiB): what a model's RAM need is compared against. */
export function modelBudgetGb(machine: MachineProfile): number {
  // The feasibility budget is in footprint units (min_ram × headroom(min_ram)); report it in
  // the same units as a row's min_ram_gb so "needs 40 GB, up to ≈46 GB runs here" compares like
  // for like: the largest min_ram whose footprint is within the "fits" ratio (0.85).
  const v = assessFeasibility({ q4Gb: 0, minRamGb: 0, isMoe: false }, machine);
  const limit = v.budgetGb * 0.85;
  let best = 0;
  for (const [lo, hi, h] of [
    [0, 32, 0.72],
    [32, 64, 0.8],
    [64, Number.POSITIVE_INFINITY, 0.85],
  ] as const) {
    const m = Math.min(hi, limit / h);
    if (m > lo) best = Math.max(best, m);
  }
  return Math.floor(best * 10) / 10;
}

/**
 * Models that DO run natively here, closest to `wanted` first.
 *
 * This is the "you declined to install the offload runtime" branch: the user still wants a
 * model, so offer the strongest ones that fit, sharing `wanted`'s purpose (coding, reasoning…)
 * where possible. Bigger first within the same purpose, since a bigger model that fits is
 * nearly always the better one.
 */
export function nativeAlternatives(
  machine: MachineProfile,
  opts: { wanted?: LocalModelEntry; limit?: number; catalog?: readonly LocalModelEntry[] } = {},
): LocalModelEntry[] {
  const catalog = opts.catalog ?? LOCAL_MODELS;
  const purpose = new Set<string>(
    (opts.wanted?.tags ?? []).filter((t) => t === "coding" || t === "reasoning" || t === "vision"),
  );
  const runnable = catalog.filter(
    (m) =>
      m.id !== opts.wanted?.id &&
      hasLocalBuild(m, machine) &&
      planLocalModel(m, machine).kind === "native",
  );
  const shares = (m: LocalModelEntry): number => m.tags.filter((t) => purpose.has(t)).length;
  return runnable
    .sort((a, b) => shares(b) - shares(a) || b.q4Gb - a.q4Gb || a.id.localeCompare(b.id))
    .slice(0, opts.limit ?? 5);
}

/** Every catalogued model with its plan on this machine, in catalogue order (small → large). */
export function planCatalog(
  machine: MachineProfile,
  catalog: readonly LocalModelEntry[] = LOCAL_MODELS,
): { model: LocalModelEntry; plan: LocalRunPlan }[] {
  return catalog.map((model) => ({ model, plan: planLocalModel(model, machine) }));
}

/** The machine, from plain numbers a host already has (`os.totalmem()`, platform, arch). */
export function machineFromHost(opts: {
  totalMemBytes: number;
  platform: string;
  arch: string;
  vramBytes?: number;
  freeDiskBytes?: number;
  freeDiskBytesByStore?: Partial<Record<string, number>>;
}): MachineProfile {
  const gib = (b: number): number => Math.round((b / 1024 ** 3) * 10) / 10;
  const unified = opts.platform === "darwin" && opts.arch === "arm64";
  return {
    platform: opts.platform,
    arch: opts.arch,
    ramGb: gib(opts.totalMemBytes),
    vramGb: opts.vramBytes ? gib(opts.vramBytes) : 0,
    unified,
    ...(opts.freeDiskBytes !== undefined ? { freeDiskGb: gib(opts.freeDiskBytes) } : {}),
    ...(opts.freeDiskBytesByStore
      ? {
          freeDiskGbByStore: Object.fromEntries(
            Object.entries(opts.freeDiskBytesByStore)
              .filter((e): e is [string, number] => typeof e[1] === "number")
              .map(([k, v]) => [k, gib(v)]),
          ),
        }
      : {}),
  };
}
