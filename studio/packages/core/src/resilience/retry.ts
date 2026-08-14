/**
 * resilience/retry.ts — bounded retry with exponential backoff + full jitter.
 *
 * A pure, dependency-free resilience primitive the engine-bridge / agent / sidecar
 * calls can wrap to ride out transient failures (a flaky spawn, a momentary FS lock)
 * WITHOUT masking real ones. AbortSignal-aware (fail-fast on cancel); `retryOn` decides
 * what is transient (default: retry everything); `sleep`/`rng` are injected so the
 * backoff schedule is deterministic in tests (no real timers, no Math.random).
 */

export interface RetryOptions {
  /** max ADDITIONAL attempts after the first (default 3 → up to 4 total). */
  retries?: number;
  /** base backoff in ms (default 100). */
  baseMs?: number;
  /** exponential growth factor (default 2). */
  factor?: number;
  /** per-delay ceiling in ms (default 10_000). */
  maxMs?: number;
  /** apply full jitter to each delay (default true). */
  jitter?: boolean;
  /** abort: a triggered signal fails fast (no further attempts). */
  signal?: AbortSignal;
  /** decide whether an error is retryable (default: all errors retry). */
  retryOn?: (err: unknown, attempt: number) => boolean;
  /** injected sleeper (default real setTimeout) — tests pass a synchronous fake. */
  sleep?: (ms: number) => Promise<void>;
  /** injected RNG in [0,1) for jitter (default Math.random) — tests pin it. */
  rng?: () => number;
  /** observe each scheduled retry (for logging/telemetry). */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /**
   * Override the computed delay for THIS error.
   *
   * Exists because some failures carry their own advice — an HTTP `Retry-After` is the
   * canonical case — and a backoff curve is a guess competing with a fact. Without this hook a
   * caller has to either abandon this primitive and write its own loop, or smuggle the real
   * delay through the injected `sleep`, which makes `sleep` mean two things.
   *
   * Receives the error, the 0-based attempt, and the delay the curve produced (post-jitter).
   */
  delayFor?: (err: unknown, attempt: number, computedMs: number) => number;
}

/** Raised when a retry loop is aborted via its AbortSignal. */
export class AbortError extends Error {
  constructor(message = "operation aborted") {
    super(message);
    this.name = "AbortError";
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The pre-jitter exponential delay for a 0-based attempt index (capped at maxMs). */
export function backoffDelay(attempt: number, opts: RetryOptions = {}): number {
  const base = opts.baseMs ?? 100;
  const factor = opts.factor ?? 2;
  const max = opts.maxMs ?? 10_000;
  return Math.min(max, Math.round(base * factor ** Math.max(0, attempt)));
}

/**
 * Run `fn` with bounded retries. `fn` receives the 0-based attempt index. On a
 * retryable failure it backs off (`backoffDelay` × optional full jitter) and retries;
 * out of retries (or a non-retryable error, or an abort) it throws the last error.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 3);
  const jitter = opts.jitter !== false;
  const retryOn = opts.retryOn ?? (() => true);
  const sleep = opts.sleep ?? realSleep;
  const rng = opts.rng ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new AbortError();
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const hasMore = attempt < retries;
      if (!hasMore || !retryOn(err, attempt) || opts.signal?.aborted) break;
      const raw = backoffDelay(attempt, opts);
      const curve = jitter ? Math.round(rng() * raw) : raw;
      // The error's own advice, when it has any, overrides the curve — see `delayFor`.
      const delay = Math.max(0, opts.delayFor?.(err, attempt, curve) ?? curve);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
