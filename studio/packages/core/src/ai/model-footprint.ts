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
  /**
   * The head dimension used by the WINDOWED layers, when it differs (`key_length_swa`).
   *
   * gemma4 reports `key_length = 512` and `key_length_swa = 256`: its sliding-window layers
   * store half-width keys. Charging them the full width over-states that model's cache by
   * ~170 MiB — small next to the weights, and exactly the kind of quiet surcharge that adds up
   * into refusing a model that would have fit.
   */
  keyLengthSwa?: number;
  /** likewise for values (`value_length_swa`). */
  valueLengthSwa?: number;
  /** `block_count` — the layer count, kept because a scalar head count needs it to expand. */
  blockCount?: number;
  /**
   * The context this model was TRAINED for (`*.context_length`).
   *
   * Load-bearing, not decoration: a runner serves `min(requested, this)`, so pricing a KV cache
   * at a 262,144-token setting for a model trained at 8,192 over-counts by 32×. That is the
   * single largest over-estimate this module can make, and `servedContext()` is what stops it.
   */
  contextLength?: number;
}

/**
 * Pull the geometry out of `/api/show`'s `model_info`, whatever the architecture prefix is.
 *
 * `attention.head_count_kv` comes in BOTH shapes. qwen3.6 reports a per-layer array; most
 * models report a single scalar meaning "every layer, this many". Rejecting the scalar — which
 * this function used to do — sent those models down the geometry-less fallback path, where a
 * blanket 24 KiB/token allowance priced a 262k context at 6 GiB of cache the model would never
 * have allocated. The scalar is expanded against `block_count` instead, which is the same fact
 * written more briefly.
 */
export function parseKvGeometry(modelInfo: Record<string, unknown>): KvGeometry | null {
  const pick = (suffix: string): unknown => {
    const key = Object.keys(modelInfo).find((k) => k.endsWith(suffix));
    return key ? modelInfo[key] : undefined;
  };
  const rawHeads = pick(".attention.head_count_kv");
  const keyLengthRaw = pick(".attention.key_length");
  const valueLength = pick(".attention.value_length");
  const blockCountRaw = pick(".block_count");
  const blockCount =
    typeof blockCountRaw === "number" && blockCountRaw > 0 ? Math.round(blockCountRaw) : undefined;
  const embedding = pick(".embedding_length");
  const headCount = pick(".attention.head_count");

  let heads: number[] | null = null;
  if (Array.isArray(rawHeads) && rawHeads.length > 0) {
    const nums = rawHeads.filter((h): h is number => typeof h === "number");
    if (nums.length === rawHeads.length) heads = nums;
  } else if (typeof rawHeads === "number" && rawHeads > 0 && blockCount) {
    // One number for every layer — the common case, and the one that used to be discarded.
    heads = new Array<number>(blockCount).fill(rawHeads);
  }
  if (!heads || heads.length === 0) return null;

  /**
   * The head dimension.
   *
   * `attention.key_length` is authoritative and is what qwen3.6 needs (256, where
   * embedding/heads would say 128). When a model omits it, `embedding_length / head_count` is
   * the definition it omitted, so deriving it is not a guess — and it is far better than
   * discarding the whole geometry over one absent field.
   */
  let keyLength = typeof keyLengthRaw === "number" && keyLengthRaw > 0 ? keyLengthRaw : 0;
  if (
    !keyLength &&
    typeof embedding === "number" &&
    typeof headCount === "number" &&
    headCount > 0
  ) {
    keyLength = Math.round(embedding / headCount);
  }
  if (!keyLength || keyLength <= 0) return null;

  const slidingWindow = pick(".attention.sliding_window");
  const pattern = pick(".attention.sliding_window_pattern");
  const contextLength = pick(".context_length");
  const keyLengthSwa = pick(".attention.key_length_swa");
  const valueLengthSwa = pick(".attention.value_length_swa");
  return {
    headCountKv: heads,
    keyLength,
    valueLength: typeof valueLength === "number" && valueLength > 0 ? valueLength : keyLength,
    ...(typeof keyLengthSwa === "number" && keyLengthSwa > 0 ? { keyLengthSwa } : {}),
    ...(typeof valueLengthSwa === "number" && valueLengthSwa > 0 ? { valueLengthSwa } : {}),
    ...(typeof slidingWindow === "number" && slidingWindow > 0 ? { slidingWindow } : {}),
    ...(Array.isArray(pattern)
      ? { slidingWindowPattern: expandWindowPattern(pattern, heads.length) }
      : {}),
    ...(blockCount ? { blockCount } : {}),
    ...(typeof contextLength === "number" && contextLength > 0 ? { contextLength } : {}),
  };
}

/**
 * Normalise `sliding_window_pattern` to one boolean per layer.
 *
 * Two dialects exist. gemma reports a full per-layer boolean array. Others report a short
 * repeating unit — `[true,true,true,true,true,false]` meaning "5 windowed, then 1 full, and
 * repeat". Reading the short form as a full-length array marks every layer past its end as
 * FULL-window, which over-counts the cache by the same order of magnitude the per-layer fix
 * was introduced to remove, so the short form is tiled instead.
 */
export function expandWindowPattern(pattern: readonly unknown[], layers: number): boolean[] {
  const bools = pattern.map((p) => p === true);
  if (bools.length === 0) return new Array<boolean>(layers).fill(false);
  if (bools.length >= layers) return bools.slice(0, layers);
  const out: boolean[] = [];
  for (let i = 0; i < layers; i++) out.push(bools[i % bools.length] as boolean);
  return out;
}

/**
 * The context a runner will ACTUALLY serve: the request, capped by what the model was trained for.
 *
 * ollama clamps silently. Prometheus must clamp too, or it prices a cache that will never be
 * allocated and refuses a model over memory it was never going to ask for.
 */
export function servedContext(requestedTokens: number, geo?: KvGeometry | null): number {
  const req = Math.max(1, Math.round(requestedTokens));
  const max = geo?.contextLength;
  return max && max > 0 ? Math.min(req, max) : req;
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
  // A windowed layer may store narrower keys and values than a full-attention one — gemma4 does
  // (512 vs 256). Fall back to the full width when the model does not distinguish them.
  const swaKey = geo.keyLengthSwa ?? geo.keyLength;
  const swaValue = geo.valueLengthSwa ?? geo.valueLength;
  let total = 0;
  for (let i = 0; i < geo.headCountKv.length; i++) {
    const kvHeads = geo.headCountKv[i] ?? 0;
    if (kvHeads <= 0) continue; // this layer keeps no cache
    const windowed = geo.slidingWindowPattern?.[i] === true && geo.slidingWindow;
    const cells = windowed ? Math.min(contextTokens, geo.slidingWindow as number) : contextTokens;
    const width = windowed ? swaKey + swaValue : geo.keyLength + geo.valueLength;
    total += cells * kvHeads * width * perElement;
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
   *
   * `calibrated` sits between the two: the KV arithmetic at this context, with the runner
   * overhead SOLVED from a real observation of this model at some other context rather than
   * taken from the flat allowance. See `ai/footprint-ledger.ts`.
   */
  source: "measured" | "calibrated" | "computed" | "estimated";
  /** the context the KV figure assumes. */
  contextTokens: number;
  /**
   * An OPTIMISTIC floor: the least this could plausibly need.
   *
   * Only meaningful on the `estimated` tier, where `totalBytes` is a deliberate ceiling built
   * from a blanket per-token allowance. The gap between the two is the honest width of our
   * ignorance, and a refusal that lands inside that gap is a refusal we have not earned — see
   * `admitModelLoad`, which downgrades it to a warning rather than a no.
   */
  lowerBoundBytes?: number;
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
    lowerBoundBytes: estimatedLowerBound(weightsBytes, contextTokens),
  };
}

/**
 * The least an unknown model could plausibly need at this context.
 *
 * The ceiling assumes every layer caches at full width. The floor assumes the opposite end of
 * what real architectures do: a sparse KV layout on a fraction of layers, and a modest runner
 * overhead. Both are true of models shipping today, which is precisely why a single number
 * cannot be both safe and fair — so the estimated tier carries both.
 */
export function estimatedLowerBound(weightsBytes: number, contextTokens: number): number {
  return Math.round(
    weightsBytes + contextTokens * FLOOR_KV_BYTES_PER_TOKEN + MIN_RUNNER_OVERHEAD_BYTES,
  );
}

/**
 * The optimistic per-token KV allowance.
 *
 * qwen3.6 — a 36B model caching on a quarter of its layers at q8_0 — measures 10.6 KiB/token.
 * A model with grouped-query attention on few layers, or sliding windows, costs a fraction of
 * that. 2 KiB is the low end of what has actually been observed, not a number chosen to be
 * convenient.
 */
export const FLOOR_KV_BYTES_PER_TOKEN = 2 * 1024;

/** The smallest runner overhead observed on this hardware. See `RUNNER_OVERHEAD_BYTES`. */
export const MIN_RUNNER_OVERHEAD_BYTES = 256 * 1024 * 1024;

/**
 * KV bytes per token when the geometry is unknown — a CEILING, and an honest one.
 *
 * This was 24 KiB, described in its own comment as safe. It was not. The arithmetic, once the
 * scalar-geometry fix made it possible to check a dense model:
 *
 *   qwen3.6   10 of 40 layers, 2 kv heads, 256-wide   → 10.6 KiB/token   (measured, in the log)
 *   llama-ish 32 of 32 layers, 8 kv heads, 128-wide   → 69.6 KiB/token   (computed)
 *
 * So 24 KiB over-charged the sparse model by 2× — refusing models that fit, the exact complaint
 * this work exists to answer — while UNDER-charging the dense one by 3×, which is the failure
 * that actually takes a machine down. A number in the middle of a 7× spread is wrong in both
 * directions at once.
 *
 * The fix is not a better single number, because there isn't one. It is:
 *
 *   1. `parseKvGeometry` now succeeds far more often (scalar head counts, derived key lengths),
 *      so this constant is reached only when the runner tells us nothing at all;
 *   2. when it IS reached, the footprint carries `lowerBoundBytes` as well, and `admitModelLoad`
 *      refuses only if the FLOOR does not fit — so a generous ceiling costs a warning, never a
 *      wrongly-refused model.
 *
 * Which frees this to be what it claims to be: high enough to cover a dense model with
 * grouped-query attention on every layer.
 */
export const FALLBACK_KV_BYTES_PER_TOKEN = 72 * 1024;

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
