/**
 * session/authorisation-store.ts — persist the last-set `--authorisation` level so it
 * becomes the DEFAULT for every future prom session (CLI-SVC).
 *
 * Lives in the SAME config home as the CLI profiles + token toggles
 * (`<config>/authorisation.json`, a flat `{ "level": 0..7 }`). @prometheus/core stays PURE
 * (no fs); this fs layer is CLI-only. Fail-soft: a missing/corrupt file reads as "unset".
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cliProfiles } from "@prometheus/core";

function authPath(home: string = homedir()): string {
  return join(cliProfiles.configDir(home), "authorisation.json");
}

/** The saved level 0–7, or null when never set / unreadable (caller falls back to the default). */
export function readSavedAuthLevel(home?: string): number | null {
  try {
    const o = JSON.parse(readFileSync(authPath(home), "utf8"));
    if (o && typeof o === "object" && typeof o.level === "number") {
      const n = Math.trunc(o.level);
      if (n >= 0 && n <= 7) return n;
    }
  } catch {
    /* fail-soft — never set / corrupt ⇒ unset */
  }
  return null;
}

/** Persist the last-set level as the next-session default (creates the config dir). */
export function saveAuthLevel(level: number, home?: string): void {
  const n = Math.max(0, Math.min(Math.trunc(level), 7));
  try {
    mkdirSync(cliProfiles.configDir(home), { recursive: true });
    writeFileSync(authPath(home), `${JSON.stringify({ level: n }, null, 2)}\n`);
  } catch {
    /* best-effort — a read-only home must never crash the session */
  }
}
