// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/workspace-view.ts — PURE view model for the handoff_3 §5 Workspace.
 *
 * §5 specifies three row shapes (Repos / Environments / Docs) whose cells are all
 * derivations: is this repo's scan still trustworthy, is this env healthy, what is this
 * document called. Each is a small judgement that is easy to get quietly wrong, so they live
 * here under node:test rather than inside JSX.
 *
 * ## Two cells §5 asks for that no source supplies
 *
 * `↑2 · clean` needs ahead/behind counts, and `RepoRow` (shared/ipc-contract.ts) carries no
 * such field — the repo sidecar reports a status enum and a commit, not a divergence count.
 * Likewise a document's age needs an mtime, and the workspace file walk returns paths only.
 * Both are therefore ABSENT rather than approximated: a sync summary that says `clean` when
 * nothing measured divergence is not a cosmetic inaccuracy, it is the exact claim a user
 * would rely on before pulling.
 */

/* ── Repos ───────────────────────────────────────────────────────────────────*/

/** The `RepoRow` fields these helpers read. Structural, so the contract type satisfies it. */
export interface RepoLike {
  status: string;
  branch?: string;
  commit?: string;
  pinnedCommit?: string;
  lastFetched?: string;
  lastVerdict?: { verdict?: string } | undefined;
}

/** One cell of §5's repo row: text plus the semantic role it paints at. */
export interface RowCell {
  text: string;
  role: "ok" | "warn" | "danger" | "muted";
}

/**
 * The sync summary.
 *
 * §5's example is `↑2 · clean`. There are no ahead/behind counts anywhere in the repo
 * contract, so this reports what IS known — whether the tree is pinned, and how long ago it
 * was fetched — and never claims a divergence it did not measure.
 */
export function repoSync(r: RepoLike): RowCell {
  if (r.pinnedCommit) return { text: "pinned", role: "ok" };
  if (!r.lastFetched) return { text: "never fetched", role: "warn" };
  return { text: `fetched ${r.commit ? r.commit.slice(0, 7) : "—"}`, role: "muted" };
}

/**
 * The scan status: `scanned ✓` when the gate has a verdict for the current tree, `stale scan`
 * when the sidecar says the tree moved since, and `unscanned` when it never ran.
 *
 * `stale` outranks the verdict deliberately. A repo whose last verdict was `allow` but whose
 * tree has since changed is not "scanned ✓"; that is precisely the window a rug-pull lands in.
 */
export function repoScan(r: RepoLike): RowCell {
  if (r.status === "stale") return { text: "stale scan", role: "warn" };
  if (r.status === "quarantined" || r.lastVerdict?.verdict === "block") {
    return { text: "blocked", role: "danger" };
  }
  if (r.lastVerdict?.verdict === "warn") return { text: "scanned ▲", role: "warn" };
  if (r.lastVerdict?.verdict === "allow") return { text: "scanned ✓", role: "ok" };
  return { text: "unscanned", role: "muted" };
}

/* ── Environments ────────────────────────────────────────────────────────────*/

/** The env fields these helpers read. The env payload is `Record<string, unknown>`. */
export interface EnvLike {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  python?: unknown;
  pythonVersion?: unknown;
  packages?: unknown;
  packageCount?: unknown;
  active?: unknown;
  broken?: unknown;
  /** 'ok' | 'degraded' | 'broken' | 'unknown' — the field rows actually carry. */
  health?: unknown;
  path?: unknown;
}

/** §5's env row: a health dot, a mono name, a detail line, a coloured status. */
export interface EnvRowView {
  id: string;
  name: string;
  /** "python 3.12 · 84 packages" — only the parts that exist. */
  detail: string;
  status: RowCell;
  active: boolean;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Project one env payload into a §5 row.
 *
 * The payload is `Record<string, unknown>` on the wire (`EnvListResult.envs`), so every field
 * is probed rather than trusted, and a detail line is assembled only from the parts that came
 * back. An env whose package count is missing says "python 3.12" — not "python 3.12 · 0
 * packages", which would read as an empty environment rather than an unmeasured one.
 */
export function envRow(e: EnvLike): EnvRowView {
  const id = str(e.id) ?? str(e.name) ?? str(e.path) ?? "";
  const parts: string[] = [];
  const py = str(e.pythonVersion) ?? str(e.python);
  if (py) parts.push(py.startsWith("python") ? py : `python ${py}`);
  const pkgs = num(e.packageCount) ?? (Array.isArray(e.packages) ? e.packages.length : null);
  if (pkgs !== null) parts.push(`${pkgs} ${pkgs === 1 ? "package" : "packages"}`);
  const kind = str(e.kind);
  if (kind) parts.push(kind);

  /**
   * The status comes from `health`, not from a `broken` boolean that no row carries.
   *
   * `EnvRow.health` is `'ok'|'degraded'|'broken'|'unknown'` (packages/ui/src/env/types.ts).
   * This probed `e.broken`, which is never set, so the broken branch — and the Recreate
   * action `envAction` derives from it — could not fire on any row, and a degraded env was
   * indistinguishable from a healthy idle one.
   */
  const health = str(e.health);
  const broken = health === "broken" || e.broken === true;
  const active = e.active === true;
  const status: RowCell = broken
    ? { text: "broken", role: "danger" }
    : health === "degraded"
      ? { text: "degraded", role: "warn" }
      : active
        ? { text: "active", role: "ok" }
        : { text: "idle", role: "muted" };

  return { id, name: str(e.name) ?? id, detail: parts.join(" · "), status, active };
}

/** The action §5 offers for an env row: Activate / Inspect / Recreate. */
export function envAction(row: EnvRowView): "Activate" | "Inspect" | "Recreate" {
  if (row.status.text === "broken") return "Recreate";
  return row.active ? "Inspect" : "Activate";
}

/* ── Docs ────────────────────────────────────────────────────────────────────*/

/** §5's doc row: filename, the path it lives at, and the absolute path to open. */
export interface DocRowView {
  path: string;
  filename: string;
  /** the directory, relative to the workspace root — ellipsized in the row. */
  dir: string;
}

/** Markdown-ish extensions the Docs segment lists. */
const DOC_EXT = /\.(md|mdx|markdown|rst|txt|adoc)$/i;

/**
 * Project a flat file walk into doc rows.
 *
 * Sorted by filename rather than by path so `README.md` from three packages sit together —
 * the question this list answers is "which document", and grouping by directory buries the
 * top-level README under whatever package sorts first.
 *
 * §5 asks for an age column. The walk (`ide.workspaceIndex`) returns paths only, with no
 * mtime, so there is no age to show and the row omits the column rather than inventing one.
 */
export function docRows(paths: readonly string[], root: string, limit = 200): DocRowView[] {
  const rows: DocRowView[] = [];
  for (const p of paths) {
    if (!DOC_EXT.test(p)) continue;
    const rel = root && p.startsWith(root) ? p.slice(root.length).replace(/^[/\\]/, "") : p;
    const cut = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"));
    rows.push({
      path: p,
      filename: cut === -1 ? rel : rel.slice(cut + 1),
      dir: cut === -1 ? "." : rel.slice(0, cut),
    });
  }
  rows.sort((a, b) => a.filename.localeCompare(b.filename) || a.dir.localeCompare(b.dir));
  return rows.slice(0, limit);
}

/** Resolve a semantic row role → its CSS var (never a raw hex, 08 §6). */
export function cellVar(role: RowCell["role"]): string {
  switch (role) {
    case "ok":
      return "var(--ok)";
    case "warn":
      return "var(--warn)";
    case "danger":
      return "var(--danger)";
    default:
      return "var(--text-muted)";
  }
}

/* ── the island's header action ──────────────────────────────────────────────*/

/**
 * §5 puts "Clone repo…" in the island HEADER, but the clone flow itself must stay exactly
 * where it is: staged with safe git flags, scanned by the real gate, with the verdict sheet
 * and typed force-confirm attached (routes/repos.tsx). A second clone entry point would be a
 * second place for that gate to be got wrong.
 *
 * So the header action is a NAVIGATION event: switch to Repos and focus the existing form.
 */
export const WORKSPACE_CLONE_EVENT = "prometheus:workspace-clone";

/** Ask the Workspace route to reveal + focus the (gated) clone form. */
export function requestClone(): void {
  window.dispatchEvent(new CustomEvent(WORKSPACE_CLONE_EVENT));
}
