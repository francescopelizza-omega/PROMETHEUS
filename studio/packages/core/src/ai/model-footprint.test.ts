/**
 * model-footprint.test.ts — the arithmetic is checked against a REAL measurement.
 *
 * The anchor test is qwen3.6:latest at 262144, where ollama's own log says exactly what it
 * allocated. An estimator that cannot reproduce a number the runtime printed is not an
 * estimator, it is a guess with a confident interface — which is what the previous attempt at
 * this was, and why it over-counted gemma by more than 10×.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FALLBACK_KV_BYTES_PER_TOKEN,
  type KvGeometry,
  admitModel,
  bytesPerElement,
  humanBytes,
  kvBytesForContext,
  modelFootprint,
  parseKvGeometry,
} from "./model-footprint.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** qwen3.6:latest, verbatim from `/api/show` on 2026-09-25. */
const QWEN_INFO: Record<string, unknown> = {
  "qwen35moe.attention.head_count": 16,
  "qwen35moe.attention.head_count_kv": [
    0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2,
    0, 0, 0, 2, 0, 0, 0, 2,
  ],
  "qwen35moe.attention.key_length": 256,
  "qwen35moe.attention.value_length": 256,
  "qwen35moe.block_count": 40,
  "qwen35moe.embedding_length": 2048,
};

/** gemma4:12b, verbatim. 5 of every 6 layers are windowed at 1024. */
const GEMMA_INFO: Record<string, unknown> = {
  "gemma4.attention.head_count": 16,
  "gemma4.attention.head_count_kv": Array.from({ length: 48 }, (_, i) =>
    (i + 1) % 6 === 0 ? 1 : 8,
  ),
  "gemma4.attention.key_length": 256,
  "gemma4.attention.value_length": 256,
  "gemma4.attention.sliding_window": 1024,
  "gemma4.attention.sliding_window_pattern": Array.from(
    { length: 48 },
    (_, i) => (i + 1) % 6 !== 0,
  ),
  "gemma4.block_count": 48,
  "gemma4.embedding_length": 3840,
};

test("ANCHOR: qwen3.6 at 262144 reproduces ollama's own 2720 MiB, to the megabyte", () => {
  // llama_kv_cache: size = 2720.00 MiB (262144 cells, 10 layers, 1/1 seqs),
  //                 K (q8_0): 1360.00 MiB, V (q8_0): 1360.00 MiB
  const geo = parseKvGeometry(QWEN_INFO);
  assert.ok(geo, "geometry must parse");
  const bytes = kvBytesForContext(geo, 262144, "q8_0");
  assert.equal(Math.round(bytes / MIB), 2720);
});

test("only the layers that CACHE are counted — 10 of qwen's 40, not all 40", () => {
  const geo = parseKvGeometry(QWEN_INFO);
  assert.ok(geo);
  assert.equal(geo.headCountKv.length, 40, "all 40 layers are described");
  assert.equal(geo.headCountKv.filter((h) => h > 0).length, 10, "but only 10 keep a cache");
  // The naive `block_count × kv_heads` would be 4× too big — the exact shape of the old bug.
  const naive = 40 * 2 * (256 + 256) * bytesPerElement("q8_0") * 262144;
  assert.ok(naive / kvBytesForContext(geo, 262144) > 3.9);
});

test("a sliding-window layer does NOT grow with the context — the other half of the old 10×", () => {
  const geo = parseKvGeometry(GEMMA_INFO);
  assert.ok(geo);
  const at32k = kvBytesForContext(geo, 32768);
  const at256k = kvBytesForContext(geo, 262144);
  // 40 of 48 layers are pinned at 1024 cells, so an 8× context is far from an 8× cost.
  assert.ok(at256k / at32k < 6, `grew ${(at256k / at32k).toFixed(1)}× for an 8× context`);
  // and treating every layer as full-attention would massively over-count
  const asIfDense = 48 * 8 * (256 + 256) * bytesPerElement("q8_0") * 262144;
  assert.ok(asIfDense / at256k > 5, "the dense assumption is the >10× error, reproduced");
});

test("the head dimension is key_length, not embedding/heads", () => {
  // qwen3.6: embedding 2048 / 16 heads = 128, but key_length is 256 — a factor of two.
  const geo = parseKvGeometry(QWEN_INFO);
  assert.equal(geo?.keyLength, 256);
  assert.notEqual(geo?.keyLength, 2048 / 16);
});

test("quantised KV element sizes include the block scale", () => {
  assert.equal(bytesPerElement("f16"), 2);
  assert.equal(bytesPerElement("q8_0"), 1.0625); // (32 int8 + one fp16 scale) / 32
  assert.equal(bytesPerElement("q4_0"), 0.5625);
  // halving the element size halves the cache
  const geo = parseKvGeometry(QWEN_INFO);
  assert.ok(geo);
  const q8 = kvBytesForContext(geo, 100_000, "q8_0");
  const f16 = kvBytesForContext(geo, 100_000, "f16");
  assert.ok(Math.abs(f16 / q8 - 2 / 1.0625) < 0.001);
});

test("unparseable model_info yields null, and the caller falls back pessimistically", () => {
  assert.equal(parseKvGeometry({}), null);
  assert.equal(
    parseKvGeometry({ "x.attention.head_count_kv": 8 }),
    null,
    "a scalar is not the array",
  );
  assert.equal(parseKvGeometry({ "x.attention.head_count_kv": [8] }), null, "key_length required");
  const fp = modelFootprint({ weightsBytes: 8 * GIB, contextTokens: 100_000 });
  assert.equal(fp.source, "estimated");
  assert.equal(fp.kvBytes, 100_000 * FALLBACK_KV_BYTES_PER_TOKEN);
  // pessimistic ON PURPOSE: refusing a model that would have fit is recoverable; starting a
  // load that takes the display down is not.
  const computed = modelFootprint({
    weightsBytes: 8 * GIB,
    contextTokens: 100_000,
    geometry: parseKvGeometry(QWEN_INFO),
  });
  assert.ok(fp.totalBytes > computed.totalBytes, "the fallback must over-, never under-estimate");
});

test("LIVE CHECK: the computed total matches what ollama actually reported resident", () => {
  // 2026-09-25, this machine: `ollama ps` showed qwen3.6:latest at 27 GB, 262144 context,
  // 100% GPU. The arithmetic below is what this module predicts for the same model and context.
  // Agreement here is the whole claim — an estimator that cannot land within a few percent of a
  // number the runtime printed has no business refusing a model load.
  const fp = modelFootprint({
    weightsBytes: 23.94e9, // /api/tags `size`
    contextTokens: 262144,
    geometry: parseKvGeometry(QWEN_INFO),
  });
  const reportedGiB = 27;
  const computedGiB = fp.totalBytes / GIB;
  assert.ok(
    Math.abs(computedGiB - reportedGiB) / reportedGiB < 0.08,
    `computed ${computedGiB.toFixed(1)} GiB vs ollama's reported ${reportedGiB} GiB`,
  );
});

test("a real measurement always wins over the arithmetic", () => {
  const fp = modelFootprint({
    weightsBytes: 23.94e9,
    contextTokens: 262144,
    geometry: parseKvGeometry(QWEN_INFO),
    measuredTotalBytes: 26.8e9,
  });
  assert.equal(fp.source, "measured");
  assert.equal(fp.totalBytes, 26.8e9);
});

test("qwen3.6 fits this 64 GB machine at full context; the shortfall is named when it does not", () => {
  const fp = modelFootprint({
    weightsBytes: 23.94e9,
    contextTokens: 262144,
    geometry: parseKvGeometry(QWEN_INFO),
  });
  // ~23.9 GB weights + 2.85 GB KV + 1 GiB overhead ≈ 27.9 GB
  assert.ok(fp.totalBytes / 1e9 > 27 && fp.totalBytes / 1e9 < 29, `${fp.totalBytes / 1e9} GB`);

  const roomy = admitModel(fp, {
    totalBytes: 64 * GIB,
    availableBytes: 55 * GIB,
    headroomBytes: 8 * GIB,
  });
  assert.equal(roomy.ok, true);

  const tight = admitModel(fp, {
    totalBytes: 16 * GIB,
    availableBytes: 14 * GIB,
    headroomBytes: 4 * GIB,
  });
  assert.equal(tight.ok, false);
  assert.ok(tight.ok === false && tight.shortfallBytes > 0);
  assert.match(tight.ok === false ? tight.reason : "", /more memory than is free/);
});

test("headroom is withheld, not merely advisory", () => {
  const fp = modelFootprint({ weightsBytes: 10 * GIB, contextTokens: 0, geometry: null });
  // 11 GiB needed (10 + 1 overhead), 12 GiB free, but 4 GiB is reserved ⇒ refused.
  const a = admitModel(fp, {
    totalBytes: 16 * GIB,
    availableBytes: 12 * GIB,
    headroomBytes: 4 * GIB,
  });
  assert.equal(a.ok, false);
  const b = admitModel(fp, {
    totalBytes: 16 * GIB,
    availableBytes: 12 * GIB,
    headroomBytes: 0,
  });
  assert.equal(b.ok, true);
});

test("humanBytes is readable and locale-pinned", () => {
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(2 * GIB), "2 GB");
  // ≥10 drops to whole units: a model list reads better as "22 GB" than "22.3 GB".
  assert.equal(humanBytes(23.94e9), "22 GB");
  assert.equal(humanBytes(7.56e9), "7 GB");
  assert.equal(humanBytes(2720 * 1024 * 1024), "2.7 GB");
});
