// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/model-health-store-path.ts — ONE place both surfaces keep endpoint health, mirroring
 * mcp-store-path.ts exactly (same bug, same fix).
 *
 * There were two files. The CLI persisted to `$PROMETHEUS_HOME/state/model-health.json`
 * (apps/cli/src/session/model-health-store.ts) and the desktop to
 * `<userData>/model-health.json` — the same shape, the same feature, two different files. A
 * breaker the CLI tripped was invisible to the desktop's Settings ▸ Model Health page, and vice
 * versa, despite `ipc-contract.ts`'s own comment calling the channel "shared with the CLI's
 * @prometheus/core ai/model-health" — only the merge/scoring LOGIC was ever actually shared.
 *
 * The CLI's location wins as the shared one, for the same reason mcp-store-path.ts's does:
 * `$PROMETHEUS_HOME` is the product-wide root, `userData` is Electron-only and means nothing to
 * a terminal.
 *
 * MIGRATION is one-way and additive, identical to mcp-store-path.ts's: entries already in the
 * old userData file are folded in once, an id present in both keeps the SHARED one, and the old
 * file is left on disk (cheap, and the only copy of pre-migration state).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { prometheusHome } from "@prometheus/core/agent-system-host";

/** The shared endpoint-health file — the same path the CLI's model-health-store.ts writes. */
export function sharedModelHealthStorePath(): string {
  return join(prometheusHome(), "state", "model-health.json");
}

/** The desktop's former, app-private location. */
export function legacyModelHealthStorePath(userData: string): string {
  return join(userData, "model-health.json");
}

/** Parse a store file into an id→record map; anything unreadable is an EMPTY map, never a throw. */
function readStore(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Fold any desktop-only endpoint records into the shared file. Idempotent; never throws.
 * Returns how many entries were adopted.
 */
export function migrateModelHealthStore(userData: string): number {
  const legacy = legacyModelHealthStorePath(userData);
  if (!existsSync(legacy)) return 0;
  const oldEntries = readStore(legacy);
  const ids = Object.keys(oldEntries);
  if (ids.length === 0) return 0;

  const shared = sharedModelHealthStorePath();
  const current = readStore(shared);
  let adopted = 0;
  for (const id of ids) {
    // The SHARED file wins on a collision — see the header.
    if (id in current) continue;
    current[id] = oldEntries[id];
    adopted++;
  }
  if (adopted === 0) return 0;
  try {
    mkdirSync(dirname(shared), { recursive: true });
    const tmp = `${shared}.migrating`;
    writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    renameSync(tmp, shared);
  } catch {
    // A read-only home is a reason to keep running on the old file, not to fail startup.
    return 0;
  }
  return adopted;
}
