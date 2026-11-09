// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog/catalog-types.ts — the row shape of the generated local-model catalogue.
 *
 * `catalog.generated.ts` is written by `studio/python/tools/build_model_catalog.py` from the
 * researched seed (`config/model-catalog.seed.json`); this file is its hand-written type, so the
 * generator can never silently change the contract the picker, the planner and the desktop read.
 */

/** A single GGUF build of a model on Hugging Face (first shard + the total of all shards). */
export interface CatalogGguf {
  /** `org/name` of the GGUF repo (the publisher's own -GGUF repo first, else a known quantizer). */
  repo: string;
  /** the file (or FIRST shard) path inside that repo. */
  file: string;
  /** total bytes across all shards — the real download size. */
  bytes?: number;
  shards?: number;
  /** the quantisation actually in the file ("Q4_K_M", "UD-Q4_K_XL", "MXFP4", …). */
  quant?: string;
}

/** What the build-time vetting established (never a substitute for the download-time scan). */
export interface CatalogGate {
  /** "caution" when any note applies (pickle files beside the weights, remote code, gated, NC). */
  status: "vetted" | "caution";
  /** safe weight formats this row can be fetched in. */
  formats: readonly ("gguf" | "safetensors" | "mlx")[];
  checks: readonly string[];
  notes: readonly string[];
}

export interface CatalogResource {
  /** Q4 weights (GiB) — the measured GGUF total when `weightsMeasured`, else the estimate. */
  q4_gb: number;
  /** RAM to run at an 8K context (GiB, rounded up to a common machine size). */
  min_ram_gb: number;
  /** RAM to run at the model's native context. */
  rec_ram_gb: number;
  gpu_min_vram_gb: number;
  cpu_ok: boolean;
  tier: "tiny" | "light" | "moderate" | "heavy" | "workstation" | "server" | "datacenter";
  /** does not fit even a 128 GB machine at Q4 — needs an offload runtime or a smaller quant. */
  needs_offload: boolean;
  /** one-line demand label, e.g. "≈4.7GB Q4 · 8GB RAM · CPU-ok". */
  label: string;
  weights_measured?: boolean;
  /** the smallest widely used quant (giant MoE rows), when the seed records one. */
  small_quant?: string;
  small_gb?: number;
  small_min_ram_gb?: number;
}

export interface CatalogModel {
  /** stable kebab id — the key `/models use local:<id>` and the sidecar's model.search use. */
  id: string;
  name: string;
  family?: string;
  publisher?: string;
  /** the OFFICIAL Hugging Face repo (safetensors). */
  repo: string;
  kind?: "llm" | "non-llm";
  params_b?: number;
  /** set for Mixture-of-Experts rows only. */
  active_params_b?: number;
  /** native context window (tokens). */
  context?: number;
  license: string;
  /** Hugging Face access gating: false, or how access is granted. */
  hf_gated?: boolean | "auto" | "manual";
  /** YYYY-MM. */
  released?: string;
  gguf?: CatalogGguf;
  gguf_small?: CatalogGguf;
  /** mlx-community (or publisher) MLX repo, for Apple Silicon. */
  mlx?: string;
  /** a LOCAL Ollama tag confirmed on ollama.com. */
  ollama?: string;
  /** an Ollama `:cloud` tag — runs on Ollama's servers, NOT locally. */
  ollama_cloud?: string;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  tags: readonly string[];
  /** the official repo ALSO ships pickle-format files (never downloaded by Prometheus). */
  has_pickle_files?: boolean;
  /** transformers loading needs trust_remote_code (custom Python in the repo). */
  remote_code?: boolean;
  /** exactly two lines for the picker: what it is good at, then its limits / who it is for. */
  blurb: readonly [string, string];
  resource: CatalogResource;
  gate: CatalogGate;
}
