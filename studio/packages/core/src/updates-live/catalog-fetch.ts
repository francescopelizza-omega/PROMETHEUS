/**
 * updates-live/catalog-fetch.ts — filling the catalogue from the sources that publish one.
 *
 * ── WHY HUGGINGFACE AND NOT OLLAMA'S LIBRARY ────────────────────────────────────────────────
 *
 * `registry.ollama.ai/v2/_catalog` is a 404 and `/tags/list` is a 404 — enumeration through the
 * registry is simply not offered. The browsable list at `ollama.com/library` is HTML, and its
 * terms prohibit automated access and use in a competing product. So the catalogue is
 * HuggingFace's documented API, which is better anyway: `ollama pull hf.co/<repo>` is officially
 * supported, so browse-on-HF → install-into-ollama needs no scraping and no conversion.
 *
 * ── THE LIST ENDPOINT PUBLISHES NO USABLE SIZE ──────────────────────────────────────────────
 *
 * Measured live on 2026-09-29, two repos:
 *
 *     repo                                    gguf.total      gguf.totalFileSize   ALL .gguf
 *     bartowski/Qwen2.5-Coder-7B-Instruct    7,615,616,512    15,237,853,696       121 GB
 *     unsloth/Qwen3-Coder-30B-A3B-Instruct  30,532,122,624    17,310,784,672       506 GB
 *
 * `total` is the PARAMETER COUNT, not bytes. And `totalFileSize` is neither the repo total nor
 * the size of anything a user would choose: it is ONE ARBITRARY FILE that HuggingFace happened
 * to parse metadata from — `f16.gguf` for the first repo, `IQ4_NL.gguf` for the second. Which
 * one is unpredictable.
 *
 * Shipping it as "the size" was wrong by **+226%** for the 7B (15.2 GB shown against a 4.68 GB
 * Q4_K_M), and — worse than any single error — it made two rows in one list incomparable, since
 * each repo's figure came from a different quantisation.
 *
 * So the size is ESTIMATED from the parameter count, at Q4_K_M's ~4.83 bits/weight, and flagged
 * as an estimate. Checked against both repos' real Q4_K_M files it lands within 2%. The exact
 * bytes for a chosen quantisation need `/tree/main`, a second request per repo, made only when
 * someone asks.
 *
 * ── RATE LIMITS ARE THE RFC HEADER, NOT `x-ratelimit-*` ─────────────────────────────────────
 *
 * Observed: `ratelimit: "api";r=499;t=125` with `ratelimit-policy: "fixed window";"api";q=500;w=300`
 * — 500 requests per 300-second window, `r` remaining, `t` seconds to reset. Code that looked
 * for `x-ratelimit-remaining` would find nothing and sail into a 429.
 */
import type { CatalogEntry, CatalogSource, InstallRoute } from "../updates/catalog.js";
import type { LicenseClass } from "../updates/models.js";

export const HF_API = "https://huggingface.co/api";

/** What the rate-limit headers said, when they said anything. */
export interface RateLimit {
  remaining: number;
  resetSeconds: number;
}

export interface CatalogFetchDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CatalogFetchResult {
  entries: CatalogEntry[];
  /** "" on success; a human reason otherwise. NEVER an empty list passed off as "none found". */
  error: string;
  limit?: RateLimit;
}

/**
 * Parse `ratelimit: "api";r=499;t=125`.
 *
 * Returns undefined rather than zeroes when the header is absent or malformed — a caller must be
 * able to tell "499 left" from "I do not know", because backing off on an unknown is as wrong as
 * charging ahead on an exhausted one.
 */
export function parseRateLimit(header: string | null): RateLimit | undefined {
  if (!header) return undefined;
  const r = /(?:^|;)\s*r=(\d+)/.exec(header);
  const t = /(?:^|;)\s*t=(\d+)/.exec(header);
  if (!r || !t) return undefined;
  return { remaining: Number(r[1]), resetSeconds: Number(t[1]) };
}

/** `license:apache-2.0` → `apache-2.0`. HuggingFace publishes the licence as a TAG. */
export function licenseFromTags(tags: readonly string[]): string | undefined {
  for (const t of tags) {
    if (t.startsWith("license:")) {
      const v = t.slice("license:".length).trim();
      if (v !== "" && v !== "other" && v !== "unknown") return v;
    }
  }
  return undefined;
}

/**
 * A licence's bearing on automated and commercial use.
 *
 * Deliberately conservative: anything not recognised is left UNDEFINED rather than assumed
 * permissive. A browser that silently labels an unknown licence as safe to use commercially is
 * giving legal advice it has no basis for.
 */
export function classifyLicense(id: string | undefined): LicenseClass | undefined {
  if (!id) return undefined;
  const l = id.toLowerCase();
  if (/^(apache-2\.0|mit|bsd-3-clause|bsd-2-clause|isc|unlicense|cc0-1\.0)$/.test(l)) {
    return "permissive";
  }
  if (/^(llama\d?|gemma|qwen|mistral|deepseek|falcon|openrail)/.test(l)) return "open-commercial";
  if (/(nc|non-?commercial|cc-by-nc)/.test(l)) return "non-commercial";
  return undefined;
}

/** One row of `GET /api/models`, as OBSERVED — not as documented. */
interface HfModelRow {
  id?: unknown;
  downloads?: unknown;
  tags?: unknown;
  pipeline_tag?: unknown;
  gguf?: {
    total?: unknown;
    architecture?: unknown;
    context_length?: unknown;
    totalFileSize?: unknown;
  };
}

/**
 * Turn one HuggingFace row into a catalogue entry, or null when it is not usable.
 *
 * Null rather than a half-filled row: a repo with no `id` cannot be installed, and a row whose
 * only purpose is to be un-clickable is noise in a list that has to be scannable.
 */
export function entryFromHf(raw: unknown): CatalogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as HfModelRow;
  const id = typeof r.id === "string" ? r.id : "";
  if (id === "" || !id.includes("/")) return null;

  const tags = Array.isArray(r.tags)
    ? r.tags.filter((t): t is string => typeof t === "string")
    : [];
  const license = licenseFromTags(tags);
  const g = r.gguf ?? {};
  /**
   * ESTIMATED from the parameter count — see the header for why `totalFileSize` cannot be used.
   * `undefined` when there is no parameter count either, because an unknown size must stay
   * unknown rather than become a number nobody can act on.
   */
  const sizeBytes = estimateQ4Bytes(g.total);
  const contextTokens =
    typeof g.context_length === "number" && g.context_length > 0 ? g.context_length : undefined;
  const route: InstallRoute = { kind: "ollama-hf", repo: id };

  return {
    id,
    source: "huggingface" as CatalogSource,
    name: id,
    summary: "",
    ...(sizeBytes !== undefined ? { sizeBytes, sizeEstimated: true } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(typeof g.architecture === "string" ? { parameters: paramLabel(g.total) } : {}),
    ...(license ? { license } : {}),
    ...(classifyLicense(license) ? { licenseClass: classifyLicense(license) } : {}),
    ...(typeof r.downloads === "number" ? { downloads: r.downloads } : {}),
    route,
    tags,
  };
}

/**
 * Bytes a Q4_K_M build of an N-parameter model takes, to within a couple of percent.
 *
 * Q4_K_M averages ~4.83 bits per weight across its mixed block types, i.e. ~0.604 bytes. Checked
 * against the two repos in the header: 30.53B → 18.44 GB estimated against 18.56 GB real
 * (-0.6%), and 7.62B → 4.60 GB against 4.68 GB real (-1.7%).
 *
 * Q4_K_M specifically because it is what `ollama pull hf.co/<repo>` resolves to when the repo
 * publishes one — so the estimate describes the file the user would actually get by default,
 * not an average over quantisations they will never choose.
 */
export const Q4_K_M_BYTES_PER_PARAM = 0.604;

export function estimateQ4Bytes(paramCount: unknown): number | undefined {
  if (typeof paramCount !== "number" || paramCount <= 0) return undefined;
  return Math.round(paramCount * Q4_K_M_BYTES_PER_PARAM);
}

/** `30532122624` → `"30.5B"`. A parameter COUNT, which is why it is not formatted as bytes. */
function paramLabel(total: unknown): string | undefined {
  if (typeof total !== "number" || total <= 0) return undefined;
  if (total >= 1e9) return `${(total / 1e9).toFixed(1)}B`;
  return `${Math.round(total / 1e6)}M`;
}

async function getJson(
  url: string,
  deps: CatalogFetchDeps,
): Promise<{ json: unknown; limit?: RateLimit } | { error: string; limit?: RateLimit }> {
  const f = deps.fetchImpl ?? globalThis.fetch;
  if (typeof f !== "function") return { error: "no fetch in this runtime" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 8000);
  try {
    const res = await f(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    const limit = parseRateLimit(res.headers.get("ratelimit"));
    if (res.status === 429) {
      const wait = limit ? ` — try again in ${limit.resetSeconds}s` : "";
      return { error: `HuggingFace rate limit reached${wait}`, ...(limit ? { limit } : {}) };
    }
    if (!res.ok)
      return { error: `HuggingFace returned HTTP ${res.status}`, ...(limit ? { limit } : {}) };
    return { json: await res.json(), ...(limit ? { limit } : {}) };
  } catch (e) {
    const aborted = ctrl.signal.aborted;
    return {
      error: aborted ? "HuggingFace timed out" : e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface HfSearchOpts {
  /** free text. Empty lists the most-downloaded GGUF repos. */
  query?: string;
  /** how many rows. Capped at 100 — see the note. */
  limit?: number;
  /**
   * Restrict to text generation.
   *
   * ON by default, because `filter=gguf` alone is NOT a chat-model filter: the second
   * most-downloaded GGUF repo on 2026-09-29 was `mudler/locate-anything.cpp-gguf`, an
   * object-detection model. A coding assistant's model browser listing an object detector is a
   * list the user has to learn to distrust.
   */
  textOnly?: boolean;
}

/**
 * Search HuggingFace for installable GGUF models.
 *
 * `limit` is capped at 100 because each row carries the repo's full `chat_template` — several
 * kilobytes of Jinja — inside the `gguf` expansion. There is no way to ask for the size without
 * it, so the defence is to ask for fewer rows rather than to hope.
 */
export async function searchHuggingFace(
  opts: HfSearchOpts = {},
  deps: CatalogFetchDeps = {},
): Promise<CatalogFetchResult> {
  const params = new URLSearchParams();
  params.set("filter", "gguf");
  if (opts.textOnly !== false) params.append("filter", "text-generation");
  if (opts.query?.trim()) params.set("search", opts.query.trim());
  params.set("sort", "downloads");
  params.set("direction", "-1");
  params.set("limit", String(Math.min(Math.max(1, opts.limit ?? 40), 100)));
  // Bracketed keys, repeated — the shape the API actually accepts.
  for (const e of ["gguf", "downloads", "tags"]) params.append("expand[]", e);

  const got = await getJson(`${HF_API}/models?${params.toString()}`, deps);
  if ("error" in got)
    return { entries: [], error: got.error, ...(got.limit ? { limit: got.limit } : {}) };
  if (!Array.isArray(got.json)) {
    return { entries: [], error: "HuggingFace returned an unexpected shape" };
  }
  const entries = got.json.map(entryFromHf).filter((e): e is CatalogEntry => e !== null);
  return { entries, error: "", ...(got.limit ? { limit: got.limit } : {}) };
}

/** One quantisation of a repo, with its REAL size. */
export interface Quantization {
  /** the `Q4_K_M` part. ollama's quant tag is case-insensitive. */
  label: string;
  /** the FIRST file of this quantisation. A sharded build has more — see `parts`. */
  file: string;
  /** total bytes, SUMMED across every shard of this quantisation. */
  sizeBytes: number;
  /** how many files make it up. Absent means one. */
  parts?: number;
}

/**
 * The quantisations a repo actually publishes, with per-file sizes.
 *
 * A second request, made only when someone asks — but the only way to answer "how big is the one
 * I would get". `gguf.totalFileSize` from the list is a single representative file: for
 * `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF` it reports 17.31 GB while the repo's quantisations
 * run from 8.91 GB to 32.48 GB. Choosing on the representative figure can be wrong by 3.6×.
 */
export async function fetchQuantizations(
  repo: string,
  deps: CatalogFetchDeps = {},
): Promise<{ quants: Quantization[]; error: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { quants: [], error: "not a repo id" };
  /**
   * `recursive=true` is MANDATORY, not an optimisation.
   *
   * Without it the API returns a directory as ONE row —
   * `{"type":"directory","size":0,"path":"BF16"}` — and every quantisation inside it vanishes.
   * Measured: a repo hid a 49 GB + 11 GB shard pair behind exactly that zero-size row, so the
   * non-recursive listing silently reported the repo's largest build as not existing.
   */
  const got = await getJson(`${HF_API}/models/${repo}/tree/main?recursive=true`, deps);
  if ("error" in got) return { quants: [], error: got.error };
  if (!Array.isArray(got.json)) return { quants: [], error: "unexpected shape" };

  /**
   * Sharded quantisations are SUMMED, not dropped.
   *
   * `…-Q8_0-00001-of-00002.gguf` and its sibling are ONE choice split across two files, which is
   * how the largest builds are published. Dropping them — the first version of this — made a
   * repo's biggest quantisations disappear from the picker. Showing a single part would have
   * been worse: it advertises half the download.
   */
  const byLabel = new Map<string, Quantization>();
  for (const raw of got.json) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { type?: unknown; path?: unknown; size?: unknown; lfs?: { size?: unknown } };
    if (e.type === "directory") continue;
    const path = typeof e.path === "string" ? e.path : "";
    if (!path.toLowerCase().endsWith(".gguf")) continue;
    // `lfs.size` is the authoritative figure for a pointer file; `size` matches it in practice
    // and is the fallback for anything stored inline.
    const size =
      typeof e.lfs?.size === "number" ? e.lfs.size : typeof e.size === "number" ? e.size : 0;
    if (size <= 0) continue;

    const label = quantLabel(path);
    const existing = byLabel.get(label);
    if (existing) {
      existing.sizeBytes += size;
      existing.parts = (existing.parts ?? 1) + 1;
      continue;
    }
    byLabel.set(label, { label, file: path, sizeBytes: size });
  }
  const quants = [...byLabel.values()].sort((a, b) => a.sizeBytes - b.sizeBytes);
  return { quants, error: "" };
}

/**
 * `Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf` → `Q4_K_M`.
 *
 * Matched against the WHOLE basename rather than by splitting on dashes, which was the first
 * version and got `…-UD-TQ1_0` wrong two ways at once: the split threw away the `UD-` prefix
 * that is part of the name, and `TQ` (ternary) is neither `Q` nor `IQ`, so the token failed the
 * test and the entire 37-character filename was shown as the label.
 *
 * Families covered, all observed in one repo on 2026-09-29: `Q4_K_M`, `IQ4_XS`, `UD-IQ1_S`,
 * `UD-TQ1_0`, `Q8_K_XL`, `BF16`, `F16`. A name that matches none of them returns the basename,
 * so the row is still selectable — mislabelled beats missing, and an unrecognised quantisation
 * is still a real file someone can choose.
 */
export function quantLabel(path: string): string {
  const base = (path.split("/").pop() ?? path)
    .replace(/\.gguf$/i, "")
    // The shard suffix goes FIRST, so every part of one quantisation yields the same label and
    // the parts can be summed into a single choice.
    .replace(/-\d{5}-of-\d{5}$/i, "");
  const m = /(?:^|-)((?:UD-)?(?:IQ|TQ|Q|BF|F)\d[\w.]*)$/i.exec(base);
  return m?.[1] ?? base;
}

/* ─────────────────────────── format detection ─────────────────────────── */

/** What a HuggingFace repo actually contains, which decides whether conversion is needed. */
export interface RepoFormats {
  /** the repo publishes at least one .gguf — so `ollama pull hf.co/<repo>` just works. */
  gguf: boolean;
  /** the repo publishes .safetensors — convertible, at a cost. */
  safetensors: boolean;
  /** an MLX-format repo. A destination, not a source. */
  mlx: boolean;
  /** "" on success; a reason otherwise. An error is never reported as "contains nothing". */
  error: string;
}

/**
 * Look inside a repo to see which formats it publishes.
 *
 * One request, the same recursive tree listing the quantisation picker uses — so a caller that
 * needs both pays once. The distinction matters because it decides which branch of
 * `planConversion` applies: a repo with a GGUF needs no conversion at all, and finding that out
 * is the difference between a 30-second pull and an hour of Python.
 */
export async function detectRepoFormats(
  repo: string,
  deps: CatalogFetchDeps = {},
): Promise<RepoFormats> {
  const none = { gguf: false, safetensors: false, mlx: false };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ...none, error: "not a repo id" };
  const got = await getJson(`${HF_API}/models/${repo}/tree/main?recursive=true`, deps);
  if ("error" in got) return { ...none, error: got.error };
  if (!Array.isArray(got.json)) return { ...none, error: "unexpected shape" };

  let gguf = false;
  let safetensors = false;
  let mlx = false;
  for (const raw of got.json) {
    if (!raw || typeof raw !== "object") continue;
    const path =
      typeof (raw as { path?: unknown }).path === "string" ? (raw as { path: string }).path : "";
    const lower = path.toLowerCase();
    if (lower.endsWith(".gguf")) gguf = true;
    else if (lower.endsWith(".safetensors")) safetensors = true;
    /**
     * MLX repos are conventionally named and carry a config rather than a distinct extension,
     * so the repo NAME is the signal. Imperfect, and deliberately only used to warn — a false
     * positive costs a note, while a false negative costs an hour discovering MLX is one-way.
     */
    if (/(^|[-/])mlx([-/]|$)/i.test(repo)) mlx = true;
  }
  return { gguf, safetensors, mlx, error: "" };
}
