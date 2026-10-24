// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/lmstudio-listing.ts — LM Studio's own model listing, parsed. PURE: no node, no imports.
 *
 * The sandboxed desktop renderer imports `context-window.ts`, which needs this, so it cannot
 * come from `@prometheus/engine-bridge` (node, child_process). engine-bridge keeps a twin in
 * `lmstudio.ts` for the watchdog's unload; `lmstudio-listing.test.ts` pins the two to the same
 * answers on the same bodies, so they cannot drift.
 *
 * What LM Studio really serves, measured 2026-10-22 (app bundle `Bionic.app`):
 *   GET /v1/models      every DOWNLOADED model, embeddings included; no size, context or state.
 *   GET /api/v1/models  `type`, `size_bytes`, `max_context_length`, `loaded_instances[]`.
 *   GET /api/v0/models  older beta: `type`, `state`, `max_context_length`, `loaded_context_length`.
 *   Ollama routes       HTTP 200 + `{"error":"Unexpected endpoint or method. (…)"}`.
 */

type FetchFn = typeof fetch;

export interface LmStudioInstance {
  /** the identifier `/api/v1/models/unload` takes. */
  instanceId: string;
  /** the context this instance was loaded with, when reported. */
  contextLength?: number;
}

/** One model in LM Studio's own listing. */
export interface LmStudioModel {
  id: string;
  /** `llm` (vision models included: `vision` says which), `embedding`, or anything else. */
  type: "llm" | "embedding" | "other";
  vision: boolean;
  /** bytes on disk; 0 when the listing does not say (the v0 beta never does). */
  sizeBytes: number;
  maxContextLength?: number;
  /** loaded right now. Empty ⇒ not resident, whatever `/v1/models` claims. */
  loaded: LmStudioInstance[];
  toolUse: boolean;
  /** the model can reason (thinking) — `capabilities.reasoning` on v1. */
  reasoning: boolean;
  architecture?: string;
  quantization?: string;
}

/** Strip a trailing `/v1` and slashes: LM Studio's REST routes hang off the server root. */
export function lmStudioRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined;
}

function str(x: unknown): string | undefined {
  return typeof x === "string" && x.length > 0 ? x : undefined;
}

function rec(x: unknown): Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
}

function kind(raw: unknown): LmStudioModel["type"] {
  const t = typeof raw === "string" ? raw.toLowerCase() : "";
  if (t === "llm" || t === "vlm") return "llm";
  if (t === "embedding" || t === "embeddings") return "embedding";
  return "other";
}

function instanceFrom(raw: unknown, fallbackId: string): LmStudioInstance | null {
  if (typeof raw === "string") return raw ? { instanceId: raw } : null;
  const r = rec(raw);
  const id =
    str(r.id) ?? str(r.identifier) ?? str(r.instance_id) ?? str(r.instanceId) ?? fallbackId;
  const cfg = rec(r.config);
  const ctx =
    num(cfg.context_length) ??
    num(cfg.contextLength) ??
    num(r.context_length) ??
    num(r.contextLength);
  return { instanceId: id, ...(ctx ? { contextLength: ctx } : {}) };
}

/**
 * Parse `/api/v1/models` (`{models:[…]}`) or `/api/v0/models` (`{data:[…]}` WITH `type`/`state`).
 *
 * `null` means "this is not an LM Studio listing": an Ollama-route error body, the plain OpenAI
 * catalogue (no `type`, no `state` — it cannot say what is loaded), a proxy page. Callers must
 * not read `null` as "nothing loaded".
 */
export function parseLmStudioModels(json: unknown): LmStudioModel[] | null {
  const body = rec(json);
  if (Array.isArray(body.models)) {
    const out: LmStudioModel[] = [];
    for (const raw of body.models) {
      const m = rec(raw);
      const id = str(m.key) ?? str(m.id) ?? str(m.modelKey);
      if (!id) continue;
      const caps = rec(m.capabilities);
      const quant = m.quantization;
      const loadedRaw = Array.isArray(m.loaded_instances) ? m.loaded_instances : [];
      out.push({
        id,
        type: kind(m.type),
        vision: caps.vision === true || String(m.type).toLowerCase() === "vlm",
        sizeBytes: num(m.size_bytes) ?? num(m.sizeBytes) ?? 0,
        ...(num(m.max_context_length) ? { maxContextLength: num(m.max_context_length) } : {}),
        loaded: loadedRaw
          .map((i) => instanceFrom(i, id))
          .filter((i): i is LmStudioInstance => i !== null),
        toolUse: caps.trained_for_tool_use === true || m.trainedForToolUse === true,
        reasoning: Object.keys(rec(caps.reasoning)).length > 0 || caps.reasoning === true,
        ...(str(m.architecture) ? { architecture: str(m.architecture) } : {}),
        ...((str(rec(quant).name) ?? str(quant))
          ? { quantization: (str(rec(quant).name) ?? str(quant)) as string }
          : {}),
      });
    }
    return out;
  }
  if (Array.isArray(body.data)) {
    const rows = body.data.map(rec);
    // The OpenAI catalogue has the same `data` key; only the beta adds `type` and `state`.
    if (!rows.some((r) => typeof r.state === "string" || typeof r.type === "string")) return null;
    const out: LmStudioModel[] = [];
    for (const m of rows) {
      const id = str(m.id);
      if (!id) continue;
      const caps = Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
      const loadedCtx = num(m.loaded_context_length);
      out.push({
        id,
        type: kind(m.type),
        vision: String(m.type).toLowerCase() === "vlm",
        sizeBytes: 0,
        ...(num(m.max_context_length) ? { maxContextLength: num(m.max_context_length) } : {}),
        loaded:
          m.state === "loaded"
            ? [{ instanceId: id, ...(loadedCtx ? { contextLength: loadedCtx } : {}) }]
            : [],
        toolUse: caps.includes("tool_use"),
        reasoning: caps.includes("reasoning"),
        ...(str(m.arch) ? { architecture: str(m.arch) } : {}),
        ...(str(m.quantization) ? { quantization: str(m.quantization) } : {}),
      });
    }
    return out;
  }
  return null;
}

/**
 * Ask an LM Studio server for its models: `/api/v1/models`, else `/api/v0/models`.
 * `null` when neither route answers with an LM Studio listing. Never throws.
 */
export async function fetchLmStudioModels(
  baseUrl: string,
  opts: { fetchFn?: FetchFn; timeoutMs?: number } = {},
): Promise<LmStudioModel[] | null> {
  const f = opts.fetchFn ?? fetch;
  const root = lmStudioRoot(baseUrl);
  for (const path of ["/api/v1/models", "/api/v0/models"]) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 2000);
    try {
      const res = await f(`${root}${path}`, { signal: ac.signal });
      if (!res.ok) continue;
      const parsed = parseLmStudioModels(await res.json());
      if (parsed) return parsed;
    } catch {
      /* unreachable / not JSON — try the next route, then give up */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** A model that can chat (an `llm`, vision included) — never an embedding model. */
export function isLmStudioChatModel(m: LmStudioModel): boolean {
  return m.type === "llm";
}

/**
 * The context a request to this model is measured against: the LOADED instance's window when
 * one is loaded (the smallest, if several), else the architecture maximum — which is what a JIT
 * load is asked for only when the caller loads it explicitly (see `lmStudioLoadArgs`).
 */
export function lmStudioServedContext(m: LmStudioModel): number | undefined {
  const loaded = m.loaded.map((i) => i.contextLength).filter((n): n is number => !!n);
  if (loaded.length > 0) return Math.min(...loaded);
  // not loaded: what a JIT load will get is not knowable in advance — plan at a bounded
  // context rather than the architecture maximum (see lmStudioPlanContext)
  return lmStudioPlanContext(m.maxContextLength);
}

/** The chat models, loaded first, then tool-trained, then the rest — the order a picker offers. */
export function rankLmStudioChatModels(models: readonly LmStudioModel[]): LmStudioModel[] {
  const score = (m: LmStudioModel): number => (m.loaded.length > 0 ? 2 : 0) + (m.toolUse ? 1 : 0);
  return models
    .filter(isLmStudioChatModel)
    .map((m, i) => ({ m, i }))
    .sort((a, b) => score(b.m) - score(a.m) || a.i - b.i)
    .map(({ m }) => m);
}

/** True when an HTTP-200 body is LM Studio's answer to a route it does not have. */
export function isLmStudioUnknownRoute(json: unknown): boolean {
  const e = rec(json).error;
  return typeof e === "string" && /unexpected endpoint or method/i.test(e);
}

/** The context an UNLOADED model is planned at — see engine-bridge `lmStudioPlanContext`. */
export const LMSTUDIO_PLAN_CONTEXT = 32768;

export function lmStudioPlanContext(
  maxContext: number | undefined,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): number {
  const asked = Number(env.PROMETHEUS_LMSTUDIO_CONTEXT);
  const plan = Number.isInteger(asked) && asked >= 512 ? asked : LMSTUDIO_PLAN_CONTEXT;
  return maxContext ? Math.min(maxContext, plan) : plan;
}
