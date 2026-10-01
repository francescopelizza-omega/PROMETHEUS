// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/model-health-command.ts — the body of the `/model-health` slash command: print the
 * on-disk `EndpointHealthRecord` for every endpoint this install has ever talked to, as a table.
 *
 * Registration (name/aliases/group in the SLASH_REGISTRY) is the host's job; this file is only
 * the pure, directly-testable `run()` body, mirroring the ctx.write / ctx.home conventions
 * `/tab-complete` (slash-registry.ts) already uses. The store itself lives in the sibling
 * model-health-store.ts (I/O only); the rendering lives in @prometheus/core's ai/model-health
 * (pure formatting, already tested there) — this file just wires the two together for the CLI.
 */
import { formatHealthTable } from "@prometheus/core";

import { loadModelHealth } from "./model-health-store.js";

/**
 * Run `/model-health`: load the global store for `ctx.home`, render it as a table via the core
 * `formatHealthTable`, and write it out to `ctx.write` ONE LINE AT A TIME — `ctx.write` is a
 * single-line writer in this codebase's convention, and `formatHealthTable` returns one
 * multi-line string, so it is split on "\n" before printing.
 *
 * An empty store is not special-cased here: `formatHealthTable([], …)` already renders its own
 * "no endpoint has been used yet this install" line, so an install that has never talked to a
 * model reads as informative rather than blank or broken.
 */
export function runModelHealthCommand(
  ctx: { home: string; write: (line: string) => void },
  nowMs?: number,
): void {
  const store = loadModelHealth(ctx.home);
  const records = Object.values(store);
  const table = formatHealthTable(records, nowMs ?? Date.now());
  for (const line of table.split("\n")) ctx.write(line);
}
