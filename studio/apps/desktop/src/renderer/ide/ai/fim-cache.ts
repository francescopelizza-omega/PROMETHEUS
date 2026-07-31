/**
 * ai/fim-cache.ts — PURE ghost-text FIM (fill-in-the-middle) prompt shaping + completion
 * cache (APP-092). No react / monaco / electron — node:test-able.
 *
 * FIM prompt tokens are model-FAMILY-specific (a wrong template yields garbage), so
 * `fimTemplate` gates on a KNOWN family (Qwen2.5-Coder / CodeLlama / StarCoder / DeepSeek)
 * and returns null otherwise → the caller disables FIM for an unknown model rather than
 * sending a malformed prompt. The cache keys on a TRAILING prefix window + LEADING suffix
 * window (not the whole prefix, which would bust on every keystroke) so re-typing over the
 * same boundary replays a cached completion; it is an LRU (~50) and MUST be dropped whole on
 * an active-file switch (a boundary collision across files would replay a wrong completion).
 */

/** Known FIM model families (each has a distinct prompt token set). */
export type FimFamily = "qwen" | "codellama" | "starcoder" | "deepseek";

/**
 * Detect the FIM family from a model id/name (case-insensitive substring match). Returns
 * null for a model with no known FIM template — the caller then disables FIM for it.
 */
export function fimFamilyOf(modelId: string | undefined | null): FimFamily | null {
  if (!modelId) return null;
  const id = modelId.toLowerCase();
  if (id.includes("qwen")) return "qwen";
  if (id.includes("deepseek")) return "deepseek";
  if (id.includes("starcoder") || id.includes("starcoder2")) return "starcoder";
  if (id.includes("codellama") || id.includes("code-llama") || id.includes("code_llama"))
    return "codellama";
  return null;
}

/**
 * Build the family-specific FIM prompt from the prefix (text before the cursor) and suffix
 * (text after). Returns null for an unknown family so the caller can disable FIM (never send
 * a malformed prompt). The templates:
 *   qwen/starcoder/deepseek : `<|fim_prefix|>{pre}<|fim_suffix|>{suf}<|fim_middle|>`
 *                             (starcoder uses the un-piped `<fim_prefix>` variant)
 *   codellama               : `<PRE> {pre} <SUF>{suf} <MID>`
 */
export function fimTemplate(
  family: FimFamily | null,
  prefix: string,
  suffix: string,
): string | null {
  switch (family) {
    case "qwen":
    case "deepseek":
      return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
    case "starcoder":
      return `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`;
    case "codellama":
      return `<PRE> ${prefix} <SUF>${suffix} <MID>`;
    default:
      return null;
  }
}

/** The default prefix/suffix window sizes for the cache key (chars). */
export const FIM_PREFIX_WINDOW = 512;
export const FIM_SUFFIX_WINDOW = 256;

/**
 * The cache key for a cursor boundary: the LAST `prefixWindow` chars of the prefix + a NUL
 * separator + the FIRST `suffixWindow` chars of the suffix. Keying on a window (not the full
 * prefix) means re-typing the same boundary hits the cache instead of busting on every char.
 */
export function fimCacheKey(
  prefix: string,
  suffix: string,
  prefixWindow = FIM_PREFIX_WINDOW,
  suffixWindow = FIM_SUFFIX_WINDOW,
): string {
  const pre = prefix.length > prefixWindow ? prefix.slice(prefix.length - prefixWindow) : prefix;
  const suf = suffix.length > suffixWindow ? suffix.slice(0, suffixWindow) : suffix;
  return `${pre}\u0000${suf}`;
}

/**
 * A tiny LRU cache of FIM completions keyed by the boundary window (fimCacheKey). Insertion/
 * access order is the eviction order (Map preserves it): a `get` re-inserts to mark recency,
 * and inserting past `capacity` evicts the oldest. `clear()` drops everything — the caller
 * MUST call it on an active-file switch so a boundary collision across files can't replay a
 * wrong completion (the refinement's requirement).
 */
export class FimCache {
  private readonly map = new Map<string, string>();
  private readonly capacity: number;

  constructor(capacity = 50) {
    this.capacity = Math.max(1, capacity);
  }

  /** Look up a cached completion for `prefix`/`suffix`; marks it most-recently-used on a hit. */
  get(prefix: string, suffix: string): string | undefined {
    const key = fimCacheKey(prefix, suffix);
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    // re-insert to move to the most-recent end (LRU recency).
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  /** Cache `completion` for the `prefix`/`suffix` boundary, evicting the oldest past capacity. */
  set(prefix: string, suffix: string, completion: string): void {
    const key = fimCacheKey(prefix, suffix);
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, completion);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Drop the whole cache (call on active-file switch — a cross-file collision is unsafe). */
  clear(): void {
    this.map.clear();
  }

  /** Current entry count (for tests / diagnostics). */
  get size(): number {
    return this.map.size;
  }
}
