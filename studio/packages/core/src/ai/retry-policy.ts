/**
 * ai/retry-policy.ts — what a model endpoint's failure MEANS, and whether to try again.
 *
 * The client made exactly one attempt and threw. A 429 from a cloud provider — the single most
 * common failure there is, and one the provider explicitly tells you how to recover from via
 * `Retry-After` — ended the turn with an opaque `HTTP 429 Too Many Requests`. Meanwhile
 * `resilience/retry.ts` had implemented exponential backoff with full jitter, AbortSignal
 * support and injected clocks since the beginning, with ZERO callers.
 *
 * This module is the missing middle: it classifies a failure, and it reads the provider's own
 * advice. `retry()` does the waiting.
 *
 * TWO JUDGEMENTS ARE THE WHOLE FILE, and both are about not making things worse:
 *
 *  1. **What is retryable.** A 429 or a 5xx is the endpoint saying "not now". A 400 or a 422 is
 *     it saying "not like that" — retrying a malformed request just spends the user's money and
 *     their time four times instead of once. A 401/403 is a credential problem no amount of
 *     waiting fixes. Retrying those would turn one clear error into a slow one.
 *
 *  2. **Retry-After beats our arithmetic.** When a provider states when to come back, our
 *     backoff curve is a guess competing with a fact. Honouring it is also the difference
 *     between recovering and getting rate-limited harder for hammering.
 *
 * PURE: no fetch, no timers, no node. The caller owns the waiting.
 */

/** An HTTP-level failure from a model endpoint, carrying what the response actually said. */
export class AiHttpError extends Error {
  readonly status: number;
  readonly statusText: string;
  /** the endpoint's own advice, in ms, when it sent `Retry-After`. */
  readonly retryAfterMs: number | undefined;
  /** a bounded slice of the error body — providers put the real reason here. */
  readonly detail: string;

  constructor(opts: {
    endpointId: string;
    status: number;
    statusText: string;
    detail?: string;
    retryAfterMs?: number;
  }) {
    super(
      `AI endpoint ${opts.endpointId} HTTP ${opts.status} ${opts.statusText}: ${opts.detail ?? ""}`,
    );
    this.name = "AiHttpError";
    this.status = opts.status;
    this.statusText = opts.statusText;
    this.retryAfterMs = opts.retryAfterMs;
    this.detail = opts.detail ?? "";
  }
}

/**
 * Parse a `Retry-After` header into milliseconds.
 *
 * The header is legally EITHER a delay in seconds or an HTTP date, and providers use both. A
 * parser that handles only the integer form silently ignores the date form — which is exactly
 * the case where the wait is long and guessing wrong matters most.
 *
 * `now` is injected so the date branch is testable without a clock.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const raw = header.trim();
  if (!raw) return undefined;
  // The delay-seconds form. Note `Number("")` is 0, hence the emptiness check above.
  if (/^\d+$/.test(raw)) {
    const secs = Number(raw);
    return Number.isFinite(secs) ? Math.max(0, secs * 1000) : undefined;
  }
  // The date form always carries letters (a day/month name, or an ISO `T`/`Z`). Requiring one
  // is what stops `Date.parse` from cheerfully reading "-5" as a year and returning a delay.
  if (!/[a-zA-Z]/.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  // A date already in the past means "now" — never a negative delay.
  return Math.max(0, at - now);
}

/**
 * Whether this status is worth trying again.
 *
 * 408 request timeout, 425 too early, 429 rate limited, and the 5xx family are all transient by
 * definition. 409 is deliberately NOT here: it is a state conflict, and repeating the same
 * request cannot resolve one.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  // 501 Not Implemented is a permanent answer, unlike the rest of the 5xx family.
  return status >= 500 && status !== 501;
}

/** Whether a thrown value is worth trying again. */
export function isRetryableAiError(err: unknown): boolean {
  if (err instanceof AiHttpError) return isRetryableStatus(err.status);
  // An abort is the user's decision, never a transient fault.
  if (isAbort(err)) return false;
  // A network-level throw (DNS, connection reset, TLS) is transient by nature: there is no
  // status to consult, and the request provably never got an answer.
  return err instanceof Error;
}

/** Whether a thrown value is an abort (the user pressed stop, or the turn was superseded). */
export function isAbort(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * The delay to wait before the next attempt, given the error and the computed backoff.
 *
 * The provider's own `Retry-After` wins over the backoff curve — our arithmetic is a guess
 * competing with a fact — but it is CAPPED, because a provider that says "come back in an hour"
 * should surface as an error the user can see rather than a turn that appears to hang.
 */
export function retryDelayMs(err: unknown, backoffMs: number, capMs = 60_000): number {
  const advised = err instanceof AiHttpError ? err.retryAfterMs : undefined;
  if (advised === undefined) return backoffMs;
  return Math.min(advised, capMs);
}

/**
 * Whether the provider's advice is longer than we are willing to wait.
 *
 * Split out from `retryDelayMs` because the two callers want opposite things: the delay
 * calculation clamps, while the RETRY DECISION should give up — waiting the clamped 60s and
 * then failing anyway is the worst of both.
 */
export function advisedWaitTooLong(err: unknown, capMs = 60_000): boolean {
  const advised = err instanceof AiHttpError ? err.retryAfterMs : undefined;
  return advised !== undefined && advised > capMs;
}

/** The defaults for a model request: 3 attempts total, ~400ms base, 20s ceiling. */
export const AI_RETRY_DEFAULTS = Object.freeze({
  /** ADDITIONAL attempts after the first. Two is enough for a transient blip and cheap to wait. */
  retries: 2,
  /** Higher than the generic 100ms default: a rate limiter needs longer than a flaky file lock. */
  baseMs: 400,
  factor: 2,
  maxMs: 20_000,
  /** Longer than this and the user should see the error instead of a stalled turn. */
  adviceCapMs: 60_000,
});

/** A one-line, honest explanation of a failure, for a transcript or a status line. */
export function describeAiFailure(err: unknown): string {
  if (err instanceof AiHttpError) {
    if (err.status === 429) {
      const wait =
        err.retryAfterMs !== undefined
          ? ` (asked to wait ${Math.ceil(err.retryAfterMs / 1000)}s)`
          : "";
      return `rate limited by the provider${wait}`;
    }
    if (err.status === 401 || err.status === 403) return "the endpoint rejected the credentials";
    if (err.status >= 500) return `the provider had a server error (${err.status})`;
    return `the request was rejected (${err.status}): ${err.detail.slice(0, 200)}`;
  }
  if (isAbort(err)) return "cancelled";
  return err instanceof Error ? err.message : String(err);
}

/* ── the pre-flight check ──────────────────────────────────────────────────*/

/**
 * Whether this request can possibly fit, checked BEFORE it is sent.
 *
 * Overflow used to surface as an HTTP 400 with a provider-specific body — "This model's maximum
 * context length is 8192 tokens, however you requested…" if you were lucky, and an opaque
 * `invalid_request_error` if you were not. Either way the turn ended, the user was billed for
 * nothing, and the transcript said something that reads like a bug in Prometheus.
 *
 * A local estimate cannot be exact — tokenizers differ per model, and this is characters ÷ 4 —
 * so it is deliberately used ONLY to refuse the clearly-impossible. The margin below is what
 * keeps an estimate that is 20% low from refusing a request that would have worked. Anything
 * inside the margin still goes to the endpoint, which is the authority.
 *
 * PURE. The caller supplies the estimate; this only decides.
 */
export interface PreflightResult {
  ok: boolean;
  /** the estimated prompt size, in tokens. */
  estimatedTokens: number;
  /** what the caller must free up, when it does not fit. */
  overflowTokens: number;
  /** an actionable sentence — never a bare number. */
  reason?: string;
}

/**
 * The share of the window an estimate must exceed before the request is refused locally.
 *
 * 1.15 rather than 1.0: `chars/4` under-counts on code and CJK and over-counts on prose, so a
 * hard equality check would refuse requests the endpoint would have accepted. Refusing a valid
 * request is a worse failure than passing an invalid one through to a clear provider error.
 */
export const PREFLIGHT_MARGIN = 1.15;

export function preflightContext(opts: {
  estimatedPromptTokens: number;
  contextWindow: number;
  /** reserved for the completion — the window must hold BOTH sides. */
  maxTokens?: number;
}): PreflightResult {
  const { estimatedPromptTokens: est, contextWindow: win } = opts;
  // An unknown or implausible window disables the check rather than triggering it. Same
  // reasoning as compaction's null sentinel: "no information" must not mean "refuse".
  if (!win || !Number.isFinite(win) || win <= 0) {
    return { ok: true, estimatedTokens: est, overflowTokens: 0 };
  }
  const reserve = opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : 0;
  const budget = Math.max(1, win - reserve);
  if (est <= budget * PREFLIGHT_MARGIN) {
    return { ok: true, estimatedTokens: est, overflowTokens: 0 };
  }
  const overflow = Math.ceil(est - budget);
  return {
    ok: false,
    estimatedTokens: est,
    overflowTokens: overflow,
    reason: [
      `this request is about ${est} tokens but the model's context window is ${win}`,
      reserve ? ` (${reserve} reserved for the reply)` : "",
      `. Roughly ${overflow} tokens have to go — compact the conversation,`,
      " drop attached files, or switch to a model with a larger window.",
    ].join(""),
  };
}

/** Raised by the pre-flight check. Distinguishable so a host can offer to compact. */
export class ContextOverflowError extends Error {
  readonly estimatedTokens: number;
  readonly overflowTokens: number;
  readonly contextWindow: number;
  constructor(res: PreflightResult, contextWindow: number) {
    super(res.reason ?? "the request does not fit in the model's context window");
    this.name = "ContextOverflowError";
    this.estimatedTokens = res.estimatedTokens;
    this.overflowTokens = res.overflowTokens;
    this.contextWindow = contextWindow;
  }
}
