// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * stretch/suggest.ts — given a model's compute demand + the user's machine, decide
 * whether it fits and, if not, recommend the cheapest viable "stretch" technique(s)
 * (the AirLLM-and-friends escalation chain) OR a smaller-model nudge.
 *
 * PURE + deterministic (fully unit-testable). Never blocks a download — it advises.
 */
import { STRETCH_TECHNIQUES, type StretchTechnique } from "./techniques.js";

/** The compute-demand inputs (mirror open-models.json `resource` + a couple model facts). */
export interface DemandInput {
  /** Q4_K_M weight size (GiB). */
  q4Gb: number;
  /** min RAM the model wants at short context (GiB) — resource.min_ram_gb. */
  minRamGb: number;
  /** is this a Mixture-of-Experts model? */
  isMoe: boolean;
  /** active params (B) for MoE decode-speed reasoning. */
  activeB?: number;
  /** the catalog said it overflows even a 128GB box at Q4. */
  needsOffload?: boolean;
}

/** The user's machine. */
export interface MachineInput {
  /** total system RAM (GiB). */
  ramGb: number;
  /** dedicated GPU VRAM (GiB); 0 = no usable discrete GPU (CPU/integrated). */
  vramGb: number;
  /** unified-memory (Apple Silicon): RAM doubles as VRAM. */
  unified?: boolean;
}

export type FitTier = "fits" | "tight" | "stretch" | "no-go";

export interface StretchSuggestion {
  technique: StretchTechnique;
  /** why this one, for this model on this machine. */
  rationale: string;
}

export interface FeasibilityVerdict {
  tier: FitTier;
  /** human one-liner. */
  headline: string;
  /** the usable memory budget we compared against (GiB). */
  budgetGb: number;
  /** ordered stretch techniques (empty when it fits comfortably). */
  suggestions: StretchSuggestion[];
  /** true when the honest advice is "pick a smaller model". */
  suggestSmaller: boolean;
}

/** Headroom fraction of total RAM usable for weights+kv+overhead, by machine size. */
function headroom(ramGb: number): number {
  if (ramGb <= 16) return 0.7;
  if (ramGb <= 32) return 0.75;
  return 0.8;
}

/**
 * Assess whether `demand` fits `machine`, and recommend stretch techniques if not.
 * The budget is VRAM when a discrete GPU is the target, else (system RAM · headroom);
 * unified memory uses RAM as the budget.
 */
export function assessFeasibility(demand: DemandInput, machine: MachineInput): FeasibilityVerdict {
  const ramBudget = machine.ramGb * headroom(machine.ramGb);
  // The primary budget: a real discrete GPU competes on VRAM; otherwise CPU/unified on RAM.
  const gpuBudget = machine.unified ? ramBudget : machine.vramGb * 0.92;
  const budget = Math.max(ramBudget, gpuBudget);
  // The model's short-context footprint ≈ min_ram_gb · headroom (back out the raw GiB).
  const footprint = demand.minRamGb * 0.72;

  const ratio = budget > 0 ? footprint / budget : Number.POSITIVE_INFINITY;
  const suggestions: StretchSuggestion[] = [];
  let tier: FitTier;
  let suggestSmaller = false;

  if (ratio <= 0.85) {
    tier = "fits";
  } else if (ratio <= 1.0) {
    tier = "tight";
  } else {
    // Doesn't fit at Q4 → build the escalation chain.
    tier = demand.needsOffload || ratio > 4 ? "no-go" : "stretch";
    suggestSmaller = true;
    const pick = (id: string, rationale: string) => {
      const t = STRETCH_TECHNIQUES.find((x) => x.id === id);
      if (t) suggestions.push({ technique: t, rationale });
    };
    // 1. a smaller quant nearly always helps first.
    pick("lower-quant", "Try a smaller quant (IQ3/IQ2) before any offload — fastest + simplest.");
    // 2. partial GPU offload when there IS a GPU and we're only moderately over.
    if (machine.vramGb >= 6 && ratio <= 2.5) {
      pick(
        "llamacpp-ngl-mmap",
        `Split layers across your ${machine.vramGb}GB GPU + ${machine.ramGb}GB RAM.`,
      );
    }
    // 3. MoE → expert offload is the single best lever.
    if (demand.isMoe) {
      pick(
        "moe-expert-offload",
        `MoE with ~${demand.activeB ?? "few"}B active — park experts in RAM, keep the active path on GPU.`,
      );
    }
    // 4/5/6. dense + far over → AirLLM / disk / swap.
    if (!demand.isMoe && ratio > 1.5) {
      pick(
        "airllm",
        "Dense model far over budget — AirLLM streams it layer-by-layer (slow but runs).",
      );
    }
    if (ratio > 2.5) {
      pick("nvme-disk-offload", "Throughput jobs on a fast NVMe can stream the rest from disk.");
      pick("ram-swap", "Zero-install last resort: enlarge swap for a one-off run.");
    }
    suggestions.sort((a, b) => a.technique.rank - b.technique.rank);
  }

  const headline =
    tier === "fits"
      ? `Fits your ${machine.ramGb}GB machine comfortably.`
      : tier === "tight"
        ? `Tight on ${machine.ramGb}GB — works at a reduced context; close other apps.`
        : tier === "stretch"
          ? `Won't fit ${machine.ramGb}GB at Q4 — runnable via offload (see below) or pick a smaller model.`
          : `Too big for ${machine.ramGb}GB even with tricks — use a served API, a smaller model, or expert-offload on more RAM.`;

  return { tier, headline, budgetGb: Math.round(budget * 10) / 10, suggestions, suggestSmaller };
}
