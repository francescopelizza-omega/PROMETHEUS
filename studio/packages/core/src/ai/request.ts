/**
 * ai/request.ts — one POST to a model endpoint, with bounded retries, for ALL four transports.
 *
 * This repo has four independent implementations of "stream an OpenAI-compatible completion":
 * core's client, the CLI's native-tool-call `toolTurn`, the desktop main process's
 * `runAiStream`, and the renderer's direct-fetch path. Every one of them made a single attempt.
 * A 429 — the most common cloud failure, and the one providers explicitly tell you how to
 * recover from — ended the turn in all four, in four different ways: a throw, a `model error:`
 * text turn, an `{ok:false}` result whose body was never even read, and another throw.
 *
 * Rather than add a fifth loop, this is the shared one. It stops at exactly the right place —
 * a successful response, BEFORE the body is read — because that is the only point where a
 * retry is safe. Once a delta has been parsed and handed to the caller, retrying would replay
 * text the user has already seen, which is worse than the failure it is trying to fix.
 *
 * THE PER-ATTEMPT SIGNAL IS THE SUBTLE PART, and it is why this takes a factory rather than a
 * signal. Two of the transports arm a 180-second hard timer and abort a controller when it
 * fires. An `AbortController` is single-use: once aborted it stays aborted, so a retry loop
 * reusing one would have attempt 2 abort instantly, and a loop reusing the timer would let
 * three attempts share one deadline. `signalFor(attempt)` hands the caller that decision,
 * because only the caller knows what its watchdog means.
 *
 * PURE over its injected fetch: no node, no timers of its own.
 */
import { CircuitBreaker } from "../resilience/circuitBreaker.js";
import { retry } from "../resilience/retry.js";
import {
  AI_RETRY_DEFAULTS,
  AiHttpError,
  advisedWaitTooLong,
  describeAiFailure,
  isRetryableAiError,
  parseRetryAfter,
  retryDelayMs,
} from "./retry-policy.js";

/**
 * One breaker per endpoint id, shared across every call this process makes to it — so a run of
 * failures against one dead local server fails fast without ever touching a different, healthy
 * endpoint's own count. Populated lazily: nothing is created until `endpointBreaker` is actually
 * called, so a caller that never asks for one (including every existing test, none of which
 * passes `ModelRequestOptions.breaker`) is completely unaffected by it.
 */
const breakers = new Map<string, CircuitBreaker>();

/** The shared circuit breaker for one endpoint id, created on first use. */
export function endpointBreaker(endpointId: string): CircuitBreaker {
  let b = breakers.get(endpointId);
  if (!b) {
    b = new CircuitBreaker();
    breakers.set(endpointId, b);
  }
  return b;
}

/** The minimum a response must expose for this module to classify it. */
export interface ModelResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

export interface ModelRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

export interface ModelRequestOptions<R extends ModelResponseLike> {
  endpointId: string;
  url: string;
  init: Omit<ModelRequestInit, "signal">;
  doFetch: (url: string, init: ModelRequestInit) => Promise<R>;
  /**
   * The signal for THIS attempt.
   *
   * Called once per attempt so a caller with a hard timeout can arm a fresh controller and a
   * fresh timer each time. Returning the same signal every time is correct only for a caller
   * that has no timer of its own.
   */
  signalFor?: (attempt: number) => AbortSignal | undefined;
  /** the USER's abort (stop button / superseded turn) — checked between attempts. */
  userSignal?: AbortSignal;
  /** injected sleeper/RNG so a test never waits and the schedule is deterministic. */
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  /** fired before each retry, so a host can SAY it is retrying rather than appearing to hang. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /** override the attempt count (default 2 additional attempts). */
  retries?: number;
  /**
   * Fail fast on a dead endpoint instead of paying the full retry schedule every turn.
   *
   * Wraps the WHOLE retry sequence below as one unit — a request that eventually succeeds
   * (even after some of its own attempts failed) is one breaker SUCCESS, and only a request
   * that exhausts every attempt without ever succeeding counts as one breaker FAILURE. That is
   * deliberate: this only trips on sustained, request-level failure (several consecutive dead
   * calls to the same endpoint), not on a single transient blip the retry loop above already
   * recovers from. Omitted ⇒ no breaker at all — the previous, always-retry behaviour. Pass
   * `endpointBreaker(opts.endpointId)` to get the one shared per-endpoint instance.
   */
  breaker?: CircuitBreaker;
}

/**
 * POST to a model endpoint, retrying only what is worth retrying, and return the OK response.
 *
 * Throws `AiHttpError` on a final non-2xx — carrying the status, the parsed `Retry-After` and
 * a bounded slice of the body. That body slice matters: one of the four transports discarded
 * it entirely, so a 400 that said exactly what was wrong surfaced to the user as the number
 * `400` and nothing else.
 */
export async function fetchModelWithRetry<R extends ModelResponseLike>(
  opts: ModelRequestOptions<R>,
): Promise<R> {
  const run = (): Promise<R> =>
    retry(
      async (attempt) => {
        const signal = opts.signalFor?.(attempt);
        const res = await opts.doFetch(opts.url, {
          ...opts.init,
          ...(signal ? { signal } : {}),
        });
        if (!res.ok) {
          const detail = await safeBody(res);
          const advice = parseRetryAfter(res.headers?.get("retry-after"));
          throw new AiHttpError({
            endpointId: opts.endpointId,
            status: res.status,
            statusText: res.statusText,
            detail,
            ...(advice !== undefined ? { retryAfterMs: advice } : {}),
          });
        }
        return res;
      },
      {
        retries: opts.retries ?? AI_RETRY_DEFAULTS.retries,
        baseMs: AI_RETRY_DEFAULTS.baseMs,
        factor: AI_RETRY_DEFAULTS.factor,
        maxMs: AI_RETRY_DEFAULTS.maxMs,
        // The USER's signal, not a per-attempt one: a stop must end the loop, while an
        // attempt's own timeout is just that attempt failing.
        ...(opts.userSignal ? { signal: opts.userSignal } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.rng ? { rng: opts.rng } : {}),
        retryOn: (err) =>
          isRetryableAiError(err) && !advisedWaitTooLong(err, AI_RETRY_DEFAULTS.adviceCapMs),
        delayFor: (err, _attempt, curve) => retryDelayMs(err, curve, AI_RETRY_DEFAULTS.adviceCapMs),
        ...(opts.onRetry
          ? {
              onRetry: (err: unknown, attempt: number, delayMs: number) =>
                opts.onRetry?.({ attempt, delayMs, reason: describeAiFailure(err) }),
            }
          : {}),
      },
    );
  return opts.breaker ? opts.breaker.exec(run) : run();
}

/** Read an error body defensively — it is only ever used for the message. */
async function safeBody(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
