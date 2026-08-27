/**
 * ai/model-health.test.ts — the pure merge from capability/breaker/context-window state into
 * one displayable record, and the strings a human actually reads.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { initialCapability } from "../agent/protocol/negotiate.js";
import {
  type EndpointHealthRecord,
  buildHealthRecord,
  describeBreaker,
  describeContextWindow,
  describeTransport,
  formatHealthTable,
  mergeHealthRecord,
} from "./model-health.js";

function record(over: Partial<EndpointHealthRecord> = {}): EndpointHealthRecord {
  return {
    ...buildHealthRecord({
      endpointId: "local:gemma4",
      model: "gemma4:12b",
      locality: "local",
      transport: "native",
      capability: initialCapability(),
      contextWindow: 8192,
      contextWindowSource: "default",
      nowIso: "2026-08-19T00:00:00.000Z",
    }),
    ...over,
  };
}

test("buildHealthRecord: native transport is NOT demonstrated until a native call has landed", () => {
  const r = buildHealthRecord({
    endpointId: "local:x",
    model: "x",
    locality: "local",
    transport: "native",
    capability: { ...initialCapability(), nativeCalls: 0 },
    contextWindow: 8192,
    contextWindowSource: "default",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(r.demonstrated, false);
  const proven = buildHealthRecord({
    endpointId: "local:x",
    model: "x",
    locality: "local",
    transport: "native",
    capability: { ...initialCapability(), nativeCalls: 3 },
    contextWindow: 8192,
    contextWindowSource: "default",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(proven.demonstrated, true);
});

test("buildHealthRecord: text transport demonstration reads textSyntaxCalls, not nativeCalls", () => {
  const r = buildHealthRecord({
    endpointId: "local:x",
    model: "x",
    locality: "local",
    transport: "text",
    capability: { ...initialCapability(), nativeCalls: 5, textSyntaxCalls: 0 },
    contextWindow: 8192,
    contextWindowSource: "default",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(r.demonstrated, false, "nativeCalls must not leak into the TEXT transport's proof");
  const proven = buildHealthRecord({
    endpointId: "local:x",
    model: "x",
    locality: "local",
    transport: "text",
    capability: { ...initialCapability(), textSyntaxCalls: 1 },
    contextWindow: 8192,
    contextWindowSource: "default",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(proven.demonstrated, true);
});

test("buildHealthRecord: no breaker supplied reads as healthy/closed, not a crash", () => {
  const r = record();
  assert.equal(r.breakerState, "closed");
  assert.equal(r.breakerFailures, 0);
  assert.equal(r.breakerOpenedAt, null);
});

test("mergeHealthRecord: keys by endpointId, replaces only that entry", () => {
  const a = record({ endpointId: "a" });
  const store1 = mergeHealthRecord({}, { ...a, endpointId: "a" });
  const b = { ...a, endpointId: "b" };
  const store2 = mergeHealthRecord(store1, b);
  assert.deepEqual(Object.keys(store2).sort(), ["a", "b"]);
  const aUpdated = { ...a, endpointId: "a", nativeCalls: 99 };
  const store3 = mergeHealthRecord(store2, aUpdated);
  assert.equal(store3.a?.nativeCalls, 99);
  assert.equal(store3.b?.nativeCalls, a.nativeCalls);
});

test("describeTransport: rejection is called out explicitly, not just 'native'", () => {
  const rejected = buildHealthRecord({
    endpointId: "x",
    model: "x",
    locality: "local",
    transport: "native",
    capability: { ...initialCapability(), nativeRejected: true },
    contextWindow: 8192,
    contextWindowSource: "default",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  assert.match(describeTransport(rejected), /rejected/);
});

test("describeBreaker: open state counts down toward the cool-down, not backward", () => {
  const r = buildHealthRecord({
    endpointId: "x",
    model: "x",
    locality: "local",
    transport: "native",
    capability: initialCapability(),
    breaker: { state: "open", failures: 5, openedAt: 1_000 },
    contextWindow: 8192,
    contextWindowSource: "default",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  const justOpened = describeBreaker(r, 1_000, 30_000);
  const halfwayThrough = describeBreaker(r, 1_000 + 15_000, 30_000);
  assert.match(justOpened, /retry in ~30s/);
  assert.match(halfwayThrough, /retry in ~15s/);
});

test("describeBreaker: half-open reads as recovering, closed with prior failures reads as recovered", () => {
  const halfOpen = buildHealthRecord({
    endpointId: "x",
    model: "x",
    locality: "local",
    transport: "native",
    capability: initialCapability(),
    breaker: { state: "half-open", failures: 5, openedAt: 1_000 },
    contextWindow: 8192,
    contextWindowSource: "default",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  assert.match(describeBreaker(halfOpen, 5_000), /recovering/);

  const recovered = buildHealthRecord({
    endpointId: "x",
    model: "x",
    locality: "local",
    transport: "native",
    capability: initialCapability(),
    breaker: { state: "closed", failures: 2, openedAt: null },
    contextWindow: 8192,
    contextWindowSource: "default",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  assert.match(describeBreaker(recovered, 5_000), /healthy \(recovered\)/);
});

test("describeContextWindow: an unmeasured default is flagged, a measured/declared one is not", () => {
  const guessed = record();
  assert.match(describeContextWindow(guessed), /⚠ unmeasured/);

  const measured = buildHealthRecord({
    endpointId: "x",
    model: "x",
    locality: "local",
    transport: "native",
    capability: initialCapability(),
    contextWindow: 131_072,
    contextWindowSource: "ollama",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  assert.doesNotMatch(describeContextWindow(measured), /⚠/);
  assert.match(describeContextWindow(measured), /measured via ollama/);

  const declared = buildHealthRecord({
    endpointId: "x",
    model: "x",
    locality: "cloud",
    transport: "native",
    capability: initialCapability(),
    contextWindow: 200_000,
    contextWindowSource: "declared",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  assert.doesNotMatch(describeContextWindow(declared), /⚠/);
  assert.match(describeContextWindow(declared), /declared/);
});

test("formatHealthTable: empty input reads as 'nothing used yet', not a crash or a blank page", () => {
  const out = formatHealthTable([], Date.now());
  assert.match(out, /no endpoint has been used yet/);
});

test("formatHealthTable: most-recently-used endpoint sorts first", () => {
  const older = buildHealthRecord({
    endpointId: "a",
    model: "a",
    locality: "local",
    transport: "native",
    capability: initialCapability(),
    contextWindow: 8192,
    contextWindowSource: "default",
    nowIso: "2026-08-19T00:00:00.000Z",
  });
  const newer = buildHealthRecord({
    endpointId: "b",
    model: "b",
    locality: "local",
    transport: "native",
    capability: initialCapability(),
    contextWindow: 8192,
    contextWindowSource: "default",
    nowIso: "2026-08-19T01:00:00.000Z",
  });
  const out = formatHealthTable([older, newer], Date.now());
  const aIdx = out.indexOf("(a)");
  const bIdx = out.indexOf("(b)");
  assert.ok(bIdx !== -1 && aIdx !== -1 && bIdx < aIdx, "the newer record should print first");
});
