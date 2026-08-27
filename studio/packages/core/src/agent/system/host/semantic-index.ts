/**
 * agent/system/host/semantic-index.ts — `semantic_search` (MVP scope).
 *
 * HONESTY NOTE, read before touching this file: this tool does REAL vector-embedding
 * search when a local embedding model answers, and falls back to a lexical BM25 ranker
 * — clearly labeled `mode: "lexical-fallback"` in every result — when it does not. The
 * fallback is NEVER reported as "semantic" search; conflating the two is exactly the kind
 * of overclaim this project has been burned by before.
 *
 * WHY OLLAMA. `ai/connectors/localServe.ts` already points the chat client at
 * `http://127.0.0.1:11434` (Ollama's OpenAI-compatible port) as the product's default local
 * brain, and `config/open-models.json` already catalogs embedding models (nomic-embed-text,
 * bge-m3, …) with Ollama pull tags — but nothing in the sidecar (`modelhub.py`) or the JS
 * client actually calls an embeddings endpoint. Rather than add a new heavy dependency
 * (a JS embedding runtime, a vector-DB client) or default to a cloud call, this reuses that
 * SAME local server: Ollama's native `/api/embeddings` route, one prompt per call. If Ollama
 * is not running or the model is not pulled, the call fails fast and this tool falls back.
 *
 * SCOPE (deliberately bounded — an MVP, not a whole-monorepo index):
 *   - walks the working directory, skipping heavy/generated/vendored dirs (node_modules,
 *     dist, build, .git, .venv, __pycache__, .next, target, coverage, .turbo, vendor, …)
 *   - only known source-ish extensions, files over 300 KB skipped (a bundle or lockfile,
 *     not something worth chunking), and NUL-sniffed for binary same as `read_file`
 *   - at most 250 files, chunked into ~80-line windows
 *   - the built index (vectors + chunk text) is cached to a FLAT JSON FILE under
 *     `<PROMETHEUS_HOME>/cache/semantic-index/<hash-of-root>.json` — no vector DB, no ANN
 *     index, linear cosine-similarity scan at query time (fine at this file count). The
 *     cache is invalidated by a cheap signature (path + size + mtime of every walked file),
 *     so repeat queries against an unchanged tree skip re-embedding entirely — only the
 *     query itself costs one embedding call.
 *
 * NOT DONE (named so nobody assumes otherwise): no ANN/HNSW index (linear scan is the
 * bottleneck to revisit if this ever needs to scale past a few thousand chunks), no
 * incremental single-file cache update (a changed file invalidates and rebuilds the whole
 * cached set), no chunking by AST/symbol (fixed line windows only).
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import type { ToolOutcome } from "../../loop.js";
import { prometheusHome } from "./home.js";

/* ── bounded scope ────────────────────────────────────────────────────────── */

const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  "target",
  "coverage",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  "generated",
  "vendor",
  "vendored",
  ".cache",
]);

const SOURCE_EXTS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".swift",
  ".md",
  ".mdx",
  ".json",
  ".yaml",
  ".yml",
  ".sh",
  ".sql",
]);

/** A generated/lockfile blown past this is skipped outright rather than truncated into noise. */
const MAX_FILE_BYTES = 300 * 1024;
/** Bounded walk (MVP scope, not a whole-monorepo index — see file header). */
const MAX_FILES = 250;
/** Hard stop so a pathological tree cannot spin forever building chunks. */
const MAX_CHUNKS = 6_000;
const CHUNK_LINES = 80;

export interface Chunk {
  /** posix-style, relative to the search root. */
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}

interface WalkedFile {
  /** posix-style, relative to root. */
  path: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Bounded recursive walk. Fail-soft: an unreadable dir is skipped, not fatal. */
async function walkWithStats(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  async function rec(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= MAX_FILES) return;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        await rec(abs);
      } else if (ent.isFile()) {
        if (!SOURCE_EXTS.has(extname(ent.name).toLowerCase())) continue;
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(abs);
        } catch {
          continue;
        }
        if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
        out.push({ path: toPosix(relative(root, abs)), abs, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  await rec(root);
  return out;
}

/** Read + line-window a file into chunks. Fail-soft (unreadable/binary ⇒ no chunks). */
async function chunkOneFile(file: WalkedFile): Promise<Chunk[]> {
  let raw: string;
  try {
    raw = await readFile(file.abs, "utf8");
  } catch {
    return [];
  }
  // Same binary sniff as `read_file`: a NUL in the first block means don't treat this as text.
  if (raw.slice(0, 4096).includes("\u0000")) return [];
  const lines = raw.split("\n");
  const chunks: Chunk[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    const text = slice.join("\n").trim();
    if (!text) continue;
    chunks.push({
      file: file.path,
      startLine: i + 1,
      endLine: Math.min(i + slice.length, lines.length),
      text,
    });
  }
  return chunks;
}

async function buildChunks(files: readonly WalkedFile[]): Promise<Chunk[]> {
  const out: Chunk[] = [];
  for (const f of files) {
    if (out.length >= MAX_CHUNKS) break;
    const chunks = await chunkOneFile(f);
    for (const c of chunks) {
      if (out.length >= MAX_CHUNKS) break;
      out.push(c);
    }
  }
  return out;
}

/* ── embedding (real vectors, via a LOCAL Ollama server) ─────────────────────*/

/** Same local base URL `ai/connectors/localServe.ts` already defaults to. */
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

const EMBED_CALL_TIMEOUT_MS = 8_000;
/** Wall-clock budget for embedding a whole bounded index; exceeding it triggers the fallback. */
const EMBED_BUDGET_MS = 60_000;
const EMBED_CONCURRENCY = 6;

/** One text in, one vector out. Throws/rejects on any failure — the caller decides to fall back. */
export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * The real embedder: Ollama's native `/api/embeddings` (one prompt per call — the
 * well-supported route across Ollama versions, unlike the newer batched `/api/embed`).
 * Rejects on a non-2xx response, a timeout, or a malformed body — ALL of which mean
 * "no local embedding backend available right now", never a silently-empty vector.
 */
export function defaultOllamaEmbedder(model: string = DEFAULT_EMBED_MODEL): EmbedFn {
  return async (text: string): Promise<number[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_CALL_TIMEOUT_MS);
    try {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: text.slice(0, 8_000) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`ollama /api/embeddings http ${res.status}`);
      }
      const body = (await res.json()) as { embedding?: unknown };
      if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
        throw new Error("ollama /api/embeddings: response had no vector");
      }
      return body.embedding.map((v) => Number(v));
    } finally {
      clearTimeout(timer);
    }
  };
}

/** A tiny worker pool so N chunks embed with bounded concurrency and a hard wall-clock budget. */
export async function embedAllWithBudget(
  embed: EmbedFn,
  texts: readonly string[],
): Promise<(number[] | undefined)[]> {
  /**
   * PARTIAL results, not all-or-nothing.
   *
   * A single rejected `embed()` — one flaky HTTP call out of hundreds — threw straight out of
   * `Promise.all`, so the whole build was discarded, NOTHING was cached, and the caller fell
   * back to lexical search. The next query paid for every chunk again and had the same odds of
   * losing everything to one more bad call, on a large repo effectively forever. Exceeding the
   * wall-clock budget did the same, which is worse: the budget exists to BOUND the work, and
   * instead it destroyed all the work that had already succeeded.
   *
   * Now a failed chunk is simply absent, and the deadline stops workers taking NEW work rather
   * than throwing away what is done. The caller drops the gaps and caches the rest.
   */
  const deadline = Date.now() + EMBED_BUDGET_MS;
  const results: (number[] | undefined)[] = new Array(texts.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (Date.now() > deadline) return; // out of budget: stop taking work, keep what is done
      const i = next++;
      if (i >= texts.length) return;
      try {
        results[i] = await embed(texts[i] as string);
      } catch {
        /* this chunk stays unembedded; the rest of the index is still worth having */
      }
    }
  }
  const n = Math.min(EMBED_CONCURRENCY, texts.length) || 1;
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ── lexical fallback: a real BM25 ranker, NOT semantic search ───────────────*/

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_$]+/g) ?? []).filter((t) => t.length > 1);
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/**
 * Classic Okapi BM25 (k1=1.5, b=0.75) over the same bounded chunk set the embedder would have
 * used. Deterministic, dependency-free, and honestly a lexical ranker — see file header.
 */
export function bm25Search(query: string, chunks: readonly Chunk[], limit: number): ScoredChunk[] {
  if (chunks.length === 0) return [];
  const k1 = 1.5;
  const b = 0.75;
  const docTokens = chunks.map((c) => tokenize(c.text));
  const docLen = docTokens.map((t) => t.length);
  const avgLen = docLen.reduce((s, n) => s + n, 0) / Math.max(docLen.length, 1) || 1;
  const df = new Map<string, number>();
  const tf: Array<Map<string, number>> = docTokens.map((tokens) => {
    const m = new Map<string, number>();
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return m;
  });
  const total = chunks.length;
  const qTokens = Array.from(new Set(tokenize(query)));
  const scored: ScoredChunk[] = chunks.map((chunk, i) => {
    let score = 0;
    for (const t of qTokens) {
      const f = tf[i]?.get(t) ?? 0;
      if (f === 0) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
      const len = docLen[i] ?? 0;
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }
    return { chunk, score };
  });
  return scored
    .filter((h) => h.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

/* ── the flat on-disk cache ───────────────────────────────────────────────── */

interface StoredChunk extends Chunk {
  vector: number[];
}

interface StoredIndex {
  signature: string;
  model: string;
  dim: number;
  builtAt: string;
  root: string;
  chunks: StoredChunk[];
}

function signatureOf(files: readonly WalkedFile[], model: string): string {
  const h = createHash("sha1");
  h.update(model);
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${f.path}:${f.size}:${Math.round(f.mtimeMs)}\n`);
  }
  return h.digest("hex");
}

function cachePathFor(root: string, home: string): string {
  const key = createHash("sha1").update(resolve(root)).digest("hex").slice(0, 16);
  return join(home, "cache", "semantic-index", `${key}.json`);
}

async function loadCachedIndex(path: string): Promise<StoredIndex | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredIndex>;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.chunks) && parsed.signature) {
      return parsed as StoredIndex;
    }
  } catch {
    /* no cache yet, or corrupt — rebuild rather than crash the tool over a cache file. */
  }
  return undefined;
}

async function saveIndex(path: string, index: StoredIndex): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(index), "utf8");
  } catch {
    /* best-effort cache; a failed write just means the next call rebuilds. */
  }
}

/* ── the tool ─────────────────────────────────────────────────────────────── */

export interface SemanticSearchDeps {
  /** injected in tests; production defaults to `defaultOllamaEmbedder(embedModel)`. */
  embed?: EmbedFn;
  /** PROMETHEUS_HOME override; production defaults to `prometheusHome()`. */
  home?: string;
  embedModel?: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fallbackNote(err: unknown, model: string): string {
  return `local embedding model unreachable at ${OLLAMA_BASE_URL} (${errText(err)}) — Ollama may not be running, or "${model}" is not pulled (try \`ollama pull ${model}\`). Falling back to a lexical BM25 ranker. This is NOT semantic/embedding search.`;
}

function formatResults(
  mode: "embedding" | "lexical-fallback",
  results: readonly ScoredChunk[],
  note: string,
): ToolOutcome {
  const header =
    mode === "embedding"
      ? "semantic_search — embedding-ranked results (cosine similarity over local Ollama embeddings)"
      : "semantic_search — LEXICAL FALLBACK (BM25 term ranking; NOT embedding/semantic search)";
  if (results.length === 0) {
    return {
      ok: true,
      summary: `${header}\nno relevant matches${note ? `\n${note}` : ""}`,
      data: { mode, count: 0 },
    };
  }
  const body = results
    .map((r, i) => {
      const snippet = r.chunk.text.split("\n").slice(0, 3).join("\n").trim();
      return `${i + 1}. ${r.chunk.file}:${r.chunk.startLine}-${r.chunk.endLine}  (score ${r.score.toFixed(3)})\n${snippet}`;
    })
    .join("\n\n");
  return {
    ok: true,
    summary: `${header}${note ? `\n${note}` : ""}\n\n${body}`,
    data: { mode, count: results.length },
  };
}

/**
 * `semantic_search` — see the file header for the real/fallback split this implements.
 *
 * Bounded to the working directory (`cwd`), same as `grep`/`glob`. Builds (or reuses a cached)
 * index, embeds the query, and ranks by cosine similarity; falls back to BM25, clearly labeled,
 * when the local embedding backend does not answer.
 */
export async function semanticSearchTool(
  args: Record<string, unknown>,
  cwd: string,
  deps: SemanticSearchDeps = {},
): Promise<ToolOutcome> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { ok: false, summary: "semantic_search: no query given" };
  const limitArg = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 8;
  const limit = Math.min(Math.max(Math.trunc(limitArg), 1), 50);

  const root = resolve(cwd);
  const home = deps.home ?? prometheusHome();
  const model = deps.embedModel ?? DEFAULT_EMBED_MODEL;
  const embed = deps.embed ?? defaultOllamaEmbedder(model);

  let files: WalkedFile[];
  try {
    files = await walkWithStats(root);
  } catch (e) {
    return { ok: false, summary: `semantic_search: failed to walk ${root}: ${errText(e)}` };
  }
  if (files.length === 0) {
    return {
      ok: true,
      summary: `semantic_search: no indexable source files found under ${root}`,
      data: { mode: "embedding", count: 0 },
    };
  }

  const cachePath = cachePathFor(root, home);
  const signature = signatureOf(files, model);
  const cached = await loadCachedIndex(cachePath);

  if (cached && cached.signature === signature) {
    try {
      const qVec = await embed(query);
      const results = cached.chunks
        .map((c) => ({ chunk: c, score: cosineSimilarity(qVec, c.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return formatResults("embedding", results, "");
    } catch (e) {
      // The backend that built this cache went away between build and query. Fall back for
      // THIS query only — the cache stays put, so the next successful query needs no rebuild.
      const chunks = await buildChunks(files);
      return formatResults(
        "lexical-fallback",
        bm25Search(query, chunks, limit),
        fallbackNote(e, model),
      );
    }
  }

  // No usable cache: probe the embedder cheaply (one short call) before paying for a full
  // read-and-chunk pass, so an Ollama-less machine fails fast instead of walking the tree first.
  let probeError: unknown;
  try {
    await embed("semantic_search availability probe");
  } catch (e) {
    probeError = e;
  }

  const chunks = await buildChunks(files);
  if (chunks.length === 0) {
    return {
      ok: true,
      summary: `semantic_search: found files under ${root} but none produced indexable text`,
      data: { mode: "embedding", count: 0 },
    };
  }
  if (probeError !== undefined) {
    return formatResults(
      "lexical-fallback",
      bm25Search(query, chunks, limit),
      fallbackNote(probeError, model),
    );
  }

  try {
    const vectors = await embedAllWithBudget(
      embed,
      chunks.map((c) => c.text),
    );
    // Keep only the chunks that actually embedded. An index missing a few chunks still answers
    // far better than the lexical fallback; an index with `undefined` vectors in it would score
    // NaN and poison every future query read from the cache.
    const embedded = chunks
      .map((c, i) => ({ chunk: c, vector: vectors[i] }))
      .filter(
        (e): e is { chunk: (typeof chunks)[number]; vector: number[] } =>
          Array.isArray(e.vector) && e.vector.length > 0,
      );
    if (embedded.length === 0) throw new Error("no chunk could be embedded");
    const stored: StoredIndex = {
      signature,
      model,
      dim: embedded[0]?.vector.length ?? 0,
      builtAt: new Date().toISOString(),
      root,
      chunks: embedded.map((e) => ({ ...e.chunk, vector: e.vector })),
    };
    await saveIndex(cachePath, stored);
    const qVec = await embed(query);
    const results = stored.chunks
      .map((c) => ({ chunk: c, score: cosineSimilarity(qVec, c.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return formatResults("embedding", results, "");
  } catch (e) {
    return formatResults(
      "lexical-fallback",
      bm25Search(query, chunks, limit),
      fallbackNote(e, model),
    );
  }
}
