/**
 * model-registry.test.ts — the upstream model-update check.
 *
 * The whole feature rests on ONE empirical claim: the SHA-256 of the manifest body the registry
 * serves is the same digest `/api/tags` reports for the installed model. If that is ever false,
 * every model looks permanently out of date and the feature becomes a nag that offers downloads
 * nobody needs. So the first test hashes REAL captured bytes and compares them to the digest
 * this machine's ollama actually reported — not to a value copied out of the same fixture.
 *
 * The rest of the file is mostly about refusing to overclaim. A changed digest is not proof of
 * a newer build (the live qwen3.6 case is SMALLER upstream), a build can require a newer ollama
 * than is installed, and deleting a superseded model frees only the layers the survivor does not
 * share. Each of those is a place where the obvious implementation is confidently wrong.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DIGEST_HEADER,
  type InstalledModel,
  type ManifestLayer,
  PUSH_TIME_HEADER,
  blobUrl,
  compareBuild,
  digestFromHeaders,
  formatModelRef,
  manifestDigest,
  manifestUrl,
  normalizeDigest,
  offerable,
  parseConfigBlob,
  parseManifest,
  parseModelRef,
  pushTimeFromHeaders,
  reclaimableAfterUpdate,
} from "./model-registry.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
/** Read as a STRING, exactly as a `fetch(...).text()` would hand it over. */
const fixture = (n: string): string => readFileSync(join(FIX, n), "utf8");

const GEMMA_MANIFEST = fixture("gemma4-12b.manifest.json");
const QWEN_MANIFEST = fixture("qwen3.6-latest.manifest.json");
const QWEN_CONFIG = fixture("qwen3.6-latest.config.json");
/**
 * The build that is INSTALLED, copied byte-exact from
 * `~/.ollama/models/manifests/registry.ollama.ai/library/qwen3.6/latest` on 2026-09-29. It
 * hashes to 07d35212591fc27746f0a317c975a6d68754fb38e9053d82e25f06057af28522 — the digest
 * `/api/tags` reports locally.
 *
 * `QWEN_MANIFEST` above is the OTHER half of the pair: the one the registry serves today
 * (096fdbd0…). Having both is what makes a same-tag reclaim measurable instead of assumed — and
 * the absence of this file is exactly why the old test compared a manifest to itself.
 *
 * NOTE for a future reader: local layer digests appear in NO ollama HTTP endpoint. Neither
 * `/api/tags` nor `/api/show` carries them, so this on-disk file is the only source.
 */
const QWEN_MANIFEST_INSTALLED = fixture("qwen3.6-latest.manifest.INSTALLED.json");

/**
 * What `/api/tags` reported on the machine these fixtures were captured from, 2026-09-28.
 * Transcribed from the daemon, NOT computed from the fixture — that is the point of the test
 * below. `gemma4:12b` was up to date; `qwen3.6:latest` had an update waiting.
 */
const LOCAL_GEMMA_DIGEST = "4eb23ef187e2c5462566d6a1d3bbbc2f1346d0b4327cbb66d58fffbcc9b2b05c";
const LOCAL_QWEN_DIGEST = "07d35212591fc27746f0a317c975a6d68754fb38e9053d82e25f06057af28522";

/* ── the claim the whole feature rests on ───────────────────────────────────────────────────*/

test("sha256 of the served manifest IS the digest ollama reports — no pull needed", () => {
  // If this ever fails, the check cannot work at all: every model would read as changed.
  assert.equal(manifestDigest(GEMMA_MANIFEST), LOCAL_GEMMA_DIGEST);
});

test("and it correctly reports a model that is genuinely BEHIND", () => {
  // qwen3.6:latest, same machine, same moment: the tag had moved upstream.
  assert.notEqual(manifestDigest(QWEN_MANIFEST), LOCAL_QWEN_DIGEST);
  assert.equal(
    manifestDigest(QWEN_MANIFEST),
    "096fdbd02fe620fc10cbeb6537e080f8041aece851e5d696aed024d4f70f2e47",
  );
});

/**
 * The digest is of the RAW BYTES, and today that is true BY ACCIDENT as much as by design.
 *
 * The obvious implementation is `JSON.stringify(await res.json())`, and right now it would work:
 * the registry serves minified JSON with no spaces, and `JSON.parse`/`JSON.stringify` preserves
 * insertion order for non-numeric keys, so the round trip happens to reproduce the bytes exactly.
 * I wrote this test expecting to prove the opposite and the first assertion refused — which is
 * the more useful result, because it means the safety here rests on a formatting choice made by
 * someone else's server.
 *
 * The day that server pretty-prints, adds a field, or reorders one, every model on every machine
 * reads as out of date at once. So the contract is "hash what came off the wire", and this pins
 * both halves: the round trip is a no-op on the real body (documented, not relied on), and any
 * reformatting at all changes the digest.
 */
test("the digest is of the RAW BYTES — any reformatting changes it", () => {
  const roundTrip = JSON.stringify(JSON.parse(GEMMA_MANIFEST));
  assert.equal(
    roundTrip,
    GEMMA_MANIFEST,
    "the registry currently serves minified JSON — if this ever fails, re-read the comment above",
  );

  // What actually breaks it: whitespace the server could add at any time.
  const pretty = JSON.stringify(JSON.parse(GEMMA_MANIFEST), null, 2);
  assert.notEqual(
    manifestDigest(pretty),
    LOCAL_GEMMA_DIGEST,
    "pretty-printing must change the digest",
  );

  // ...and a single trailing newline, which is what a naive file-based fixture or a shell
  // pipeline adds without anyone noticing.
  assert.notEqual(manifestDigest(`${GEMMA_MANIFEST}\n`), LOCAL_GEMMA_DIGEST);
});

test("a Buffer and the equivalent string hash identically", () => {
  assert.equal(manifestDigest(Buffer.from(GEMMA_MANIFEST, "utf8")), manifestDigest(GEMMA_MANIFEST));
});

/* ── digest normalisation: the other way to make everything look changed ────────────────────*/

test("normalizeDigest reconciles ollama's bare hex with the registry's sha256: prefix", () => {
  const bare = LOCAL_GEMMA_DIGEST;
  assert.equal(normalizeDigest(bare), bare);
  assert.equal(normalizeDigest(`sha256:${bare}`), bare);
  assert.equal(normalizeDigest(`SHA256:${bare.toUpperCase()}`), bare);
  assert.equal(normalizeDigest(`  ${bare}  `), bare);
});

test("normalizeDigest returns '' for anything that is not a digest, and '' never matches", () => {
  // Returning the input unchanged would make two unparseable values compare EQUAL, which reads
  // as "up to date" — the dangerous direction. An empty string is compared explicitly below.
  for (const bad of ["", "sha256:", "nope", "12345", `sha512:${"a".repeat(64)}`, undefined]) {
    assert.equal(normalizeDigest(bad as string | undefined), "");
  }
  assert.equal(normalizeDigest(`zz${"a".repeat(62)}`), "", "non-hex is rejected");
});

/* ── reference parsing: this goes into a URL ────────────────────────────────────────────────*/

test("parseModelRef resolves the forms ollama actually produces", () => {
  assert.deepEqual(parseModelRef("gemma4:12b"), {
    registry: "registry.ollama.ai",
    namespace: "library",
    name: "gemma4",
    tag: "12b",
  });
  assert.deepEqual(parseModelRef("qwen3.6"), {
    registry: "registry.ollama.ai",
    namespace: "library",
    name: "qwen3.6",
    tag: "latest",
  });
  // two parts is namespace/name — NOT host/name, which is how ollama reads it
  assert.deepEqual(parseModelRef("someuser/custom:q4"), {
    registry: "registry.ollama.ai",
    namespace: "someuser",
    name: "custom",
    tag: "q4",
  });
  assert.deepEqual(parseModelRef("hf.co/user/model:Q8_0"), {
    registry: "hf.co",
    namespace: "user",
    name: "model",
    tag: "Q8_0",
  });
});

test("a port in the host is not mistaken for the tag", () => {
  // The tag separator is the last ':' AFTER the last '/'. Without that rule
  // `localhost:5000/ns/m` parses as the model `localhost` at tag `5000/ns/m`.
  const r = parseModelRef("localhost:5000/ns/m:v2");
  assert.deepEqual(r, { registry: "localhost:5000", namespace: "ns", name: "m", tag: "v2" });
  const noTag = parseModelRef("localhost:5000/ns/m");
  assert.equal(noTag?.tag, "latest");
  assert.equal(noTag?.registry, "localhost:5000");
});

test("parseModelRef REFUSES anything that could rewrite the request path", () => {
  // These are interpolated straight into a URL. A `..` segment or a stray slash would escape the
  // manifests path entirely.
  for (const bad of [
    "../../etc/passwd",
    "library/../../x:latest",
    "gemma4:../../v2",
    "a/b/c/d",
    "/leading",
    "trailing/",
    "a//b",
    "gemma4:",
    "",
    "   ",
    ".hidden",
    "-dash",
    "gemma4:tag with space",
    "gemma4:tag/slash",
    `x${"y".repeat(600)}`,
  ]) {
    assert.equal(parseModelRef(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test("formatModelRef round-trips, and elides the defaults a user would not type", () => {
  for (const s of ["gemma4:12b", "someuser/custom:q4", "hf.co/user/model:Q8_0"]) {
    assert.equal(formatModelRef(parseModelRef(s) as never), s);
  }
  assert.equal(formatModelRef(parseModelRef("qwen3.6") as never), "qwen3.6:latest");
});

test("the URLs are built only from validated segments", () => {
  const r = parseModelRef("gemma4:12b") as never;
  assert.equal(manifestUrl(r), "https://registry.ollama.ai/v2/library/gemma4/manifests/12b");
  const d = `sha256:${"a".repeat(64)}`;
  assert.equal(blobUrl(r, d), `https://registry.ollama.ai/v2/library/gemma4/blobs/${d}`);
  // a malformed digest must not reach the URL
  for (const bad of ["sha256:xyz", "../../x", "", `sha256:${"a".repeat(63)}`]) {
    assert.equal(blobUrl(r, bad), null, `${bad} must not build a blob URL`);
  }
});

/* ── manifest + config parsing ──────────────────────────────────────────────────────────────*/

test("parseManifest reads the real qwen manifest", () => {
  const m = parseManifest(QWEN_MANIFEST);
  assert.ok(m);
  assert.equal(m.digest, manifestDigest(QWEN_MANIFEST));
  assert.equal(m.layers.length, 4);
  assert.match(m.configDigest, /^sha256:[0-9a-f]{64}$/);
  // 21.718 GB model + 0.903 GB projector + two tiny blobs, as served
  assert.ok(m.totalBytes > 22e9 && m.totalBytes < 23e9, `totalBytes was ${m.totalBytes}`);
  assert.ok(m.layers.some((l) => l.mediaType === "application/vnd.ollama.image.model"));
});

test("parseManifest is fail-soft on everything a background check can actually receive", () => {
  // A 404 body, a proxy's HTML error page, a truncated response, an empty body. None of these
  // may throw inside a startup task.
  for (const body of [
    '{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}',
    "<html><body>502 Bad Gateway</body></html>",
    '{"schemaVersion":2,"layers":',
    "",
    "null",
    "[]",
    '{"schemaVersion":2}',
  ]) {
    assert.equal(parseManifest(body), null, `${body.slice(0, 30)} must parse to null`);
  }
});

test("a layer with a missing or absurd size counts as zero rather than NaN", () => {
  // One NaN in a reduce poisons totalBytes, and `NaN <= free` is false — so a single malformed
  // layer would silently make every update look like it does not fit.
  const m = parseManifest(
    '{"schemaVersion":2,"config":{"digest":"sha256:aa"},"layers":[{"mediaType":"x","digest":"sha256:bb"},{"mediaType":"y","digest":"sha256:cc","size":-5},{"mediaType":"z","digest":"sha256:dd","size":100}]}',
  );
  assert.ok(m);
  assert.equal(m.totalBytes, 100);
  assert.ok(Number.isFinite(m.totalBytes));
});

test("parseConfigBlob reads the quantisation, the parameter count and the ollama floor", () => {
  const c = parseConfigBlob(QWEN_CONFIG);
  assert.equal(c.fileType, "Q4_K_M");
  assert.equal(c.modelType, "35.5B");
  assert.equal(c.family, "qwen35moe");
  assert.equal(c.requiresOllama, "0.30.0");
});

test("parseConfigBlob returns {} rather than throwing on junk", () => {
  for (const body of ["", "not json", "null", "[]", '{"file_type":""}']) {
    assert.deepEqual(parseConfigBlob(body), {}, `${body} should yield no fields`);
  }
});

/* ── the comparison ─────────────────────────────────────────────────────────────────────────*/

const qwenLocal: InstalledModel = {
  name: "qwen3.6:latest",
  digest: LOCAL_QWEN_DIGEST,
  size: 23_940_000_000,
  quantization: "Q4_K_M",
  parameterSize: "36.0B",
};
const qwenRemote = {
  manifest: parseManifest(QWEN_MANIFEST) as never,
  config: parseConfigBlob(QWEN_CONFIG),
};

test("the live case: qwen3.6 reads as CHANGED, and the new build is SMALLER", () => {
  const u = compareBuild(qwenLocal, qwenRemote, "0.34.1");
  assert.ok(u);
  assert.equal(u.changed, true);
  assert.equal(u.localDigest, LOCAL_QWEN_DIGEST);
  // The honesty check. "Newer" would be a guess; "smaller and differently shaped" is measured.
  assert.ok((u.delta.sizeDelta ?? 0) < 0, `expected a negative delta, got ${u.delta.sizeDelta}`);
  assert.deepEqual(u.delta.parameters, { from: "36.0B", to: "35.5B" });
  assert.equal(
    u.delta.quantization,
    undefined,
    "the quantisation did NOT move; do not claim it did",
  );
});

test("an up-to-date model is not 'changed', whichever way the digest is spelled", () => {
  const local: InstalledModel = { name: "gemma4:12b", digest: `sha256:${LOCAL_GEMMA_DIGEST}` };
  const u = compareBuild(local, {
    manifest: parseManifest(GEMMA_MANIFEST) as never,
    config: {},
  });
  assert.ok(u);
  assert.equal(u.changed, false, "the sha256: prefix must not read as a difference");
});

test("an unreadable digest on either side is never reported as changed", () => {
  // The safe direction: a model we cannot compare is left alone, not offered as an update.
  const u = compareBuild({ name: "gemma4:12b", digest: "" }, qwenRemote);
  assert.ok(u);
  assert.equal(u.changed, false);
});

test("a build that needs a NEWER ollama than is installed is flagged unsatisfiable", () => {
  // It would pull happily and then fail to load, having spent the bandwidth and replaced a
  // model that worked.
  assert.equal(compareBuild(qwenLocal, qwenRemote, "0.34.1")?.satisfiable, true);
  assert.equal(compareBuild(qwenLocal, qwenRemote, "0.30.0")?.satisfiable, true, "equal satisfies");
  assert.equal(compareBuild(qwenLocal, qwenRemote, "0.29.9")?.satisfiable, false);
  assert.equal(compareBuild(qwenLocal, qwenRemote, "0.4.0")?.satisfiable, false, "0.4 < 0.30");
});

test("an UNKNOWN ollama version is satisfiable — a failed read is not evidence of an old one", () => {
  assert.equal(compareBuild(qwenLocal, qwenRemote, undefined)?.satisfiable, true);
  assert.equal(compareBuild(qwenLocal, qwenRemote, "")?.satisfiable, true);
  assert.equal(compareBuild(qwenLocal, qwenRemote, "not-a-version")?.satisfiable, true);
});

test("peak disk is BOTH builds, not the download — a pull writes before it releases", () => {
  const u = compareBuild(qwenLocal, qwenRemote, "0.34.1");
  assert.ok(u);
  assert.equal(u.peakDiskBytes, (qwenLocal.size as number) + u.remoteBytes);
  assert.ok(u.peakDiskBytes > u.remoteBytes, "checking the download size alone under-reserves");
});

test("a model whose ref cannot be parsed is not compared at all", () => {
  assert.equal(compareBuild({ name: "../evil", digest: LOCAL_QWEN_DIGEST }, qwenRemote), null);
});

/* ── what gets OFFERED ──────────────────────────────────────────────────────────────────────*/

test("offerable refuses an unchanged, an unsatisfiable, or an oversized update", () => {
  const u = compareBuild(qwenLocal, qwenRemote, "0.34.1") as never;
  assert.equal(offerable(u), true);
  assert.equal(offerable(u, u.peakDiskBytes + 1), true, "just enough room is enough");
  assert.equal(offerable(u, u.peakDiskBytes - 1), false, "would fill the volume mid-pull");
  assert.equal(offerable(u, 0), true, "an unknown/zero free figure must not block the offer");

  const stale = compareBuild(qwenLocal, qwenRemote, "0.1.0") as never;
  assert.equal(offerable(stale), false, "needs a newer ollama");

  const same = compareBuild(
    { name: "gemma4:12b", digest: LOCAL_GEMMA_DIGEST },
    { manifest: parseManifest(GEMMA_MANIFEST) as never, config: {} },
  ) as never;
  assert.equal(offerable(same), false, "nothing changed");
});

/* ── the disk saving, which is the easiest number to get wrong ──────────────────────────────*/

const L = (digest: string, size: number): ManifestLayer => ({ mediaType: "m", digest, size });

test("reclaimable counts only the layers the survivor does NOT share", () => {
  // Two tags of one family routinely share most of their weight. Reporting the victim's full
  // size as the saving is the obvious, wrong number.
  const victim = [L("sha256:a", 10e9), L("sha256:shared", 5e9), L("sha256:b", 1e9)];
  const keep = [L("sha256:shared", 5e9), L("sha256:c", 12e9)];
  assert.equal(reclaimableAfterUpdate(victim, [keep]), 11e9);
});

test("EVERY surviving manifest is subtracted, not just one", () => {
  /**
   * The signature took a single `keep`, which is only correct on a machine with exactly two
   * models. With three installed, deleting A while B and C remain counted every layer A shares
   * with C as reclaimable — an over-report, in the direction that promises the user disk space
   * they will not get back.
   */
  const victim = [L("sha256:a", 1e9), L("sha256:inB", 2e9), L("sha256:inC", 4e9)];
  const b = [L("sha256:inB", 2e9)];
  const c = [L("sha256:inC", 4e9)];
  assert.equal(reclaimableAfterUpdate(victim, [b, c]), 1e9);
  // Counting only B would have claimed 5 GB — the old behaviour, and wrong by 4 GB.
  assert.equal(reclaimableAfterUpdate(victim, [b]), 5e9);
});

test("REGRESSION: a same-tag update does NOT reclaim zero — the old test proved nothing", () => {
  /**
   * This test asserted `reclaimableAfterUpdate(layers, layers) === 0` and called that "a SAME-TAG
   * update reclaims nothing". Passing the SAME manifest as both arguments is trivially zero and
   * says nothing about a same-tag update: the two builds of one tag are DIFFERENT manifests.
   *
   * Measured live on 2026-09-29 against both real qwen3.6:latest manifests — the installed one
   * and the one the tag now resolves to — the answer is 23.94 GB, sharing exactly one blob (the
   * licence). The doc comment on the function said 0, and was wrong.
   */
  const installed = parseManifest(QWEN_MANIFEST_INSTALLED) as NonNullable<
    ReturnType<typeof parseManifest>
  >;
  const upstream = parseManifest(QWEN_MANIFEST) as NonNullable<ReturnType<typeof parseManifest>>;
  const freed = reclaimableAfterUpdate(installed.layers, [upstream.layers]);
  assert.equal(freed, 23_938_321_758);
  assert.notEqual(freed, 0);

  // Exactly one blob is shared between the two builds: the 11,357-byte licence.
  const shared = installed.layers.filter((l) => upstream.layers.some((u) => u.digest === l.digest));
  assert.equal(shared.length, 1);
  assert.equal(shared[0]?.size, 11_357);

  /**
   * …and the number still justifies NO user-facing offer. On a same-tag pull ollama releases the
   * superseded layers itself — the capture machine had served five pulls and carried zero orphan
   * blobs against nine references. The bytes are real; a "delete the old model to save space"
   * button would be claiming credit for work ollama already did.
   */
});

test("a layer with no digest is never counted as reclaimable", () => {
  // An unidentifiable layer cannot be proven unshared, and over-reporting the saving is the
  // direction that disappoints.
  assert.equal(reclaimableAfterUpdate([L("", 9e9)], []), 0);
});

/* ── the HEAD path: the digest without downloading anything ─────────────────────────────────*/

/** A `Headers.get`-shaped lookup over a plain object, lowercased like the wire. */
const hdrs =
  (o: Record<string, string>) =>
  (name: string): string | null =>
    o[name.toLowerCase()] ?? null;

test("a HEAD response yields the digest directly — no body, no hashing", () => {
  // Verified live: HEAD /v2/library/qwen3.6/manifests/latest returns this header, and its value
  // is identical to the SHA-256 of the body a GET returns. That makes the routine check free.
  const h = hdrs({
    [DIGEST_HEADER]: "096fdbd02fe620fc10cbeb6537e080f8041aece851e5d696aed024d4f70f2e47",
  });
  assert.equal(digestFromHeaders(h), manifestDigest(QWEN_MANIFEST));
});

test("digestFromHeaders normalises, and is '' when the header is missing or junk", () => {
  assert.equal(
    digestFromHeaders(hdrs({ [DIGEST_HEADER]: `sha256:${LOCAL_GEMMA_DIGEST}` })),
    LOCAL_GEMMA_DIGEST,
  );
  assert.equal(
    digestFromHeaders(hdrs({})),
    "",
    "a proxy that strips it must fall back to GET, not compare ''",
  );
  assert.equal(digestFromHeaders(hdrs({ [DIGEST_HEADER]: "garbage" })), "");
});

test("push time is SECONDS on the wire and MILLISECONDS in the code", () => {
  // The bug this exists to stop: treating the header as ms puts every push in 1970, which makes
  // every remote build look OLDER than the local copy — silently inverting the one comparison
  // the value exists for, in the direction that never shows an update.
  const live = pushTimeFromHeaders(hdrs({ [PUSH_TIME_HEADER]: "1787610369" }));
  assert.equal(live, 1_787_610_369_000);
  assert.ok((live as number) > Date.parse("2026-01-01"), "a seconds/ms mix-up lands in 1970");
});

test("push time rejects anything outside a plausible range rather than guessing", () => {
  for (const bad of ["", "   ", "abc", "0", "-1", "1787610369000", "99999999999999"]) {
    assert.equal(pushTimeFromHeaders(hdrs({ [PUSH_TIME_HEADER]: bad })), undefined, `"${bad}"`);
  }
  assert.equal(pushTimeFromHeaders(hdrs({})), undefined);
});

/* ── "newer" vs merely "changed" ────────────────────────────────────────────────────────────*/

test("NEWER is claimed only when both timestamps are readable", () => {
  const withTime = (pushedAt?: number, modifiedAt?: string) =>
    compareBuild(
      { ...qwenLocal, ...(modifiedAt !== undefined ? { modifiedAt } : {}) },
      { ...qwenRemote, ...(pushedAt !== undefined ? { pushedAt } : {}) },
      "0.34.1",
    );

  // both known, remote later → newer
  assert.equal(withTime(Date.parse("2026-09-01"), "2026-07-24T05:25:11Z")?.newer, true);
  // both known, remote EARLIER → explicitly not newer (a rollback, which is real)
  assert.equal(withTime(Date.parse("2026-01-01"), "2026-07-24T05:25:11Z")?.newer, false);
  // either side missing → UNKNOWN, never false. The header is undocumented and often absent.
  assert.equal(withTime(undefined, "2026-07-24T05:25:11Z")?.newer, undefined);
  assert.equal(withTime(Date.parse("2026-09-01"), undefined)?.newer, undefined);
  assert.equal(withTime(Date.parse("2026-09-01"), "not a date")?.newer, undefined);
});

test("an unknown 'newer' never suppresses a change that is real", () => {
  // The safety property: the timestamp only decides the WORD used, never whether to offer.
  const u = compareBuild(qwenLocal, qwenRemote, "0.34.1");
  assert.equal(u?.newer, undefined);
  assert.equal(u?.changed, true);
  assert.equal(offerable(u as never), true);
});
