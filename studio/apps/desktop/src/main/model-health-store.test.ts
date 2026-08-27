/**
 * model-health-store.test.ts — the atomic on-disk ModelHealthStore persistence behind
 * Model Health (desktop main). Real tmpdir fs, no Electron.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EndpointHealthRecord } from "@prometheus/core";

import { loadModelHealth, recordEndpointHealth, saveModelHealth } from "./model-health-store.js";

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "prom-model-health-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeRecord(overrides: Partial<EndpointHealthRecord> = {}): EndpointHealthRecord {
  return {
    endpointId: "local-ollama",
    model: "llama3",
    locality: "local",
    transport: "native",
    demonstrated: true,
    nativeCalls: 3,
    textCallsWhileNative: 0,
    textSyntaxCalls: 0,
    nativeRejected: false,
    breakerState: "closed",
    breakerFailures: 0,
    breakerOpenedAt: null,
    contextWindow: 8192,
    contextWindowSource: "ollama",
    lastUsedIso: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

test("loadModelHealth: missing file → empty store (fail-soft, never throws)", async () => {
  await withTmpDir(async (dir) => {
    const store = await loadModelHealth(join(dir, "model-health.json"));
    assert.deepEqual(store, {});
  });
});

test("saveModelHealth + loadModelHealth: round-trips a store, creates missing parent dirs", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "nested", "model-health.json");
    const record = makeRecord();
    await saveModelHealth(path, { [record.endpointId]: record });
    const loaded = await loadModelHealth(path);
    assert.deepEqual(loaded, { [record.endpointId]: record });
  });
});

test("recordEndpointHealth: merges a fresh record into a missing store", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "model-health.json");
    const record = makeRecord();
    const store = await recordEndpointHealth(path, record);
    assert.deepEqual(store, { [record.endpointId]: record });
    // persisted, not just returned in-memory
    const reloaded = await loadModelHealth(path);
    assert.deepEqual(reloaded, { [record.endpointId]: record });
  });
});

test("recordEndpointHealth: merging two different endpoints loses neither", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "model-health.json");
    const first = makeRecord({ endpointId: "local-ollama", model: "llama3" });
    const second = makeRecord({
      endpointId: "cloud-anthropic",
      model: "claude",
      locality: "cloud",
      transport: "text",
      contextWindowSource: "declared",
      contextWindow: 200_000,
    });

    await recordEndpointHealth(path, first);
    const store = await recordEndpointHealth(path, second);

    assert.deepEqual(store, {
      "local-ollama": first,
      "cloud-anthropic": second,
    });
    const reloaded = await loadModelHealth(path);
    assert.deepEqual(reloaded, {
      "local-ollama": first,
      "cloud-anthropic": second,
    });
  });
});

test("recordEndpointHealth: re-recording the same endpoint overwrites it, keeps others", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "model-health.json");
    const first = makeRecord({ endpointId: "local-ollama", nativeCalls: 1 });
    const other = makeRecord({ endpointId: "cloud-anthropic", locality: "cloud" });
    const updated = makeRecord({ endpointId: "local-ollama", nativeCalls: 5 });

    await recordEndpointHealth(path, first);
    await recordEndpointHealth(path, other);
    const store = await recordEndpointHealth(path, updated);

    assert.equal(store["local-ollama"]?.nativeCalls, 5);
    assert.deepEqual(store["cloud-anthropic"], other);
  });
});

test("recordEndpointHealth: CONCURRENT calls for different endpoints never drop one another (read-modify-write race)", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "model-health.json");
    const a = makeRecord({ endpointId: "local-ollama" });
    const b = makeRecord({ endpointId: "cloud-anthropic", locality: "cloud" });

    // Fired via Promise.all, exactly as two agent-pane tabs finishing a turn in the same tick
    // would both call `window.prometheus.modelHealth.record(...)` — without serialization both
    // used to read the same pre-write snapshot, so whichever save landed last silently erased
    // the other endpoint's just-recorded entry instead of merging with it.
    await Promise.all([recordEndpointHealth(path, a), recordEndpointHealth(path, b)]);

    const reloaded = await loadModelHealth(path);
    assert.deepEqual(
      Object.keys(reloaded).sort(),
      ["cloud-anthropic", "local-ollama"],
      "both endpoints must survive — neither write may silently drop the other",
    );
    assert.deepEqual(reloaded["local-ollama"], a);
    assert.deepEqual(reloaded["cloud-anthropic"], b);
  });
});

test("recordEndpointHealth: many concurrent calls for many DIFFERENT endpoints all survive", async () => {
  await withTmpDir(async (dir) => {
    const path = join(dir, "model-health.json");
    const records = Array.from({ length: 20 }, (_, i) =>
      makeRecord({ endpointId: `ep-${i}`, nativeCalls: i }),
    );
    await Promise.all(records.map((r) => recordEndpointHealth(path, r)));

    const reloaded = await loadModelHealth(path);
    assert.equal(Object.keys(reloaded).length, 20, "every one of the 20 endpoints must survive");
    for (const r of records) assert.deepEqual(reloaded[r.endpointId], r);
  });
});
