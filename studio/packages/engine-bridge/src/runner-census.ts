/**
 * runner-census.ts — which model servers are up, and what are they holding?
 *
 * The admission rule "one model server at a time" needs an answer to "is one already running",
 * and nothing in the repo could answer it. `service-shutdown.ts` reads ollama's `/api/ps` for an
 * exit-time prompt, `model-server.ts` finds a server by `lsof` on a port, and neither counts
 * runners or reports what they hold. `detectBackends` starts every known runner in a
 * `Promise.all`, so a single CLI boot could cold-start two of them, each sampling free memory
 * before the other had loaded anything.
 *
 * HTTP, NOT `lsof` or `ps`. A census over the runner's own API is the only one that works
 * unchanged against a REMOTE host — which is the whole point, because when Prometheus drives a
 * model server on another machine the memory that matters is that machine's. Give this a
 * `baseUrl` on the LAN and it reports that host's residency with no other change.
 *
 * Fail-soft everywhere: a runner that does not answer is ABSENT, never an error. A census that
 * throws would block the very load it exists to permit.
 */

/** A runner we know how to ask. */
export interface RunnerProbe {
  /** stable id used by the admission rules — "ollama", "lmstudio". */
  id: string;
  /** e.g. "http://127.0.0.1:11434" */
  baseUrl: string;
  /** which dialect its residency endpoint speaks. */
  api: "ollama" | "openai";
}

/** The two runners this repo models today (`core/src/ai/local-runners.ts`). */
export const DEFAULT_RUNNERS: readonly RunnerProbe[] = Object.freeze([
  { id: "ollama", baseUrl: "http://127.0.0.1:11434", api: "ollama" },
  { id: "lmstudio", baseUrl: "http://127.0.0.1:1234", api: "openai" },
]);

export interface ResidentModelInfo {
  id: string;
  /** bytes held in memory. 0 when the runner does not report it. */
  sizeBytes: number;
  /** bytes on the accelerator, when distinguished. */
  vramBytes?: number;
  /** the context it was loaded with, when reported. */
  contextTokens?: number;
}

export interface RunnerStatus {
  runner: string;
  baseUrl: string;
  /** did it answer at all? */
  up: boolean;
  /** models resident right now. Empty for a daemon that is up but idle. */
  models: ResidentModelInfo[];
  host?: string;
}

type FetchFn = typeof fetch;

/** Parse ollama `/api/ps`. Tolerant: any field may be missing on an older build. */
export function parseOllamaPs(json: unknown): ResidentModelInfo[] {
  const rows = (json as { models?: unknown })?.models;
  if (!Array.isArray(rows)) return [];
  const out: ResidentModelInfo[] = [];
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    const id =
      typeof row.name === "string" ? row.name : typeof row.model === "string" ? row.model : "";
    if (!id) continue;
    out.push({
      id,
      sizeBytes: typeof row.size === "number" ? row.size : 0,
      ...(typeof row.size_vram === "number" ? { vramBytes: row.size_vram } : {}),
      ...(typeof row.context_length === "number" ? { contextTokens: row.context_length } : {}),
    });
  }
  return out;
}

/**
 * Parse an OpenAI-shaped `/v1/models`.
 *
 * LM Studio lists models it can serve, not models it currently HOLDS, and reports no sizes — so
 * this answers "is a runner up" honestly and "how much is it holding" not at all. `sizeBytes: 0`
 * is therefore the truth rather than a placeholder, and the one-server rule (which only needs to
 * know that something is loaded) is what actually protects memory here.
 */
export function parseOpenAiModels(json: unknown): ResidentModelInfo[] {
  const rows = (json as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => (r as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => ({ id, sizeBytes: 0 }));
}

/** Ask ONE runner. Never throws; an unreachable runner is `up: false`. */
export async function probeRunner(
  probe: RunnerProbe,
  opts: { fetchFn?: FetchFn; timeoutMs?: number; host?: string } = {},
): Promise<RunnerStatus> {
  const f = opts.fetchFn ?? fetch;
  const base = probe.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const path = probe.api === "ollama" ? "/api/ps" : "/v1/models";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 2000);
  try {
    const res = await f(`${base}${path}`, { signal: ac.signal });
    if (!res.ok) return { runner: probe.id, baseUrl: probe.baseUrl, up: false, models: [] };
    const json = (await res.json()) as unknown;
    return {
      runner: probe.id,
      baseUrl: probe.baseUrl,
      up: true,
      models: probe.api === "ollama" ? parseOllamaPs(json) : parseOpenAiModels(json),
      ...(opts.host ? { host: opts.host } : {}),
    };
  } catch {
    // Unreachable, refused, timed out, or answered something that is not JSON — all mean the
    // same thing for admission: it is not holding weights we have to plan around.
    return { runner: probe.id, baseUrl: probe.baseUrl, up: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask every runner, concurrently. Only those that answered are returned. */
export async function runnerCensus(
  probes: readonly RunnerProbe[] = DEFAULT_RUNNERS,
  opts: { fetchFn?: FetchFn; timeoutMs?: number; host?: string } = {},
): Promise<RunnerStatus[]> {
  const all = await Promise.all(probes.map((p) => probeRunner(p, opts)));
  return all.filter((s) => s.up);
}

/** Total bytes held across every runner in a census. */
export function residentBytes(census: readonly RunnerStatus[]): number {
  return census.reduce((sum, s) => sum + s.models.reduce((n, m) => n + m.sizeBytes, 0), 0);
}
