// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * lmstudio.ts — what an LM Studio server really holds, and how to make it let go.
 *
 * Everything Prometheus asked LM Studio until now was either the OpenAI catalogue or an Ollama
 * route aimed at LM Studio's port, and both answer the wrong question. Measured on a real
 * install (LM Studio, app bundle `Bionic.app`, 2026-10-22):
 *
 *   GET /v1/models      every DOWNLOADED model, embeddings included, no size, no context,
 *                       no hint of what is loaded — JIT loading makes all of them "servable".
 *   GET /api/v1/models  per model: `type` (llm | embedding), `size_bytes`,
 *                       `max_context_length`, `loaded_instances[]`, capabilities.
 *   GET /api/v0/models  older REST beta: `type` (llm | vlm | embeddings), `state`
 *                       (loaded | not-loaded), `max_context_length`, `loaded_context_length`.
 *   GET /api/tags, /api/ps, /api/version (Ollama routes)
 *                       HTTP **200** with `{"error":"Unexpected endpoint or method. (…)"}` —
 *                       so every `res.ok` check written for Ollama "succeeded" against it.
 *   POST /api/v1/models/unload {instance_id}   frees one loaded instance (404 when not loaded).
 *
 * So this module reads `/api/v1/models`, falls back to `/api/v0/models`, and treats a body that
 * is neither as "not an LM Studio listing" — never as an empty one. Unload goes through the REST
 * route and, when the server is too old for it, through LM Studio's own `lms unload --all`.
 *
 * `lms server stop` — the only "free memory" action Prometheus had — closes the HTTP port and
 * leaves every loaded model resident inside the app. That is why eviction calls `unload` first.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { execCapture } from "./system-probe.js";

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

/** Where `lms` lives: on PATH, else the app's own `~/.lmstudio/bin/lms`. */
export function lmsBinary(
  env: NodeJS.ProcessEnv = process.env,
  opts: { home?: string; exists?: (p: string) => boolean } = {},
): string | null {
  const exists = opts.exists ?? existsSync;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir && exists(join(dir, "lms"))) return join(dir, "lms");
  }
  const bundled = join(opts.home ?? homedir(), ".lmstudio", "bin", "lms");
  return exists(bundled) ? bundled : null;
}

export interface UnloadOutcome {
  /** instance ids that are gone now. */
  unloaded: string[];
  /** instance ids still loaded (with why), when known. */
  failed: { instanceId: string; reason: string }[];
  /** how it was done. */
  via: "rest" | "lms" | "none";
}

/**
 * Unload what LM Studio holds — every loaded instance, or only those of the given model ids.
 *
 * REST first (`POST /api/v1/models/unload`), because it needs no binary and works the same on a
 * remote LM Studio. When the server is too old for that route it answers with LM Studio's
 * "Unexpected endpoint" error, and `lms unload --all` is used instead (local only, and only when
 * nothing narrower was asked for — `--all` cannot be told to spare a model).
 */
export async function unloadLmStudio(
  baseUrl: string,
  opts: {
    fetchFn?: FetchFn;
    timeoutMs?: number;
    only?: readonly string[];
    lms?: string | null;
    run?: (bin: string, args: string[]) => Promise<{ code: number; stderr: string }>;
  } = {},
): Promise<UnloadOutcome> {
  const f = opts.fetchFn ?? fetch;
  const models = await fetchLmStudioModels(baseUrl, opts);
  if (!models) return { unloaded: [], failed: [], via: "none" };
  const targets = models
    .filter((m) => !opts.only || opts.only.includes(m.id))
    .flatMap((m) => m.loaded.map((i) => i.instanceId));
  if (targets.length === 0) return { unloaded: [], failed: [], via: "none" };

  const unloaded: string[] = [];
  const failed: { instanceId: string; reason: string }[] = [];
  let restMissing = false;
  for (const instanceId of targets) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await f(`${lmStudioRoot(baseUrl)}/api/v1/models/unload`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instance_id: instanceId }),
        signal: ac.signal,
      });
      const body = rec(await res.json().catch(() => ({})));
      if (typeof body.error === "string" && /unexpected endpoint/i.test(body.error)) {
        restMissing = true;
        break;
      }
      if (res.ok && !body.error) unloaded.push(instanceId);
      else {
        const e = rec(body.error);
        failed.push({ instanceId, reason: str(e.message) ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      failed.push({ instanceId, reason: (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  }
  if (!restMissing) return { unloaded, failed, via: "rest" };

  const bin = opts.lms === undefined ? lmsBinary() : opts.lms;
  if (!bin || opts.only) {
    return {
      unloaded: [],
      failed: targets.map((instanceId) => ({
        instanceId,
        reason: bin ? "this LM Studio cannot unload one model by REST" : "`lms` not found",
      })),
      via: "none",
    };
  }
  const run =
    opts.run ??
    ((b: string, a: string[]) => execCapture(b, a, { timeoutMs: 30_000 }).then((r) => r));
  const r = await run(bin, ["unload", "--all"]);
  return r.code === 0
    ? { unloaded: targets, failed: [], via: "lms" }
    : {
        unloaded: [],
        failed: targets.map((instanceId) => ({
          instanceId,
          reason: r.stderr.trim() || `lms exited ${r.code}`,
        })),
        via: "lms",
      };
}

/** True when an HTTP-200 body is LM Studio's answer to a route it does not have. */
export function isLmStudioUnknownRoute(json: unknown): boolean {
  const e = rec(json).error;
  return typeof e === "string" && /unexpected endpoint or method/i.test(e);
}

/**
 * `keep_alive` ("60s", "5m", "1h", "300") → LM Studio's `ttl` in seconds. LM Studio ignores
 * Ollama's field, so a JIT-loaded model stayed resident for LM Studio's own idle default (about
 * an hour) instead of the 60 s Prometheus asks every other runner for. `undefined` for "never
 * unload" (`-1`, `0` means unload now and is not a TTL) or anything unparseable.
 */
export function ttlSecondsFromKeepAlive(keepAlive: string | undefined): number | undefined {
  if (!keepAlive) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(keepAlive.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const secs = unit === "ms" ? n / 1000 : unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n;
  const whole = Math.ceil(secs);
  return whole >= 1 ? whole : undefined;
}

/**
 * The context Prometheus plans an UNLOADED LM Studio model at — for the RAM check and for the
 * session's context budget. A JIT load uses the model's own default (set per model in LM Studio),
 * which no API reports before it happens; pricing at the architecture maximum (262k here) made a
 * model that loads in 24 GiB look like 46 GB and refused it on smaller machines.
 * `PROMETHEUS_LMSTUDIO_CONTEXT` overrides. Mirrored in core `ai/lmstudio-listing.ts`.
 */
export const LMSTUDIO_PLAN_CONTEXT = 32768;

export function lmStudioPlanContext(
  maxContext: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const asked = Number(env.PROMETHEUS_LMSTUDIO_CONTEXT);
  const plan = Number.isInteger(asked) && asked >= 512 ? asked : LMSTUDIO_PLAN_CONTEXT;
  return maxContext ? Math.min(maxContext, plan) : plan;
}

/** `Estimated Total Memory: 24.31 GiB` (lms load --estimate-only) → bytes, or null. */
export function parseLmsEstimate(out: string): number | null {
  const m = /Estimated Total Memory:\s*([\d.]+)\s*(GiB|GB|MiB|MB|KiB|KB|B)\b/i.exec(out);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] as string).toLowerCase();
  const mult =
    unit === "gib" ? 2 ** 30 : unit === "gb" ? 1e9 : unit === "mib" ? 2 ** 20 : unit === "mb" ? 1e6 : unit === "kib" ? 1024 : unit === "kb" ? 1e3 : 1;
  return Number.isFinite(n) && n > 0 ? Math.round(n * mult) : null;
}

/**
 * LM Studio's OWN memory estimate for loading `model` at `contextLength` — `lms load
 * --estimate-only`, which loads nothing (verified 2026-10-22: no instance appears in `lms ps`).
 * Measured on a hybrid MoE: 24.31 GiB at 32k and at 262k, where KV arithmetic without the
 * model's geometry said 46.5 GB. null when `lms` is absent or says nothing parseable.
 */
export async function lmsEstimateBytes(
  model: string,
  contextLength: number,
  opts: {
    lms?: string | null;
    run?: (bin: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  } = {},
): Promise<number | null> {
  const bin = opts.lms === undefined ? lmsBinary() : opts.lms;
  if (!bin || model.startsWith("-")) return null;
  const run =
    opts.run ?? ((b: string, a: string[]) => execCapture(b, a, { timeoutMs: 30_000 }));
  const r = await run(bin, ["load", model, "-c", String(contextLength), "--estimate-only", "-y"]);
  return r.code === 0 ? parseLmsEstimate(r.stdout) : null;
}
