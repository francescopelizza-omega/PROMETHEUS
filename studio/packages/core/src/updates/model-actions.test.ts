/**
 * model-actions.test.ts — pull-stream reading, action availability, and the deletion rule.
 *
 * The stream shapes come from ollama's own `api/types.go` / `server/routes.go` and from a live
 * 0.34.1 daemon probed on 2026-09-29. The cases that look pedantic are the ones that were
 * measured: absent (not zero) byte counters, an error line arriving after a 200, and per-digest
 * rather than cumulative progress.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTH_DESTRUCTIVE,
  AUTH_INSTALL,
  PullProgressTracker,
  actionsFor,
  honestReclaim,
  parsePullLine,
  pullBlockedReason,
  removalAction,
} from "./model-actions.js";
import type { ModelCheck, ModelUpdate } from "./model-registry.js";

/* ───────────────────────────── the pull stream ───────────────────────────── */

test("the six real phase lines parse, in the order ollama emits them", () => {
  assert.deepEqual(parsePullLine('{"status":"pulling manifest"}'), {
    kind: "status",
    status: "pulling manifest",
  });
  assert.deepEqual(
    parsePullLine(
      '{"status":"pulling 8934d96d3f08","digest":"sha256:8934","total":2142590208,"completed":241970}',
    ),
    {
      kind: "progress",
      status: "pulling 8934d96d3f08",
      digest: "sha256:8934",
      completed: 241970,
      total: 2142590208,
    },
  );
  assert.deepEqual(parsePullLine('{"status":"verifying sha256 digest"}'), {
    kind: "status",
    status: "verifying sha256 digest",
  });
  assert.deepEqual(parsePullLine('{"status":"writing manifest"}'), {
    kind: "status",
    status: "writing manifest",
  });
  assert.deepEqual(parsePullLine('{"status":"removing unused layers"}'), {
    kind: "status",
    status: "removing unused layers",
  });
  assert.deepEqual(parsePullLine('{"status":"success"}'), { kind: "success" });
});

test("an ERROR line is read as an error even when it also carries a status", () => {
  /**
   * `streamResponse()` appends `{"error":"…"}` to a stream that has ALREADY been committed as
   * HTTP 200. A reader that checks `res.ok` and ignores the body reports a successful download
   * of a model that is not on disk.
   */
  assert.deepEqual(parsePullLine('{"error":"pull model manifest: file does not exist"}'), {
    kind: "error",
    message: "pull model manifest: file does not exist",
  });
  assert.deepEqual(parsePullLine('{"status":"pulling manifest","error":"boom"}'), {
    kind: "error",
    message: "boom",
  });
});

test("`total` and `completed` are ABSENT, not zero, on the non-download lines", () => {
  /**
   * They are `omitempty` int64 in api/types.go. Defaulting them to 0 renders "0%" for four of
   * the six phases and a bar that lurches backwards when the first real layer line arrives.
   */
  const e = parsePullLine('{"status":"writing manifest"}');
  assert.equal(e?.kind, "status");
  assert.ok(!("total" in (e as object)));
  assert.ok(!("completed" in (e as object)));
});

test("a first layer line with no `total` is still progress, with total undefined", () => {
  const e = parsePullLine('{"status":"pulling abc","digest":"sha256:abc","completed":0}');
  assert.deepEqual(e, {
    kind: "progress",
    status: "pulling abc",
    digest: "sha256:abc",
    completed: 0,
  });
});

test("blank lines, junk and shapes with no meaning are null, never a phantom phase", () => {
  assert.equal(parsePullLine(""), null);
  assert.equal(parsePullLine("   "), null);
  assert.equal(parsePullLine("not json"), null);
  assert.equal(parsePullLine("[1,2,3]"), null);
  assert.equal(parsePullLine("null"), null);
  assert.equal(
    parsePullLine('{"digest":"sha256:x","completed":5}'),
    null,
    "no status = no meaning",
  );
  assert.equal(parsePullLine('{"error":"   "}'), null, "a blank error is not an error");
});

/* ───────────────────────────── progress folding ───────────────────────────── */

test("REGRESSION: progress is per-DIGEST, not a running sum", () => {
  /**
   * ollama re-sends each layer's `completed` as an ABSOLUTE figure on every tick. Adding them
   * produces a number that races past the total and a bar that fills several times over.
   */
  const t = new PullProgressTracker();
  const feed = (line: string) => {
    const e = parsePullLine(line);
    if (e) t.apply(e);
  };
  feed('{"status":"pulling a","digest":"sha256:a","total":100,"completed":50}');
  feed('{"status":"pulling a","digest":"sha256:a","total":100,"completed":90}');
  feed('{"status":"pulling b","digest":"sha256:b","total":100,"completed":10}');
  const s = t.snapshot();
  assert.equal(s.completed, 100, "90 + 10, not 50 + 90 + 10");
  assert.equal(s.total, 200);
  assert.equal(s.fraction, 0.5);
});

test("the fraction is UNDEFINED while any layer's total is unknown — never a fake 0%", () => {
  const t = new PullProgressTracker();
  t.apply({ kind: "progress", status: "pulling a", digest: "sha256:a", completed: 10, total: 100 });
  t.apply({ kind: "progress", status: "pulling b", digest: "sha256:b", completed: 5 });
  const s = t.snapshot();
  assert.equal(s.fraction, undefined, "a 0% that means 'don't know' reads as a stalled download");
  assert.equal(s.total, undefined);
  assert.equal(s.completed, 15);
});

test("before any layer appears, the phase is reported and no fraction is invented", () => {
  const t = new PullProgressTracker();
  t.apply({ kind: "status", status: "pulling manifest" });
  const s = t.snapshot();
  assert.equal(s.phase, "pulling manifest");
  assert.equal(s.completed, 0);
  assert.equal(s.fraction, undefined);
});

test("the fraction never exceeds 1, even if a layer over-reports", () => {
  const t = new PullProgressTracker();
  t.apply({ kind: "progress", status: "x", digest: "d", completed: 150, total: 100 });
  assert.equal(t.snapshot().fraction, 1);
});

/* ───────────────────────────── actions ───────────────────────────── */

const update = (over: Partial<ModelUpdate> = {}): ModelUpdate =>
  ({
    model: "qwen3.6:latest",
    ref: { registry: "registry.ollama.ai", namespace: "library", name: "qwen3.6", tag: "latest" },
    localDigest: "aaa",
    remoteDigest: "bbb",
    changed: true,
    remoteBytes: 22_621_314_161,
    delta: {},
    satisfiable: true,
    peakDiskBytes: 46_559_647_738,
    ...over,
  }) as ModelUpdate;

const ok = (u: ModelUpdate): ModelCheck => ({ ok: true, update: u });

test("a changed model offers a pull at the INSTALL rung, with the download size", () => {
  const a = actionsFor(ok(update()));
  const pull = a.find((x) => x.kind === "pull");
  assert.equal(pull?.minAuthLevel, AUTH_INSTALL);
  assert.equal(pull?.downloadBytes, 22_621_314_161);
  // The equivalent command is shown so nothing here is a black box the user cannot reproduce.
  assert.equal(pull?.equivalent, "ollama pull qwen3.6:latest");
});

test("an unchanged model offers no pull", () => {
  assert.equal(
    actionsFor(ok(update({ changed: false }))).some((a) => a.kind === "pull"),
    false,
  );
});

test("a build needing a newer daemon is BLOCKED, not silently offered", () => {
  /**
   * It would pull happily and then fail to load — having already replaced a model that worked
   * and spent 22 GB of bandwidth.
   */
  const u = update({ satisfiable: false, requiresOllama: "0.40.0" });
  const pull = actionsFor(ok(u)).find((a) => a.kind === "pull");
  assert.match(pull?.blocked ?? "", /needs ollama 0\.40\.0/);
  assert.match(pullBlockedReason(u), /upgrade the daemon first/);
});

test("a pull that would not fit is BLOCKED — peak disk is BOTH builds, not the download", () => {
  // A pull writes the new layers before the tag moves and the old ones are released.
  const u = update();
  assert.match(pullBlockedReason(u, 40e9), /not enough free disk/);
  assert.equal(pullBlockedReason(u, 60e9), "");
  // Unknown free space is not a refusal: refusing on a figure we failed to read is the worse error.
  assert.equal(pullBlockedReason(u), "");
});

test("the ACTIVE model is not offered to itself", () => {
  const a = actionsFor(ok(update()), { active: "qwen3.6:latest" });
  assert.equal(
    a.some((x) => x.kind === "use"),
    false,
  );
  assert.equal(
    actionsFor(ok(update()), { active: "other" }).some((x) => x.kind === "use"),
    true,
  );
});

test("a model that could not be checked offers nothing at all", () => {
  assert.deepEqual(actionsFor({ ok: false, model: "x", reason: "unreachable" }), []);
});

/* ───────────────────────────── the deletion rule ───────────────────────────── */

const L = (digest: string, size: number) => ({ digest, size });

test("a removal frees only the layers no surviving model references", () => {
  /**
   * Two tags of one family routinely share the bulk of their weight. Reporting the victim's full
   * size is the obvious, wrong number.
   */
  const v = honestReclaim({
    victim: "old:tag",
    victimLayers: [L("a", 10e9), L("shared", 5e9)],
    survivorLayers: [[L("shared", 5e9), L("c", 1e9)]],
    loaded: [],
  });
  assert.deepEqual(v, { honest: true, bytes: 10e9 });
});

test("EVERY survivor is subtracted — counting one when three remain over-reports", () => {
  const v = honestReclaim({
    victim: "old:tag",
    victimLayers: [L("a", 1e9), L("inB", 2e9), L("inC", 4e9)],
    survivorLayers: [[L("inB", 2e9)], [L("inC", 4e9)]],
    loaded: [],
  });
  assert.equal(v.bytes, 1e9);
});

test("REFUSED: the model is loaded right now", () => {
  /**
   * `GET /api/ps` is the only thing that knows. Deleting a resident model is a different
   * operation from the one the user agreed to.
   */
  const v = honestReclaim({
    victim: "qwen3.6:latest",
    victimLayers: [L("a", 10e9)],
    survivorLayers: [],
    loaded: ["qwen3.6:latest"],
  });
  assert.equal(v.honest, false);
  assert.match((v as { reason: string }).reason, /loaded right now/);
  assert.equal(v.bytes, 0);
});

test("REFUSED: the layers could not be read, so no number may be claimed", () => {
  /**
   * Local layer digests appear in NEITHER `/api/tags` NOR `/api/show` — measured against a live
   * 0.34.1 daemon. An implementation that computes this from an API response is computing it
   * from nothing, so an empty layer list must refuse rather than report 0.
   */
  const v = honestReclaim({
    victim: "x:1",
    victimLayers: [],
    survivorLayers: [[L("a", 1e9)]],
    loaded: [],
  });
  assert.equal(v.honest, false);
  assert.match((v as { reason: string }).reason, /could not be read/);
});

test("REFUSED: everything is shared, so the offer would free nothing", () => {
  const v = honestReclaim({
    victim: "x:1",
    victimLayers: [L("a", 5e9), L("b", 2e9)],
    survivorLayers: [[L("a", 5e9), L("b", 2e9)]],
    loaded: [],
  });
  assert.equal(v.honest, false);
  assert.match((v as { reason: string }).reason, /frees nothing/);
});

test("a layer with no digest is never counted as reclaimable", () => {
  const v = honestReclaim({
    victim: "x:1",
    victimLayers: [L("", 9e9), L("real", 1e9)],
    survivorLayers: [],
    loaded: [],
  });
  assert.equal(v.bytes, 1e9, "the unidentifiable layer cannot be proven unshared");
});

test("the removal action sits on the DESTRUCTIVE rung and carries its blocked reason", () => {
  const good = removalAction({
    victim: "x:1",
    victimLayers: [L("a", 3e9)],
    survivorLayers: [],
    loaded: [],
  });
  assert.equal(good.minAuthLevel, AUTH_DESTRUCTIVE);
  assert.equal(good.freesBytes, 3e9);
  assert.equal(good.blocked, undefined);
  assert.equal(good.equivalent, "ollama rm x:1");

  const bad = removalAction({
    victim: "x:1",
    victimLayers: [L("a", 3e9)],
    survivorLayers: [],
    loaded: ["x:1"],
  });
  assert.equal(bad.freesBytes, undefined, "a blocked action must not also advertise a saving");
  assert.ok(bad.blocked);
});

test("removal outranks a pull on the ladder — destructive is above install", () => {
  assert.ok(AUTH_DESTRUCTIVE > AUTH_INSTALL);
});
