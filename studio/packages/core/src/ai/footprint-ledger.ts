// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/footprint-ledger.ts — what a model ACTUALLY took, remembered, so the next estimate is right.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────────────────────
 *
 * `ai/model-footprint.ts` computes a footprint from architecture. That arithmetic is exact for
 * the KV cache — verified to the megabyte against ollama's own allocation — but two of its three
 * terms are not measurements:
 *
 *   - **weights** come from `/api/tags` `size`, the on-disk GGUF byte count. What is resident is
 *     close to that but not equal to it.
 *   - **overhead** is `RUNNER_OVERHEAD_BYTES`, a flat 1 GiB allowance for compute buffers, the
 *     graph and the runner process. For a 30 GB model that is noise. For a 2 GB model it is a
 *     50% surcharge, and a 50% surcharge is how a model that fits gets refused.
 *
 * An over-estimate is not free. The user's words: refusing a model that would in fact have run,
 * because the estimate was wrong, is the failure mode to design against.
 *
 * ── THE KEY INSIGHT ─────────────────────────────────────────────────────────────────────────
 *
 * ONE real measurement pins the unknown term exactly, at any context:
 *
 *     total = weights + kv(context) + overhead
 *     ⇒ overhead = total − weights − kv(context)        ← solved, not assumed
 *
 * `kv(context)` is the part we can already compute exactly, and `weights` is known. So after a
 * model has loaded once — at ANY context — every future prediction for it, at ANY other context,
 * is `weights + kv(newContext) + thatSolvedOverhead`. That is measurement, not estimation, and
 * it is why this module exists rather than a fudge factor.
 *
 * Observations are cheap to come by and are never gathered by loading anything:
 *   - `/api/ps` reports the real total of whatever is resident right now.
 *   - ollama's own `server.log` records `llama_kv_cache: size` and the tensor buffer sizes for
 *     every load it has ever done, including loads from before Prometheus was installed.
 *
 * ── HONESTY ABOUT WHAT IS KNOWN ─────────────────────────────────────────────────────────────
 *
 * `source` distinguishes the tiers so a surface can say which one it is showing. A calibrated
 * figure is not a measured one and must not be presented as if it were: it is arithmetic anchored
 * to a measurement, which is a real and useful thing to be, and a different thing from having
 * watched the model load at this exact context.
 */

import {
  type KvCacheType,
  type KvGeometry,
  type ModelFootprint,
  RUNNER_OVERHEAD_BYTES,
  estimatedLowerBound,
  kvBytesForContext,
} from "./model-footprint.js";

/**
 * One real observation of a model's memory use.
 *
 * ── THE TWO SOURCES MEASURE DIFFERENT THINGS, AND CONFLATING THEM IS A BUG ──────────────────
 *
 * `/api/ps` reports ONE number: total resident bytes, weights and cache and compute buffers
 * together. It does not break them down.
 *
 * ollama's `server.log` reports the opposite: the KV cache exactly (`llama_kv_cache: size =`)
 * and the mapped tensor buffers exactly (`load_tensors: … buffer size =`), but never their sum
 * with the runner's own overhead included.
 *
 * So a log row is NOT a total. Storing `weights + kv` in `totalBytes` and then solving
 * `overhead = total − weights − kv` yields exactly zero, every time — a systematic
 * under-estimate dressed up as a measurement. `totalBytes` is therefore optional and means what
 * it says: present only when something actually measured the whole.
 */
export interface FootprintObservation {
  /** model id as the runner names it, e.g. "qwen3.6:latest". */
  model: string;
  /** which machine — undefined means the local one. Kept because RAM is a per-host fact. */
  host?: string;
  /** the context it was serving at when observed. */
  contextTokens: number;
  /**
   * TOTAL resident bytes — weights, cache and runner overhead together.
   *
   * Only from a source that measured the whole thing (`/api/ps`). Absent for a log-derived row,
   * which knows its parts but not their sum.
   */
  totalBytes?: number;
  /** the KV cache alone, measured. The log gives this exactly; `/api/ps` does not give it at all. */
  kvBytes?: number;
  /** the weights as actually mapped. */
  weightsBytes?: number;
  /** the KV element type in force, when known. */
  kvType?: KvCacheType;
  /** ISO timestamp. Used to prefer recent observations and to expire stale ones. */
  observedAt: string;
  /** where the number came from — shown to the user, and used to break ties. */
  via: "api-ps" | "server-log" | "load";
}

/** How many observations to keep per model. Enough to spot a change, small enough to stay cheap. */
export const MAX_OBSERVATIONS_PER_MODEL = 8;

/** Total rows kept. A ledger is a cache, not an archive. */
export const MAX_OBSERVATIONS = 200;

/**
 * Observations older than this are ignored when predicting.
 *
 * Not because memory use drifts — it does not — but because a model can be re-pulled at a
 * different quantisation under the SAME tag, and `latest` is a moving target. Thirty days is
 * long enough that a daily user never falls back to arithmetic, short enough that a silent
 * re-quantisation self-corrects.
 */
export const OBSERVATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Identity for a ledger row: a model on a host. */
export function ledgerKey(model: string, host?: string): string {
  return `${host ?? "local"}\u0000${model}`;
}

/** Parse a persisted ledger. Fail-soft: anything unexpected yields an empty list. */
export function parseObservations(raw: unknown): FootprintObservation[] {
  const rows = typeof raw === "string" ? safeJson(raw) : raw;
  if (!Array.isArray(rows)) return [];
  const out: FootprintObservation[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    if (typeof r?.model !== "string" || !r.model) continue;
    if (typeof r.contextTokens !== "number" || !(r.contextTokens > 0)) continue;
    const total = typeof r.totalBytes === "number" && r.totalBytes > 0 ? r.totalBytes : undefined;
    const kv = typeof r.kvBytes === "number" && r.kvBytes >= 0 ? r.kvBytes : undefined;
    // A row that measured neither the whole nor the cache tells us nothing we can use.
    if (total === undefined && kv === undefined) continue;
    out.push({
      model: r.model,
      ...(total !== undefined ? { totalBytes: total } : {}),
      contextTokens: r.contextTokens,
      observedAt: typeof r.observedAt === "string" ? r.observedAt : new Date(0).toISOString(),
      via: r.via === "api-ps" || r.via === "server-log" || r.via === "load" ? r.via : "load",
      ...(typeof r.host === "string" && r.host ? { host: r.host } : {}),
      ...(typeof r.kvBytes === "number" && r.kvBytes >= 0 ? { kvBytes: r.kvBytes } : {}),
      ...(typeof r.weightsBytes === "number" && r.weightsBytes > 0
        ? { weightsBytes: r.weightsBytes }
        : {}),
      ...(r.kvType === "f16" || r.kvType === "q8_0" || r.kvType === "q4_0"
        ? { kvType: r.kvType }
        : {}),
    });
  }
  return out;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Add an observation, keeping the ledger bounded.
 *
 * An observation at a context we have already seen for this model REPLACES the older one rather
 * than accumulating beside it: the newest reading of the same thing is the better reading, and
 * keeping both would let a stale row outvote a fresh one.
 */
export function recordObservation(
  obs: FootprintObservation,
  ledger: readonly FootprintObservation[],
): FootprintObservation[] {
  const key = ledgerKey(obs.model, obs.host);
  const kept = ledger.filter(
    (o) => !(ledgerKey(o.model, o.host) === key && o.contextTokens === obs.contextTokens),
  );
  const forModel = kept.filter((o) => ledgerKey(o.model, o.host) === key);
  const others = kept.filter((o) => ledgerKey(o.model, o.host) !== key);
  const trimmed = [obs, ...forModel]
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .slice(0, MAX_OBSERVATIONS_PER_MODEL);
  return [...trimmed, ...others]
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .slice(0, MAX_OBSERVATIONS);
}

/** Observations for one model on one host, freshest first, stale ones dropped. */
export function observationsFor(
  ledger: readonly FootprintObservation[],
  model: string,
  host: string | undefined,
  now: number = Date.now(),
): FootprintObservation[] {
  const key = ledgerKey(model, host);
  return ledger
    .filter((o) => ledgerKey(o.model, o.host) === key)
    .filter((o) => {
      const t = Date.parse(o.observedAt);
      return !Number.isFinite(t) || now - t <= OBSERVATION_TTL_MS;
    })
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}

/**
 * Solve for the runner's non-weight, non-KV overhead from one observation.
 *
 * Returns null when the observation cannot support the subtraction — no weights figure, no
 * geometry to price the KV with, or an implausible result. "Implausible" is doing real work
 * here: if `weightsBytes` was recorded against a different quantisation of the same tag, the
 * subtraction can go negative or absurdly large, and a silently wrong overhead is worse than
 * falling back to the flat allowance.
 */
export function solveOverhead(
  obs: FootprintObservation,
  geo: KvGeometry | null | undefined,
  weightsBytes: number,
): number | null {
  // Only a source that measured the WHOLE thing can tell us about the part we cannot compute.
  // A log row knows its weights and its cache exactly and their sum not at all, so subtracting
  // them from a "total" it never reported would return zero and call it a measurement.
  if (obs.totalBytes === undefined || !(obs.totalBytes > 0)) return null;
  const w = obs.weightsBytes ?? weightsBytes;
  if (!(w > 0)) return null;
  const kv =
    obs.kvBytes ??
    (geo ? kvBytesForContext(geo, obs.contextTokens, obs.kvType ?? "q8_0") : undefined);
  if (kv === undefined) return null;
  const overhead = obs.totalBytes - w - kv;
  // A negative overhead means the model was smaller in memory than on disk — real (a partially
  // mapped file), but it is not an OVERHEAD, so clamp to zero rather than crediting it.
  if (overhead < 0) return 0;
  // Four gigabytes of "overhead" is not overhead; it is a mismatched weights figure.
  if (overhead > 4 * 1024 * 1024 * 1024) return null;
  return overhead;
}

/** The overhead to use for a model: solved from the freshest usable observation, else the flat one. */
export function calibratedOverhead(
  observations: readonly FootprintObservation[],
  geo: KvGeometry | null | undefined,
  weightsBytes: number,
): { bytes: number; calibrated: boolean } {
  for (const obs of observations) {
    const solved = solveOverhead(obs, geo, weightsBytes);
    if (solved !== null) return { bytes: solved, calibrated: true };
  }
  return { bytes: RUNNER_OVERHEAD_BYTES, calibrated: false };
}

/**
 * A footprint that uses everything actually known about this model.
 *
 * The tiers, best first:
 *
 *   1. **measured**   — an observation at exactly this context. Nothing beats having watched it.
 *   2. **calibrated** — the KV arithmetic at this context, plus an overhead SOLVED from a real
 *                       observation at some other context. This is the tier that stops the flat
 *                       1 GiB allowance from refusing small models.
 *   3. **computed**   — geometry arithmetic plus the flat allowance. Correct, mildly cautious.
 *   4. **estimated**  — no geometry: weights plus a per-token allowance. A ceiling, flagged as one.
 *
 * `resident` short-circuits everything: a model that is loaded RIGHT NOW has a real total, and
 * that is not a prediction at all.
 */
export function ledgerFootprint(opts: {
  model: string;
  host?: string;
  weightsBytes: number;
  contextTokens: number;
  geometry?: KvGeometry | null;
  kvCacheType?: KvCacheType;
  /** a live figure from `/api/ps` for this exact model, if it is resident. */
  residentTotalBytes?: number;
  ledger?: readonly FootprintObservation[];
  now?: number;
  /** fallback per-token KV allowance when there is no geometry. */
  fallbackKvBytesPerToken: number;
}): ModelFootprint {
  const { weightsBytes, contextTokens, geometry } = opts;
  const kvType = opts.kvCacheType ?? "q8_0";

  if (opts.residentTotalBytes && opts.residentTotalBytes > 0) {
    return {
      weightsBytes,
      kvBytes: Math.max(0, opts.residentTotalBytes - weightsBytes),
      overheadBytes: 0,
      totalBytes: opts.residentTotalBytes,
      source: "measured",
      contextTokens,
    };
  }

  const history = observationsFor(opts.ledger ?? [], opts.model, opts.host, opts.now);

  // 1. Something measured the WHOLE model at exactly this context. Unbeatable.
  const exactTotal = history.find(
    (o) => o.contextTokens === contextTokens && o.totalBytes !== undefined,
  );
  if (exactTotal?.totalBytes !== undefined) {
    return {
      weightsBytes,
      kvBytes: exactTotal.kvBytes ?? Math.max(0, exactTotal.totalBytes - weightsBytes),
      overheadBytes: 0,
      totalBytes: exactTotal.totalBytes,
      source: "measured",
      contextTokens,
    };
  }

  /**
   * 2. The KV cache, measured rather than computed.
   *
   * A log row reports the cache's real size at a real cell count, which prices it per token with
   * no architecture reasoning at all — and it is the SAME number the geometry arithmetic is
   * trying to reproduce. So when one exists it is used in preference to the arithmetic: it needs
   * no assumption about which layers cache or which are windowed, and it cannot be wrong about a
   * model whose `/api/show` is incomplete or whose architecture is newer than this code.
   */
  const measuredKv = measuredKvPerToken(history);
  const kvBytes =
    measuredKv !== null
      ? Math.round(measuredKv * contextTokens)
      : geometry
        ? kvBytesForContext(geometry, contextTokens, kvType)
        : null;

  if (kvBytes !== null) {
    const { bytes: overheadBytes, calibrated } = calibratedOverhead(
      history,
      geometry,
      weightsBytes,
    );
    return {
      weightsBytes,
      kvBytes,
      overheadBytes,
      totalBytes: weightsBytes + kvBytes + overheadBytes,
      // Either half being a measurement makes this better than pure arithmetic, and saying so
      // is the difference between a user trusting the number and second-guessing it.
      source: calibrated || measuredKv !== null ? "calibrated" : "computed",
      contextTokens,
    };
  }

  /**
   * No geometry and no measured cache — but two TOTALS at different contexts still price it.
   *
   *     bytesPerToken = (total₂ − total₁) / (context₂ − context₁)
   *
   * The weights and the overhead are identical in both readings, so they cancel: whatever is
   * left over between two totals is the cache, and nothing about the architecture had to be
   * known to find it. This covers a runner whose `/api/show` says nothing useful at all.
   */
  const slope = kvSlope(history);
  const anchor = history.find((o) => o.totalBytes !== undefined);
  if (slope !== null && anchor?.totalBytes !== undefined) {
    const slopeKv = Math.max(0, Math.round(slope * contextTokens));
    const anchorKv = slope * anchor.contextTokens;
    const overheadBytes = Math.max(0, Math.round(anchor.totalBytes - weightsBytes - anchorKv));
    return {
      weightsBytes,
      kvBytes: slopeKv,
      overheadBytes,
      totalBytes: weightsBytes + slopeKv + overheadBytes,
      source: "calibrated",
      contextTokens,
    };
  }

  const fallbackKv = Math.round(contextTokens * opts.fallbackKvBytesPerToken);
  return {
    weightsBytes,
    kvBytes: fallbackKv,
    overheadBytes: RUNNER_OVERHEAD_BYTES,
    totalBytes: weightsBytes + fallbackKv + RUNNER_OVERHEAD_BYTES,
    source: "estimated",
    contextTokens,
    lowerBoundBytes: estimatedLowerBound(weightsBytes, contextTokens),
  };
}

/**
 * KV bytes per token, measured directly.
 *
 * A single log row is enough: it reports the cache's exact size AND the exact cell count it was
 * sized for, so the division needs no second point and no architecture. This is the strongest
 * KV figure available short of the model being resident right now — stronger than the geometry
 * arithmetic, because it cannot be wrong about a model this code has never seen.
 *
 * A WINDOWED model is the one case to be careful about: layers pinned to a sliding window cost
 * the same at 8k as at 256k, so their per-token rate is not constant and extrapolating from a
 * small context over-states a large one. That errs towards caution, which is the safe direction
 * here, and the geometry path handles windows exactly when `/api/show` describes them.
 */
export function measuredKvPerToken(history: readonly FootprintObservation[]): number | null {
  for (const o of history) {
    if (o.kvBytes === undefined || !(o.kvBytes > 0)) continue;
    if (!(o.contextTokens > 0)) continue;
    const perToken = o.kvBytes / o.contextTokens;
    if (!Number.isFinite(perToken) || perToken <= 0 || perToken > 1024 * 1024) continue;
    return perToken;
  }
  return null;
}

/**
 * KV bytes per token, from two observations at different contexts.
 *
 * Null unless there are two usable points and the slope is sane. A negative slope means the two
 * readings disagree about something other than context (a re-quantised model, most likely), and
 * inventing a number from contradictory data is worse than admitting we have none.
 */
export function kvSlope(history: readonly FootprintObservation[]): number | null {
  const withTotals = history.filter((o) => o.totalBytes !== undefined);
  if (withTotals.length < 2) return null;
  const a = withTotals[0] as FootprintObservation;
  const b = withTotals.find((o) => o.contextTokens !== a.contextTokens);
  if (!b || a.totalBytes === undefined || b.totalBytes === undefined) return null;
  const dTotal = a.totalBytes - b.totalBytes;
  const dCtx = a.contextTokens - b.contextTokens;
  if (dCtx === 0) return null;
  const slope = dTotal / dCtx;
  if (!Number.isFinite(slope) || slope <= 0) return null;
  // 1 MiB per token would be a 260 TB cache at a 262k context. Something is wrong; say so.
  if (slope > 1024 * 1024) return null;
  return slope;
}
