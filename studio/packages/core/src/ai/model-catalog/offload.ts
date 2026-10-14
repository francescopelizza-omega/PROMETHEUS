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
 * Sources (2026-10-12): github.com/lyogavin/airllm (README, v3.0), github.com/JustVugg/colibri
 * (README). Speeds are the authors' own figures.
 */
import type { OffloadRuntime } from "./types.js";

export const OFFLOAD_RUNTIMES: readonly OffloadRuntime[] = Object.freeze([
  {
    id: "colibri",
    name: "colibri",
    repo: "https://github.com/JustVugg/colibri",
    mechanism:
      "Keeps the dense part of a Mixture-of-Experts model in RAM and streams the experts from NVMe.",
    speed: "Mid-size MoE (Qwen3.6-35B) about 6 tok/s on CPU; giant MoE (GLM-5.2) 0.05–1.8 tok/s.",
    servesOpenAi: true,
    serveUrl: "http://127.0.0.1:8000/v1",
    interactive: true,
    helps: "moe",
    // Not an engine verb: colibri is a C engine built from a GitHub checkout, and Prometheus's
    // rule for fetched code is that nemesis scans it before anything runs. The steps are shown
    // verbatim for the user to run after that scan — never executed on their behalf.
    manualSteps: [
      "git clone https://github.com/JustVugg/colibri ~/colibri",
      "prometheus nemesis ~/colibri     # nemesis threat scan before running anything from it",
      "cd ~/colibri && ./start-here.sh --list          # shows which models fit this machine",
      "cd ~/colibri && ./start-here.sh --model <ID>    # downloads + starts the server on 127.0.0.1:8000",
    ],
    license: "Apache-2.0",
  },
  {
    id: "airllm",
    name: "AirLLM",
    repo: "https://github.com/lyogavin/airllm",
    mechanism:
      "Runs a dense model one transformer layer at a time from disk, so peak RAM is about one layer.",
    speed: "Disk-bound: roughly 20 s to minutes per token for a 70B model — offline jobs only.",
    servesOpenAi: false,
    interactive: false,
    helps: "dense",
    installCommand: "prometheus models install airllm",
    license: "Apache-2.0",
  },
]);

export function offloadRuntime(id: OffloadRuntime["id"]): OffloadRuntime {
  const r = OFFLOAD_RUNTIMES.find((x) => x.id === id);
  if (!r) throw new Error(`unknown offload runtime ${id}`);
  return r;
}
