/**
 * catalog.test.ts — the shared shape, the fit verdict, and the ordering.
 *
 * One rule runs through all of it: **an absent field is not a zero.** A source that does not
 * publish a size must not make a 40 GB model look like the smallest thing in the list, and a
 * model whose size is unknown must not be told it fits.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CatalogEntry,
  type FitBudget,
  filterCatalog,
  fitOf,
  installCommand,
  mergeCatalog,
  routeKey,
  sortCatalog,
} from "./catalog.js";

const GB = 1e9;

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: "x",
  source: "huggingface",
  name: "some-model",
  summary: "",
  route: { kind: "ollama-hf", repo: "someone/model", quant: "Q4_K_M" },
  ...over,
});

/* ─────────────────────────── the fit verdict ─────────────────────────── */

const budget: FitBudget = { usableBytes: 24 * GB, contextTokens: 8192 };

test("a model that comfortably fits says so, with the spare", () => {
  const f = fitOf(entry({ sizeBytes: 4 * GB }), budget);
  assert.equal(f.verdict, "fits");
  // weights + a floor KV allowance + the smallest observed runner overhead — never just weights.
  assert.ok(f.verdict === "fits" && f.needBytes > 4 * GB);
});

test("a model larger than the budget is too-big, with the shortfall", () => {
  const f = fitOf(entry({ sizeBytes: 40 * GB }), budget);
  assert.equal(f.verdict, "too-big");
  assert.ok(f.verdict === "too-big" && f.shortBytes > 15 * GB);
});

test("`tight` is its own verdict, not a rounding of `fits`", () => {
  /**
   * Under a tenth of the budget left means the model loads and then competes with everything
   * else — which on Apple Silicon unified memory is where the compositor starves before
   * anything is killed. The user is better told.
   */
  const f = fitOf(entry({ sizeBytes: 23 * GB }), budget);
  assert.equal(f.verdict, "tight");
});

test("REGRESSION: an ABSENT size is `unknown`, never a fit", () => {
  /**
   * Treating a missing size as 0 would rank a model as the smallest thing in the list and tell
   * a 16 GB machine that a 40 GB download is comfortable.
   */
  assert.deepEqual(fitOf(entry({}), budget), { verdict: "unknown" });
  assert.deepEqual(fitOf(entry({ sizeBytes: 0 }), budget), { verdict: "unknown" });
});

test("a bigger context costs memory, so the same model can stop fitting", () => {
  /**
   * The arithmetic, so the numbers are not magic: `estimatedLowerBound` is weights + tokens ×
   * 2 KiB + 256 MiB. At the FLOOR rate a full 262,144-token window costs ~0.54 GB — cheap, and
   * deliberately so, because that floor is the low end of what has actually been observed
   * rather than a convenient guess. It only decides the verdict when the model already nearly
   * fills the budget, which is exactly the case worth warning about.
   */
  const e = entry({ sizeBytes: 23.5 * GB });
  assert.equal(fitOf(e, { usableBytes: 24 * GB, contextTokens: 4096 }).verdict, "tight");
  assert.equal(fitOf(e, { usableBytes: 24 * GB, contextTokens: 262_144 }).verdict, "too-big");
  // …and at a comfortable size the same window change is a non-event.
  const small = entry({ sizeBytes: 4 * GB });
  assert.equal(fitOf(small, { usableBytes: 24 * GB, contextTokens: 262_144 }).verdict, "fits");
});

/* ─────────────────────────── merging sources ─────────────────────────── */

test("the same route from two sources is ONE row, and the better source wins identity", () => {
  const hf = entry({
    source: "huggingface",
    name: "someone/model",
    downloads: 5000,
    sizeBytes: 4 * GB,
  });
  const curated = entry({
    source: "curated",
    name: "curated name",
    license: "Apache-2.0",
    licenseClass: "permissive",
  });
  const merged = mergeCatalog([[hf], [curated]]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.name, "curated name", "curated outranks huggingface for identity");
  assert.equal(merged[0]?.license, "Apache-2.0");
  /**
   * …and the loser's facts SURVIVE. A curated row knows the licence and nothing about size; if
   * the merge replaced rather than merged, every curated model's fit verdict would be `unknown`.
   */
  assert.equal(merged[0]?.sizeBytes, 4 * GB);
  assert.equal(merged[0]?.downloads, 5000);
});

test("an INSTALLED row outranks everything, and the flag survives either ordering", () => {
  const hf = entry({ source: "huggingface", sizeBytes: 4 * GB });
  const local = entry({ source: "installed", name: "on disk", installed: true });
  assert.equal(mergeCatalog([[hf], [local]])[0]?.name, "on disk");
  assert.equal(mergeCatalog([[local], [hf]])[0]?.installed, true);
  assert.equal(mergeCatalog([[hf], [local]])[0]?.installed, true);
});

test("two quantisations of one repo are TWO rows — they are different downloads", () => {
  const q4 = entry({ route: { kind: "ollama-hf", repo: "a/b", quant: "Q4_K_M" } });
  const q8 = entry({ route: { kind: "ollama-hf", repo: "a/b", quant: "Q8_0" } });
  assert.equal(mergeCatalog([[q4, q8]]).length, 2);
  assert.notEqual(routeKey(q4.route), routeKey(q8.route));
});

/* ─────────────────────────── ordering ─────────────────────────── */

test("the DEFAULT order leads with what you can actually use, not with popularity", () => {
  /**
   * A browser sorted purely by downloads leads with a 400 GB model on a laptop. Relevance is
   * installed first, then what fits, then the rest.
   */
  const rows = [
    entry({ id: "huge", name: "huge", sizeBytes: 400 * GB, downloads: 9_000_000 }),
    entry({ id: "small", name: "small", sizeBytes: 4 * GB, downloads: 10 }),
    entry({ id: "mine", name: "mine", sizeBytes: 8 * GB, downloads: 1, installed: true }),
  ];
  assert.deepEqual(
    sortCatalog(rows, "relevance", budget).map((e) => e.id),
    ["mine", "small", "huge"],
  );
});

test("sorting by SIZE puts unknown sizes last — an absent size is not `very small`", () => {
  const rows = [
    entry({ id: "unknown", name: "u" }),
    entry({ id: "big", name: "b", sizeBytes: 20 * GB }),
    entry({ id: "small", name: "s", sizeBytes: 2 * GB }),
  ];
  assert.deepEqual(
    sortCatalog(rows, "size").map((e) => e.id),
    ["small", "big", "unknown"],
  );
});

test("sorting by downloads puts an unknown count last, not first", () => {
  const rows = [entry({ id: "none", name: "n" }), entry({ id: "many", name: "m", downloads: 100 })];
  assert.deepEqual(
    sortCatalog(rows, "downloads").map((e) => e.id),
    ["many", "none"],
  );
});

test("relevance without a budget still leads with installed rows", () => {
  // The GUI may not know the machine's memory yet; the ordering must not throw or invert.
  const rows = [entry({ id: "a", name: "a" }), entry({ id: "b", name: "b", installed: true })];
  assert.deepEqual(
    sortCatalog(rows, "relevance").map((e) => e.id),
    ["b", "a"],
  );
});

/* ─────────────────────────── filter + install ─────────────────────────── */

test("the filter matches name, summary, quantisation and tags", () => {
  const rows = [
    entry({ id: "1", name: "Qwen2.5-Coder", summary: "" }),
    entry({ id: "2", name: "other", summary: "a coding model" }),
    entry({ id: "3", name: "third", quantization: "Q8_0" }),
    entry({ id: "4", name: "fourth", tags: ["text-generation", "gguf"] }),
    entry({ id: "5", name: "nope", summary: "unrelated" }),
  ];
  assert.deepEqual(
    filterCatalog(rows, "cod").map((e) => e.id),
    ["1", "2"],
  );
  assert.deepEqual(
    filterCatalog(rows, "q8").map((e) => e.id),
    ["3"],
  );
  assert.deepEqual(
    filterCatalog(rows, "gguf").map((e) => e.id),
    ["4"],
  );
  assert.equal(filterCatalog(rows, "").length, 5);
});

test("a HuggingFace repo installs through ollama's OFFICIAL hf.co form — no conversion", () => {
  /**
   * `ollama pull hf.co/<repo>:<quant>` is supported by ollama itself. That is what makes a
   * HuggingFace-backed browser work without scraping anything and, for almost every model,
   * without a conversion step: someone has already published a GGUF.
   */
  assert.equal(
    installCommand(
      entry({ route: { kind: "ollama-hf", repo: "bartowski/X-GGUF", quant: "Q4_K_M" } }),
    ),
    "ollama pull hf.co/bartowski/X-GGUF:Q4_K_M",
  );
  assert.equal(
    installCommand(entry({ route: { kind: "ollama-hf", repo: "a/b" } })),
    "ollama pull hf.co/a/b",
  );
  assert.equal(
    installCommand(entry({ route: { kind: "ollama-tag", tag: "qwen3.6:latest" } })),
    "ollama pull qwen3.6:latest",
  );
});

test("a repo with no published GGUF offers NO command, rather than one that will fail", () => {
  const e = entry({ route: { kind: "manual", why: "no GGUF published for this repo" } });
  assert.equal(installCommand(e), null);
});
