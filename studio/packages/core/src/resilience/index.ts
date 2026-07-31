/**
 * resilience — durability/stability primitives (Reliability & Polish pack): bounded
 * retry+backoff+jitter, a circuit breaker, and a timeout race. Pure; clock/rng/timer
 * are injected for deterministic tests. Wrap any flaky dependency (sidecar, network,
 * spawn) without masking real failures.
 */
export type { RetryOptions } from "./retry.js";
export { AbortError, backoffDelay, retry } from "./retry.js";
export type { BreakerOptions, BreakerSnapshot, BreakerState } from "./circuitBreaker.js";
export { CircuitBreaker, CircuitOpenError } from "./circuitBreaker.js";
export type { TimerLike } from "./timeout.js";
export { TimeoutError, withTimeout } from "./timeout.js";
