// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * catalog/normalize.ts — PURE projections of engine JSON into `CatalogItem[]` (file 06 §2).
 *
 * No I/O, no spawning, no security decisions (C5). Every function takes the raw shape an
 * engine command emits (already parsed by the engine-bridge clients in `catalog.ts`) and
 * returns the Studio-side `CatalogItem`/`InstallTarget` projection. The verdict ride-through
 * is NOT computed here — `reconcile.ts` attaches the engine's signed verdict ref.
 *
 * Grounded against LIVE `prometheus.py --json` output @ 0.15.0:
 *   - `list`     → {catalog:[{name,tier,summary,repo,stars,license,scope,supported_os,
 *                             recommend_rank,targets:{agent:{method,installed}}}]}
 *   - `info <n>` → {plugin:{name,summary,tier,scope,repo,license,stars,category,
 *                  recommend_rank,automation,security_note,caveats,post_install_note,
 *                  supported_os,targets:{agent:{...}},components:[{name,kind,desc}]}}
 *   - `matrix`   → {agents:[...],reach:[{plugin,scope:"C"|"U",native,sync,unavailable}]}
 *   - `where <n>`→ {plugin:{name,scope,targets:[{agent,method,dest,mcp_name,repo_url,
 *                  universal_add}]}}
 *   - DOCUMENTED_ONLY → [{id,summary,why_excluded,doc_url}]  (NEVER in `list`; installable:false)
 *   - apps/worldsim/models → HUMAN TABLE lines (rawEngine.lines): a `[cat] id — Title  method`
 *     header + indented description / `safest:` / `serves on :PORT` / URL rows.
 *
 * Ordering (file 06 §4.1, mirrors cmd_wizard :10092): OFFICIAL above EXTERNAL, then ranked by
 * recommendRank (0 official; 1..N community), TIES BROKEN BY NAME. Items WITHOUT a rank sort
 * after ranked ones (still tier-grouped), by name.
 */

import type {
  CatalogComponent,
  CatalogItem,
  CatalogScope,
  CatalogTier,
  InstallState,
  InstallTarget,
  ReachCell,
} from "./types.js";

// ── loose engine input shapes (tolerant of omitted fields) ─────────────────────

/** One `list` catalog row (a subset of engine-bridge CatalogEntry; fields optional). */
export interface EngineListRow {
  name: string;
  tier?: string;
  summary?: string;
  repo?: string;
  stars?: number | null;
  forks?: number | null;
  license?: string | null;
  scope?: string;
  supported_os?: string[];
  recommend_rank?: number | null;
  category?: string;
  bundle?: boolean;
  redundancy_group?: string;
  targets?: Record<string, { method?: string; installed?: boolean | null }>;
}

/** The `info` plugin block (richer than a list row). */
export interface EngineInfoPlugin {
  name: string;
  summary?: string;
  tier?: string;
  scope?: string;
  repo?: string;
  owner?: string;
  license?: string | null;
  stars?: number | null;
  forks?: number | null;
  category?: string;
  recommend_rank?: number | null;
  redundancy_group?: string;
  bundle?: boolean;
  automation?: string;
  security_note?: string;
  caveats?: string[];
  post_install_note?: string;
  installs_skills?: boolean;
  supported_os?: string[];
  targets?: Record<string, EngineInfoTarget>;
  components?: { name?: string; id?: string; kind?: string; desc?: string }[];
}

interface EngineInfoTarget {
  method?: string;
  marketplace_name?: string | null;
  marketplace_repo?: string | null;
  mcp_name?: string | null;
  repo_url?: string | null;
  dest?: string | null;
  universal_add?: string | null;
}

/** A DOCUMENTED_ONLY reference entry (`prometheus.py:3648`). */
export interface DocumentedEntry {
  id: string;
  summary?: string;
  why_excluded?: string;
  doc_url?: string;
}

/** One `matrix` reach row. */
export interface MatrixReachRow {
  plugin: string;
  scope?: string; // compact "C" | "U"
  native?: string[];
  sync?: string[];
  unavailable?: string[];
}

/** One `where` per-agent target row. */
export interface WhereTargetRow {
  agent: string;
  method?: string;
  dest?: string;
  mcp_name?: string | null;
  repo_url?: string | null;
  universal_add?: string | null;
}

// ── small helpers ───────────────────────────────────────────────────────────────

const KNOWN_TIERS = new Set(["official", "community", "devtool", "documented"]);

/** Coerce an engine tier string to a CatalogTier (default "community"). */
function toTier(raw: unknown): CatalogTier {
  const t = String(raw ?? "").toLowerCase();
  return (KNOWN_TIERS.has(t) ? t : "community") as CatalogTier;
}

/** Coerce an engine scope ("claude-only"/"universal" or compact "C"/"U"). */
function toScope(raw: unknown): CatalogScope | undefined {
  const s = String(raw ?? "").toLowerCase();
  if (s === "universal" || s === "u") return "universal";
  if (s === "claude-only" || s === "c") return "claude-only";
  return undefined;
}

const KNOWN_OS = new Set(["macos", "linux", "windows"]);

/** Filter supported_os to the typed set; default ("macos","linux") like the Plugin dataclass. */
function toSupportedOs(raw: unknown): ("macos" | "linux" | "windows")[] {
  if (!Array.isArray(raw)) return ["macos", "linux"];
  const out = raw.map((x) => String(x).toLowerCase()).filter((x) => KNOWN_OS.has(x)) as (
    | "macos"
    | "linux"
    | "windows"
  )[];
  return out.length ? out : ["macos", "linux"];
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** A plugin "installs skills" when any target uses universal_skill / git_clone* (file 06 §1.2). */
const SKILL_DROPPING_METHODS = new Set(["universal_skill", "git_clone", "git_clone_shell"]);

function derivesSkills(targets?: Record<string, { method?: string }>): boolean {
  if (!targets) return false;
  return Object.values(targets).some((t) => SKILL_DROPPING_METHODS.has(String(t?.method ?? "")));
}

/** A fresh, empty install state (reconcile.ts fills the truth later). */
function emptyState(): InstallState {
  return { installed: false };
}

// ── list → CatalogItem[] (plugins) ──────────────────────────────────────────────

/**
 * Project a `list` catalog row into a plugin `CatalogItem`. `installsSkills` and the
 * derived components are inferred from the row's `targets` (the richer `info` fields
 * override these when an info detail is later merged in via `mergeInfo`).
 */
export function listRowToItem(row: EngineListRow): CatalogItem {
  const tier = toTier(row.tier);
  return {
    id: row.name,
    kind: "plugin",
    tier,
    title: row.name,
    summary: row.summary ?? "",
    category: strOrUndef(row.category),
    repo: strOrUndef(row.repo),
    license: strOrUndef(row.license ?? undefined),
    stars: numOrUndef(row.stars),
    forks: numOrUndef(row.forks),
    recommendRank: numOrUndef(row.recommend_rank),
    redundancyGroup: strOrUndef(row.redundancy_group),
    bundle: typeof row.bundle === "boolean" ? row.bundle : undefined,
    scope: toScope(row.scope),
    installsSkills: derivesSkills(row.targets),
    installable: true, // every `list` row is installable; only DOCUMENTED_ONLY is not
    supportedOs: toSupportedOs(row.supported_os),
    state: emptyState(),
  };
}

/** Project the whole `list.catalog` array (UNSORTED — call `sortCatalog` to order). */
export function listToItems(rows: EngineListRow[] | undefined): CatalogItem[] {
  return (rows ?? []).map(listRowToItem);
}

// ── info → component/guidance enrichment ────────────────────────────────────────

/** Project `info.plugin.components` into the selectable sub-unit list (`:sel`/`--only`). */
export function infoComponents(plugin: EngineInfoPlugin): CatalogComponent[] {
  const comps = plugin.components ?? [];
  return comps
    .map((c) => ({ id: String(c.id ?? c.name ?? ""), kind: String(c.kind ?? "") }))
    .filter((c) => c.id.length > 0);
}

/** Build a full plugin `CatalogItem` from the rich `info` detail (richer than a list row). */
export function infoToItem(plugin: EngineInfoPlugin): CatalogItem {
  const components = infoComponents(plugin);
  return {
    id: plugin.name,
    kind: "plugin",
    tier: toTier(plugin.tier),
    title: plugin.name,
    summary: plugin.summary ?? "",
    category: strOrUndef(plugin.category),
    repo: strOrUndef(plugin.repo),
    owner: strOrUndef(plugin.owner),
    license: strOrUndef(plugin.license ?? undefined),
    stars: numOrUndef(plugin.stars),
    forks: numOrUndef(plugin.forks),
    recommendRank: numOrUndef(plugin.recommend_rank),
    redundancyGroup: strOrUndef(plugin.redundancy_group),
    bundle: typeof plugin.bundle === "boolean" ? plugin.bundle : undefined,
    scope: toScope(plugin.scope),
    components: components.length ? components : undefined,
    installsSkills:
      typeof plugin.installs_skills === "boolean"
        ? plugin.installs_skills
        : derivesSkills(plugin.targets),
    automation: strOrUndef(plugin.automation),
    securityNote: strOrUndef(plugin.security_note),
    caveats: plugin.caveats?.length ? plugin.caveats.map(String) : undefined,
    postInstallNote: strOrUndef(plugin.post_install_note),
    installable: true,
    supportedOs: toSupportedOs(plugin.supported_os),
    state: emptyState(),
  };
}

/**
 * Merge rich `info` fields into an existing list-derived `CatalogItem` WITHOUT discarding
 * its reconciled `state`. Used when the card opens and we fetch `info` for the full detail.
 */
export function mergeInfo(item: CatalogItem, plugin: EngineInfoPlugin): CatalogItem {
  const detail = infoToItem(plugin);
  return {
    ...item,
    ...detail,
    // preserve the (separately reconciled) live state + any already-bound verdict
    state: item.state,
  };
}

// ── matrix → reach map ──────────────────────────────────────────────────────────

/** Convert one matrix reach row into the per-agent `{agent: native|sync|-}` map. */
export function reachRowToMap(row: MatrixReachRow): Record<string, ReachCell> {
  const out: Record<string, ReachCell> = {};
  for (const a of row.native ?? []) out[a] = "native";
  for (const a of row.sync ?? []) out[a] = "sync";
  for (const a of row.unavailable ?? []) out[a] = "-";
  return out;
}

/** Index all matrix reach rows by plugin name → reach map (for fast item annotation). */
export function reachIndex(
  reach: MatrixReachRow[] | undefined,
): Map<string, Record<string, ReachCell>> {
  const idx = new Map<string, Record<string, ReachCell>>();
  for (const row of reach ?? []) idx.set(row.plugin, reachRowToMap(row));
  return idx;
}

/** Attach reach (+ scope, when the matrix carries the compact code) onto matching items. */
export function applyReach(
  items: CatalogItem[],
  reach: MatrixReachRow[] | undefined,
): CatalogItem[] {
  const idx = reachIndex(reach);
  const scopeByPlugin = new Map<string, CatalogScope | undefined>();
  for (const row of reach ?? []) scopeByPlugin.set(row.plugin, toScope(row.scope));
  return items.map((it) => {
    const r = idx.get(it.id);
    if (!r) return it;
    return { ...it, reach: r, scope: it.scope ?? scopeByPlugin.get(it.id) };
  });
}

// ── where → InstallTarget[] (the dry-run destination preview) ───────────────────

/** Project `where.plugin.targets` into the dry-run `InstallTarget[]` preview. */
export function whereTargets(targets: WhereTargetRow[] | undefined): InstallTarget[] {
  return (targets ?? []).map((t) => ({
    agent: t.agent,
    method: String(t.method ?? ""),
    dest: String(t.dest ?? ""),
    mcpName: strOrUndef(t.mcp_name ?? undefined),
    repoUrl: strOrUndef(t.repo_url ?? undefined),
    universalAdd: strOrUndef(t.universal_add ?? undefined),
  }));
}

// ── DOCUMENTED_ONLY → read-only reference cards (installable:false) ─────────────

/**
 * Project a DOCUMENTED_ONLY entry into a read-only `CatalogItem`. `installable:false` is
 * set HERE (in core), not merely hidden in the UI — file 06 §0 rule 2 / §10. No Install
 * action should be rendered for these; `docUrl` + `whyExcluded` drive the caution card.
 */
export function documentedToItem(entry: DocumentedEntry): CatalogItem {
  return {
    id: entry.id,
    kind: "plugin",
    tier: "documented",
    title: entry.id,
    summary: entry.summary ?? "",
    installable: false, // ENFORCED in core (file 06 §10)
    docUrl: strOrUndef(entry.doc_url),
    whyExcluded: strOrUndef(entry.why_excluded),
    supportedOs: ["macos", "linux"],
    state: emptyState(),
  };
}

export function documentedToItems(entries: DocumentedEntry[] | undefined): CatalogItem[] {
  return (entries ?? []).map(documentedToItem);
}

// ── apps / worldsim / models HUMAN TABLE → CatalogItem[] ────────────────────────

/**
 * Parse the human-table `lines` (from `rawEngine`) for `apps`/`worldsim`/`models` list into
 * `CatalogItem[]`. The table format (verified LIVE @ 0.15.0):
 *
 *   `  [category] id — Title   <install-method hint>`
 *   `      <description>`
 *   `      safest: <safest alternative>`
 *   `      serves on :<port>`           (optional)
 *   `      https://github.com/owner/repo` (optional)
 *
 * A new item starts at every header line (the `[category] id — Title` shape). Subsequent
 * indented lines enrich the current item until the next header. This is a faithful
 * projection of LIVE engine output — it NEVER fabricates rows.
 */
export interface AppTableOptions {
  /** the catalog kind the table belongs to ("app" | "worldsim" | "model-tool"). */
  kind: "app" | "worldsim" | "model-tool";
  /** tier for these rows ("devtool" for apps/worldsim repos; "community" for model-tools). */
  tier?: CatalogTier;
}

// `[cat] id — Title   rest`  — the em-dash separates id from Title (engine uses " — ").
const HEADER_RE = /^\s*\[([^\]]+)\]\s+(\S+)\s+—\s+(.+)$/;
const URL_RE = /(https?:\/\/\S+)/;
const PORT_RE = /serves on\s+:?(\d+)/i;
const SAFEST_RE = /^\s*safest:\s*(.+)$/i;

/** Derive "owner/repo" from a GitHub URL, else undefined. */
function ownerRepoFromUrl(url: string): { repo?: string; owner?: string } {
  const m = url.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (!m || !m[1] || !m[2]) return {};
  const owner = m[1];
  const name = m[2].replace(/\.git$/, "");
  return { repo: `${owner}/${name}`, owner };
}

export function appTableToItems(lines: string[], opts: AppTableOptions): CatalogItem[] {
  const items: CatalogItem[] = [];
  let cur: CatalogItem | null = null;
  let titleRest = ""; // the post-Title remainder of the header (install-method hint)

  const flush = () => {
    if (cur) {
      // fold the install-method hint into the summary when no description was found
      if (!cur.summary && titleRest) cur.summary = titleRest.trim();
      items.push(cur);
    }
    cur = null;
    titleRest = "";
  };

  for (const raw of lines) {
    const header = raw.match(HEADER_RE);
    if (header) {
      flush();
      const category = (header[1] ?? "").trim();
      const id = (header[2] ?? "").trim();
      const titleAndRest = header[3] ?? "";
      // Title is the first run before 2+ spaces; the rest is the method hint.
      const split = titleAndRest.split(/\s{2,}/);
      const title = (split[0] ?? id).trim();
      titleRest = split.slice(1).join("  ").trim();
      cur = {
        id,
        kind: opts.kind,
        tier: opts.tier ?? (opts.kind === "model-tool" ? "community" : "devtool"),
        title,
        summary: "",
        category,
        installable: true,
        supportedOs: ["macos", "linux"],
        state: emptyState(),
      };
      continue;
    }
    const item = cur; // non-null narrowing survives the closure-mutated `cur`
    if (!item) continue;

    const url = raw.match(URL_RE);
    if (url?.[1]) {
      const { repo, owner } = ownerRepoFromUrl(url[1]);
      if (repo && !item.repo) item.repo = repo;
      if (owner && !item.owner) item.owner = owner;
      continue;
    }
    const port = raw.match(PORT_RE);
    if (port?.[1]) {
      item.state = { ...item.state, port: port[1] };
      continue;
    }
    const safest = raw.match(SAFEST_RE);
    if (safest?.[1]) {
      // the "safest install" steer → security guidance (verbatim, never paraphrased)
      item.securityNote = safest[1].trim();
      continue;
    }
    // first plain indented line = the description
    if (!item.summary) {
      item.summary = raw.trim();
    }
  }
  flush();
  return items;
}

// ── ordering (file 06 §4.1) ─────────────────────────────────────────────────────

const TIER_ORDER: Record<CatalogTier, number> = {
  official: 0,
  community: 1,
  devtool: 2,
  documented: 3,
};

/**
 * Sort a catalog list for display (file 06 §4.1, mirrors cmd_wizard :10092):
 *   1. by TIER  (official → community → devtool → documented)
 *   2. then by recommendRank ASC (0 official, 1..N community); UNRANKED sort last
 *   3. ties broken by case-insensitive title.
 * Pure + stable; returns a NEW array (does not mutate the input).
 */
export function sortCatalog(items: CatalogItem[]): CatalogItem[] {
  return [...items].sort((a, b) => {
    const ta = TIER_ORDER[a.tier] ?? 9;
    const tb = TIER_ORDER[b.tier] ?? 9;
    if (ta !== tb) return ta - tb;
    const ra = a.recommendRank ?? Number.POSITIVE_INFINITY;
    const rb = b.recommendRank ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
  });
}

/**
 * The full plugin-catalog projection: `list` rows + DOCUMENTED_ONLY entries → reach-annotated,
 * sorted `CatalogItem[]`. OFFICIAL above EXTERNAL above DOCUMENTED, ranked, ties-by-name.
 */
export function buildPluginCatalog(input: {
  list?: EngineListRow[];
  documented?: DocumentedEntry[];
  reach?: MatrixReachRow[];
}): CatalogItem[] {
  const plugins = applyReach(listToItems(input.list), input.reach);
  const docs = documentedToItems(input.documented);
  return sortCatalog([...plugins, ...docs]);
}
