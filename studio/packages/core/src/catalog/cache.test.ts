import assert from "node:assert/strict";
/**
 * catalog/cache.test.ts — the two-speed catalog cache (file 06 §7).
 *
 * Covers: REGISTRY entries invalidate by EngineSignature (version OR mtime change drops the
 * WHOLE registry); VOLATILE install-state entries expire by an injected-clock TTL + explicit
 * invalidation after a mutation; the get-or-load helpers; and clear/size diagnostics. A fake
 * clock keeps the TTL test deterministic (no real timers).
 */
import { test } from "node:test";

import {
  CatalogCache,
  DEFAULT_VOLATILE_TTL_MS,
  createCatalogCache,
  sameSignature,
} from "./cache.js";

const sig = (version: string, mtimeMs: number) => ({ version, mtimeMs });

test("sameSignature compares version AND mtime", () => {
  assert.equal(sameSignature(sig("1", 100), sig("1", 100)), true);
  assert.equal(sameSignature(sig("1", 100), sig("2", 100)), false);
  assert.equal(sameSignature(sig("1", 100), sig("1", 200)), false);
});

// ── registry: static per engine version+mtime ─────────────────────────────────── //

test("getRegistry returns a stored value under a matching signature", () => {
  const c = new CatalogCache();
  c.setRegistry("list", sig("0.15.0", 1), [{ id: "a" }]);
  assert.deepEqual(c.getRegistry("list", sig("0.15.0", 1)), [{ id: "a" }]);
});

test("getRegistry misses (and evicts) when the signature changes", () => {
  const c = new CatalogCache();
  c.setRegistry("list", sig("0.15.0", 1), [{ id: "a" }]);
  assert.equal(c.getRegistry("list", sig("0.15.0", 2)), undefined); // mtime bump
  // the stale entry was evicted
  assert.equal(c.size().registry, 0);
});

test("withRegistry: a new signature ANYWHERE drops the WHOLE registry", () => {
  const c = new CatalogCache();
  let loads = 0;
  const load = () => {
    loads += 1;
    return loads;
  };
  assert.equal(c.withRegistry("list", sig("0.15.0", 1), load), 1);
  assert.equal(c.withRegistry("matrix", sig("0.15.0", 1), load), 2);
  // cache hits: no new loads under the same signature
  assert.equal(c.withRegistry("list", sig("0.15.0", 1), load), 1);
  assert.equal(loads, 2);
  // a new engine version drops the whole registry -> both must reload
  assert.equal(c.withRegistry("list", sig("0.16.0", 1), load), 3);
  assert.equal(c.size().registry, 1); // only "list" reloaded so far
});

// ── volatile: install-state TTL ───────────────────────────────────────────────── //

test("volatile entries expire after the TTL (fake clock)", () => {
  let now = 1000;
  const c = new CatalogCache({ volatileTtlMs: 50, now: () => now });
  c.setVolatile("status:all", { installed: true });
  assert.deepEqual(c.getVolatile("status:all"), { installed: true });
  now += 49; // still fresh
  assert.deepEqual(c.getVolatile("status:all"), { installed: true });
  now += 1; // now == TTL -> expired (>= TTL)
  assert.equal(c.getVolatile("status:all"), undefined);
  assert.equal(c.size().volatile, 0); // evicted on read
});

test("withVolatile loads only on a miss/expiry", () => {
  let now = 0;
  let loads = 0;
  const c = new CatalogCache({ volatileTtlMs: 10, now: () => now });
  const load = () => {
    loads += 1;
    return loads;
  };
  assert.equal(c.withVolatile("status", load), 1);
  assert.equal(c.withVolatile("status", load), 1); // hit
  now += 10; // expire
  assert.equal(c.withVolatile("status", load), 2);
  assert.equal(loads, 2);
});

test("invalidateVolatile after a mutation drops install-state (file 06 §7)", () => {
  const c = new CatalogCache();
  c.setVolatile("status:all", 1);
  c.setVolatile("apps:installed", 2);
  c.invalidateVolatile("status:all"); // targeted
  assert.equal(c.getVolatile("status:all"), undefined);
  assert.equal(c.getVolatile("apps:installed"), 2);
  c.invalidateVolatile(); // all
  assert.equal(c.getVolatile("apps:installed"), undefined);
});

test("invalidateRegistry + clear", () => {
  const c = new CatalogCache();
  c.setRegistry("list", sig("1", 1), [1]);
  c.setVolatile("status", 2);
  c.invalidateRegistry("list");
  assert.equal(c.getRegistry("list", sig("1", 1)), undefined);
  c.setRegistry("matrix", sig("1", 1), [3]);
  c.clear();
  assert.deepEqual(c.size(), { registry: 0, volatile: 0 });
});

test("DEFAULT_VOLATILE_TTL_MS is the documented 10s; factory works", () => {
  assert.equal(DEFAULT_VOLATILE_TTL_MS, 10_000);
  assert.ok(createCatalogCache() instanceof CatalogCache);
});
