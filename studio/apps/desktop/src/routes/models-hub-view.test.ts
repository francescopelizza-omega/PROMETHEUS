/**
 * models-hub-view.test.ts — the §3 view model.
 *
 * The load-bearing assertions here are all about NOT inventing: a metric with no source
 * produces no chip, a pull line that parses to nothing produces no percentage, and a cloud
 * endpoint below A5 is marked unusable rather than quietly offered.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLOUD_MIN_AUTH,
  endpointRow,
  formatBytes,
  installedRows,
  installedTotal,
  metricChips,
  parsePullProgress,
} from "./models-hub-view.js";

/* ── sizes ───────────────────────────────────────────────────────────────────*/

test("bytes format in binary units — the same ones the sidecar and ollama use", () => {
  // Decimal GB here would make the Installed island and the pull progress line disagree
  // about the size of the same file.
  assert.equal(formatBytes(4.1 * 1024 ** 3), "4.1 GB");
  assert.equal(formatBytes(512 * 1024 ** 2), "512 MB");
  assert.equal(formatBytes(7.5 * 1024 ** 2), "7.5 MB");
  assert.equal(formatBytes(24 * 1024 ** 3), "24 GB", "double digits drop the decimal");
});

test("an absent or zero size is null, never `0 B`", () => {
  for (const v of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatBytes(v), null, `${String(v)} produced a size`);
  }
});

test("the total reports how many rows had NO size, so the header can say so", () => {
  const t = installedTotal([{ sizeBytes: 1024 ** 3 }, {}, { sizeBytes: 1024 ** 3 }]);
  assert.equal(t.bytes, 2 * 1024 ** 3);
  assert.equal(t.unknown, 1, "a row with no size must not silently count as zero");
});

/* ── metric chips ────────────────────────────────────────────────────────────*/

test("a metric with no source produces NO chip — not a zero", () => {
  // §3 asks for tok/s, ctx, memory and load time. Only ctx has a real source today, and
  // `0 tok/s` beside a model that is serving fine would be a lie with a plausible face.
  const chips = metricChips({ ctxLen: 8192 });
  assert.deepEqual(chips, [{ label: "ctx", value: "8k" }]);
  assert.deepEqual(metricChips({}), []);
});

test("chips appear in §3's order once their sources exist", () => {
  const chips = metricChips({
    tokensPerSecond: 42.5,
    ctxLen: 4096,
    memoryBytes: 6 * 1024 ** 3,
    loadMs: 2400,
  });
  assert.deepEqual(
    chips.map((c) => c.label),
    ["tok/s", "ctx", "memory", "load"],
  );
  assert.equal(chips[3]?.value, "2.4s");
});

/* ── pull progress ───────────────────────────────────────────────────────────*/

test("a real ollama progress line yields both halves of §3's readout", () => {
  const p = parsePullProgress({
    raw: "pulling 8934d96d3f08: 62% ▕███    ▏ 4.1 GB/6.6 GB  12 MB/s",
  });
  assert.equal(p.pct, 62);
  assert.equal(p.bytes, "4.1 of 6.6 GB");
});

test("main's `pct` wins over the raw line, and is clamped", () => {
  assert.equal(parsePullProgress({ pct: 30, raw: "…: 62% …" }).pct, 30);
  assert.equal(parsePullProgress({ pct: 140 }).pct, 100);
  assert.equal(parsePullProgress({ pct: -5 }).pct, 0);
});

test("an unparseable line yields nulls — never a fabricated 0%", () => {
  // A bar pinned at zero while a 6 GB download runs reads as "stuck", which is the one
  // thing the user must not conclude.
  const p = parsePullProgress({ raw: "verifying sha256 digest" });
  assert.equal(p.pct, null);
  assert.equal(p.bytes, null);
  assert.deepEqual(parsePullProgress(null), { pct: null, bytes: null });
});

/* ── endpoints ───────────────────────────────────────────────────────────────*/

test("a local endpoint is usable at every level", () => {
  for (let level = 0; level <= 7; level += 1) {
    const row = endpointRow({ name: "ollama", baseUrl: "http://localhost:11434" }, "local", level);
    assert.equal(row.usable, true, `A${level} could not use a LOCAL endpoint`);
    assert.equal(row.note, undefined);
  }
});

test("a cloud endpoint is refused below A5 and carries §3's reason", () => {
  for (let level = 0; level < CLOUD_MIN_AUTH; level += 1) {
    const row = endpointRow({ name: "openai", baseUrl: "https://api.openai.com" }, "cloud", level);
    assert.equal(row.usable, false, `A${level} was allowed to use a cloud endpoint`);
    assert.match(row.note ?? "", /A5\+ only/);
  }
  for (let level = CLOUD_MIN_AUTH; level <= 7; level += 1) {
    assert.equal(
      endpointRow({ name: "openai", baseUrl: "https://api.openai.com" }, "cloud", level).usable,
      true,
      `A${level} could not use a cloud endpoint`,
    );
  }
});

/* ── installed rows ──────────────────────────────────────────────────────────*/

test("every §3 cell that has no source is null — the row never fills a blank", () => {
  const [row] = installedRows([{ id: "ollama:qwen3:8b" }]);
  assert.deepEqual(row, {
    id: "ollama:qwen3:8b",
    size: null,
    ctx: null, // `model.list` reports no context length — this stays empty, not 0
    quant: null,
    served: false,
  });
});

test("quant falls back to the parameter size, which is still a fact about the file", () => {
  const [row] = installedRows([{ id: "a", params: "8B" }]);
  assert.equal(row?.quant, "8B");
  const [explicit] = installedRows([{ id: "b", params: "8B", quant: "Q4_K_M" }]);
  assert.equal(explicit?.quant, "Q4_K_M", "an explicit quantization outranks the size class");
});

test("size, ctx and served pass through when the payload has them", () => {
  const [row] = installedRows([
    { id: "x", sizeBytes: 4.1 * 1024 ** 3, contextLen: 32768, quant: "Q4_K_M", served: true },
  ]);
  assert.deepEqual(row, {
    id: "x",
    size: "4.1 GB",
    // the raw byte count rides along so the island header can total what it knows without
    // re-parsing the formatted string back into a number.
    sizeBytes: 4.1 * 1024 ** 3,
    ctx: "32k",
    quant: "Q4_K_M",
    served: true,
  });
});
