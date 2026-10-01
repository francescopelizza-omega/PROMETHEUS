// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * resilience/timeout.ts — race a promise against a deadline (fail-closed).
 *
 * A bounded wait so a hung dependency can't stall the agent loop / IPC forever. The
 * timer is injectable (default real setTimeout) so tests are deterministic, and it is
 * always cleared on settle (no dangling handle). Fail-closed: on timeout it REJECTS
 * with a `TimeoutError` — never silently resolves.
 */

/** Raised when a wrapped promise exceeds its deadline. */
export class TimeoutError extends Error {
  readonly ms: number;
  readonly label: string;
  constructor(ms: number, label = "operation") {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.ms = ms;
    this.label = label;
  }
}

/** A settable/clearable timer seam (matches setTimeout/clearTimeout). */
export interface TimerLike {
  set: (cb: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimer: TimerLike = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Resolve with `promise`'s value if it settles within `ms`; otherwise reject with a
 * `TimeoutError`. The timer is cleared whichever way it settles.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "operation",
  timer: TimerLike = realTimer,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = timer.set(() => reject(new TimeoutError(ms, label)), ms);
    promise.then(
      (v) => {
        timer.clear(handle);
        resolve(v);
      },
      (e) => {
        timer.clear(handle);
        reject(e);
      },
    );
  });
}
