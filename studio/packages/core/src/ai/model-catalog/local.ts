// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog/local.ts — the local models the picker lists, smallest first.
 *
 * Every row now comes from the GENERATED catalogue (`catalog.generated.ts`, written by
 * `studio/python/tools/build_model_catalog.py` from the researched seed, and the same rows as
 * `config/open-models.json`), so the picker, the sidecar's `model.search` and the desktop can
 * never disagree about a model's size, RAM need, licence or download coordinates. This file
 * only maps a catalogue row onto the picker's `LocalModelEntry` and adds the handful of facts
 * the catalogue does not carry — today, which models colibri (the NVMe-streaming offload
 * runtime) ships a build of.
 *
 * Range: from 2 GB machines (sub-1B models, embeddings) to 1.5 TB+ frontier MoE models, each
 * with the two picker lines (what it is good at · its limits) researched against Hugging Face
 * and ollama.com on 2026-11-02.
 */
import type { CatalogModel } from "./catalog-types.js";
import { CATALOG_MODELS } from "./catalog.generated.js";
import type { LocalModelEntry } from "./types.js";

/**
 * colibri builds (from colibri's own model table): the id colibri uses and the RAM it needs.
 * The row keeps the model's OFFICIAL repo as `hfRepo`. (glm-5.2 used to have it replaced by a
 * third party's colibri int4 pack that no code path ever fetched — streaming downloads the
 * catalogued GGUF and imports it — while every consumer of `hfRepo` (AirLLM, vLLM, the
 * details pane) was pointed at the wrong repo.)
 */
const COLIBRI: Readonly<
  Record<string, { colibri: string; colibriMinRamGb: number; label?: string }>
> = Object.freeze({
  "qwen3-coder-30b": { colibri: "qwen3-coder-30b", colibriMinRamGb: 16 },
  "glm-5.2": {
    colibri: "glm-5.2",
    colibriMinRamGb: 16,
    label: "GLM-5.2 via colibri (MoE, streamed from disk)",
  },
});

/** Map one generated catalogue row onto the picker's entry shape. */
export function toLocalEntry(m: CatalogModel): LocalModelEntry {
  const extra = COLIBRI[m.id];
  const r = m.resource;
  return {
    id: m.id,
    label: extra?.label ?? m.name,
    ...(m.ollama ? { ollama: m.ollama } : {}),
    hfRepo: m.repo,
    ...(extra ? { colibri: extra.colibri, colibriMinRamGb: extra.colibriMinRamGb } : {}),
    blurb: { strengths: m.blurb[0], limits: m.blurb[1] },
    ...(m.params_b !== undefined ? { paramsB: m.params_b } : {}),
    ...(m.active_params_b !== undefined ? { activeB: m.active_params_b } : {}),
    q4Gb: r.q4_gb,
    minRamGb: r.min_ram_gb,
    recRamGb: r.rec_ram_gb,
    ...(r.needs_offload ? { needsOffload: true } : {}),
    context: m.context ?? 8192,
    tools: m.tools === true,
    license: m.license,
    tags: m.tags,
    ...(m.gguf ? { gguf: m.gguf } : {}),
    ...(m.gguf_small ? { ggufSmall: m.gguf_small } : {}),
    ...(m.mlx ? { mlx: m.mlx } : {}),
    ...(m.ollama_cloud ? { ollamaCloud: m.ollama_cloud } : {}),
    ...(m.remote_code ? { remoteCode: true } : {}),
    ...(m.vision ? { vision: true } : {}),
    ...(m.hf_gated ? { hfGated: m.hf_gated } : {}),
    ...(m.publisher ? { publisher: m.publisher } : {}),
    gate: m.gate,
    resourceLabel: r.label,
    tier: r.tier,
    ...(m.family ? { family: m.family } : {}),
    ...(m.released ? { released: m.released } : {}),
    ...(r.small_min_ram_gb !== undefined ? { smallMinRamGb: r.small_min_ram_gb } : {}),
    ...(r.small_gb !== undefined ? { smallGb: r.small_gb } : {}),
    ...(m.tags.includes("reasoning") || m.reasoning ? { reasoning: true } : {}),
  };
}

/** Language models only (embeddings / rerankers / speech / image are not chat picks). */
export const LOCAL_MODELS: readonly LocalModelEntry[] = Object.freeze(
  CATALOG_MODELS.filter((m) => (m.kind ?? "llm") === "llm").map(toLocalEntry),
);

/** Find a catalogued local model by catalogue id or Ollama tag. */
export function findLocalModel(idOrTag: string): LocalModelEntry | undefined {
  const k = idOrTag.trim().toLowerCase();
  return LOCAL_MODELS.find((m) => m.id === k || m.ollama?.toLowerCase() === k);
}
