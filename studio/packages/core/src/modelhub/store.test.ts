import assert from "node:assert/strict";
/**
 * modelhub/store.test.ts — the framework-free Model Hub state layer (file 05 §1,§5,§7).
 *
 * Covers: EVERY edge of the §5 download-queue state machine (including the
 * block→quarantined TERMINAL sink and the verdict→event mapping that is the only
 * passive path to `admitted`, C5), the §8 concurrency-limit slot scheduling, the
 * library cache (upsert / modality index / remove / selectors), the §6 open-weight-
 * first sort-to-top, the §4.4 fit-rank ordering, and the §2.4 serve-profile status
 * machine + its selectors.
 */
import { test } from "node:test";

import type { Model, NemesisVerdictRef, ServeProfile } from "../domain/models.js";
import {
  type DownloadEvent,
  type DownloadState,
  type QuantFitRow,
  type ServeEvent,
  type ServeStatus,
  advance,
  advanceServeProfile,
  availableSlots,
  canDownloadTransition,
  canServeTransition,
  downloadTransition,
  enqueueDownload,
  fitRankSelector,
  initialDownloadQueueState,
  initialLibraryCacheState,
  initialServeProfilesState,
  isActiveDownload,
  isBlockedDownload,
  isFreeOpenWeight,
  isTerminalDownload,
  legalDownloadEvents,
  legalServeEvents,
  modalityBucket,
  removeDownload,
  removeFromLibrary,
  removeServeProfile,
  scanEventForVerdict,
  selectActiveDownloads,
  selectAllModels,
  selectByModality,
  selectInstalledModels,
  selectQuarantined,
  selectQueue,
  selectReadyServeProfiles,
  selectServeProfiles,
  selectStartable,
  serveProfilesForModel,
  serveTransition,
  sortOpenWeightFirst,
  upsertModels,
  upsertServeProfile,
} from "./store.js";

// ── §5 download queue: every edge in the flow ─────────────────────────────── //

const DL_EDGES: ReadonlyArray<[DownloadState, DownloadEvent, DownloadState]> = [
  // queued → staging (a slot opened)
  ["queued", "start", "staging"],
  // staging → scanning (bytes on disk) / blocked (sha256 mismatch)
  ["staging", "staged", "scanning"],
  ["staging", "checksumMismatch", "blocked"],
  // scanning → admitted | confirm | blocked (the nemesis verdict)
  ["scanning", "scanAllow", "admitted"],
  ["scanning", "scanWarn", "confirm"],
  ["scanning", "scanBlock", "blocked"],
  ["scanning", "scanError", "blocked"],
  ["scanning", "checksumMismatch", "blocked"],
  // confirm → admitted | blocked (the user's call on a warn item)
  ["confirm", "confirmAdmit", "admitted"],
  ["confirm", "confirmReject", "blocked"],
  // admitted (terminal) → queued only via a fresh retry
  ["admitted", "retry", "queued"],
  // blocked → quarantined (the §5 sink) | admitted (force) | scanning (rescan) | queued (retry)
  ["blocked", "quarantine", "quarantined"],
  ["blocked", "force", "admitted"],
  ["blocked", "rescan", "scanning"],
  ["blocked", "retry", "queued"],
  // quarantined (TERMINAL) → queued only via a fresh retry
  ["quarantined", "retry", "queued"],
];

test("download: every state-machine edge transitions exactly as specified", () => {
  for (const [from, event, to] of DL_EDGES) {
    assert.equal(downloadTransition(from, event), to, `${from} --${event}--> expected ${to}`);
    assert.equal(canDownloadTransition(from, event), true, `${from} --${event}-- should be legal`);
  }
});

test("download: block→quarantined is a TERMINAL sink (no passive escape to admitted)", () => {
  // The only events that leave `quarantined` are retry (re-enqueue) — never a
  // passive slide toward admitted/scanning.
  assert.equal(downloadTransition("quarantined", "scanAllow"), "quarantined");
  assert.equal(downloadTransition("quarantined", "force"), "quarantined");
  assert.equal(downloadTransition("quarantined", "rescan"), "quarantined");
  assert.equal(downloadTransition("quarantined", "confirmAdmit"), "quarantined");
  assert.equal(downloadTransition("quarantined", "retry"), "queued");
  assert.equal(isTerminalDownload("quarantined"), true);
  assert.equal(isBlockedDownload("quarantined"), true);
  // `blocked` itself is deep-red but escapable (quarantine/force/rescan/retry).
  assert.equal(isBlockedDownload("blocked"), true);
  assert.deepEqual(
    new Set(legalDownloadEvents("blocked")),
    new Set<DownloadEvent>(["quarantine", "force", "rescan", "retry"]),
  );
});

test("download: admitted is terminal-success; only retry re-enqueues it", () => {
  assert.equal(isTerminalDownload("admitted"), true);
  assert.equal(isBlockedDownload("admitted"), false);
  assert.equal(downloadTransition("admitted", "scanAllow"), "admitted");
  assert.equal(downloadTransition("admitted", "force"), "admitted");
  assert.equal(downloadTransition("admitted", "retry"), "queued");
});

test("download: illegal/unknown events are total NO-OPs (table never throws)", () => {
  const states: DownloadState[] = [
    "queued",
    "staging",
    "scanning",
    "confirm",
    "admitted",
    "blocked",
    "quarantined",
  ];
  const events: DownloadEvent[] = [
    "start",
    "staged",
    "scanAllow",
    "scanWarn",
    "scanBlock",
    "scanError",
    "checksumMismatch",
    "confirmAdmit",
    "confirmReject",
    "quarantine",
    "force",
    "rescan",
    "retry",
  ];
  for (const s of states) {
    for (const e of events) {
      const next = downloadTransition(s, e);
      // an event not in the table for this state must return the SAME state.
      if (!canDownloadTransition(s, e)) assert.equal(next, s, `${s} --${e}-- should be no-op`);
    }
  }
});

test("download: scanEventForVerdict maps the REAL nemesis verdict (fail-closed)", () => {
  assert.equal(scanEventForVerdict("allow"), "scanAllow");
  assert.equal(scanEventForVerdict("warn"), "scanWarn");
  assert.equal(scanEventForVerdict("block"), "scanBlock");
  assert.equal(scanEventForVerdict("error"), "scanError");
  // anything unexpected fails closed to scanError (→ blocked).
  assert.equal(scanEventForVerdict("nonsense" as NemesisVerdictRef["verdict"]), "scanError");
});

test("download: isActiveDownload only counts in-flight (staging|scanning)", () => {
  assert.equal(isActiveDownload("staging"), true);
  assert.equal(isActiveDownload("scanning"), true);
  for (const s of ["queued", "confirm", "admitted", "blocked", "quarantined"] as DownloadState[]) {
    assert.equal(isActiveDownload(s), false);
  }
});

// ── §5 queue reducers: enqueue / advance / remove / patches ───────────────── //

test("queue: enqueue is idempotent and FIFO-ordered", () => {
  let s = initialDownloadQueueState(2);
  s = enqueueDownload(s, { id: "a:q4", modelId: "a", quant: "q4_k_m" });
  s = enqueueDownload(s, { id: "b:q8", modelId: "b", quant: "q8_0", modality: "text" });
  // re-enqueueing an existing id is a no-op (no duplicate row, no seq bump).
  const before = s;
  s = enqueueDownload(s, { id: "a:q4", modelId: "a", quant: "q4_k_m" });
  assert.equal(s, before, "re-enqueue should return the same state object");
  const q = selectQueue(s);
  assert.deepEqual(
    q.map((i) => i.id),
    ["a:q4", "b:q8"],
  );
  assert.equal(q[0].state, "queued");
  assert.equal(q[1].modality, "text");
});

test("queue: advance applies the transition + records the patch verbatim", () => {
  let s = initialDownloadQueueState();
  s = enqueueDownload(s, { id: "m:q4", modelId: "m", quant: "q4_k_m" });
  s = advance(s, "m:q4", "start", { pct: 0, stagePath: "/stage/m" });
  assert.equal(s.items["m:q4"].state, "staging");
  assert.equal(s.items["m:q4"].stagePath, "/stage/m");
  s = advance(s, "m:q4", "staged", { pct: 100, sha256: "deadbeef" });
  assert.equal(s.items["m:q4"].state, "scanning");
  assert.equal(s.items["m:q4"].sha256, "deadbeef");
  // an allow verdict is the ONLY passive path to admitted.
  const verdict: NemesisVerdictRef = {
    verdict: "allow",
    score: 0,
    signedAt: "2026-01-01T00:00:00Z",
  };
  s = advance(s, "m:q4", scanEventForVerdict(verdict.verdict), { verdict, localPath: "/lib/m" });
  assert.equal(s.items["m:q4"].state, "admitted");
  assert.equal(s.items["m:q4"].localPath, "/lib/m");
  assert.equal(s.items["m:q4"].verdict?.verdict, "allow");
});

test("queue: a malicious staged dir blocks then quarantines (the §5 refuse path)", () => {
  let s = initialDownloadQueueState();
  s = enqueueDownload(s, { id: "bad:bin", modelId: "bad", quant: "q4_k_m" });
  s = advance(s, "bad:bin", "start");
  s = advance(s, "bad:bin", "staged");
  const verdict: NemesisVerdictRef = {
    verdict: "block",
    score: 99,
    signedAt: "2026-01-01T00:00:00Z",
    findingsRef: "report-1",
  };
  s = advance(s, "bad:bin", scanEventForVerdict(verdict.verdict), { verdict });
  assert.equal(s.items["bad:bin"].state, "blocked");
  // the §5 quarantine: keep the stage dir for inspection (terminal).
  s = advance(s, "bad:bin", "quarantine");
  assert.equal(s.items["bad:bin"].state, "quarantined");
  assert.deepEqual(
    selectQuarantined(s).map((i) => i.id),
    ["bad:bin"],
  );
});

test("queue: a fail-closed (error) scan blocks; force admits with a forced_danger record", () => {
  let s = initialDownloadQueueState();
  s = enqueueDownload(s, { id: "x:q4", modelId: "x", quant: "q4_k_m" });
  s = advance(s, "x:q4", "start");
  s = advance(s, "x:q4", "staged");
  // missing/timeout/unparseable nemesis => "error" => fail closed → blocked.
  s = advance(s, "x:q4", scanEventForVerdict("error"));
  assert.equal(s.items["x:q4"].state, "blocked");
  // a security-authorised force carries the forced_danger record.
  s = advance(s, "x:q4", "force", {
    forced: { label: "x:q4", verdict: "error", risk_score: 100, blocking_reasons: ["scan failed"] },
  });
  assert.equal(s.items["x:q4"].state, "admitted");
  assert.equal(s.items["x:q4"].forced?.verdict, "error");
});

test("queue: checksum mismatch during staging fails closed to blocked", () => {
  let s = initialDownloadQueueState();
  s = enqueueDownload(s, { id: "c:q4", modelId: "c", quant: "q4_k_m" });
  s = advance(s, "c:q4", "start");
  s = advance(s, "c:q4", "checksumMismatch", { sha256: "wrong" });
  assert.equal(s.items["c:q4"].state, "blocked");
});

test("queue: advance on an unknown id or illegal event is a no-op", () => {
  let s = initialDownloadQueueState();
  s = enqueueDownload(s, { id: "k:q4", modelId: "k", quant: "q4_k_m" });
  const before = s;
  assert.equal(advance(s, "nope", "start"), before, "unknown id is a no-op");
  // illegal event in `queued` (staged) leaves state unchanged.
  s = advance(s, "k:q4", "staged");
  assert.equal(s.items["k:q4"].state, "queued");
});

test("queue: removeDownload drops the row", () => {
  let s = initialDownloadQueueState();
  s = enqueueDownload(s, { id: "r:q4", modelId: "r", quant: "q4_k_m" });
  s = removeDownload(s, "r:q4");
  assert.equal(selectQueue(s).length, 0);
  assert.equal(removeDownload(s, "ghost"), s, "removing a ghost id is a no-op");
});

// ── §8 concurrency limit scheduling ───────────────────────────────────────── //

test("concurrency: availableSlots + selectStartable never exceed the limit", () => {
  let s = initialDownloadQueueState(2);
  for (const id of ["a", "b", "c", "d"]) {
    s = enqueueDownload(s, { id, modelId: id, quant: "q4_k_m" });
  }
  // four queued, two slots → exactly two startable (FIFO: a, b).
  assert.equal(availableSlots(s), 2);
  assert.deepEqual(
    selectStartable(s).map((i) => i.id),
    ["a", "b"],
  );
  // start them → slots full, nothing startable.
  s = advance(s, "a", "start");
  s = advance(s, "b", "start");
  assert.equal(selectActiveDownloads(s).length, 2);
  assert.equal(availableSlots(s), 0);
  assert.deepEqual(selectStartable(s), []);
  // one finishes (admitted) → frees a slot, next FIFO item (c) becomes startable.
  s = advance(s, "a", "staged");
  s = advance(s, "a", "scanAllow");
  assert.equal(availableSlots(s), 1);
  assert.deepEqual(
    selectStartable(s).map((i) => i.id),
    ["c"],
  );
});

test("concurrency: a clamped minimum of 1 slot is enforced", () => {
  const s = initialDownloadQueueState(0);
  assert.equal(s.concurrency, 1);
});

// ── library cache: upsert / modality index / remove / selectors ───────────── //

function mkModel(over: Partial<Model>): Model {
  return {
    id: over.id ?? "m",
    name: over.name ?? "M",
    family: over.family ?? "fam",
    kind: over.kind ?? "llm",
    subtype: over.subtype,
    paramsB: over.paramsB ?? 8,
    license: over.license ?? "apache-2.0",
    quants: over.quants ?? ["q4_k_m"],
    tags: over.tags ?? [],
    repo: over.repo ?? "org/repo",
    ...over,
  };
}

test("library: modalityBucket buckets llm as text, non-llm by subtype", () => {
  assert.equal(modalityBucket(mkModel({ kind: "llm" })), "text");
  assert.equal(modalityBucket(mkModel({ kind: "non-llm", subtype: "embedding" })), "embedding");
  assert.equal(modalityBucket(mkModel({ kind: "non-llm" })), "non-llm");
});

test("library: upsert indexes by id + modality, last-write-wins, installed marking", () => {
  let s = initialLibraryCacheState();
  s = upsertModels(s, [
    mkModel({ id: "t1", kind: "llm" }),
    mkModel({ id: "e1", kind: "non-llm", subtype: "embedding" }),
  ]);
  assert.equal(selectAllModels(s).length, 2);
  assert.deepEqual(
    selectByModality(s, "text").map((m) => m.id),
    ["t1"],
  );
  assert.deepEqual(
    selectByModality(s, "embedding").map((m) => m.id),
    ["e1"],
  );
  // last write wins for the same id.
  s = upsertModels(s, [mkModel({ id: "t1", kind: "llm", name: "T1-updated" })]);
  assert.equal(s.byId.t1.name, "T1-updated");
  assert.equal(selectAllModels(s).length, 2);
  // installed marking.
  assert.equal(selectInstalledModels(s).length, 0);
  s = upsertModels(s, [mkModel({ id: "t1", kind: "llm", name: "T1-updated" })], {
    markInstalled: true,
  });
  assert.deepEqual(
    selectInstalledModels(s).map((m) => m.id),
    ["t1"],
  );
});

test("library: removeFromLibrary drops id from map, index and installed list", () => {
  let s = initialLibraryCacheState();
  s = upsertModels(s, [mkModel({ id: "t1", kind: "llm" })], { markInstalled: true });
  s = upsertModels(s, [mkModel({ id: "t2", kind: "llm" })]);
  s = removeFromLibrary(s, "t1");
  assert.equal(s.byId.t1, undefined);
  assert.deepEqual(
    selectByModality(s, "text").map((m) => m.id),
    ["t2"],
  );
  assert.deepEqual(selectInstalledModels(s), []);
  assert.equal(removeFromLibrary(s, "ghost"), s, "removing a ghost id is a no-op");
});

// ── §6 open-weight-first sort ─────────────────────────────────────────────── //

test("openweight: isFreeOpenWeight matches permissive licenses, rejects restrictive", () => {
  assert.equal(isFreeOpenWeight(mkModel({ license: "apache-2.0" })), true);
  assert.equal(isFreeOpenWeight(mkModel({ license: "MIT" })), true);
  assert.equal(isFreeOpenWeight(mkModel({ license: "BSD-3-Clause" })), true);
  assert.equal(isFreeOpenWeight(mkModel({ license: "mpl-2.0" })), true);
  assert.equal(isFreeOpenWeight(mkModel({ license: "Apache 2.0" })), true); // space-normalised
  // restrictive / non-commercial / gated sort below free.
  assert.equal(isFreeOpenWeight(mkModel({ license: "cc-by-nc-4.0" })), false);
  assert.equal(isFreeOpenWeight(mkModel({ license: "llama-community" })), false);
  assert.equal(isFreeOpenWeight(mkModel({ license: "proprietary" })), false);
});

test("openweight: sortOpenWeightFirst floats free licenses to the top deterministically", () => {
  const models = [
    mkModel({ id: "z-nc", license: "cc-by-nc-4.0", tags: ["a", "b"] }),
    mkModel({ id: "a-free", license: "apache-2.0", tags: ["x"] }),
    mkModel({ id: "m-free", license: "mit", tags: ["x", "y", "z"] }),
    mkModel({ id: "p-prop", license: "proprietary", tags: [] }),
  ];
  const sorted = sortOpenWeightFirst(models);
  // free ones first; within free, more tags first (m-free has 3, a-free has 1).
  assert.deepEqual(
    sorted.map((m) => m.id),
    ["m-free", "a-free", "z-nc", "p-prop"],
  );
  // input is not mutated.
  assert.equal(models[0].id, "z-nc");
});

// ── §4.4 fit-rank ordering ────────────────────────────────────────────────── //

function fitRow(over: Partial<QuantFitRow>): QuantFitRow {
  return {
    label: over.label ?? "q4_k_m",
    fmt: over.fmt ?? "gguf",
    verdict: over.verdict ?? "FITS",
    qualityRank: over.qualityRank ?? 0.82,
    ratio: over.ratio ?? 0.3,
    runnable: over.runnable ?? true,
    ...over,
  };
}

test("fitRank: orders runnable-first, then FITS<TIGHT<PARTIAL<OVERFLOW, then quality DESC", () => {
  const rows = [
    fitRow({ label: "q3_k_m", verdict: "FITS", qualityRank: 0.62 }),
    fitRow({ label: "f16", verdict: "TIGHT", qualityRank: 1.0 }),
    fitRow({ label: "fp8", verdict: "FITS", qualityRank: 0.97, runnable: false, fmt: "fp8" }),
    fitRow({ label: "q8_0", verdict: "FITS", qualityRank: 0.99 }),
    fitRow({ label: "q4_k_m", verdict: "FITS", qualityRank: 0.82 }),
    fitRow({ label: "q2_k", verdict: "OVERFLOW", qualityRank: 0.4 }),
  ];
  const ranked = fitRankSelector(rows);
  // head is the §4.4 recommendation: highest-quality runnable FITS quant (q8_0).
  assert.equal(ranked[0].label, "q8_0");
  // ALL runnable quants sort before the caps-gated one: runnable FITS in quality
  // DESC (q8_0, q4_k_m, q3_k_m), then runnable TIGHT (f16), then runnable OVERFLOW
  // (q2_k); the unrunnable fp8 (FITS but caps-gated, §4.3) sinks dead last.
  assert.deepEqual(
    ranked.map((r) => r.label),
    ["q8_0", "q4_k_m", "q3_k_m", "f16", "q2_k", "fp8"],
  );
});

test("fitRank: GGUF tie-break wins when verdict + quality are equal", () => {
  const rows = [
    fitRow({ label: "awq-4bit", fmt: "awq", verdict: "FITS", qualityRank: 0.8 }),
    fitRow({ label: "q4_k_m", fmt: "gguf", verdict: "FITS", qualityRank: 0.8 }),
  ];
  const ranked = fitRankSelector(rows);
  assert.equal(ranked[0].fmt, "gguf");
});

// ── §2.4 serve-profile status machine ─────────────────────────────────────── //

const SERVE_EDGES: ReadonlyArray<[ServeStatus, ServeEvent, ServeStatus]> = [
  ["stopped", "start", "starting"],
  ["starting", "ready", "ready"],
  ["starting", "fail", "error"],
  ["starting", "stop", "stopped"],
  ["ready", "stop", "stopped"],
  ["ready", "crash", "error"],
  ["error", "retry", "starting"],
  ["error", "stop", "stopped"],
];

test("serve: every status-machine edge transitions as specified", () => {
  for (const [from, event, to] of SERVE_EDGES) {
    assert.equal(serveTransition(from, event), to, `${from} --${event}--> ${to}`);
    assert.equal(canServeTransition(from, event), true);
  }
});

test("serve: illegal events are NO-OPs; ready can't jump straight to stopped via start", () => {
  assert.equal(serveTransition("stopped", "ready"), "stopped");
  assert.equal(serveTransition("ready", "start"), "ready");
  assert.equal(serveTransition("ready", "ready"), "ready");
  assert.deepEqual(
    new Set(legalServeEvents("starting")),
    new Set<ServeEvent>(["ready", "fail", "stop"]),
  );
});

function mkProfile(over: Partial<ServeProfile>): ServeProfile {
  return {
    id: over.id ?? "p1",
    command: over.command ?? "llama-server",
    args: over.args,
    ...over,
  };
}

test("serve: upsert defaults to stopped, re-upsert keeps live status", () => {
  let s = initialServeProfilesState();
  s = upsertServeProfile(s, mkProfile({ id: "p1" }));
  assert.equal(s.byId.p1.status, "stopped");
  // bring it ready, then re-upsert (edit recipe) — live status survives.
  s = advanceServeProfile(s, "p1", "start");
  s = advanceServeProfile(s, "p1", "ready", { baseUrl: "http://127.0.0.1:8080/v1", pid: 42 });
  assert.equal(s.byId.p1.status, "ready");
  s = upsertServeProfile(s, mkProfile({ id: "p1", args: ["-ngl", "33"] }));
  assert.equal(s.byId.p1.status, "ready", "editing the recipe must not reset live status");
  assert.deepEqual(s.byId.p1.profile.args, ["-ngl", "33"]);
});

test("serve: advance records patches and clears lastError on leaving error", () => {
  let s = initialServeProfilesState();
  s = upsertServeProfile(s, mkProfile({ id: "p1" }));
  s = advanceServeProfile(s, "p1", "start");
  s = advanceServeProfile(s, "p1", "fail", { lastError: "spawn ENOENT" });
  assert.equal(s.byId.p1.status, "error");
  assert.equal(s.byId.p1.lastError, "spawn ENOENT");
  // retry → starting clears the stale error.
  s = advanceServeProfile(s, "p1", "retry");
  assert.equal(s.byId.p1.status, "starting");
  assert.equal(s.byId.p1.lastError, undefined);
  // unknown id is a no-op.
  assert.equal(advanceServeProfile(s, "ghost", "start"), s);
});

test("serve: selectors expose ready profiles + the §3 model-remove guard", () => {
  let s = initialServeProfilesState();
  s = upsertServeProfile(s, mkProfile({ id: "qwen3-8b-q4-llamacpp" }));
  s = upsertServeProfile(s, mkProfile({ id: "embed-bge" }));
  s = advanceServeProfile(s, "qwen3-8b-q4-llamacpp", "start");
  s = advanceServeProfile(s, "qwen3-8b-q4-llamacpp", "ready", {
    baseUrl: "http://127.0.0.1:8080/v1",
  });
  assert.deepEqual(
    selectServeProfiles(s).map((r) => r.profile.id),
    ["embed-bge", "qwen3-8b-q4-llamacpp"],
  );
  assert.deepEqual(
    selectReadyServeProfiles(s).map((r) => r.profile.id),
    ["qwen3-8b-q4-llamacpp"],
  );
  // the §3 remove guard: a profile id encoding the model blocks library removal.
  assert.equal(serveProfilesForModel(s, "qwen3-8b-q4").length, 1);
  assert.equal(serveProfilesForModel(s, "no-such-model").length, 0);
});

test("serve: removeServeProfile drops the row", () => {
  let s = initialServeProfilesState();
  s = upsertServeProfile(s, mkProfile({ id: "p1" }));
  s = removeServeProfile(s, "p1");
  assert.equal(selectServeProfiles(s).length, 0);
  assert.equal(removeServeProfile(s, "ghost"), s);
});
