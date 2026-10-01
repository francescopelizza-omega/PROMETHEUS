// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/model-activity-store.ts — the desktop's half of the ONE shared "when was a local model
 * last used" file, mirroring model-health-store-path.ts's sharing convention exactly: the CLI's
 * `$PROMETHEUS_HOME/state/model-activity.json` (apps/cli/src/session/model-activity-store.ts)
 * IS the shared file, no separate app-private copy — there's no legacy desktop-only predecessor
 * to migrate here, unlike model health, so this file is deliberately simpler.
 *
 * Read by packages/engine-bridge/src/ollama-watchdog-entry.ts's idle-shutdown loop; written by
 * this module AND its CLI/VS Code siblings whenever ANY surface completes a request to a local
 * endpoint, so the watchdog sees cross-surface activity, not just its own starter's.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { prometheusHome } from "@prometheus/core/agent-system-host";

/** The shared activity file — the same path the CLI's model-activity-store.ts writes. */
export function sharedModelActivityPath(): string {
  return join(prometheusHome(), "state", "model-activity.json");
}

/** Record "a local model was just used, right now". Never throws — see the CLI sibling's doc
 *  for why a missed tick is the safe direction to fail in. */
export function touchModelActivity(): void {
  try {
    const file = sharedModelActivityPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ lastActiveAt: Date.now() })}\n`);
  } catch {
    /* best-effort */
  }
}

/** Fail-soft read, mainly for tests/diagnostics — production only ever writes this file. */
export function readModelActivity(): { lastActiveAt: number } {
  try {
    const raw = JSON.parse(readFileSync(sharedModelActivityPath(), "utf8")) as unknown;
    const at =
      raw && typeof raw === "object" ? (raw as { lastActiveAt?: unknown }).lastActiveAt : undefined;
    return { lastActiveAt: typeof at === "number" && Number.isFinite(at) ? at : 0 };
  } catch {
    return { lastActiveAt: 0 };
  }
}
