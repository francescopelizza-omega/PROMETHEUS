/**
 * ai/ollama-inventory.ts — what models exist on a host, how big they are, and how their cache scales.
 *
 * `model-candidates.ts` builds the `/model` picker's list and carries no size metadata at all,
 * so nothing downstream could answer "will this one fit?". This module is that missing half: it
 * asks the runner what it has (`/api/tags` → weight bytes) and how each model is shaped
 * (`/api/show` → the KV geometry `ai/model-footprint.ts` needs).
 *
 * `baseUrl` is a parameter, never a constant. The same functions answer for `127.0.0.1:11434`
 * and for a GPU box on the LAN, which is what lets the RAM rules apply to the machine that
 * actually runs the model rather than the one running Prometheus.
 *
 * Fail-soft throughout: an unreachable runner is an empty inventory, and a model whose geometry
 * cannot be read still gets a candidate — with `geometry: null`, which makes the footprint
 * estimate deliberately pessimistic rather than absent.
 */
import type { ModelCandidate } from "./model-admission.js";
import { type KvGeometry, parseKvGeometry } from "./model-footprint.js";

type FetchFn = typeof fetch;

/** One row of `/api/tags`. */
export interface InstalledModel {
  name: string;
  /** on-disk bytes. */
  sizeBytes: number;
  parameterSize?: string;
  quantization?: string;
}

/** Strip a trailing `/v1` (the OpenAI shim) so native `/api/*` paths resolve. */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** `/api/tags` → the installed models with their weight sizes. `[]` on any failure. */
export async function listInstalledModels(
  baseUrl: string,
  opts: { fetchFn?: FetchFn; timeoutMs?: number } = {},
): Promise<InstalledModel[]> {
  const f = opts.fetchFn ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await f(`${ollamaRoot(baseUrl)}/api/tags`, { signal: ac.signal });
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: unknown };
    if (!Array.isArray(json.models)) return [];
    const out: InstalledModel[] = [];
    for (const row of json.models) {
      const m = row as Record<string, unknown>;
      const name = typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : "";
      if (!name) continue;
      const details = (m.details ?? {}) as Record<string, unknown>;
      out.push({
        name,
        sizeBytes: typeof m.size === "number" ? m.size : 0,
        ...(typeof details.parameter_size === "string"
          ? { parameterSize: details.parameter_size }
          : {}),
        ...(typeof details.quantization_level === "string"
          ? { quantization: details.quantization_level }
          : {}),
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** `/api/show` → the KV geometry, or null when it cannot be read. */
export async function fetchModelGeometry(
  baseUrl: string,
  model: string,
  opts: { fetchFn?: FetchFn; timeoutMs?: number } = {},
): Promise<KvGeometry | null> {
  const f = opts.fetchFn ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await f(`${ollamaRoot(baseUrl)}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { model_info?: unknown };
    const info = json.model_info;
    if (!info || typeof info !== "object") return null;
    return parseKvGeometry(info as Record<string, unknown>);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every installed model as an admission candidate, at a given serving context.
 *
 * Geometry is fetched CONCURRENTLY but bounded by the caller's timeout, because this runs in
 * front of an interactive `/model` switch: a runner that has gone slow must cost the user a
 * pessimistic estimate, not a hang. A `geometry: null` candidate still works — the footprint is
 * simply the cautious one.
 */
export async function inventoryCandidates(
  baseUrl: string,
  contextTokens: number,
  opts: {
    fetchFn?: FetchFn;
    timeoutMs?: number;
    runner?: string;
    resident?: readonly { id: string; sizeBytes: number }[];
  } = {},
): Promise<ModelCandidate[]> {
  const models = await listInstalledModels(baseUrl, opts);
  const runner = opts.runner ?? "ollama";
  return Promise.all(
    models.map(async (m): Promise<ModelCandidate> => {
      const geometry = await fetchModelGeometry(baseUrl, m.name, opts);
      // A model that is resident RIGHT NOW has a real measured total — always better than
      // arithmetic, and free to read since the census already fetched it.
      const measured = opts.resident?.find((r) => r.id === m.name)?.sizeBytes;
      return {
        id: m.name,
        weightsBytes: m.sizeBytes,
        contextTokens,
        geometry,
        runner,
        ...(measured && measured > 0 ? { measuredTotalBytes: measured } : {}),
      };
    }),
  );
}
