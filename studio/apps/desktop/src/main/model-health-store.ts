/**
 * main/model-health-store.ts — pure(ish) disk persistence for `ModelHealthStore` (Model
 * Health feature). Split out exactly like settings-store.ts (which imports `electron`
 * indirectly via its neighbors) so this stays unit-testable: node:fs/promises +
 * @prometheus/core only, no Electron.
 *
 * Unlike settings, model health has only ONE layer — model endpoints are not
 * workspace-scoped — so this is a thin read/merge/write on top of settings-store's
 * fail-soft `readLayer` / atomic `writeLayerAtomic`, reused directly rather than
 * reimplementing file I/O. The caller resolves the absolute path (this repo's
 * convention is `${app.getPath("userData")}/model-health.json`); this module never
 * touches Electron's `app` module, keeping it as pure/testable as settings-store.ts.
 */
import { mergeHealthRecord } from "@prometheus/core";
import type { EndpointHealthRecord, ModelHealthStore } from "@prometheus/core";

import { readLayer, writeLayerAtomic } from "./settings-store.js";

/** Load the whole store from disk; a missing/corrupt file is an empty store (fail-soft). */
export async function loadModelHealth(globalPath: string): Promise<ModelHealthStore> {
  return (await readLayer(globalPath)) as unknown as ModelHealthStore;
}

/** Persist the whole store atomically. */
export async function saveModelHealth(globalPath: string, store: ModelHealthStore): Promise<void> {
  await writeLayerAtomic(globalPath, store as unknown as Record<string, unknown>);
}

/**
 * Serializes `recordEndpointHealth` calls PER PATH.
 *
 * Two overlapping calls for two DIFFERENT endpoint ids (e.g. two agent-pane tabs each
 * finishing a turn within the same event-loop tick) used to both `loadModelHealth` the same
 * on-disk snapshot before either had written — a classic read-modify-write race — so whichever
 * call's `saveModelHealth` finished last would silently OVERWRITE the other's just-recorded
 * endpoint, not merely delay it: an entire endpoint's health entry could vanish from the store.
 * Chaining every call for the same `globalPath` onto the SAME in-process promise means the next
 * call's load always happens after the previous call's save has already landed.
 */
const writeQueues = new Map<string, Promise<unknown>>();

/** Load, merge in one fresh record (keyed by `endpointId`), save, and return the new store. */
export async function recordEndpointHealth(
  globalPath: string,
  record: EndpointHealthRecord,
): Promise<ModelHealthStore> {
  const prior = writeQueues.get(globalPath) ?? Promise.resolve();
  const run = prior
    // A prior call's failure must never wedge the queue for every later caller on this path.
    .catch(() => {})
    .then(async () => {
      const store = await loadModelHealth(globalPath);
      const merged = mergeHealthRecord(store, record);
      await saveModelHealth(globalPath, merged);
      return merged;
    });
  writeQueues.set(globalPath, run);
  return run;
}
