// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/list.ts — `prometheus list`: the installable plugin/agent catalog.
 *
 * Renders the engine's `list` envelope (catalog[]). Read-only; no gating here —
 * a catalog row is gated only when the user explicitly runs `prometheus gate`/install.
 */
import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, sym, table } from "../render.js";

interface CatalogRow {
  name: string;
  tier?: string;
  summary?: string;
  repo?: string;
  stars?: number;
  license?: string;
  scope?: string;
  recommend_rank?: number;
  targets?: Record<string, { installed?: boolean }>;
}

function isInstalled(row: CatalogRow): boolean {
  if (!row.targets) return false;
  return Object.values(row.targets).some((t) => t && t.installed === true);
}

/** Tri-state install presence for the status mark (present ✓ / absent ✗ / unknown ·). */
function presenceOf(row: CatalogRow): "present" | "absent" | "unknown" {
  if (!row.targets) return "unknown";
  const vals = Object.values(row.targets).map((t) => t?.installed);
  if (vals.some((v) => v === true)) return "present";
  if (vals.some((v) => v === false)) return "absent";
  return "unknown";
}

/** Green ✓ present · red ✗ absent · dim · unknown — the same marks the GUI/picker use. */
function presenceMark(row: CatalogRow): string {
  const p = presenceOf(row);
  return p === "present" ? c.green("✓") : p === "absent" ? c.red("✗") : c.dim("·");
}

function tierColor(tier: string | undefined): string {
  switch (tier) {
    case "official":
      return c.green(tier);
    case "community":
      return c.blue(tier);
    default:
      return c.dim(tier ?? "—");
  }
}

export async function runList(ctx: CliContext): Promise<CommandOutcome> {
  const env = await ctx.client.list();

  if (ctx.json) {
    return { json: env, exitCode: env.ok === false ? 2 : 0 };
  }
  if (env.ok === false) {
    return { text: c.red(`list failed: ${env.error ?? "unknown error"}`), exitCode: 2 };
  }

  const catalog = Array.isArray(env.catalog) ? (env.catalog as CatalogRow[]) : [];
  const rows = catalog
    .slice()
    .sort((a, b) => {
      const ra = a.recommend_rank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.recommend_rank ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    })
    .map((row) => [
      presenceMark(row),
      row.name,
      tierColor(row.tier),
      typeof row.stars === "number" ? c.dim(`★${row.stars}`) : c.dim("—"),
      c.dim(truncate(row.summary ?? "", 64)),
    ]);

  const installed = catalog.filter(isInstalled).length;
  const lines: string[] = [];
  lines.push(heading(`Catalog  ${c.dim(`(${installed}/${catalog.length} installed)`)}`));
  lines.push("");
  lines.push(
    table(
      [
        { header: "" },
        { header: "NAME" },
        { header: "TIER" },
        { header: "STARS", align: "right" },
        { header: "SUMMARY" },
      ],
      rows,
    ),
  );
  return { text: lines.join("\n"), exitCode: 0 };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
