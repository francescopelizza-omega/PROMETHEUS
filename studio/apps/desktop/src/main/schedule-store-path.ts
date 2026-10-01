// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/schedule-store-path.ts — ONE place both surfaces keep scheduled tasks, mirroring
 * mcp-store-path.ts exactly (same bug, same fix).
 *
 * There were two files, and this one was worse than mcp's ever was: the CLI's
 * `apps/cli/src/session/schedule-runner.ts` — the ONLY code anywhere that ever executes a due
 * task, reachable solely via `prometheus tasks run-due` — reads
 * `$PROMETHEUS_HOME/state/schedules.json`, while the desktop's Settings ▸ Scheduled Tasks page
 * wrote to `<userData>/schedules.json`. The desktop process has no runner of its own. So a task
 * created ENTIRELY through the GUI — enabled, showing a "Next run" countdown, with copy that
 * promises "run automatically, unattended" — could never execute via any path in this codebase:
 * it was persisted to a file nothing ever reads for execution.
 *
 * The CLI's location wins as the shared one, for the same reason mcp-store-path.ts's does.
 *
 * MIGRATION is one-way and additive, identical to mcp-store-path.ts's: entries already in the
 * old userData file are folded in once, an id present in both keeps the SHARED one, and the old
 * file is left on disk (cheap, and the only copy of pre-migration state).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { prometheusHome } from "@prometheus/core/agent-system-host";

/** The shared task-schedule file — the same path `prometheus tasks` / `schedule-runner.ts` use. */
export function sharedScheduleStorePath(): string {
  return join(prometheusHome(), "state", "schedules.json");
}

/** The desktop's former, app-private location. */
export function legacyScheduleStorePath(userData: string): string {
  return join(userData, "schedules.json");
}

/** Parse a store file into an id→task map; anything unreadable is an EMPTY map, never a throw. */
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
 * Fold any desktop-only scheduled tasks into the shared file. Idempotent; never throws.
 * Returns how many entries were adopted.
 */
export function migrateScheduleStore(userData: string): number {
  const legacy = legacyScheduleStorePath(userData);
  if (!existsSync(legacy)) return 0;
  const oldEntries = readStore(legacy);
  const ids = Object.keys(oldEntries);
  if (ids.length === 0) return 0;

  const shared = sharedScheduleStorePath();
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
