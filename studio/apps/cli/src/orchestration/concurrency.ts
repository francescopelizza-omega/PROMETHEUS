// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/concurrency.ts — per-provider concurrency control.
 *
 * Each vendor has its OWN rate limit (anthropic ~3, openai ~4, google ~5, cursor ~2);
 * firing 6 parallel agents at one account is an instant 429. A keyed semaphore caps how
 * many CLI calls run concurrently PER service (a bulkhead), so the swarm's parallelism is
 * real but provider-safe. PURE: no IO; queues are FIFO + deterministic. Used by the
 * backend invoker to wrap every `cli` spawn.
 */

/** A FIFO async semaphore: at most `limit` holders at once; the rest queue. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** Run `fn` once a slot is free; always releases the slot (even if `fn` throws). */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get inFlight(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    // full → wait; the releaser HANDS us the slot (active is not decremented), so when we
    // resume we already hold it.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next)
      next(); // hand the slot directly to the next waiter (active unchanged)
    else this.active -= 1;
  }
}

/** A semaphore per key (service id), each with its own limit. */
export class KeyedSemaphore {
  private readonly sems = new Map<string, Semaphore>();
  private readonly limitFor: (key: string) => number;

  constructor(limitFor: (key: string) => number) {
    this.limitFor = limitFor;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let s = this.sems.get(key);
    if (!s) {
      s = new Semaphore(this.limitFor(key));
      this.sems.set(key, s);
    }
    return s.run(fn);
  }
}

/** Default per-provider concurrency caps (independent vendor limits). */
export function defaultProviderLimit(service: string): number {
  switch (service.toLowerCase()) {
    case "claude":
      return 3;
    case "codex":
      return 4;
    case "gemini":
      return 5;
    case "cursor":
      return 2;
    case "kilocode":
      return 2;
    default:
      return 3;
  }
}
