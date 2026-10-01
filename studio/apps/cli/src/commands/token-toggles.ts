// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/token-toggles.ts — per-technique enable/disable persistence for `prometheus tokens` (CLI-088).
 *
 * The toggle state lives in the SAME config home as the CLI profiles (`<config>/token-toggles.json`,
 * a flat `{ [id]: boolean }`) — no new store family. @prometheus/core stays PURE (no fs); this fs
 * layer lives in the CLI only. Fail-soft: a missing/corrupt file reads as "nothing enabled".
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cliProfiles } from "@prometheus/core";

function togglesPath(home: string = homedir()): string {
  return join(cliProfiles.configDir(home), "token-toggles.json");
}

/** Read the persisted `{ [id]: boolean }` toggles (fail-soft: missing/corrupt ⇒ {}). */
export function readTokenToggles(home?: string): Record<string, boolean> {
  try {
    const o = JSON.parse(readFileSync(togglesPath(home), "utf8"));
    if (o && typeof o === "object" && !Array.isArray(o)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(o)) if (typeof v === "boolean") out[k] = v;
      return out;
    }
  } catch {
    /* fail-soft — no toggles */
  }
  return {};
}

/** Persist one technique's enabled state (atomic-enough single write; creates the config dir). */
export function setTokenToggle(id: string, enabled: boolean, home?: string): void {
  const cur = readTokenToggles(home);
  cur[id] = enabled;
  mkdirSync(cliProfiles.configDir(home), { recursive: true });
  writeFileSync(togglesPath(home), `${JSON.stringify(cur, null, 2)}\n`);
}

/** Is a technique currently enabled? */
export function isTokenEnabled(id: string, home?: string): boolean {
  return readTokenToggles(home)[id] === true;
}
