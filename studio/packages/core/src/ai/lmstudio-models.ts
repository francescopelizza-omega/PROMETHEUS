// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/lmstudio-models.ts — LM Studio as admission, census and context see it.
 *
 * Every memory decision was written against Ollama's API and then aimed at whatever endpoint was
 * selected. For an LM Studio endpoint that meant `/api/tags` and `/api/show` on port 1234, which
 * LM Studio answers with HTTP 200 and an "Unexpected endpoint" error: the inventory came back
 * empty, every load was allowed (`weightsBytes: 0` ⇒ "nothing to weigh"), and the census probed
 * "ollama" at LM Studio's own port — so the REAL Ollama on 11434, possibly holding 23 GB, was
 * never counted. Two runners fully loaded at once is exactly the documented freeze path.
 *
 * The facts come from `lmstudio-listing.ts` (LM Studio's own REST listing);
 * this module turns them into the shapes admission and the census already speak.
 */
import { type LmStudioModel, fetchLmStudioModels } from "./lmstudio-listing.js";
import { localRunners, portOf } from "./local-runners.js";
import type { ModelCandidate } from "./model-admission.js";

type FetchFn = typeof fetch;

/** A census probe, structurally `RunnerProbe` from engine-bridge. */
export interface CensusProbe {
  id: string;
  baseUrl: string;
  api: "ollama" | "openai" | "lmstudio";
}

/**
 * Which runner a base URL talks to, by its port — local OR remote (a GPU box runs the same
 * runners on the same default ports). `PROMETHEUS_RUNNER_<ID>_URL` / `OLLAMA_HOST` overrides move
 * a runner's port and are honoured. Unknown port ⇒ "ollama", the historical default.
 */
export function runnerIdForUrl(
  baseUrl: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const port = portOf(baseUrl);
  if (port === undefined) return "ollama";
  return localRunners(env).find((r) => r.port === port)?.id ?? "ollama";
}

/** `scheme://host` of a URL, brackets kept on an IPv6 literal. */
function origin(baseUrl: string): { scheme: string; host: string } | null {
  try {
    const u = new URL(baseUrl);
    return { scheme: u.protocol.replace(":", ""), host: u.hostname };
  } catch {
    return null;
  }
}

/**
 * The runners a load on `baseUrl` could collide with, each at ITS OWN port on the same host.
 *
 * The census used to probe `ollama` at the endpoint's own root and skip LM Studio whenever the
 * endpoint WAS LM Studio — so for an LM Studio endpoint it asked LM Studio Ollama questions and
 * never looked at the Ollama next to it. The endpoint's own runner is probed at the endpoint's
 * URL (it may sit on a custom port); the other one at its default.
 */
export function censusProbesFor(
  baseUrl: string,
  env: Record<string, string | undefined> = process.env,
): CensusProbe[] {
  const own = runnerIdForUrl(baseUrl, env);
  const o = origin(baseUrl);
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const at = (port: number): string => (o ? `${o.scheme}://${o.host}:${port}` : root);
  const ports = new Map(localRunners(env).map((r) => [r.id, r.port]));
  return [
    {
      id: "ollama",
      baseUrl: own === "ollama" ? root : at(ports.get("ollama") ?? 11434),
      api: "ollama",
    },
    {
      id: "lmstudio",
      baseUrl: own === "lmstudio" ? root : at(ports.get("lmstudio") ?? 1234),
      api: "lmstudio",
    },
  ];
}

/** LM Studio's chat models as admission candidates (weights = the file size it reports). */
export function lmStudioCandidatesFrom(
  models: readonly LmStudioModel[],
  contextTokens: number,
  opts: { host?: string; resident?: readonly { id: string; sizeBytes: number }[] } = {},
): ModelCandidate[] {
  return models
    .filter((m) => m.type === "llm" && m.sizeBytes > 0)
    .map((m) => {
      const measured = opts.resident?.find((r) => r.id === m.id)?.sizeBytes;
      return {
        id: m.id,
        weightsBytes: m.sizeBytes,
        // never more than the model can take: a 262k window priced for a 32k model is fiction
        contextTokens: m.maxContextLength
          ? Math.min(contextTokens, m.maxContextLength)
          : contextTokens,
        // LM Studio's listing carries no KV geometry: the footprint stays the cautious estimate
        geometry: null,
        runner: "lmstudio",
        ...(measured && measured > m.sizeBytes ? { measuredTotalBytes: measured } : {}),
        ...(opts.host !== undefined ? { host: opts.host } : {}),
      };
    });
}

/** Fetch + convert. `[]` when the server is not an LM Studio, or does not answer. */
export async function lmStudioCandidates(
  baseUrl: string,
  contextTokens: number,
  opts: {
    fetchFn?: FetchFn;
    timeoutMs?: number;
    host?: string;
    resident?: readonly { id: string; sizeBytes: number }[];
  } = {},
): Promise<ModelCandidate[]> {
  const models = await fetchLmStudioModels(baseUrl, {
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return models ? lmStudioCandidatesFrom(models, contextTokens, opts) : [];
}
