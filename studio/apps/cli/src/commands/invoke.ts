// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/invoke.ts — the `/invoke` repo-install picker (CLI side of the unified install).
 *
 * Lists the installable catalog with a present/absent status mark (green ✓ installed / red ✗
 * absent / · unknown — the SAME tri-state the GUI panel + the core reconcile use), lets the
 * user pick one, and runs the install through the canonical NEMESIS-GATED install verb (a
 * dry-run preview shows the verdict, then a typed confirm executes). It never installs
 * anything itself — `install` is an injected seam that routes to the gated engine path, so the
 * security gate (Phase 0) is identical to every other install surface.
 *
 * Selection is by number so it works identically in the line-based host AND the raw-mode TUI;
 * the TUI can later overlay arrow-key navigation on the same data + dispatch.
 */
import type { EngineClient } from "@prometheus/engine-bridge";

import { c } from "../render.js";

export interface CatalogRow {
  name: string;
  tier?: string;
  summary?: string;
  recommend_rank?: number;
  targets?: Record<string, { installed?: boolean }>;
}

export type Presence = "present" | "absent" | "unknown";

/** Tri-state install presence for the status mark (mirrors core presenceOf + list.ts). */
export function presenceOf(row: CatalogRow): Presence {
  if (!row.targets) return "unknown";
  const vals = Object.values(row.targets).map((t) => t?.installed);
  if (vals.some((v) => v === true)) return "present";
  if (vals.some((v) => v === false)) return "absent";
  return "unknown";
}

/** The colored tri-state glyph (green ✓ / red ✗ / dim ·). */
export function mark(p: Presence): string {
  return p === "present" ? c.green("✓") : p === "absent" ? c.red("✗") : c.dim("·");
}

/** The catalog fetch outcome: `ok:false` (transport/engine error → "unavailable") vs a rows list
 *  (possibly empty → "no matches"/"empty"). Keeps the two states distinct for honest messaging. */
export interface CatalogResult {
  ok: boolean;
  rows: CatalogRow[];
  error?: string;
}

/** Fetch + rank the installable catalog rows (recommend_rank, then name), capped at 40 (CLI-059).
 *  `ok:false` on a catalog error (distinct from an empty catalog) so both surfaces message it. */
export async function fetchCatalogRows(client: EngineClient, filter = ""): Promise<CatalogResult> {
  let env: { ok?: boolean; catalog?: unknown; error?: string };
  try {
    env = (await client.list()) as typeof env;
  } catch (err) {
    return { ok: false, rows: [], error: err instanceof Error ? err.message : String(err) };
  }
  if (env.ok === false) return { ok: false, rows: [], error: env.error ?? "unknown error" };
  const catalog = Array.isArray(env.catalog) ? (env.catalog as CatalogRow[]) : [];
  const q = filter.trim().toLowerCase();
  const rows = catalog
    .filter(
      (r) => !q || r.name.toLowerCase().includes(q) || (r.summary ?? "").toLowerCase().includes(q),
    )
    .sort((a, b) => {
      const ra = a.recommend_rank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.recommend_rank ?? Number.MAX_SAFE_INTEGER;
      return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
    })
    .slice(0, 40);
  return { ok: true, rows };
}

/**
 * Run the canonical nemesis-gated install of ONE catalog entry: an already-installed repo asks to
 * reinstall; a dry-run preview shows the verdict; a typed confirm executes. Extracted so BOTH the
 * number-pick list AND the arrow-nav overlay (CLI-059) dispatch through the IDENTICAL gated path.
 */
export async function dispatchInvoke(pick: CatalogRow, deps: InvokeDeps, args = ""): Promise<void> {
  const extra = args.trim() ? { args: args.trim() } : {};
  if (presenceOf(pick) === "present") {
    const again = await deps.confirm(
      `${pick.name} already appears installed — reinstall/update anyway?`,
    );
    if (!again) {
      deps.write(c.dim("(left as-is)"));
      return;
    }
  }
  // preview: the dry-run install renders the nemesis verdict + the plan, no mutation. This MUST
  // pass dryRun:true — without it (the previous bug), any catalog entry that passed nemesis
  // cleanly (the common case) had this "preview" perform a REAL install before the user was
  // ever asked to confirm, making the later "(not installed)" message on decline false.
  deps.write(c.dim(`previewing the nemesis-gated install of ${c.cyan(pick.name)}…`));
  await deps.install(pick.name, { ...extra, dryRun: true });
  const go = await deps.confirm(
    `install ${pick.name} now? (runs the nemesis gate before any change)`,
  );
  if (!go) {
    deps.write(c.dim("(not installed)"));
    return;
  }
  await deps.install(pick.name, { ...extra, yes: true });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export interface InvokeDeps {
  client: EngineClient;
  write: (line: string) => void;
  ask: (prompt: string) => Promise<string>;
  confirm: (prompt: string) => Promise<boolean>;
  /** run the canonical nemesis-gated install verb (preview unless yes). `args` = extra tokens the
   *  overlay's argument prompt collected (CLI-059); forwarded verbatim to the gated install verb.
   *  `dryRun` MUST reach the engine as a real `--dry-run` flag — this is the ONLY thing that
   *  makes the preview call in `dispatchInvoke` actually not mutate anything. */
  install: (
    name: string,
    opts?: { yes?: boolean; dryRun?: boolean; args?: string },
  ) => Promise<void>;
}

/** `/invoke [filter]` — pick a repo from the catalog + install it (nemesis-gated). The number-pick
 *  list; the raw-mode TUI overlays arrow-nav on the SAME rows + `dispatchInvoke` (CLI-059). */
export async function runInvoke(rest: string, deps: InvokeDeps): Promise<void> {
  const res = await fetchCatalogRows(deps.client, rest);
  if (!res.ok) {
    deps.write(c.red(`/invoke: catalog unavailable: ${res.error ?? "unknown error"}`));
    return;
  }
  const rows = res.rows;
  const q = rest.trim().toLowerCase();
  if (rows.length === 0) {
    deps.write(c.dim(q ? `No catalog repos match "${q}".` : "Catalog is empty."));
    return;
  }
  deps.write(`${c.bold("Invoke — pick a repo to install")} ${c.dim("(nemesis-gated)")}`);
  deps.write(c.dim(`  ${c.green("✓")} installed   ${c.red("✗")} not installed   · unknown`));
  rows.forEach((r, i) => {
    deps.write(
      `  ${String(i + 1).padStart(2)}) ${mark(presenceOf(r))} ${c.cyan(r.name)}  ${c.dim(truncate(r.summary ?? "", 56))}`,
    );
  });
  deps.write(c.dim("Type a number to install it (Enter to cancel)."));

  const ans = (await deps.ask("invoke #: ")).trim();
  const n = Number(ans);
  if (!Number.isInteger(n) || n < 1 || n > rows.length) {
    deps.write(c.dim("(cancelled)"));
    return;
  }
  const pick = rows[n - 1];
  if (!pick) return;
  await dispatchInvoke(pick, deps);
}
