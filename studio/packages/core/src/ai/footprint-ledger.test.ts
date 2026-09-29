/**
 * footprint-ledger.test.ts — the over-estimates, and the measurements that kill them.
 *
 * The brief was explicit: Prometheus must not discard a model as too big when the estimate was
 * simply wrong. Every test here is either a demonstration of an over-estimate that used to
 * happen, or a proof that a real measurement removes it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type FootprintObservation,
  calibratedOverhead,
  kvSlope,
  ledgerFootprint,
  measuredKvPerToken,
  observationsFor,
  parseObservations,
  recordObservation,
  solveOverhead,
} from "./footprint-ledger.js";
import {
  FALLBACK_KV_BYTES_PER_TOKEN,
  type KvGeometry,
  RUNNER_OVERHEAD_BYTES,
} from "./model-footprint.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const iso = (offsetMs = 0): string => new Date(NOW + offsetMs).toISOString();

/** qwen3.6's real shape: 10 of 40 layers cache, at 2 kv heads and 256-wide keys. */
const QWEN_GEO: KvGeometry = {
  headCountKv: Array.from({ length: 40 }, (_, i) => ((i + 1) % 4 === 0 ? 2 : 0)),
  keyLength: 256,
  valueLength: 256,
  blockCount: 40,
  contextLength: 262144,
};

const base = {
  model: "qwen3.6:latest",
  weightsBytes: 22_485_653_259,
  fallbackKvBytesPerToken: FALLBACK_KV_BYTES_PER_TOKEN,
  now: NOW,
};

/* ── the over-estimate the flat overhead causes ─────────────────────────────────────────────*/

test("a SMALL model is not charged a full gigabyte of overhead once it has been measured", () => {
  // A 2 GB model with a flat 1 GiB allowance is carrying a 50% surcharge. On a machine with
  // 3 GB free that is the difference between running and being refused.
  const small = { ...base, model: "tiny:1b", weightsBytes: 2 * GIB, contextTokens: 8192 };
  const uncalibrated = ledgerFootprint({ ...small, geometry: QWEN_GEO });
  assert.equal(uncalibrated.overheadBytes, RUNNER_OVERHEAD_BYTES);

  // One /api/ps reading at a DIFFERENT context is enough: the overhead is solved, not assumed.
  const seen: FootprintObservation[] = [
    {
      model: "tiny:1b",
      contextTokens: 4096,
      totalBytes: 2 * GIB + kvAt(QWEN_GEO, 4096) + 300 * MIB,
      weightsBytes: 2 * GIB,
      observedAt: iso(),
      via: "api-ps",
    },
  ];
  const calibrated = ledgerFootprint({ ...small, geometry: QWEN_GEO, ledger: seen });
  assert.equal(calibrated.source, "calibrated");
  assert.ok(
    Math.abs(calibrated.overheadBytes - 300 * MIB) < MIB,
    `overhead should be the measured ~300 MiB, got ${calibrated.overheadBytes}`,
  );
  assert.ok(
    calibrated.totalBytes < uncalibrated.totalBytes - 700 * MIB,
    "the calibrated total must be meaningfully smaller",
  );
});

test("a measurement at THIS context beats everything and reports source 'measured'", () => {
  const seen: FootprintObservation[] = [
    {
      model: base.model,
      contextTokens: 262144,
      totalBytes: 27_000_000_000,
      observedAt: iso(),
      via: "api-ps",
    },
  ];
  const fp = ledgerFootprint({ ...base, contextTokens: 262144, geometry: QWEN_GEO, ledger: seen });
  assert.equal(fp.source, "measured");
  assert.equal(fp.totalBytes, 27_000_000_000);
  assert.equal(fp.overheadBytes, 0, "nothing is added on top of a real total");
});

/* ── the log gives the cache, but NOT the total ─────────────────────────────────────────────*/

test("a server-log row must NOT be read as a total — that would solve the overhead to zero", () => {
  // The log reports `llama_kv_cache: size` and `load_tensors: … buffer size` exactly, and their
  // sum with the runner's own buffers not at all. Storing weights+kv as a "total" and then
  // subtracting them back gives exactly 0 every time: a systematic under-estimate wearing a
  // measurement's clothes. This is the guard against that.
  const logRow: FootprintObservation = {
    model: base.model,
    contextTokens: 262144,
    kvBytes: 2720 * MIB,
    weightsBytes: 21_444 * MIB,
    kvType: "q8_0",
    observedAt: iso(),
    via: "server-log",
  };
  assert.equal(logRow.totalBytes, undefined, "a log row has no total by construction");
  assert.equal(
    solveOverhead(logRow, QWEN_GEO, base.weightsBytes),
    null,
    "and it must refuse to pretend it does",
  );
  const { bytes, calibrated } = calibratedOverhead([logRow], QWEN_GEO, base.weightsBytes);
  assert.equal(calibrated, false);
  assert.equal(bytes, RUNNER_OVERHEAD_BYTES, "the flat allowance stands until something measures");
});

test("a log row still prices the CACHE exactly, with no architecture knowledge at all", () => {
  const logRow: FootprintObservation = {
    model: base.model,
    contextTokens: 262144,
    kvBytes: 2720 * MIB,
    observedAt: iso(),
    via: "server-log",
  };
  const perToken = measuredKvPerToken([logRow]);
  assert.ok(perToken !== null);
  // ollama's own log: 2720 MiB over 262144 cells = 10880 B/token, i.e. the 10.6 KiB/token
  // CLAUDE.md records for this model. Derived by division, with nothing else known about it.
  assert.equal(perToken, 10880);

  // And with NO geometry it still beats the blanket fallback by a wide margin.
  const withLog = ledgerFootprint({
    ...base,
    contextTokens: 262144,
    geometry: null,
    ledger: [logRow],
  });
  const without = ledgerFootprint({ ...base, contextTokens: 262144, geometry: null });
  assert.equal(withLog.source, "calibrated");
  assert.equal(without.source, "estimated");
  assert.ok(
    without.kvBytes > withLog.kvBytes * 2,
    `the fallback (${without.kvBytes}) should be far above the measured (${withLog.kvBytes})`,
  );
});

/* ── two totals price the cache without any geometry ────────────────────────────────────────*/

test("two totals at different contexts give the per-token cost, weights and overhead cancelling", () => {
  const hist: FootprintObservation[] = [
    { model: "x:1", contextTokens: 32768, totalBytes: 10 * GIB, observedAt: iso(1), via: "api-ps" },
    {
      model: "x:1",
      contextTokens: 8192,
      totalBytes: 10 * GIB - 24576 * 1024,
      observedAt: iso(0),
      via: "api-ps",
    },
  ];
  const slope = kvSlope(hist);
  assert.ok(slope !== null);
  // (32768 − 8192) tokens accounted for 24 MiB ⇒ 1024 B/token.
  assert.ok(Math.abs(slope - 1024) < 1, `slope ${slope}`);
});

test("kvSlope refuses contradictory readings rather than inventing a number", () => {
  // A bigger context that measured SMALLER means the two readings disagree about something
  // other than context — a re-quantised model under the same tag, most likely.
  const hist: FootprintObservation[] = [
    { model: "x:1", contextTokens: 32768, totalBytes: 5 * GIB, observedAt: iso(1), via: "api-ps" },
    { model: "x:1", contextTokens: 8192, totalBytes: 9 * GIB, observedAt: iso(0), via: "api-ps" },
  ];
  assert.equal(kvSlope(hist), null);
});

/* ── guards on a bad observation ────────────────────────────────────────────────────────────*/

test("an absurd solved overhead is rejected — a mismatched weights figure, not an overhead", () => {
  const obs: FootprintObservation = {
    model: base.model,
    contextTokens: 8192,
    totalBytes: 40 * GIB, // the tag was re-pulled at a bigger quantisation
    weightsBytes: 2 * GIB,
    observedAt: iso(),
    via: "api-ps",
  };
  assert.equal(solveOverhead(obs, QWEN_GEO, 2 * GIB), null, "> 4 GiB of 'overhead' is not real");
});

test("a negative solved overhead clamps to zero rather than crediting memory back", () => {
  const obs: FootprintObservation = {
    model: base.model,
    contextTokens: 8192,
    totalBytes: 1 * GIB,
    weightsBytes: 2 * GIB, // mapped lazily; less resident than on disk
    observedAt: iso(),
    via: "api-ps",
  };
  assert.equal(solveOverhead(obs, QWEN_GEO, 2 * GIB), 0);
});

/* ── the ledger as a store ──────────────────────────────────────────────────────────────────*/

test("a newer reading at the same context REPLACES the older one", () => {
  const a: FootprintObservation = {
    model: "m:1",
    contextTokens: 4096,
    totalBytes: 1 * GIB,
    observedAt: iso(0),
    via: "api-ps",
  };
  const b: FootprintObservation = { ...a, totalBytes: 2 * GIB, observedAt: iso(60_000) };
  const led = recordObservation(b, recordObservation(a, []));
  assert.equal(led.length, 1, "not two rows for one fact");
  assert.equal(led[0]?.totalBytes, 2 * GIB, "and the newer one wins");
});

test("observations are scoped to a host — a remote reading never answers for the local machine", () => {
  const local: FootprintObservation = {
    model: "m:1",
    contextTokens: 4096,
    totalBytes: 1 * GIB,
    observedAt: iso(),
    via: "api-ps",
  };
  const remote: FootprintObservation = { ...local, host: "gpu-box.lan", totalBytes: 9 * GIB };
  const led = recordObservation(remote, recordObservation(local, []));
  assert.equal(led.length, 2, "same model, two machines, two facts");
  assert.equal(observationsFor(led, "m:1", undefined, NOW)[0]?.totalBytes, 1 * GIB);
  assert.equal(observationsFor(led, "m:1", "gpu-box.lan", NOW)[0]?.totalBytes, 9 * GIB);
});

test("a stale observation is ignored — a tag like :latest is a moving target", () => {
  const old: FootprintObservation = {
    model: "m:1",
    contextTokens: 4096,
    totalBytes: 1 * GIB,
    observedAt: new Date(NOW - 40 * 24 * 3600 * 1000).toISOString(),
    via: "api-ps",
  };
  assert.equal(observationsFor([old], "m:1", undefined, NOW).length, 0);
});

test("a corrupt or hand-edited ledger parses to an empty list, never a throw", () => {
  assert.deepEqual(parseObservations("not json"), []);
  assert.deepEqual(parseObservations('{"not":"an array"}'), []);
  assert.deepEqual(parseObservations(undefined), []);
  // A row that measured neither a total nor a cache carries no information.
  assert.deepEqual(
    parseObservations(JSON.stringify([{ model: "m", contextTokens: 10, via: "api-ps" }])),
    [],
  );
});

test("a well-formed ledger round-trips through JSON", () => {
  const rows: FootprintObservation[] = [
    { model: "m:1", contextTokens: 4096, totalBytes: GIB, observedAt: iso(), via: "api-ps" },
    {
      model: "m:2",
      contextTokens: 8192,
      kvBytes: 100 * MIB,
      weightsBytes: GIB,
      kvType: "q8_0",
      observedAt: iso(),
      via: "server-log",
    },
  ];
  assert.deepEqual(parseObservations(JSON.stringify(rows)), rows);
});

/** KV bytes for a geometry, duplicated locally so the test does not lean on the thing it checks. */
function kvAt(geo: KvGeometry, tokens: number): number {
  let total = 0;
  for (const h of geo.headCountKv) {
    if (h <= 0) continue;
    total += tokens * h * (geo.keyLength + geo.valueLength) * 1.0625;
  }
  return Math.round(total);
}
