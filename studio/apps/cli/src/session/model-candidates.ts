// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/model-candidates.ts — the switchable chat-model list behind `/model` (alias `/worker`).
 *
 * A model candidate is a chat model this session could point at RIGHT NOW, not merely a model
 * that exists somewhere: a model a live local runner actually serves, or a cloud endpoint whose
 * key is actually present. `Backends.paidClis` is deliberately excluded — those launch a
 * SEPARATE nested terminal chat (`prometheus chat --cli <svc> --open`), not an in-session model
 * swap, and listing them here would offer a pick `/model` cannot honor.
 *
 * Each candidate carries the exact `ModelRef` `/model` should `tune()` with AND the ready
 * `AiEndpoint` the host should start sending requests to — picking one has to move BOTH, or the
 * footer/status line would say one model while every request still goes to the old one.
 */
import type { AiEndpoint } from "@prometheus/core";
import { DEFAULT_CONTEXT_WINDOW, type agent } from "@prometheus/core";

import type { Backends } from "./onboarding.js";

/** `AgentTuning`'s model field shape — not part of core's public surface as a standalone type
 *  (only `AgentTuning` itself is), so it's projected off that instead of a duplicate local type. */
type ModelRef = agent.AgentTuning["model"];

export interface ModelCandidate {
  /** stable id, used by both the picker and a typed `/model <id>` (e.g. "local:ollama:qwen3:8b"). */
  id: string;
  /** the bare model name, shown to the user. */
  label: string;
  /** one-line origin note (e.g. "local · ollama" or "cloud · anthropic"). */
  detail: string;
  /** true when this candidate IS the currently active model. */
  current: boolean;
  /** what `/model` should tune the session to. */
  model: ModelRef;
  /** the ready-to-use endpoint this candidate resolves to. */
  endpoint: AiEndpoint;
}

/** A minimal cloud-endpoint shape — `ai.discoverCloudEndpoints`'s `CloudEndpointInfo` satisfies
 *  this structurally, so callers can pass it straight through with no extra import here. */
export interface CloudCandidateSource {
  endpoint: AiEndpoint;
  label: string;
  providerId: string;
}

/** Every model this session could switch to right now (see module doc for what's excluded).
 *  `activeEndpointId` marks the currently-active candidate, when it is one of these. */
export function modelCandidates(
  backends: Backends,
  cloudEndpoints: readonly CloudCandidateSource[],
  activeEndpointId: string | undefined,
): ModelCandidate[] {
  const out: ModelCandidate[] = [];
  for (const runner of backends.liveRunners) {
    for (const model of runner.models) {
      const id = `local:${runner.name}:${model}`;
      out.push({
        id,
        label: model,
        detail: `local · ${runner.name}`,
        current: id === activeEndpointId,
        model: { provider: runner.name, modelId: model },
        endpoint: {
          id,
          baseUrl: runner.baseUrl,
          locality: "local",
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          supportsTools: true,
          model,
        },
      });
    }
  }
  for (const cloud of cloudEndpoints) {
    const id = `cloud:${cloud.endpoint.id}`;
    out.push({
      id,
      label: cloud.label,
      detail: "cloud",
      current: id === activeEndpointId,
      model: { provider: cloud.providerId, modelId: cloud.endpoint.model ?? cloud.label },
      endpoint: cloud.endpoint,
    });
  }
  return out;
}

/** Resolve a `/model` argument (typed text or a picker id) against the candidate list: exact
 *  id, exact label, then a case-insensitive substring — the same leniency `/resume` gives ids. */
export function resolveModelCandidate(
  candidates: readonly ModelCandidate[],
  query: string,
): ModelCandidate | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const lower = q.toLowerCase();
  return (
    candidates.find((cand) => cand.id === q) ??
    candidates.find((cand) => cand.label === q) ??
    candidates.find((cand) => cand.label.toLowerCase().includes(lower))
  );
}

/** The numbered baseline list `/model` (bare) prints before its `ask()` prompt — same shape as
 *  `/resume`'s `formatPicker` and `/timeout`'s preset list, so every host without a real arrow-key
 *  overlay still gets a working picker. */
export function renderModelCandidates(candidates: readonly ModelCandidate[]): string {
  if (candidates.length === 0) {
    return "no switchable models detected — run /setup to download a local model (or start it, if you already have one installed) or configure a cloud key.";
  }
  return candidates
    .map(
      (cand, i) =>
        `  ${i + 1}) ${cand.label}  (${cand.detail})${cand.current ? "  ← current" : ""}`,
    )
    .join("\n");
}
