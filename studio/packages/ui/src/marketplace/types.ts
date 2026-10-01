// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * marketplace/types.ts — the in-GUI marketplace data model + PURE helpers (file 09 §6).
 *
 * One unified browser over four catalogs (Plugins / Skills / MCP Servers /
 * Extensions), every row carrying a live verdict chip. These are presentational
 * row shapes (data passed as props from the container) + the pure projections the
 * chip/filter/sort use. NOTHING decides "safe" — the chip color is a direct read of
 * the engine's `worst_verdict` (file 09 §6, mirrors computeIsError).
 */
import type { RoleToken } from "../tokens.js";

export type MarketplaceTab = "plugins" | "skills" | "mcp" | "extensions";

/** The engine's worst-verdict severity (mirror of core's WorstVerdict). */
export type WorstVerdict =
  | "clean"
  | "allow"
  | "low"
  | "medium"
  | "warn"
  | "high"
  | "critical"
  | "block"
  | "error";

export type CatalogTier = "official" | "community" | "external" | "documented";

export type McpHealth = "unknown" | "starting" | "ready" | "error" | "blocked";

export type SortBy = "rank" | "name" | "verdict";

/** A plugin/skill row (Plugins ← cmd_list; Skills ← cmd_skills_list). */
export interface MarketplaceRow {
  id: string;
  name: string;
  tier?: CatalogTier;
  repo?: string;
  rank?: number;
  worstVerdict?: WorstVerdict;
  summary?: string;
  securityNote?: string;
  installed?: boolean;
  /** documented-only entries (e.g. Odysseus) are never inline-installable (§6). */
  installable?: boolean;
}

/** An MCP server row (host connection — §2). */
export interface McpServerRow {
  id: string;
  label: string;
  health: McpHealth;
  source: "builtin" | "marketplace" | "imported" | "manual";
  transportKind: "stdio" | "http";
  worstVerdict?: WorstVerdict;
}

/** An extension (.promext) row — permissions are DECLARATIVE (from the manifest). */
export interface ExtensionRow extends MarketplaceRow {
  permissions: string[];
  publisher?: string;
}

/* ── PURE projections (the chip/filter/sort logic) ───────────────────────────── */

export interface ChipDisplay {
  glyph: string;
  label: string;
  role: RoleToken;
}

const OK = new Set<WorstVerdict>(["clean", "allow", "low"]);
const WARN = new Set<WorstVerdict>(["medium", "warn"]);

/** Map a worst_verdict → its chip {glyph,label,role} (token-driven; never a hex). */
export function verdictChip(w: WorstVerdict | undefined): ChipDisplay {
  if (w === undefined) return { glyph: "·", label: "—", role: "text-secondary" };
  if (OK.has(w)) return { glyph: "✓", label: "clean", role: "ok" };
  if (WARN.has(w)) return { glyph: "▲", label: w === "warn" ? "warn" : "medium", role: "warn" };
  if (w === "error") return { glyph: "⚠", label: "scan failed", role: "danger" };
  return { glyph: "⛔", label: "blocked", role: "danger" }; // high|critical|block
}

/** Rank a verdict for sorting (loudest first). */
export function verdictRank(w: WorstVerdict | undefined): number {
  if (w === undefined) return 0;
  if (OK.has(w)) return 1;
  if (WARN.has(w)) return 2;
  return 3; // block/error/high/critical
}

/** Tier glyph (§6 mock: ◆ official · ✓ external/community · ⓘ documented). */
export function tierGlyph(tier: CatalogTier | undefined): string {
  switch (tier) {
    case "official":
      return "◆";
    case "documented":
      return "ⓘ";
    default:
      return "✓";
  }
}

/** Health dot for an MCP server row. */
export function healthDot(h: McpHealth): ChipDisplay {
  switch (h) {
    case "ready":
      return { glyph: "●", label: "ready", role: "ok" };
    case "starting":
      return { glyph: "◐", label: "starting", role: "warn" };
    case "error":
      return { glyph: "○", label: "error", role: "danger" };
    case "blocked":
      return { glyph: "⛔", label: "blocked", role: "danger" };
    default:
      return { glyph: "○", label: "unknown", role: "text-secondary" };
  }
}

/** Case-insensitive filter over name/id/repo (active tab only — the container scopes it). */
export function filterRows<T extends { name: string; id: string; repo?: string }>(
  rows: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      r.id.toLowerCase().includes(q) ||
      (r.repo ?? "").toLowerCase().includes(q),
  );
}

/** Stable sort by rank (asc, undefined last), name (asc), or verdict (loudest first). */
export function sortRows<T extends MarketplaceRow>(rows: readonly T[], by: SortBy): T[] {
  const out = [...rows];
  out.sort((a, b) => {
    if (by === "name") return a.name.localeCompare(b.name);
    if (by === "verdict") return verdictRank(b.worstVerdict) - verdictRank(a.worstVerdict);
    // rank: ascending, undefined → bottom
    const ra = a.rank ?? Number.POSITIVE_INFINITY;
    const rb = b.rank ?? Number.POSITIVE_INFINITY;
    return ra === rb ? a.name.localeCompare(b.name) : ra - rb;
  });
  return out;
}
