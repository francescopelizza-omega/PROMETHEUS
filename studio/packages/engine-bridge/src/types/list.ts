/**
 * types/list.ts — the `list` envelope + CatalogEntry (file 02 §3.3).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json list` @ 0.15.0):
 *   {"command":"list","ok":true,
 *    "catalog":[{"name","tier","summary","repo","stars":num|null,
 *                "license":str|null,"scope":"claude-only"|"universal",
 *                "supported_os":[..],"recommend_rank":num|null,
 *                "targets":{ "<agent>": {"method","installed":bool|null} }}],
 *    "detected_agents":[...]}
 * NOTE: the probed envelope did not always include `detected_agents`; it is
 * optional here so the type tolerates engines that omit it.
 */
import type { EnvelopeBase } from "./envelope.js";

/** Plugin tier; open-ended (official | community | devtool | …future). */
export type CatalogTier = "official" | "community" | "devtool" | (string & {});

/** Install scope mirrors InstallScope but stays string-open for forward compat. */
export type CatalogScope = "claude-only" | "universal" | (string & {});

/** Per-agent install target inside a catalog entry's `targets` map. */
export interface CatalogTarget {
  method: string;
  /** true installed, false not, null when the engine cannot determine it. */
  installed: boolean | null;
}

/** One registry catalog row. */
export interface CatalogEntry {
  name: string;
  tier: CatalogTier;
  summary: string;
  repo: string;
  stars: number | null;
  license: string | null;
  scope: CatalogScope;
  supported_os: string[];
  recommend_rank: number | null;
  targets: Record<string, CatalogTarget>;
}

export type ListEnvelope = EnvelopeBase<{
  command: "list";
  catalog: CatalogEntry[];
  detected_agents?: string[];
}>;
