// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * render/catalog-view.ts — P3 ANSI projectors for the catalog surface.
 *
 * Two pure presentation functions, GUI-parity with the desktop catalog route:
 *   • renderCatalogList(items, opts?) — the `list` table (one row per plugin,
 *     tier + scope + reach + stars), or a compact name-only list when asked.
 *   • renderItemCard(item) — the `describe`/`methods`/`tutorial` card: a single,
 *     pager-friendly PLAIN-text block (no boxes, no cursor moves) so it pipes
 *     cleanly into `less`/`more` and reads fine with NO_COLOR.
 *
 * Like the rest of apps/cli/src/render/*, this is pure string formatting over
 * data the engine-bridge already produced (C5): it NEVER decides install-ability
 * or safety — it only renders the `installable`/`security` fields verbatim.
 *
 * Color goes exclusively through the shared render.ts helpers (which source the
 * 16-color SGR map from @prometheus/ui/tokens, §8.1) — no raw hex, ever.
 */
import type { CatalogEntry } from "@prometheus/engine-bridge";

import { c, kv, padEnd, sym, table } from "../render.js";

// --------------------------------------------------------------------------- //
// renderCatalogList — the `list` table
// --------------------------------------------------------------------------- //

export interface CatalogListOptions {
  /**
   * "table" (default) renders the full multi-column grid; "compact" renders a
   * one-line-per-plugin name + summary list (good for narrow panes / palettes).
   */
  layout?: "table" | "compact";
  /** Optional title line above the list. Omitted when empty. */
  title?: string;
}

/**
 * Render a catalog (`prometheus list`) as a colored table or a compact list.
 * Returns a multi-line string with no trailing newline; empty catalogs render
 * a single dim "No catalog entries." line so callers always get a printable.
 */
export function renderCatalogList(items: CatalogEntry[], opts: CatalogListOptions = {}): string {
  const out: string[] = [];
  if (opts.title) out.push(c.bold(opts.title));

  if (items.length === 0) {
    out.push(c.dim("No catalog entries."));
    return out.join("\n");
  }

  if (opts.layout === "compact") {
    for (const item of items) {
      // "name  — summary", name tinted by tier, summary dimmed.
      const head = padEnd(tierTint(item.name, item.tier), 22);
      out.push(`${head} ${c.dim(truncate(item.summary, 64))}`);
    }
    return out.join("\n");
  }

  const rows = items.map((item) => [
    tierTint(item.name, item.tier),
    tierLabel(item.tier),
    scopeLabel(item.scope),
    reachCell(item),
    starsCell(item.stars),
    c.dim(item.license ?? "—"),
  ]);

  out.push(
    table(
      [
        { header: "NAME" },
        { header: "TIER" },
        { header: "SCOPE" },
        { header: "REACH" },
        { header: "STARS", align: "right" },
        { header: "LICENSE" },
      ],
      rows,
    ),
  );
  return out.join("\n");
}

// --------------------------------------------------------------------------- //
// renderItemCard — the describe / methods / tutorial card
// --------------------------------------------------------------------------- //

/**
 * Minimal structural shape consumed by renderItemCard.
 *
 * NOTE: the engine-bridge root barrel (@prometheus/engine-bridge) re-exports a
 * curated type subset that does NOT include DescribeEnvelope / MethodsEnvelope /
 * TutorialEnvelope (they live in engine-bridge's internal types/index.ts). To
 * stay decoupled from non-public types, the card takes this plain superset: the
 * always-present `describe` fields plus the OPTIONAL markdown sections from the
 * `methods` (install methods) and `tutorial` (deep dossier) envelopes. Callers
 * merge those envelopes' payloads into one object before rendering.
 */
export interface ItemCard {
  id: string;
  /** plugin | model_tool | app | model | documented */
  kind: string;
  name: string;
  summary: string;
  repo: string;
  license: string;
  category: string;
  tier: string;
  /** human security note from the engine (rendered verbatim, never re-judged). */
  security: string;
  /** false for documented-only / excluded entries (no install path). */
  installable: boolean;
  /** whether a deep tutorial (dossier) exists for `tutorial <id>`. */
  has_tutorial: boolean;
  /** the `methods` envelope's "## Install" markdown section (when fetched). */
  methods?: string | null;
  /** the `tutorial` envelope's full dossier markdown (when fetched). */
  tutorial?: string | null;
}

/**
 * Render a single catalog item card (describe + optional methods/tutorial) as a
 * plain, pager-friendly block: a header, a key/value metadata stanza, then the
 * methods and tutorial markdown sections when present. No box-drawing or cursor
 * control — just lines — so it pipes cleanly into `less` and survives NO_COLOR.
 */
export function renderItemCard(item: ItemCard): string {
  const out: string[] = [];

  // Header: name + kind badge + id.
  out.push(`${c.bold(item.name)}  ${kindBadge(item.kind)}  ${c.dim(item.id)}`);
  if (item.summary) {
    out.push("");
    out.push(item.summary);
  }

  // Metadata stanza.
  out.push("");
  out.push(kv("repo", item.repo || "—"));
  out.push(kv("category", item.category || "—"));
  out.push(kv("tier", item.tier ? tierLabel(item.tier) : c.dim("—")));
  out.push(kv("license", item.license || "—"));
  out.push(
    kv("installable", item.installable ? `${sym.ok()} yes` : `${sym.off()} documented-only`),
  );
  out.push(kv("tutorial", item.has_tutorial ? `${sym.ok()} available` : c.dim("none")));

  // Security note — rendered as-is (C5: the engine already decided, we don't).
  if (item.security) {
    out.push("");
    out.push(c.bold("Security"));
    for (const line of wrapMarkdownBlock(item.security)) out.push(line);
  }

  // Install methods section (markdown from the `methods` envelope).
  if (item.methods?.trim()) {
    out.push("");
    out.push(c.bold("Install methods"));
    for (const line of plainMarkdown(item.methods)) out.push(line);
  }

  // Deep tutorial / dossier (markdown from the `tutorial` envelope).
  if (item.tutorial?.trim()) {
    out.push("");
    out.push(c.bold("Tutorial"));
    for (const line of plainMarkdown(item.tutorial)) out.push(line);
  } else if (item.has_tutorial) {
    out.push("");
    out.push(c.dim(`Run \`prometheus tutorial ${item.id}\` for the full dossier.`));
  }

  return out.join("\n");
}

// --------------------------------------------------------------------------- //
// shared cell formatters
// --------------------------------------------------------------------------- //

/** Tint a plugin name by its tier (official=brand, community=accent, …). */
function tierTint(name: string, tier: string): string {
  switch (tier) {
    case "official":
      return c.role(name, "brand");
    case "community":
      return c.role(name, "accent");
    case "devtool":
      return c.role(name, "info");
    default:
      return name;
  }
}

/** A short, colored tier label. */
function tierLabel(tier: string): string {
  switch (tier) {
    case "official":
      return c.role("official", "brand");
    case "community":
      return c.role("community", "accent");
    case "devtool":
      return c.role("devtool", "info");
    default:
      return tier ? c.dim(tier) : c.dim("—");
  }
}

/** Scope label: claude-only vs universal. */
function scopeLabel(scope: string): string {
  switch (scope) {
    case "universal":
      return c.green("universal");
    case "claude-only":
      return c.yellow("claude-only");
    default:
      return scope ? c.dim(scope) : c.dim("—");
  }
}

/**
 * Reach cell: how many of the entry's known targets are installed.
 * Renders "n/m" where m is the number of targets the engine reported and n the
 * number it marked installed (null/unknown counts as not-installed for display).
 */
function reachCell(item: CatalogEntry): string {
  const targets = Object.values(item.targets ?? {});
  const total = targets.length;
  if (total === 0) return c.dim("—");
  const installed = targets.filter((t) => t.installed === true).length;
  const label = `${installed}/${total}`;
  if (installed === 0) return c.dim(label);
  if (installed === total) return c.green(label);
  return c.yellow(label);
}

/** Right-aligned stars cell ("—" when the engine has no count). */
function starsCell(stars: number | null): string {
  if (stars === null || stars === undefined) return c.dim("—");
  return c.dim(formatStars(stars));
}

/** Compact star count: 1234 -> "1.2k", 12000 -> "12k". */
function formatStars(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}

/** A colored kind badge for the card header. */
function kindBadge(kind: string): string {
  switch (kind) {
    case "plugin":
      return c.role("[plugin]", "brand");
    case "model_tool":
      return c.role("[model tool]", "accent");
    case "model":
      return c.role("[model]", "info");
    case "app":
      return c.role("[app]", "info");
    case "documented":
      return c.dim("[documented]");
    default:
      return kind ? c.dim(`[${kind}]`) : "";
  }
}

// --------------------------------------------------------------------------- //
// text helpers
// --------------------------------------------------------------------------- //

/** Truncate to `max` visible chars (plain text only), adding an ellipsis. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Lightly de-emphasize a short prose block: split on newlines, drop trailing
 * blank lines, dim each line. Used for the (usually one-paragraph) security note.
 */
function wrapMarkdownBlock(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => c.dim(line))
    .join("\n")
    .replace(/\n+$/, "")
    .split("\n");
}

/**
 * Turn engine markdown (methods/tutorial sections) into pager-friendly plain
 * lines: normalize CRLF, strip a trailing run of blank lines, dim ATX headings
 * (`# ...`) so the section structure reads without rendering Markdown. Indented
 * code and bullets pass through untouched.
 */
function plainMarkdown(md: string): string[] {
  const normalized = md.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return normalized.split("\n").map((line) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) return c.bold(heading[2] ?? line);
    return line;
  });
}
