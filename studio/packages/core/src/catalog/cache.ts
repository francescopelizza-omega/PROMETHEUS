// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * catalog/cache.ts — the two-speed catalog cache (file 06 §7).
 *
 * Two distinct cache classes, by volatility:
 *   - REGISTRY data (`list`, `matrix`, `info`) is effectively STATIC per engine version →
 *     cache key = `prometheus.py --version` + the file mtime; it stays valid until either
 *     changes (no TTL needed).
 *   - INSTALL-STATE (`status`, `apps installed`, `skills list`, `inventory`) is VOLATILE →
 *     a SHORT TTL + explicit invalidation on ANY state-changing command (file 06 §7).
 *
 * Framework-free + I/O-free: this is an in-memory store. The caller supplies the engine
 * version + mtime (read in the desktop main / CLI via engine-bridge) and a clock (so tests
 * are deterministic). We NEVER infer installed-state by peeking the filesystem here — that is
 * `inventory`'s job in the engine (file 06 §7).
 */

/** The signature that invalidates the whole REGISTRY cache when it changes. */
export interface EngineSignature {
  /** `prometheus.py --version` (SCRIPT_VERSION). */
  version: string;
  /** the engine file mtime (ms epoch) — bumps on any in-place engine edit. */
  mtimeMs: number;
}

/** Two registry keys point at the same data iff version AND mtime match. */
export function sameSignature(a: EngineSignature, b: EngineSignature): boolean {
  return a.version === b.version && a.mtimeMs === b.mtimeMs;
}

interface RegistryEntry<T> {
  sig: EngineSignature;
  value: T;
}

interface VolatileEntry<T> {
  value: T;
  storedAt: number; // ms epoch from the injected clock
}

/** Default volatile TTL: install-state goes stale fast (file 06 §7 short TTL). */
export const DEFAULT_VOLATILE_TTL_MS = 10_000;

export interface CatalogCacheOptions {
  /** TTL for volatile install-state entries (ms). Default 10s. */
  volatileTtlMs?: number;
  /** injected clock for determinism (default `Date.now`). */
  now?: () => number;
}

/**
 * A namespaced two-speed cache. Registry entries invalidate by EngineSignature; volatile
 * entries invalidate by TTL or explicit `invalidateVolatile()` (called after any mutation).
 *
 * Keys are caller-chosen strings (e.g. `"list"`, `"matrix"`, `"info:codegraph"`,
 * `"status:all"`, `"apps:installed"`). The value type is per-key via the generic accessor.
 */
export class CatalogCache {
  private readonly registry = new Map<string, RegistryEntry<unknown>>();
  private readonly volatile = new Map<string, VolatileEntry<unknown>>();
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(opts: CatalogCacheOptions = {}) {
    this.ttl = opts.volatileTtlMs ?? DEFAULT_VOLATILE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  // --- registry (static per engine version+mtime) ---------------------------- //

  /** Read a registry entry IFF its stored signature matches `sig`; else `undefined`. */
  getRegistry<T>(key: string, sig: EngineSignature): T | undefined {
    const e = this.registry.get(key);
    if (!e) return undefined;
    if (!sameSignature(e.sig, sig)) {
      this.registry.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  /** Store a registry entry tagged with the engine signature it was read under. */
  setRegistry<T>(key: string, sig: EngineSignature, value: T): void {
    this.registry.set(key, { sig, value });
  }

  /**
   * Get-or-load a registry entry. On a signature change ANYWHERE, the WHOLE registry is
   * dropped first (a new engine version/mtime invalidates every cached registry read).
   */
  withRegistry<T>(key: string, sig: EngineSignature, load: () => T): T {
    this.dropRegistryIfSignatureChanged(sig);
    const hit = this.getRegistry<T>(key, sig);
    if (hit !== undefined) return hit;
    const value = load();
    this.setRegistry(key, sig, value);
    return value;
  }

  /** If ANY cached registry entry carries a different signature, clear the whole registry. */
  private dropRegistryIfSignatureChanged(sig: EngineSignature): void {
    for (const e of this.registry.values()) {
      if (!sameSignature(e.sig, sig)) {
        this.registry.clear();
        return;
      }
    }
  }

  // --- volatile (install-state, short TTL) ----------------------------------- //

  /** Read a volatile entry IFF it has not exceeded the TTL; else `undefined`. */
  getVolatile<T>(key: string): T | undefined {
    const e = this.volatile.get(key);
    if (!e) return undefined;
    if (this.now() - e.storedAt >= this.ttl) {
      this.volatile.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  /** Store a volatile entry stamped with the current clock. */
  setVolatile<T>(key: string, value: T): void {
    this.volatile.set(key, { value, storedAt: this.now() });
  }

  /** Get-or-load a volatile entry (load runs only on a miss/expiry). */
  withVolatile<T>(key: string, load: () => T): T {
    const hit = this.getVolatile<T>(key);
    if (hit !== undefined) return hit;
    const value = load();
    this.setVolatile(key, value);
    return value;
  }

  // --- invalidation ---------------------------------------------------------- //

  /**
   * Invalidate volatile install-state. Call after ANY state-changing engine command
   * (install/uninstall/enable/disable/apps/worldsim/models lifecycle) — file 06 §7.
   * Omit `key` to drop every volatile entry; pass a key to drop just one.
   */
  invalidateVolatile(key?: string): void {
    if (key === undefined) this.volatile.clear();
    else this.volatile.delete(key);
  }

  /** Drop the entire registry cache (e.g. on a forced engine-version re-probe). */
  invalidateRegistry(key?: string): void {
    if (key === undefined) this.registry.clear();
    else this.registry.delete(key);
  }

  /** Nuke everything (both classes). */
  clear(): void {
    this.registry.clear();
    this.volatile.clear();
  }

  /** Diagnostics: current entry counts. */
  size(): { registry: number; volatile: number } {
    return { registry: this.registry.size, volatile: this.volatile.size };
  }
}

/** Convenience factory (mirrors the other core stores). */
export const createCatalogCache = (opts?: CatalogCacheOptions): CatalogCache =>
  new CatalogCache(opts);
