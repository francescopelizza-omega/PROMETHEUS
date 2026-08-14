/**
 * agent/system/host/grants-store.ts — make "don't ask again" actually mean it.
 *
 * `ScopedPermissionStore` has four scopes: `once`, `session`, `project`, `user`. Three of them
 * worked. The fourth and fifth — the two that are supposed to OUTLIVE the session — did not,
 * because nothing ever serialized them: the store's own doc says "the host serializes `all()`",
 * and no host did. So a user who answered "yes, always" was asked again on the next start, and
 * the only lesson available to them was that the option does not work.
 *
 * `<config>/grants.json`, alongside `authorisation.json` and `token-toggles.json` — the same
 * config home, the same fail-soft posture (core's PURE half stays pure; the fs layer is here,
 * in the host half, alongside the other `system/host` modules).
 *
 * ONE FILE FOR BOTH SURFACES, deliberately. This started in `apps/cli`, which meant a grant
 * given in the terminal was invisible to the GUI and vice versa — the user would answer
 * "always" twice for the same tool and reasonably conclude the answer had not been recorded.
 * The authorisation LEVEL already has that split (CLI on disk, GUI in localStorage) and it is
 * a known wart; repeating it for a security decision the user makes once would be worse.
 *
 * TWO RULES THAT ARE SECURITY, NOT STYLE:
 *
 *  1. **Only `project` and `user` are written.** `once` and `session` are scoped to a lifetime
 *     that has ended by the time this runs; persisting either would silently promote a
 *     one-turn answer into a permanent one.
 *  2. **Rehydration goes through `add()`, never around it.** `add()` rejects over-broad
 *     subjects (`*`, `engine:*`, a bare bash wildcard, anything carrying `--force`). This file
 *     is a plain JSON file on the user's disk: it can be hand-edited, and it is exactly the
 *     thing a hostile process would write to. Loading it through the same door as a live grant
 *     means an edited file cannot express a grant the UI would have refused.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type * as agentNs from "../../../agent/index.js";
import * as cliProfiles from "../../../cli-profiles/index.js";

type Grant = agentNs.Grant;
type ScopedPermissionStore = agentNs.ScopedPermissionStore;

/** The scopes that survive a session — the only ones ever written. */
const PERSISTED: ReadonlySet<string> = new Set(["project", "user"]);

export function grantsPath(home: string = homedir()): string {
  return join(cliProfiles.configDir(home), "grants.json");
}

function isGrantShaped(x: unknown): x is Grant {
  if (typeof x !== "object" || x === null) return false;
  const g = x as Record<string, unknown>;
  if (typeof g.subject !== "string" || g.subject.length === 0) return false;
  if (g.decision !== "allow" && g.decision !== "deny") return false;
  if (!PERSISTED.has(String(g.scope))) return false;
  if (g.root !== undefined && typeof g.root !== "string") return false;
  if (g.paths !== undefined && !Array.isArray(g.paths)) return false;
  return true;
}

/** Read the persisted grants. A missing, corrupt or hand-mangled file reads as none. */
export function readGrants(home?: string): Grant[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(grantsPath(home), "utf8"));
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null
        ? ((parsed as { grants?: unknown }).grants ?? [])
        : [];
    if (!Array.isArray(rows)) return [];
    const out: Grant[] = [];
    for (const row of rows) {
      if (!isGrantShaped(row)) continue;
      // Rebuild the object field by field: an edited file must not smuggle extra keys into a
      // structure the permission engine reads.
      const g: Grant = {
        subject: row.subject,
        decision: row.decision,
        scope: row.scope,
        ...(typeof row.root === "string" ? { root: row.root } : {}),
        ...(Array.isArray(row.paths)
          ? { paths: row.paths.filter((p): p is string => typeof p === "string") }
          : {}),
      };
      out.push(g);
    }
    return out;
  } catch {
    return []; // fail-soft: never let a config file stop a session
  }
}

/**
 * Load the persisted grants INTO a store, through `add()` so every guard runs.
 *
 * Returns how many were accepted and how many the guards refused — a refusal is worth saying
 * out loud, because it means the file on disk asked for something the UI would not have.
 */
export function loadGrantsInto(
  store: ScopedPermissionStore,
  home?: string,
): { loaded: number; refused: number } {
  let loaded = 0;
  let refused = 0;
  for (const g of readGrants(home)) {
    const res = store.add(g);
    if (res.ok) loaded++;
    else refused++;
  }
  return { loaded, refused };
}

/** Write the store's long-lived grants. Best-effort: a read-only home must not break a turn. */
export function saveGrants(store: ScopedPermissionStore, home?: string): boolean {
  try {
    const keep = store.all().filter((g) => PERSISTED.has(g.scope));
    const path = grantsPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ grants: keep }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
