/**
 * main/path-frecency-store.ts — the per-workspace "most-used @-path" memory (opt-in;
 * see the "Tools ▸ Path Completion" setting, `completion.pathFrecency`). Reuses
 * settings-store.ts's atomic JSON read/write (same guarantees, same file shape as the
 * workspace settings layer, just a sibling file) — the actual scoring/eviction math
 * lives in @prometheus/core/path-completion, shared with the CLI's own store.
 */
import { join } from "node:path";

import {
  type FrecencyStore,
  parseFrecencyStore,
  recordPathUse as recordPathUseInStore,
} from "@prometheus/core/path-completion";

import { readLayer, writeLayerAtomic } from "./settings-store.js";

/** `<workspaceRoot>/.prometheus/path-frecency.json` — a sibling of the workspace settings layer. */
export function pathFrecencyPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".prometheus", "path-frecency.json");
}

/** Load this workspace's frecency store (fail-soft → empty; never throws). */
export async function loadPathFrecency(workspaceRoot: string): Promise<FrecencyStore> {
  const raw = await readLayer(pathFrecencyPath(workspaceRoot));
  return parseFrecencyStore(raw);
}

/** Persist this workspace's frecency store (atomic write, creates `.prometheus/` as needed). */
export async function savePathFrecency(workspaceRoot: string, store: FrecencyStore): Promise<void> {
  // FrecencyStore ({ entries: [...] }) satisfies writeLayerAtomic's Record<string, unknown>
  // contract structurally — no conversion needed.
  await writeLayerAtomic(
    pathFrecencyPath(workspaceRoot),
    store as unknown as Record<string, unknown>,
  );
}

/** Record a use of `absolutePath` under `workspaceRoot`'s store, persisting + returning it. */
export async function recordPathUse(
  workspaceRoot: string,
  absolutePath: string,
  nowMs: number,
): Promise<FrecencyStore> {
  const next = recordPathUseInStore(await loadPathFrecency(workspaceRoot), absolutePath, nowMs);
  await savePathFrecency(workspaceRoot, next);
  return next;
}
