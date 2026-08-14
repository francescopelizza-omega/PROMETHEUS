/**
 * semantic-index.test.ts — `semantic_search`: real embedding ranking (injected fake vectors,
 * no network) AND the explicitly-labeled BM25 fallback when the embedder is unavailable.
 *
 * No test spawns Ollama or hits the network — `embed` is always injected, matching the house
 * style (`SystemToolDeps.exec` in system-tools.test.ts). What IS real: the file walk, the
 * chunking, the cosine-similarity ranking, the BM25 scoring, and the on-disk cache round-trip.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  type Chunk,
  type EmbedFn,
  bm25Search,
  cosineSimilarity,
  semanticSearchTool,
} from "./semantic-index.js";

function ws(): string {
  return mkdtempSync(join(tmpdir(), "prom-semsearch-"));
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "prom-semsearch-home-"));
}

/** A deterministic fake embedder: a bag-of-words one-hot-ish vector over a fixed vocabulary. */
function fakeEmbedder(vocab: readonly string[]): EmbedFn {
  return async (text: string): Promise<number[]> => {
    const words = new Set(text.toLowerCase().match(/[a-z0-9_$]+/g) ?? []);
    return vocab.map((w) => (words.has(w) ? 1 : 0));
  };
}

const VOCAB = ["auth", "login", "password", "widget", "render", "database", "query"];

/* ── cosine similarity (pure) ────────────────────────────────────────────── */

test("cosineSimilarity: identical vectors score 1, orthogonal vectors score 0", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0, "a zero vector never divides by zero");
});

/* ── bm25 (pure, the honest fallback) ────────────────────────────────────── */

test("bm25Search ranks the chunk containing the query term above one that lacks it", () => {
  const chunks: Chunk[] = [
    { file: "a.ts", startLine: 1, endLine: 1, text: "function login(user, password) {}" },
    { file: "b.ts", startLine: 1, endLine: 1, text: "function renderWidget() {}" },
  ];
  const hits = bm25Search("login password", chunks, 5);
  assert.equal(hits[0]?.chunk.file, "a.ts");
  assert.ok(hits[0]!.score > 0);
  assert.equal(
    hits.some((h) => h.chunk.file === "b.ts"),
    false,
  );
});

test("bm25Search returns nothing for a query with no overlapping terms", () => {
  const chunks: Chunk[] = [{ file: "a.ts", startLine: 1, endLine: 1, text: "totally unrelated" }];
  assert.deepEqual(bm25Search("xyzzy plugh", chunks, 5), []);
});

/* ── semanticSearchTool: the embedding path ──────────────────────────────── */

test("semanticSearchTool ranks by embedding cosine similarity when the embedder answers", async () => {
  const dir = ws();
  writeFileSync(
    join(dir, "auth.ts"),
    "export function login(password) { return checkAuth(password); }\n",
  );
  writeFileSync(join(dir, "ui.ts"), "export function renderWidget() { return '<div/>'; }\n");

  const out = await semanticSearchTool({ query: "user login and password", limit: 5 }, dir, {
    embed: fakeEmbedder(VOCAB),
    home: home(),
  });

  assert.equal(out.ok, true);
  const data = out.data as { mode: string; count: number };
  assert.equal(data.mode, "embedding");
  assert.match(out.summary, /embedding-ranked results/);
  assert.match(out.summary, /auth\.ts/);
  // The auth chunk should outrank the widget chunk for this query.
  const authIdx = out.summary.indexOf("auth.ts");
  const uiIdx = out.summary.indexOf("ui.ts");
  assert.ok(authIdx >= 0 && (uiIdx === -1 || authIdx < uiIdx));
});

test("semanticSearchTool reuses the cached index on a second call (no re-embedding of unchanged files)", async () => {
  const dir = ws();
  writeFileSync(
    join(dir, "auth.ts"),
    "export function login(password) { return checkAuth(password); }\n",
  );
  const h = home();

  let embedCalls = 0;
  const counting: EmbedFn = async (text) => {
    embedCalls += 1;
    return fakeEmbedder(VOCAB)(text);
  };

  const first = await semanticSearchTool({ query: "login" }, dir, { embed: counting, home: h });
  assert.equal(first.ok, true);
  const callsAfterFirst = embedCalls;
  assert.ok(callsAfterFirst > 1, "the first call embeds the probe, the chunk(s), and the query");

  embedCalls = 0;
  const second = await semanticSearchTool({ query: "login" }, dir, { embed: counting, home: h });
  assert.equal(second.ok, true);
  // Only the query itself should need embedding once the cache is warm.
  assert.equal(
    embedCalls,
    1,
    `expected exactly 1 embed call on the cached path, got ${embedCalls}`,
  );
});

test("semanticSearchTool invalidates the cache when a file changes", async () => {
  const dir = ws();
  const h = home();
  writeFileSync(join(dir, "a.ts"), "export function login() {}\n");
  await semanticSearchTool({ query: "login" }, dir, { embed: fakeEmbedder(VOCAB), home: h });

  // Touch the file with different content/size — the signature must change.
  writeFileSync(join(dir, "a.ts"), "export function login() { return true; } // changed\n");
  let embedCalls = 0;
  const counting: EmbedFn = async (text) => {
    embedCalls += 1;
    return fakeEmbedder(VOCAB)(text);
  };
  const out = await semanticSearchTool({ query: "login" }, dir, { embed: counting, home: h });
  assert.equal(out.ok, true);
  assert.ok(embedCalls > 1, "a changed file must trigger a rebuild, not a cache hit");
});

/* ── semanticSearchTool: the explicit, labeled fallback ──────────────────── */

test("semanticSearchTool falls back to a LABELED lexical ranker when the embedder is unavailable", async () => {
  const dir = ws();
  writeFileSync(join(dir, "auth.ts"), "export function login(password) {}\n");
  writeFileSync(join(dir, "ui.ts"), "export function renderWidget() {}\n");

  const brokenEmbed: EmbedFn = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  };

  const out = await semanticSearchTool({ query: "login password" }, dir, {
    embed: brokenEmbed,
    home: home(),
  });

  assert.equal(out.ok, true);
  const data = out.data as { mode: string };
  assert.equal(data.mode, "lexical-fallback");
  // The report must never call this "semantic" — that is the whole point of the split.
  assert.match(out.summary, /LEXICAL FALLBACK/);
  assert.match(out.summary, /NOT embedding\/semantic search/);
  assert.match(out.summary, /ECONNREFUSED/);
});

test("semanticSearchTool falls back per-query when the embedder dies AFTER a cache was built", async () => {
  const dir = ws();
  const h = home();
  writeFileSync(join(dir, "auth.ts"), "export function login(password) {}\n");

  // First call succeeds and warms the cache.
  const warm = await semanticSearchTool({ query: "login" }, dir, {
    embed: fakeEmbedder(VOCAB),
    home: h,
  });
  assert.equal((warm.data as { mode: string }).mode, "embedding");

  // Second call: the backend is now down, but the cache (from the successful build) is still there.
  const brokenEmbed: EmbedFn = async () => {
    throw new Error("fetch failed");
  };
  const out = await semanticSearchTool({ query: "login" }, dir, { embed: brokenEmbed, home: h });
  assert.equal(out.ok, true);
  assert.equal((out.data as { mode: string }).mode, "lexical-fallback");
  assert.match(out.summary, /LEXICAL FALLBACK/);
});

/* ── bounded scope ────────────────────────────────────────────────────────── */

test("semanticSearchTool skips heavy/vendored directories and non-source files", async () => {
  const dir = ws();
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "export function login() {}\n");
  writeFileSync(join(dir, "photo.png"), "not really a png but has the login word anyway");
  writeFileSync(join(dir, "real.ts"), "export function login() {}\n");

  const out = await semanticSearchTool({ query: "login" }, dir, {
    embed: fakeEmbedder(VOCAB),
    home: home(),
  });
  assert.equal(out.ok, true);
  assert.match(out.summary, /real\.ts/);
  assert.doesNotMatch(out.summary, /node_modules/);
  assert.doesNotMatch(out.summary, /photo\.png/);
});

test("semanticSearchTool refuses an empty query", async () => {
  const dir = ws();
  const out = await semanticSearchTool({ query: "  " }, dir, {
    embed: fakeEmbedder(VOCAB),
    home: home(),
  });
  assert.equal(out.ok, false);
});

test("semanticSearchTool reports no matches (not an error) over a tree with no indexable files", async () => {
  const dir = ws();
  writeFileSync(join(dir, "data.bin"), Buffer.from([0, 1, 2, 3]));
  const out = await semanticSearchTool({ query: "anything" }, dir, {
    embed: fakeEmbedder(VOCAB),
    home: home(),
  });
  assert.equal(out.ok, true);
  assert.match(out.summary, /no indexable source files/);
});
