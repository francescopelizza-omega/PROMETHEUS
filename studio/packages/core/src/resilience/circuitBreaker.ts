// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * resilience/circuitBreaker.ts — a closed → open → half-open breaker.
 *
 * Wraps a flaky dependency (a sidecar, a network call) so that after N consecutive
 * failures it trips OPEN and fails fast for a cool-down — instead of hammering a dead
 * service — then admits a limited HALF-OPEN probe to test recovery before closing. Pure:
 * the clock (`now`) is injected so trip/recovery timing is deterministic in tests.
 */

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerOptions {
  /** consecutive failures that trip the breaker open (default 5). */
  failureThreshold?: number;
  /** how long to stay open before admitting a half-open probe, ms (default 30_000). */
  coolDownMs?: number;
  /** concurrent probes allowed in half-open before deciding (default 1). */
  halfOpenMax?: number;
  /** injected clock (default Date.now) — tests advance it deterministically. */
  now?: () => number;
}

/** Raised when a call is rejected because the breaker is open (fail-fast). */
export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`circuit open — fail-fast (retry in ~${retryAfterMs}ms)`);
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface BreakerSnapshot {
  state: BreakerState;
  failures: number;
  openedAt: number | null;
}

/** A circuit breaker around an async call. */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly coolDownMs: number;
  private readonly halfOpenMax: number;
  private readonly now: () => number;
  private state: BreakerState = "closed";
  private failures = 0;
  private openedAt: number | null = null;
  private probes = 0;

  constructor(opts: BreakerOptions = {}) {
    this.threshold = Math.max(1, opts.failureThreshold ?? 5);
    this.coolDownMs = Math.max(0, opts.coolDownMs ?? 30_000);
    this.halfOpenMax = Math.max(1, opts.halfOpenMax ?? 1);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Run `fn` through the breaker. Throws `CircuitOpenError` when open + cooling down.
   *
   * `opts.isEndpointFailure` decides whether a thrown error says anything about the ENDPOINT's
   * health. It defaults to "yes, everything does", which is what every existing caller wants —
   * but a turn the USER cancelled is not evidence that the model is down, and counting it as
   * such meant five cancels in a row (routine with a slow local model) opened the breaker and
   * refused the next perfectly ordinary message for 30 seconds. Reproduced against the real
   * shared `endpointBreaker`: five AbortErrors, then `CircuitOpenError` on a request that would
   * have succeeded.
   *
   * A non-failure is NOT counted as a success either — it leaves the breaker exactly as it was,
   * because a cancelled request is no evidence in either direction.
   */
  async exec<T>(
    fn: () => Promise<T>,
    opts: { isEndpointFailure?: (err: unknown) => boolean } = {},
  ): Promise<T> {
    this.maybeHalfOpen();
    if (this.state === "open") {
      throw new CircuitOpenError(this.remainingCoolDown());
    }
    if (this.state === "half-open") {
      if (this.probes >= this.halfOpenMax) throw new CircuitOpenError(this.remainingCoolDown());
      this.probes += 1;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (opts.isEndpointFailure === undefined || opts.isEndpointFailure(err)) this.onFailure();
      else this.probes = Math.max(0, this.probes - 1); // a half-open probe that never happened
      throw err;
    }
  }

  /** Transition open → half-open once the cool-down has elapsed. */
  private maybeHalfOpen(): void {
    if (
      this.state === "open" &&
      this.openedAt !== null &&
      this.now() - this.openedAt >= this.coolDownMs
    ) {
      this.state = "half-open";
      this.probes = 0;
    }
  }

  private remainingCoolDown(): number {
    if (this.openedAt === null) return 0;
    return Math.max(0, this.coolDownMs - (this.now() - this.openedAt));
  }

  private onSuccess(): void {
    this.failures = 0;
    this.probes = 0;
    this.openedAt = null;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures += 1;
    // a failed half-open probe re-opens immediately; closed trips at the threshold.
    if (this.state === "half-open" || this.failures >= this.threshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.probes = 0;
  }

  /** The current state + counters (for a health/diagnostics surface). */
  snapshot(): BreakerSnapshot {
    this.maybeHalfOpen();
    return { state: this.state, failures: this.failures, openedAt: this.openedAt };
  }

  /** Force the breaker back to a clean closed state. */
  reset(): void {
    this.onSuccess();
  }
}
