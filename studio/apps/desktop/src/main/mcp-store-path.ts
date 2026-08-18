/**
 * main/mcp-store-path.ts — ONE place both surfaces keep their MCP connectors.
 *
 * There were two. The CLI persisted to `$PROMETHEUS_HOME/config/mcp-servers.json` and the
 * desktop to `<userData>/mcp-servers.json` — the same file format, the same product, two
 * different files. So a connector added with `prometheus mcp add` was invisible in Studio's
 * Extensions panel, and one added in Studio was invisible to every CLI session. Both sides
 * reported success, both sides listed a different set, and nothing anywhere said the two
 * existed. `apps/cli/src/mcp-store.ts` even documents its file as "the SAME shape the desktop
 * Extensions panel manages", which was true of the shape and not of the file.
 *
 * The CLI's location wins as the shared one: `$PROMETHEUS_HOME` is the product-wide root that
 * the engine, the audit log, the session store and the grants already use, whereas `userData`
 * is Electron's per-app directory and means nothing to a terminal.
 *
 * MIGRATION is one-way and additive. Entries already in the old userData file are folded in
 * once, and an id that exists in both keeps the SHARED one — a user who has been running both
 * surfaces has the shared file as the newer truth, and silently overwriting it with a stale
 * desktop copy would be the one outcome worth avoiding. The old file is left on disk rather
 * than deleted: it costs nothing, and it is the only copy of the pre-migration state.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { prometheusHome } from "@prometheus/core/agent-system-host";

/** The shared connector file — the same path `prometheus mcp add` writes. */
export function sharedMcpStorePath(): string {
  return join(prometheusHome(), "config", "mcp-servers.json");
}

/** The desktop's former, app-private location. */
export function legacyMcpStorePath(userData: string): string {
  return join(userData, "mcp-servers.json");
}

/** Parse a store file into an id→entry map; anything unreadable is an EMPTY map, never a throw. */
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
 * Fold any desktop-only connectors into the shared file. Idempotent; never throws.
 *
 * Returns how many entries were adopted, so the caller can say so rather than migrating in
 * silence — a connector quietly appearing in a list is indistinguishable from a bug.
 */
export function migrateMcpStore(userData: string): number {
  const legacy = legacyMcpStorePath(userData);
  if (!existsSync(legacy)) return 0;
  const oldEntries = readStore(legacy);
  const ids = Object.keys(oldEntries);
  if (ids.length === 0) return 0;

  const shared = sharedMcpStorePath();
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
    // atomic temp+rename, matching the stores' own write discipline
    const tmp = `${shared}.migrating`;
    writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    renameSync(tmp, shared);
  } catch {
    // A read-only home is a reason to keep running on the old file, not to fail startup.
    return 0;
  }
  return adopted;
}
