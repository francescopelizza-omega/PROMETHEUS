/**
 * ai/model-footprint.ts — how much memory a model will actually need, computed rather than guessed.
 *
 * This exists so Prometheus can REFUSE to load a model that does not fit, name the shortfall,
 * and list what does fit — instead of starting the load and letting the machine discover the
 * answer. On Apple Silicon unified memory the discovery is expensive: the compositor starves
 * before jetsam kills anything (CLAUDE.md, Hazard B).
 *
 * ── WHY THE OBVIOUS FORMULA IS WRONG ────────────────────────────────────────────────────────
 *
 * The textbook estimate is `block_count × head_count_kv × head_dim × 2 × bytes × context`. On
 * 2026-09-24 that over-counted gemma by more than 10×, which is what made an earlier attempt at
 * this abandon modelling altogether. Two modern architecture features break it, and both are
 * readable from ollama's own `/api/show` `model_info`:
 *
 *  1. **KV on a SUBSET of layers.** `attention.head_count_kv` is a PER-LAYER ARRAY, not a
 *     scalar. qwen3.6 reports `[0,0,0,2, 0,0,0,2, …]` — 40 layers, of which only 10 keep a KV
 *     cache at all. Multiplying by `block_count` over-counts by 4×.
 *
 *  2. **Sliding-window attention.** gemma4 reports `attention.sliding_window = 1024` with a
 *     `sliding_window_pattern` marking 5 of every 6 layers as windowed. Those layers allocate
 *     1024 cells no matter how large the context is — so their cost does NOT grow with the
 *     window, and treating it as if it did is where the 10× came from.
 *
 * Also: the head dimension is `attention.key_length`, NOT `embedding_length / head_count`.
 * qwen3.6 has embedding 2048 and 16 heads (⇒ 128) but a key_length of 256 — a factor of two.
 *
 * ── VERIFIED AGAINST GROUND TRUTH ───────────────────────────────────────────────────────────
 *
 * ollama logs what it actually allocated. For qwen3.6:latest at 262144 on 2026-09-25:
 *
 *   llama_kv_cache: size = 2720.00 MiB (262144 cells, 10 layers, 1/1 seqs),
 *                   K (q8_0): 1360.00 MiB, V (q8_0): 1360.00 MiB
 *
 * This module's arithmetic: 10 layers × 2 kv-heads × 256 key_length × 1.0625 B/elem
 * = 5440 B/token × 262144 = **1360 MiB** for K. Exact, to the megabyte.
 *
 * Weights come from `/api/tags` (`size`, the on-disk bytes, which is what gets mapped in).
 * When a model is actually resident, `/api/ps` reports the real total and that always wins —
 * a measurement beats a model, and `source` says which one you got.
 */

/** KV cache element encoding. `OLLAMA_KV_CACHE_TYPE` selects this; this repo pins q8_0. */
export type KvCacheType = "f16" | "q8_0" | "q4_0";

/**
 * Bytes per stored element, including the block scales the quantised formats carry.
 *
 * q8_0 stores 32 int8 values plus one fp16 scale per block: (32 + 2) / 32 = 1.0625.
 * q4_0 stores 32 4-bit values plus one fp16 scale: (16 + 2) / 32 = 0.5625.
 */
export function bytesPerElement(type: KvCacheType): number {
  if (type === "f16") return 2;
  if (type === "q4_0") return 0.5625;
  return 1.0625;
}

/** The geometry needed to size a KV cache, as `/api/show` reports it. */
export interface KvGeometry {
  /** per-layer KV head count. A 0 means that layer keeps no KV cache at all. */
  headCountKv: readonly number[];
  /** the K head dimension (`attention.key_length`) — NOT embedding_length / head_count. */
  keyLength: number;
  /** the V head dimension (`attention.value_length`); equals keyLength on most models. */
  valueLength: number;
  /** cells a windowed layer allocates regardless of the context length. */
  slidingWindow?: number;
  /** which layers are windowed; `true` = windowed. Same length as headCountKv. */
  slidingWindowPattern?: readonly boolean[];
}

/** Pull the geometry out of `/api/show`'s `model_info`, whatever the architecture prefix is. */
export function parseKvGeometry(modelInfo: Record<string, unknown>): KvGeometry | null {
  const pick = (suffix: string): unknown => {
    const key = Object.keys(modelInfo).find((k) => k.endsWith(suffix));
    return key ? modelInfo[key] : undefined;
  };
  const headCountKv = pick(".attention.head_count_kv");
  const keyLength = pick(".attention.key_length");
  const valueLength = pick(".attention.value_length");
  if (!Array.isArray(headCountKv) || headCountKv.length === 0) return null;
  if (typeof keyLength !== "number" || keyLength <= 0) return null;
  const heads = headCountKv.filter((h): h is number => typeof h === "number");
  if (heads.length !== headCountKv.length) return null;

  const slidingWindow = pick(".attention.sliding_window");
  const pattern = pick(".attention.sliding_window_pattern");
  return {
    headCountKv: heads,
    keyLength,
    valueLength: typeof valueLength === "number" && valueLength > 0 ? valueLength : keyLength,
    ...(typeof slidingWindow === "number" && slidingWindow > 0 ? { slidingWindow } : {}),
    ...(Array.isArray(pattern) ? { slidingWindowPattern: pattern.map((p) => p === true) } : {}),
  };
}

/**
 * Bytes the KV cache will occupy at `contextTokens`.
 *
 * Summed PER LAYER, because the two things that matter — whether a layer caches at all, and
 * whether it is windowed — are per-layer facts.
 */
export function kvBytesForContext(
  geo: KvGeometry,
  contextTokens: number,
  type: KvCacheType = "q8_0",
): number {
  const perElement = bytesPerElement(type);
  let total = 0;
  for (let i = 0; i < geo.headCountKv.length; i++) {
    const kvHeads = geo.headCountKv[i] ?? 0;
    if (kvHeads <= 0) continue; // this layer keeps no cache
    const windowed = geo.slidingWindowPattern?.[i] === true && geo.slidingWindow;
    const cells = windowed ? Math.min(contextTokens, geo.slidingWindow as number) : contextTokens;
    total += cells * kvHeads * (geo.keyLength + geo.valueLength) * perElement;
  }
  return Math.round(total);
}

/**
 * Non-KV, non-weight cost: compute buffers, the graph, the runner process itself.
 *
 * A flat allowance rather than a model: it is small next to the weights, it does not scale with
 * context, and pretending to know it precisely would add false confidence to a number whose job
 * is to be SAFE. Measured in the 0.5–1.5 GB range on this hardware; 1 GiB is the round number
 * that does not under-promise.
 */
export const RUNNER_OVERHEAD_BYTES = 1024 * 1024 * 1024;

export interface ModelFootprint {
  /** on-disk weight bytes, mapped into memory when the model loads. */
  weightsBytes: number;
  /** KV cache at the requested context. */
  kvBytes: number;
  /** compute buffers + the runner process. */
  overheadBytes: number;
  totalBytes: number;
  /**
   * Where the number came from — the caller SHOWS this, because "we measured this model at
   * 26 GB last time" and "we think it is about 26 GB" deserve different confidence.
   */
  source: "measured" | "computed" | "estimated";
  /** the context the KV figure assumes. */
  contextTokens: number;
}

/**
 * A model's memory footprint at a given context.
 *
 * Three tiers, best first:
 *   - `measured`  — the caller had a real figure (`/api/ps` `size`, or a cached past load).
 *   - `computed`  — weights from `/api/tags` + KV from the verified geometry arithmetic.
 *   - `estimated` — weights only, plus a KV allowance, because the geometry was unavailable.
 *
 * The estimated tier is deliberately PESSIMISTIC: an over-estimate refuses a model that might
 * have fit (recoverable — the user can override), while an under-estimate starts a load that
 * takes the machine down (not recoverable in the moment). Asymmetric costs, asymmetric bias.
 */
export function modelFootprint(opts: {
  weightsBytes: number;
  contextTokens: number;
  geometry?: KvGeometry | null;
  kvCacheType?: KvCacheType;
  /** a real observed total (from `/api/ps`, or remembered from a previous load). */
  measuredTotalBytes?: number;
}): ModelFootprint {
  const { weightsBytes, contextTokens } = opts;
  if (opts.measuredTotalBytes && opts.measuredTotalBytes > 0) {
    return {
      weightsBytes,
      kvBytes: Math.max(0, opts.measuredTotalBytes - weightsBytes),
      overheadBytes: 0,
      totalBytes: opts.measuredTotalBytes,
      source: "measured",
      contextTokens,
    };
  }
  if (opts.geometry) {
    const kvBytes = kvBytesForContext(opts.geometry, contextTokens, opts.kvCacheType ?? "q8_0");
    return {
      weightsBytes,
      kvBytes,
      overheadBytes: RUNNER_OVERHEAD_BYTES,
      totalBytes: weightsBytes + kvBytes + RUNNER_OVERHEAD_BYTES,
      source: "computed",
      contextTokens,
    };
  }
  // No geometry: assume every layer caches and none is windowed — the worst case, on purpose.
  const kvBytes = Math.round(contextTokens * FALLBACK_KV_BYTES_PER_TOKEN);
  return {
    weightsBytes,
    kvBytes,
    overheadBytes: RUNNER_OVERHEAD_BYTES,
    totalBytes: weightsBytes + kvBytes + RUNNER_OVERHEAD_BYTES,
    source: "estimated",
    contextTokens,
  };
}

/**
 * KV bytes per token when the geometry is unknown.
 *
 * qwen3.6 — a 36B MoE that caches on a quarter of its layers — measures 10.6 KiB/token. A dense
 * model of similar size caching on every layer would be several times that, so this is set
 * above the measured figure rather than at it: the fallback's job is to be safe, and the
 * `estimated` source tells the caller to treat it as a ceiling.
 */
export const FALLBACK_KV_BYTES_PER_TOKEN = 24 * 1024;

/** What the machine can actually give a model right now. */
export interface MemoryBudget {
  /** physical RAM (or the remote host's). */
  totalBytes: number;
  /** what a new allocation may realistically take — see `headroomBytes`. */
  availableBytes: number;
  /**
   * Memory deliberately NOT offered to a model: the OS, the compositor, the editor, Prometheus
   * itself. On Apple Silicon the compositor starves before jetsam intervenes, so this is not
   * politeness — it is the difference between a refused load and a dead display.
   */
  headroomBytes: number;
  /** where these numbers describe: this machine, or a named remote host. */
  host?: string;
}

export type Admission =
  | { ok: true; footprint: ModelFootprint; budget: MemoryBudget; spareBytes: number }
  | {
      ok: false;
      footprint: ModelFootprint;
      budget: MemoryBudget;
      shortfallBytes: number;
      reason: string;
    };

/** Would this model fit, with the headroom kept back? */
export function admitModel(footprint: ModelFootprint, budget: MemoryBudget): Admission {
  const usable = Math.max(0, budget.availableBytes - budget.headroomBytes);
  const spare = usable - footprint.totalBytes;
  if (spare >= 0) return { ok: true, footprint, budget, spareBytes: spare };
  return {
    ok: false,
    footprint,
    budget,
    shortfallBytes: -spare,
    reason:
      footprint.source === "measured"
        ? "it needs more memory than is free"
        : "it is expected to need more memory than is free",
  };
}

/** Human bytes. `en-US` pinned so a test is not machine-dependent. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}
