// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog/plan.ts — can THIS machine run that local model, and how?
 *
 * Built on `stretch.assessFeasibility`, which already turns a model's compute demand and a
 * machine into fits / tight / stretch / no-go. What it does not do is answer the picker's real
 * question: "if I pick this, what happens next?" — run it natively, install colibri or AirLLM
 * first, or pick something else. That is this module. Pure: no IO, no clock.
 */
import { type FitTier, assessFeasibility } from "../../stretch/suggest.js";
import { LOCAL_MODELS } from "./local.js";
import { offloadRuntime } from "./offload.js";
import type { LocalModelEntry, MachineProfile, OffloadRuntime } from "./types.js";

export type LocalRunPlan =
  /** loads in an ordinary runner (Ollama) on this machine. */
  | { kind: "native"; tier: Extract<FitTier, "fits" | "tight">; headline: string }
  /** runs only through an offload runtime, which must be installed first. */
  | {
      kind: "offload";
      runtime: OffloadRuntime;
      headline: string;
      /** false = it will run, but too slowly for an interactive agent session. */
      interactive: boolean;
    }
  /** will not run here at all. */
  | { kind: "too-big"; headline: string };

const isMoe = (m: LocalModelEntry): boolean => m.activeB !== undefined || m.tags.includes("moe");

/**
 * The plan for one model on one machine.
 *
 * colibri is preferred for MoE models it ships, because it serves an OpenAI-compatible endpoint
 * the session can adopt; AirLLM is the dense-model fallback and is flagged non-interactive,
 * because at seconds-to-minutes per token an agent turn would effectively never finish.
 */
export function planLocalModel(m: LocalModelEntry, machine: MachineProfile): LocalRunPlan {
  const verdict = assessFeasibility(
    {
      q4Gb: m.q4Gb,
      minRamGb: m.minRamGb,
      isMoe: isMoe(m),
      ...(m.activeB !== undefined ? { activeB: m.activeB } : {}),
      ...(m.needsOffload ? { needsOffload: true } : {}),
    },
    machine,
  );
  if (m.ollama && (verdict.tier === "fits" || verdict.tier === "tight")) {
    return { kind: "native", tier: verdict.tier, headline: verdict.headline };
  }
  if (m.colibri && machine.ramGb >= (m.colibriMinRamGb ?? Number.POSITIVE_INFINITY)) {
    const runtime = offloadRuntime("colibri");
    return {
      kind: "offload",
      runtime,
      interactive: m.ollama !== undefined, // a mid-size MoE streams usably; a giant one does not
      headline: `Too big for Ollama on ${machine.ramGb} GB — runs through colibri (experts streamed from disk).`,
    };
  }
  // Dense and over budget, whether "stretch" or "no-go": AirLLM's whole point is that peak RAM
  // is about ONE layer, so the feasibility ratio that rules out every other runner does not
  // rule it out. It is still offered as what it is — non-interactive.
  if (!isMoe(m) && m.hfRepo) {
    return {
      kind: "offload",
      runtime: offloadRuntime("airllm"),
      interactive: false,
      headline: `Too big for ${machine.ramGb} GB — only AirLLM can run it, at minutes per token.`,
    };
  }
  return { kind: "too-big", headline: verdict.headline };
}

/** Is there room on disk for the weights? `undefined` when free space is unknown. */
export function diskFits(m: LocalModelEntry, machine: MachineProfile): boolean | undefined {
  if (machine.freeDiskGb === undefined) return undefined;
  // 10% headroom: a pull writes a blob and then links it, and an exactly-full disk is a
  // failed pull plus a filesystem nothing else can write to.
  return machine.freeDiskGb >= m.q4Gb * 1.1;
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
    (m) => m.id !== opts.wanted?.id && planLocalModel(m, machine).kind === "native",
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
}): MachineProfile {
  const gib = (b: number): number => Math.round((b / 1024 ** 3) * 10) / 10;
  const unified = opts.platform === "darwin" && opts.arch === "arm64";
  return {
    ramGb: gib(opts.totalMemBytes),
    vramGb: opts.vramBytes ? gib(opts.vramBytes) : 0,
    unified,
    ...(opts.freeDiskBytes !== undefined ? { freeDiskGb: gib(opts.freeDiskBytes) } : {}),
  };
}
