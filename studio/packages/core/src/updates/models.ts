/**
 * updates/models.ts — local (Ollama) model update detection + a curated FREE catalog.
 *
 * Ollama has no remote "is there a newer tag" endpoint; the manifest DIGEST is the change
 * signal. We snapshot each installed model's digest, and a later snapshot whose digest moved
 * means `ollama pull <tag>` would fetch new layers. We also recommend FREE, commercial-safe
 * coding models the user doesn't have yet. PURE: digests in, diff out; the CLI does the IO.
 * Licenses verified 2026-06-25 — Codestral is flagged non-commercial and never recommended.
 */

/** One installed Ollama model (from `ollama list` / GET /api/tags). */
export interface OllamaModel {
  /** the tag, e.g. "qwen2.5-coder:7b". */
  name: string;
  /** the manifest digest (sha256:… or a short id) — the change signal. */
  digest: string;
  /** bytes on disk, if known. */
  size?: number;
  /** ISO mtime, if known. */
  modifiedAt?: string;
}

/** A model digest snapshot: tag → digest. Persisted between checks. */
export type DigestSnapshot = Record<string, string>;

export interface ModelDigestDiff {
  /** tags whose digest changed since the last snapshot (a `pull` would update them). */
  changed: string[];
  /** tags present now but absent in the previous snapshot. */
  added: string[];
  /** tags gone since the last snapshot. */
  removed: string[];
}

/** Build the {tag: digest} snapshot for persistence. */
export function snapshotDigests(models: readonly OllamaModel[]): DigestSnapshot {
  const snap: DigestSnapshot = {};
  for (const m of models) snap[m.name] = m.digest;
  return snap;
}

/** Diff the current models against a previous digest snapshot. */
export function diffDigests(prev: DigestSnapshot, models: readonly OllamaModel[]): ModelDigestDiff {
  const now = snapshotDigests(models);
  const changed: string[] = [];
  const added: string[] = [];
  for (const [tag, dig] of Object.entries(now)) {
    if (!(tag in prev)) added.push(tag);
    else if (prev[tag] !== dig) changed.push(tag);
  }
  const removed = Object.keys(prev).filter((tag) => !(tag in now));
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

/** A model license's bearing on automated/commercial use. */
export type LicenseClass = "permissive" | "open-commercial" | "non-commercial";

export interface CatalogModel {
  /** the `ollama pull` tag. */
  tag: string;
  /** short capability note. */
  note: string;
  /** approx Q4 size on disk (GB). */
  gb: number;
  /** SPDX-ish license id. */
  license: string;
  /** automation/commercial bearing. */
  licenseClass: LicenseClass;
  /** rough minimum system RAM (GB) to run comfortably. */
  ramGb: number;
}

/**
 * Curated FREE, local, coding-capable models (mid-2026, via Ollama), small→large.
 * Commercial-safe first. Codestral is included but flagged non-commercial so the
 * recommender can exclude it by default.
 */
export const LOCAL_MODEL_CATALOG: readonly CatalogModel[] = Object.freeze([
  {
    tag: "qwen2.5-coder:7b",
    note: "proven coding workhorse — great default",
    gb: 4.7,
    license: "Apache-2.0",
    licenseClass: "permissive",
    ramGb: 8,
  },
  {
    tag: "qwen2.5-coder:14b",
    note: "stronger coder, fits 16GB boxes",
    gb: 9,
    license: "Apache-2.0",
    licenseClass: "permissive",
    ramGb: 16,
  },
  {
    tag: "devstral:24b",
    note: "best small agentic SWE (multi-file edits)",
    gb: 14,
    license: "Apache-2.0",
    licenseClass: "permissive",
    ramGb: 32,
  },
  {
    tag: "qwen3-coder:30b",
    note: "top agentic/repo-scale coder, 256K ctx",
    gb: 19,
    license: "Apache-2.0",
    licenseClass: "permissive",
    ramGb: 32,
  },
  {
    tag: "deepseek-coder-v2:16b",
    note: "strong coding MoE, 160K ctx",
    gb: 8.9,
    license: "DeepSeek License",
    licenseClass: "open-commercial",
    ramGb: 16,
  },
  {
    tag: "granite-code:8b",
    note: "IBM enterprise coder, 125K ctx",
    gb: 4.6,
    license: "Apache-2.0",
    licenseClass: "permissive",
    ramGb: 8,
  },
  {
    tag: "codestral:22b",
    note: "best FIM autocomplete — NON-COMMERCIAL license",
    gb: 13,
    license: "Mistral Non-Production License",
    licenseClass: "non-commercial",
    ramGb: 32,
  },
]);

export interface RecommendOpts {
  /** host RAM (GB) — only suggest models that fit. */
  ramGb?: number;
  /** include non-commercial-licensed models (default false). */
  allowNonCommercial?: boolean;
  /** cap the number of suggestions (default 3). */
  limit?: number;
}

/** Normalize a tag for "do I already have this" comparison (strip the :latest default). */
function baseTag(tag: string): string {
  return tag.includes(":") ? tag : `${tag}:latest`;
}

/**
 * Suggest catalog models the user does NOT have yet, that fit their RAM + license posture.
 * Commercial-safe by default (Codestral excluded). Smallest-fitting first.
 */
export function recommendUpgrades(
  installed: readonly string[],
  opts: RecommendOpts = {},
): CatalogModel[] {
  const have = new Set(installed.map(baseTag));
  const ram = opts.ramGb ?? Number.POSITIVE_INFINITY;
  const limit = opts.limit ?? 3;
  return LOCAL_MODEL_CATALOG.filter(
    (m) =>
      !have.has(baseTag(m.tag)) &&
      m.ramGb <= ram &&
      (opts.allowNonCommercial || m.licenseClass !== "non-commercial"),
  )
    .slice()
    .sort((a, b) => a.gb - b.gb)
    .slice(0, limit);
}
