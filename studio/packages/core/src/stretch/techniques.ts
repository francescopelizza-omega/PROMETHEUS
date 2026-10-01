// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * stretch/techniques.ts — the curated registry of ways to run a model that is too big
 * for a machine's RAM/VRAM (the "stretch" toolkit), from the 33-agent resource
 * investigation. Prometheus suggests these (cheapest viable first) when a model
 * OVERFLOWs the user's box, instead of only saying "pick something smaller".
 *
 * PURE data + a recommender (see ./suggest.ts). Every figure is from measured/cited
 * sources; the ordering encodes the canonical escalation chain:
 *   lower-quant → llama.cpp partial GPU offload → MoE expert-offload → AirLLM/disk → swap.
 */

/** How much a technique slows token generation vs. fully-resident inference. */
export type SpeedCost = "none" | "low" | "moderate" | "severe";
/** How much a technique degrades output quality. */
export type QualityCost = "none" | "low" | "moderate";

export interface StretchTechnique {
  id: string;
  name: string;
  /** one-line mechanism. */
  mechanism: string;
  /** what RAM/VRAM ceiling it unlocks (human). */
  ramUnlocked: string;
  speedCost: SpeedCost;
  qualityCost: QualityCost;
  /** how to install / invoke it. */
  install: string;
  /** when Prometheus should suggest it. */
  whenToSuggest: string;
  /** does it serve an OpenAI-compatible endpoint (drop-in for the app)? */
  openaiCompatible: boolean;
  /** escalation rank (1 = try first / cheapest). */
  rank: number;
}

export const STRETCH_TECHNIQUES: readonly StretchTechnique[] = Object.freeze([
  {
    id: "lower-quant",
    name: "Lower quantization (Q4_K_M → Q3 → IQ2)",
    mechanism:
      "Use a smaller quant: fewer bits/weight shrinks the weights, often FASTER (less memory bandwidth).",
    ramUnlocked: "Q8→Q4_K_M cuts size ~45% for ~2% quality loss; IQ3/IQ2 fit very tight VRAM.",
    speedCost: "none",
    qualityCost: "low",
    install:
      "Download the smaller-quant GGUF (e.g. *-Q4_K_M.gguf / *-IQ3_XXS.gguf) from HF; load in llama.cpp/Ollama.",
    whenToSuggest:
      "FIRST move — a smaller quant that fits beats any offload scheme on speed AND simplicity.",
    openaiCompatible: true,
    rank: 1,
  },
  {
    id: "llamacpp-ngl-mmap",
    name: "llama.cpp partial GPU offload (-ngl) + mmap",
    mechanism:
      "Split layers GPU+CPU (-ngl N keeps N layers on the GPU, the rest in RAM); mmap pages weights from disk.",
    ramUnlocked:
      "Run a model larger than VRAM by spilling layers to system RAM; mmap lets total exceed RAM via disk paging.",
    speedCost: "moderate",
    qualityCost: "none",
    install:
      "llama.cpp / llama-cpp-python / Ollama; run e.g. `llama-server -m model.gguf -ngl 20`. Avoid overflowing VRAM into the driver's shared-RAM fallback (slower than pure CPU).",
    whenToSuggest:
      "Default when a GGUF is slightly-to-moderately bigger than VRAM and you have a GPU + enough RAM for the rest.",
    openaiCompatible: true,
    rank: 2,
  },
  {
    id: "moe-expert-offload",
    name: "MoE expert offload (llama.cpp --cpu-moe / -ot)",
    mechanism:
      "Keep attention + the active path in VRAM; park the bulk expert weights in system RAM. Only active experts compute per token.",
    ramUnlocked:
      "Run 200B+ MoE on a single 24GB GPU + ~128GB RAM (Qwen3-235B-A22B, DeepSeek, Mixtral).",
    speedCost: "low",
    qualityCost: "none",
    install:
      "Recent llama.cpp: `llama-server -m moe.gguf -ngl 99 --cpu-moe` (keep shared experts in VRAM).",
    whenToSuggest:
      "Best technique whenever the target is a large MoE — active params are tiny so RAM-resident experts barely hurt.",
    openaiCompatible: true,
    rank: 3,
  },
  {
    id: "airllm",
    name: "AirLLM (layer-by-layer disk streaming)",
    mechanism:
      "Load + run ONE transformer layer at a time from disk; only ~1 layer (+KV) is resident, so peak RAM ≈ a single layer.",
    ramUnlocked:
      "70B in ~4GB VRAM; claims 405B in 8GB. Can run full precision or 4/8-bit block compression.",
    speedCost: "severe",
    qualityCost: "none",
    install:
      "pip install airllm; `from airllm import AutoModel; m = AutoModel.from_pretrained(repo)`.",
    whenToSuggest:
      "Last-resort for a DENSE model that fits no other way AND the user accepts minutes-per-token (not interactive).",
    openaiCompatible: false,
    rank: 4,
  },
  {
    id: "nvme-disk-offload",
    name: "NVMe/disk offload (DeepSpeed ZeRO-Infinity / accelerate)",
    mechanism:
      "Stream weights from NVMe/CPU through the GPU (ZeRO-Inference / HF accelerate device_map='disk').",
    ramUnlocked:
      "Hundreds-of-billions params on a single GPU; throughput-oriented (hide latency with big batches).",
    speedCost: "severe",
    qualityCost: "none",
    install:
      "pip install deepspeed (ZeRO-Inference) OR accelerate device_map with an offload_folder on a fast NVMe.",
    whenToSuggest:
      "Batch/throughput jobs on a box with a fast NVMe when the model exceeds GPU+RAM combined. Very slow without NVMe.",
    openaiCompatible: false,
    rank: 5,
  },
  {
    id: "ram-swap",
    name: "RAM + OS swap spillover",
    mechanism:
      "Enlarge the swapfile/pagefile so effective RAM = physical + swap; run normally with mmap.",
    ramUnlocked:
      "Effective RAM = physical RAM + swap size — lets a model nominally larger than RAM load.",
    speedCost: "severe",
    qualityCost: "none",
    install: "No install: increase swap/pagefile size; run with mmap (llama.cpp default).",
    whenToSuggest:
      "Emergency zero-install fallback on a fast-NVMe box for a one-off run; constant page-thrashing otherwise.",
    openaiCompatible: true,
    rank: 6,
  },
]);

/** Look up a technique by id. */
export function getTechnique(id: string): StretchTechnique | undefined {
  return STRETCH_TECHNIQUES.find((t) => t.id === id);
}
