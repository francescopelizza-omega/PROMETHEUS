/**
 * catalog-fetch.test.ts — reading HuggingFace's catalogue without misreading it.
 *
 * Every shape here was observed live on 2026-09-29 against the real API. The two that matter
 * most are the ones a reasonable implementation gets wrong: `gguf.total` is a parameter COUNT
 * and `gguf.totalFileSize` is a single representative FILE, not the repo's total.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Q4_K_M_BYTES_PER_PARAM,
  classifyLicense,
  entryFromHf,
  estimateQ4Bytes,
  fetchQuantizations,
  licenseFromTags,
  parseRateLimit,
  quantLabel,
  searchHuggingFace,
} from "./catalog-fetch.js";

/** A fake HF that returns a fixed body and headers. */
function fake(body: unknown, opts: { status?: number; ratelimit?: string } = {}) {
  const seen: string[] = [];
  const impl = (async (url: string) => {
    seen.push(String(url));
    return {
      ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
      status: opts.status ?? 200,
      headers: {
        get: (n: string) => (n.toLowerCase() === "ratelimit" ? (opts.ratelimit ?? null) : null),
      },
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

/** The real first row from `GET /api/models?filter=gguf&sort=downloads`, 2026-09-29. */
const REAL_ROW = {
  _id: "688b451a53e70a07b0669a7c",
  id: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
  downloads: 9_901_942,
  gguf: {
    total: 30_532_122_624,
    architecture: "qwen3moe",
    context_length: 262_144,
    chat_template: "{# several kilobytes of Jinja #}",
    totalFileSize: 17_310_784_672,
  },
  tags: ["transformers", "gguf", "qwen3", "text-generation", "license:apache-2.0", "region:us"],
};

/* ─────────────────────────── the size trap ─────────────────────────── */

test("REGRESSION: the size is ESTIMATED from params — `totalFileSize` is an arbitrary file", () => {
  /**
   * The bug this replaces SHIPPED. `gguf.totalFileSize` is neither the repo total nor the size
   * of anything a user picks: it is ONE file HuggingFace happened to parse, and WHICH one is
   * unpredictable. Measured across two repos:
   *
   *   bartowski/Qwen2.5-Coder-7B  totalFileSize 15.24 GB  <- f16.gguf  (real Q4_K_M 4.68 GB)
   *   unsloth/Qwen3-Coder-30B     totalFileSize 17.31 GB  <- IQ4_NL    (real Q4_K_M 18.56 GB)
   *
   * Shown as "the size" that was +226% wrong for the 7B — and, worse, made two rows in one list
   * incomparable, because each came from a different quantisation.
   */
  const e = entryFromHf(REAL_ROW);
  assert.notEqual(e?.sizeBytes, 17_310_784_672, "totalFileSize must NOT be the size");
  assert.notEqual(e?.sizeBytes, 30_532_122_624, "…and neither is the parameter count");
  assert.equal(e?.sizeEstimated, true, "the renderer has to be able to say it is an estimate");
  // 30.53B x 0.604 B/param; the repo's real Q4_K_M is 18.56 GB, so this lands within 2%.
  assert.ok(Math.abs((e?.sizeBytes ?? 0) - 18_560_000_000) / 18_560_000_000 < 0.02);
  assert.equal(e?.parameters, "30.5B", "`total` is rendered as a parameter count");
});

test("the 7B case that made the bug visible: 4.6 GB estimated, not 15.2 GB published", () => {
  const e = entryFromHf({
    id: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF",
    gguf: { total: 7_615_616_512, totalFileSize: 15_237_853_696, architecture: "qwen2" },
    tags: [],
  });
  assert.ok((e?.sizeBytes ?? 0) < 5e9, "a 7B Q4_K_M is ~4.7 GB, never 15 GB");
  assert.ok(Math.abs((e?.sizeBytes ?? 0) - 4_680_000_000) / 4_680_000_000 < 0.02);
});

test("no parameter count means NO size — an unknown must not become a number", () => {
  const e = entryFromHf({ id: "a/b", gguf: { totalFileSize: 99e9, architecture: "x" }, tags: [] });
  assert.equal(e?.sizeBytes, undefined, "totalFileSize must not be used as a fallback either");
  assert.equal(e?.sizeEstimated, undefined);
});

test("estimateQ4Bytes refuses anything that is not a positive count", () => {
  assert.equal(estimateQ4Bytes(undefined), undefined);
  assert.equal(estimateQ4Bytes(0), undefined);
  assert.equal(estimateQ4Bytes(-1), undefined);
  assert.equal(estimateQ4Bytes("7000000000"), undefined);
  assert.equal(estimateQ4Bytes(1e9), Math.round(1e9 * Q4_K_M_BYTES_PER_PARAM));
});

test("the row's real fields are carried across, and unknowns stay absent", () => {
  const e = entryFromHf(REAL_ROW);
  assert.equal(e?.id, "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF");
  assert.equal(e?.source, "huggingface");
  assert.equal(e?.contextTokens, 262_144);
  assert.equal(e?.downloads, 9_901_942);
  assert.equal(e?.license, "apache-2.0");
  assert.equal(e?.licenseClass, "permissive");
  assert.deepEqual(e?.route, {
    kind: "ollama-hf",
    repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
  });
  // No card was fetched, so there is no summary — absent, not an invented one.
  assert.equal(e?.summary, "");
});

test("a row with no size leaves sizeBytes ABSENT, so the fit verdict stays honest", () => {
  const e = entryFromHf({ id: "a/b", gguf: { architecture: "llama" }, tags: [] });
  assert.equal(e?.sizeBytes, undefined);
  assert.notEqual(e?.sizeBytes, 0, "0 would read as `fits comfortably`");
});

test("a row that cannot be installed is dropped rather than half-filled", () => {
  assert.equal(entryFromHf({ downloads: 5 }), null, "no id");
  assert.equal(entryFromHf({ id: "no-slash" }), null, "not a repo id");
  assert.equal(entryFromHf(null), null);
  assert.equal(entryFromHf("nope"), null);
});

/* ─────────────────────────── licence ─────────────────────────── */

test("the licence is a TAG, not a field", () => {
  assert.equal(licenseFromTags(["gguf", "license:apache-2.0"]), "apache-2.0");
  assert.equal(licenseFromTags(["gguf", "license:mit"]), "mit");
  assert.equal(licenseFromTags(["gguf"]), undefined);
  // `other` and `unknown` are placeholders, not licences.
  assert.equal(licenseFromTags(["license:other"]), undefined);
});

test("an UNRECOGNISED licence is left unclassified, never assumed permissive", () => {
  /**
   * Labelling an unknown licence as safe for commercial use is giving legal advice with no
   * basis for it. Absent is the honest answer.
   */
  assert.equal(classifyLicense("apache-2.0"), "permissive");
  assert.equal(classifyLicense("mit"), "permissive");
  assert.equal(classifyLicense("llama3.1"), "open-commercial");
  assert.equal(classifyLicense("cc-by-nc-4.0"), "non-commercial");
  assert.equal(classifyLicense("some-bespoke-eula"), undefined);
  assert.equal(classifyLicense(undefined), undefined);
});

/* ─────────────────────────── rate limits ─────────────────────────── */

test("the rate limit is the RFC `ratelimit` header, not `x-ratelimit-*`", () => {
  // Observed: `ratelimit: "api";r=499;t=125` with policy `q=500;w=300`.
  assert.deepEqual(parseRateLimit('"api";r=499;t=125'), { remaining: 499, resetSeconds: 125 });
  // Absent or malformed is UNDEFINED — backing off on an unknown is as wrong as charging ahead
  // on an exhausted one, and the caller must be able to tell them apart.
  assert.equal(parseRateLimit(null), undefined);
  assert.equal(parseRateLimit("garbage"), undefined);
  assert.equal(parseRateLimit('"api";r=499'), undefined, "a remaining with no reset is unusable");
});

test("a 429 is reported with the wait, and NEVER as an empty catalogue", () => {
  return (async () => {
    const { impl } = fake([], { status: 429, ratelimit: '"api";r=0;t=88' });
    const r = await searchHuggingFace({}, { fetchImpl: impl });
    assert.deepEqual(r.entries, []);
    assert.match(r.error, /rate limit/);
    assert.match(r.error, /88s/);
    assert.equal(r.limit?.remaining, 0);
  })();
});

test("a transport failure is an ERROR, not `no models found`", async () => {
  const impl = (async () => {
    throw new Error("ENOTFOUND huggingface.co");
  }) as unknown as typeof fetch;
  const r = await searchHuggingFace({}, { fetchImpl: impl });
  assert.equal(r.entries.length, 0);
  assert.match(r.error, /ENOTFOUND/);
});

test("an unexpected body shape is an error rather than a silent empty list", async () => {
  const { impl } = fake({ not: "an array" });
  const r = await searchHuggingFace({}, { fetchImpl: impl });
  assert.match(r.error, /unexpected shape/);
});

/* ─────────────────────────── the query ─────────────────────────── */

test("the search filters to TEXT GENERATION, because `gguf` alone is not a chat filter", async () => {
  /**
   * Measured: the second most-downloaded GGUF repo on 2026-09-29 was
   * `mudler/locate-anything.cpp-gguf`, an object-detection model. A coding assistant's model
   * browser listing an object detector is a list the user learns to distrust.
   */
  const { impl, seen } = fake([REAL_ROW]);
  await searchHuggingFace({}, { fetchImpl: impl });
  const url = seen[0] ?? "";
  assert.match(url, /filter=gguf/);
  assert.match(url, /filter=text-generation/);
  assert.match(url, /sort=downloads/);
  assert.match(url, /expand%5B%5D=gguf/, "bracketed, repeated — the shape the API accepts");
});

test("the row limit is capped, because each row carries a multi-kilobyte chat template", async () => {
  const { impl, seen } = fake([]);
  await searchHuggingFace({ limit: 5000 }, { fetchImpl: impl });
  assert.match(seen[0] ?? "", /limit=100/);
  await searchHuggingFace({ limit: -3 }, { fetchImpl: impl });
  assert.match(seen[1] ?? "", /limit=1/);
});

test("text-only can be turned OFF for a deliberately wider search", async () => {
  const { impl, seen } = fake([]);
  await searchHuggingFace({ textOnly: false, query: "embed" }, { fetchImpl: impl });
  assert.doesNotMatch(seen[0] ?? "", /text-generation/);
  assert.match(seen[0] ?? "", /search=embed/);
});

/* ─────────────────────────── quantisations ─────────────────────────── */

test("REGRESSION: a UD- prefixed, ternary quantisation keeps its real label", () => {
  /**
   * The first version split on dashes and tested the tail for `Q`/`IQ`. That lost the `UD-`
   * prefix AND failed on `TQ` (ternary), so `…-UD-TQ1_0.gguf` was labelled with its entire
   * 37-character filename. All of these are real files in one repo.
   */
  assert.equal(quantLabel("Qwen3-Coder-30B-A3B-Instruct-UD-TQ1_0.gguf"), "UD-TQ1_0");
  assert.equal(quantLabel("Qwen3-Coder-30B-A3B-Instruct-UD-IQ1_S.gguf"), "UD-IQ1_S");
  assert.equal(quantLabel("Qwen3-Coder-30B-A3B-Instruct-UD-Q8_K_XL.gguf"), "UD-Q8_K_XL");
  assert.equal(quantLabel("Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"), "Q4_K_M");
  assert.equal(quantLabel("Qwen3-Coder-30B-A3B-Instruct-IQ4_NL.gguf"), "IQ4_NL");
  assert.equal(quantLabel("model-BF16.gguf"), "BF16");
  assert.equal(quantLabel("model-f16.gguf"), "f16");
});

test("a filename with no recognisable quantisation keeps the basename — mislabelled beats missing", () => {
  // It is still a real file someone can choose; dropping it would hide a valid option.
  assert.equal(quantLabel("some-model.gguf"), "some-model");
  assert.equal(quantLabel("weights-30B.gguf"), "weights-30B", "30B is a size, not a quantisation");
});

test("quantisations come back smallest-first with real per-file sizes", async () => {
  const { impl } = fake([
    { type: "file", path: "m-Q8_0.gguf", size: 32_482_000_000, lfs: { size: 32_482_000_000 } },
    { type: "file", path: "m-Q4_K_M.gguf", size: 18_560_000_000, lfs: { size: 18_560_000_000 } },
    { type: "file", path: "README.md", size: 1234 },
  ]);
  const r = await fetchQuantizations("a/b", { fetchImpl: impl });
  assert.equal(r.error, "");
  assert.deepEqual(
    r.quants.map((q) => q.label),
    ["Q4_K_M", "Q8_0"],
    "smallest first, and non-gguf files dropped",
  );
  assert.equal(r.quants[0]?.sizeBytes, 18_560_000_000);
});

test("REGRESSION: sharded parts are SUMMED into one choice, not dropped", async () => {
  /**
   * `…-00001-of-00002.gguf` and its sibling are ONE quantisation split across two files, which
   * is how the largest builds are published. Dropping them — the first version of this — made a
   * repo's biggest quantisations vanish from the picker. Showing one part would be worse: it
   * advertises half the download.
   *
   * Live confirmation: unsloth/Qwen3-Coder-30B publishes BF16 as a 2-file shard totalling
   * 61.10 GB, matching HuggingFace's own `treesize` for that directory to the byte.
   */
  const { impl } = fake([
    { type: "file", path: "BF16/m-BF16-00001-of-00002.gguf", size: 49e9, lfs: { size: 49e9 } },
    { type: "file", path: "BF16/m-BF16-00002-of-00002.gguf", size: 12.1e9, lfs: { size: 12.1e9 } },
    { type: "file", path: "m-Q2_K.gguf", size: 5e9 },
  ]);
  const r = await fetchQuantizations("a/b", { fetchImpl: impl });
  const bf16 = r.quants.find((q) => q.label.toUpperCase() === "BF16");
  assert.ok(bf16, "the sharded quantisation must be OFFERED");
  assert.equal(bf16?.sizeBytes, 61.1e9, "…at its full summed size");
  assert.equal(bf16?.parts, 2);
});

test("REGRESSION: the tree request is RECURSIVE, or sharded quants hide behind a directory", async () => {
  /**
   * Without `recursive=true` the API returns `{"type":"directory","size":0,"path":"BF16"}` as a
   * single row and everything inside it disappears. Measured: that hid a 49 GB + 11 GB shard
   * pair, so the repo's largest build was silently reported as not existing.
   */
  const { impl, seen } = fake([]);
  await fetchQuantizations("a/b", { fetchImpl: impl });
  assert.match(seen[0] ?? "", /recursive=true/);
});

test("a directory row is skipped rather than shown as a 0-byte choice", async () => {
  const { impl } = fake([
    { type: "directory", path: "BF16", size: 0 },
    { type: "file", path: "m-Q2_K.gguf", size: 5e9 },
  ]);
  const r = await fetchQuantizations("a/b", { fetchImpl: impl });
  assert.deepEqual(
    r.quants.map((q) => q.label),
    ["Q2_K"],
  );
});

test("a zero-size or unreadable entry is skipped rather than shown as 0 GB", async () => {
  const { impl } = fake([
    { type: "file", path: "a-Q4_K_M.gguf", size: 0 },
    { type: "file", path: "b-Q2_K.gguf", size: 5e9 },
    { type: "file" },
  ]);
  const r = await fetchQuantizations("a/b", { fetchImpl: impl });
  assert.deepEqual(
    r.quants.map((q) => q.label),
    ["Q2_K"],
  );
});

test("SECURITY: a crafted repo id never reaches the URL", async () => {
  // The repo becomes a URL PATH. A traversal must be refused before the request is built.
  const { impl, seen } = fake([]);
  for (const bad of ["../../etc", "a/b/../c", "no-slash", "a b/c", ""]) {
    const r = await fetchQuantizations(bad, { fetchImpl: impl });
    assert.equal(r.error, "not a repo id", `accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(seen, [], "no request was made for any of them");
});
