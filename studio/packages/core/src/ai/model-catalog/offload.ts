// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog/offload.ts — runtimes that run a model too big for this machine, and what
 * they cost.
 *
 * The user asked to be TOLD, before anything is downloaded, when a model will only run through
 * one of these — and to have the runtime installed first, or be offered models that fit. The
 * honest version of that has to say how slow they are: AirLLM streams a dense model layer by
 * layer from disk, which measures in seconds-to-minutes PER TOKEN, and an agent turn is
 * thousands of tokens. Offering it as a chat model without saying so would be the worst kind
 * of "it works" — the session would simply never answer.
 *
 * None of them is ever chosen for the user: a model that does not fit RAM is refused, and these
 * run it only when the user insists (`local:<id>@<runtime>`) and types the model's name.
 *
 * Sources (2026-10-12): github.com/lyogavin/airllm (README, v3.0), github.com/JustVugg/colibri
 * (README), llama.cpp `--mmap` / `--cpu-moe` docs. Speeds are the authors' own figures.
 */
import type { OffloadRuntime } from "./types.js";

export const OFFLOAD_RUNTIMES: readonly OffloadRuntime[] = Object.freeze([
  {
    id: "colibri",
    name: "colibri",
    repo: "https://github.com/JustVugg/colibri",
    mechanism:
      "Keeps the dense part of a Mixture-of-Experts model in RAM and streams the experts from NVMe.",
    speed: "Mid-size MoE (Qwen3.6-35B) about 6 tok/s on CPU; giant MoE (GLM-5.2) 0.05–2 tok/s.",
    servesOpenAi: true,
    serveUrl: "http://127.0.0.1:8000/v1",
    interactive: true,
    helps: "moe",
    // Installed by Prometheus from its PINNED source commit (v2.1.0), scanned by nemesis and
    // built here — the prebuilt release archive is refused by nemesis (native binaries nobody
    // here built). It reads the gated GGUF in place (`coli import --mode link`).
    license: "Apache-2.0",
  },
  {
    id: "llamacpp-stream",
    name: "llama.cpp from SSD",
    repo: "https://github.com/ggml-org/llama.cpp",
    mechanism:
      "llama-server memory-maps the GGUF; weights that do not fit in RAM are paged in from disk as each token needs them.",
    speed:
      "Disk-bound: a MoE model with few active experts stays usable; a dense model larger than RAM reads every weight per token (tens of seconds per token).",
    servesOpenAi: true,
    serveUrl: "http://127.0.0.1:8080/v1",
    interactive: false,
    helps: "any",
    license: "MIT",
  },
  {
    id: "airllm",
    name: "AirLLM",
    repo: "https://github.com/lyogavin/airllm",
    mechanism:
      "Runs a dense model one transformer layer at a time from disk, so peak RAM is about one layer.",
    speed: "Disk-bound: roughly 20 s to minutes per token for a 70B model — offline jobs only.",
    // Prometheus's own OpenAI-compatible shim (python/sidecar/airllm_serve.py) wraps the library
    // on 127.0.0.1 — AirLLM itself is a Python library with no server.
    servesOpenAi: true,
    serveUrl: "http://127.0.0.1:8094/v1",
    interactive: false,
    helps: "dense",
    license: "Apache-2.0",
  },
]);

export function offloadRuntime(id: OffloadRuntime["id"]): OffloadRuntime {
  const r = OFFLOAD_RUNTIMES.find((x) => x.id === id);
  if (!r) throw new Error(`unknown offload runtime ${id}`);
  return r;
}
