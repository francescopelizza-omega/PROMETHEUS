/**
 * updates/catalog.ts — one shape for "a model you could install", from several sources.
 *
 * ── WHY A SHARED SHAPE AND NOT A SOURCE-SPECIFIC ONE ────────────────────────────────────────
 *
 * The browser draws rows from places that agree on almost nothing. HuggingFace knows download
 * counts and file sizes but not whether a tag exists in ollama; the curated in-repo list knows
 * licences and RAM floors but is a handful of rows; ollama's own recommendation endpoint returns
 * five entries, four of them cloud. A row has to be comparable across all of them or the list
 * cannot be sorted, filtered or judged as one thing.
 *
 * So every source is normalised into `CatalogEntry`, and the fields a source cannot fill stay
 * ABSENT rather than defaulted. That distinction is the whole point: `sizeBytes: undefined`
 * means "this source does not publish a size", and a filter that treated it as 0 would show a
 * 40 GB model as fitting comfortably on a 16 GB machine.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────────
 *
 * `ollama.com/library` is not a source. Its terms prohibit automated access, and PROMETHEUS is
 * arguably a competing product under the same clause. The catalogue that replaces it is
 * HuggingFace's documented API — which closes the loop anyway, because `ollama run hf.co/<repo>`
 * is officially supported, so browse-on-HF → install-into-ollama needs no scraping and no
 * conversion.
 *
 * PURE: rows in, rows out. Every fetch is the caller's.
 */

import { estimatedLowerBound } from "../ai/model-footprint.js";
import type { LicenseClass } from "./models.js";

/** Where a row came from. Shown to the user, because sources differ in what they can be trusted for. */
export type CatalogSource =
  /** HuggingFace Hub — the broad, documented, rate-limited catalogue. */
  | "huggingface"
  /** the curated in-repo list: few rows, but licence and RAM floor are human-verified. */
  | "curated"
  /** ollama's own `model-recommendations` endpoint. Official, tiny, mostly cloud. */
  | "ollama-recommended"
  /** already on this machine. */
  | "installed";

/** How a row would be installed, which decides what the browser can offer to do about it. */
export type InstallRoute =
  /** `ollama pull <tag>` — a tag in ollama's own library. */
  | { kind: "ollama-tag"; tag: string }
  /**
   * `ollama run hf.co/<repo>:<quant>` — officially supported, and the reason HuggingFace works
   * as a catalogue without any conversion step.
   */
  | { kind: "ollama-hf"; repo: string; quant?: string }
  /** nothing automatic: a repo with no published GGUF needs the conversion path. */
  | { kind: "manual"; why: string };

export interface CatalogEntry {
  /** stable within a source; `source + id` is unique across the catalogue. */
  id: string;
  source: CatalogSource;
  /** what to show as the row's name. */
  name: string;
  /** one line. May be empty — a model card is a second request and is fetched lazily. */
  summary: string;
  /**
   * Download size. ABSENT when it is not known — never 0.
   *
   * A filter that read a missing size as 0 would rank a 40 GB model as the smallest thing in the
   * list and tell a 16 GB machine it fits.
   */
  sizeBytes?: number;
  /**
   * True when `sizeBytes` is DERIVED rather than published.
   *
   * It exists because HuggingFace's list endpoint does not publish a usable one. Measured:
   * `gguf.totalFileSize` is one ARBITRARY file from the repo — it matched `f16.gguf` for
   * `bartowski/Qwen2.5-Coder-7B-Instruct-GGUF` (15.2 GB, against a 4.68 GB Q4_K_M and a 121 GB
   * repo total) and `IQ4_NL.gguf` for the unsloth 30B. Showing it as "the size" was wrong by
   * +226% on the 7B, and it made two rows in one list incomparable.
   *
   * So the size shown is estimated from the parameter count instead, and this flag makes the
   * renderer say so. The exact figure needs a second request per repo (`/tree/main`).
   */
  sizeEstimated?: boolean;
  /** e.g. "Q4_K_M". Absent when the source does not say. */
  quantization?: string;
  /** e.g. "7B". Absent when unknown. */
  parameters?: string;
  /** the model's declared context length, in tokens. */
  contextTokens?: number;
  /** SPDX-ish id when the source declares one. */
  license?: string;
  /** bearing on automated/commercial use — only set when the licence is actually known. */
  licenseClass?: LicenseClass;
  /** popularity, for ordering. Absent when the source has no notion of it. */
  downloads?: number;
  /** how it would be installed. */
  route: InstallRoute;
  /** already on this machine under this tag. */
  installed?: boolean;
  /** free-form tags from the source, for filtering. */
  tags?: readonly string[];
}

/* ─────────────────────────── does it fit this machine ─────────────────────────── */

/** What the browser knows about the machine it is choosing for. */
export interface FitBudget {
  /** what a new allocation may realistically take, after headroom. */
  usableBytes: number;
  /** the context the user intends to run at. Drives the KV allowance. */
  contextTokens: number;
}

export type Fit =
  | { verdict: "fits"; needBytes: number; spareBytes: number }
  | { verdict: "tight"; needBytes: number; spareBytes: number }
  | { verdict: "too-big"; needBytes: number; shortBytes: number }
  /** the source published no size, so no honest verdict is possible. */
  | { verdict: "unknown" };

/**
 * Would this model run here?
 *
 * Uses `estimatedLowerBound` — the OPTIMISTIC estimate, weights plus a floor KV allowance plus
 * the smallest runner overhead ever observed on this hardware. Optimistic is the right direction
 * for a browser: the number is a lower bound, so a model this says will NOT fit definitely will
 * not, while one it admits may still be refused later by the real admission gate with its
 * measured geometry. A browser that hid everything the pessimistic estimate rejected would hide
 * models that run fine.
 *
 * `unknown` when the source published no size. Guessing here is how a 16 GB machine gets told a
 * 40 GB model is comfortable.
 */
export function fitOf(entry: CatalogEntry, budget: FitBudget): Fit {
  if (entry.sizeBytes === undefined || entry.sizeBytes <= 0) return { verdict: "unknown" };
  const need = estimatedLowerBound(entry.sizeBytes, budget.contextTokens);
  const spare = budget.usableBytes - need;
  if (spare < 0) return { verdict: "too-big", needBytes: need, shortBytes: -spare };
  /**
   * "Tight" is a real category, not a rounding of "fits".
   *
   * Under a tenth of the budget left means the model loads and then competes with everything
   * else on the machine — which, on Apple Silicon unified memory, is the situation where the
   * compositor starves before anything gets killed (CLAUDE.md §2). The user is better told.
   */
  return spare < budget.usableBytes * 0.1
    ? { verdict: "tight", needBytes: need, spareBytes: spare }
    : { verdict: "fits", needBytes: need, spareBytes: spare };
}

/* ─────────────────────────── merge and order ─────────────────────────── */

/**
 * Fold several sources into one list, preferring the source that knows most about a model.
 *
 * Dedup key is the ROUTE, not the name: `qwen2.5-coder:7b` from the curated list and the same
 * tag reported as installed are one row, while two different quantisations of one HuggingFace
 * repo are two, because they are genuinely different downloads.
 *
 * Precedence is `installed` > `curated` > `ollama-recommended` > `huggingface`: an installed row
 * carries the truth about this machine, and the curated rows carry a human-verified licence that
 * an API field does not.
 */
const SOURCE_RANK: Readonly<Record<CatalogSource, number>> = Object.freeze({
  installed: 0,
  curated: 1,
  "ollama-recommended": 2,
  huggingface: 3,
});

export function routeKey(route: InstallRoute): string {
  switch (route.kind) {
    case "ollama-tag":
      return `tag:${route.tag}`;
    case "ollama-hf":
      return `hf:${route.repo}${route.quant ? `:${route.quant}` : ""}`;
    default:
      return `manual:${route.why}`;
  }
}

export function mergeCatalog(sources: readonly (readonly CatalogEntry[])[]): CatalogEntry[] {
  const byKey = new Map<string, CatalogEntry>();
  for (const list of sources) {
    for (const e of list) {
      const key = routeKey(e.route);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, e);
        continue;
      }
      const winner = SOURCE_RANK[e.source] < SOURCE_RANK[existing.source] ? e : existing;
      const loser = winner === e ? existing : e;
      /**
       * Fields are merged, not replaced. The winning source decides identity and licence, but a
       * size or a download count it lacks is still worth having from the other — an installed
       * row knows it is installed and nothing else, and dropping HuggingFace's size with it
       * would make the fit verdict `unknown` for every model the user already has.
       */
      byKey.set(key, {
        ...loser,
        ...stripUndefined(winner),
        installed: existing.installed || e.installed || undefined,
      });
    }
  }
  return [...byKey.values()];
}

/** Drop absent fields so a spread cannot overwrite a known value with `undefined`. */
function stripUndefined(e: CatalogEntry): Partial<CatalogEntry> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined) out[k] = v;
  return out as Partial<CatalogEntry>;
}

export type CatalogSort = "relevance" | "downloads" | "size" | "name";

/**
 * Order the list for display.
 *
 * `relevance` is the default and is deliberately not popularity: it puts what you can actually
 * use first — installed, then what fits, then the rest — because a browser sorted purely by
 * downloads leads with a 400 GB model on a laptop.
 */
export function sortCatalog(
  entries: readonly CatalogEntry[],
  sort: CatalogSort,
  budget?: FitBudget,
): CatalogEntry[] {
  const out = [...entries];
  const fitRank = (e: CatalogEntry): number => {
    if (!budget) return 1;
    const f = fitOf(e, budget);
    return f.verdict === "fits" ? 0 : f.verdict === "tight" ? 1 : f.verdict === "unknown" ? 2 : 3;
  };
  switch (sort) {
    case "downloads":
      return out.sort((a, b) => (b.downloads ?? -1) - (a.downloads ?? -1));
    case "size":
      // Unknown sizes sort LAST, not first: an absent size is not "very small".
      return out.sort(
        (a, b) =>
          (a.sizeBytes ?? Number.POSITIVE_INFINITY) - (b.sizeBytes ?? Number.POSITIVE_INFINITY),
      );
    case "name":
      return out.sort((a, b) => a.name.localeCompare(b.name));
    default:
      return out.sort((a, b) => {
        if (a.installed !== b.installed) return a.installed ? -1 : 1;
        const fr = fitRank(a) - fitRank(b);
        if (fr !== 0) return fr;
        return (b.downloads ?? -1) - (a.downloads ?? -1);
      });
  }
}

/** The filter the browser's text box applies. Matches name, summary and tags. */
export function filterCatalog(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];
  return entries.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.summary.toLowerCase().includes(q) ||
      (e.quantization ?? "").toLowerCase().includes(q) ||
      (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
  );
}

/** The command that installs a row, or null when there is no automatic route. */
export function installCommand(entry: CatalogEntry): string | null {
  switch (entry.route.kind) {
    case "ollama-tag":
      return `ollama pull ${entry.route.tag}`;
    case "ollama-hf":
      /**
       * `hf.co/<repo>:<quant>` is ollama's own officially supported form for a HuggingFace GGUF
       * repo — which is why the catalogue needs no scraping and, for the overwhelming majority
       * of models, no conversion either. Someone has already published a GGUF.
       */
      return `ollama pull hf.co/${entry.route.repo}${entry.route.quant ? `:${entry.route.quant}` : ""}`;
    default:
      return null;
  }
}
