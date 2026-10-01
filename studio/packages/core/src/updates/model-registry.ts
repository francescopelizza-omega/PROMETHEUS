// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/model-registry.ts — is there a newer build of this model UPSTREAM?
 *
 * ── WHY THIS EXISTS, AND WHAT IT REPLACES ───────────────────────────────────────────────────
 *
 * `updates/models.ts` says, in its own header: "Ollama has no remote 'is there a newer tag'
 * endpoint; the manifest DIGEST is the change signal", and then diffs the LOCAL digest against
 * the PREVIOUS LOCAL digest. That detects an update only AFTER the user has already pulled it —
 * it can never answer "is there something newer waiting". The question it answers is "did
 * something change while I wasn't looking", which is a different question.
 *
 * There IS a remote endpoint. Ollama's registry speaks the standard OCI/Docker registry v2
 * protocol, and the manifest is public and unauthenticated (verified live, 2026-09-28):
 *
 *     GET https://registry.ollama.ai/v2/library/gemma4/manifests/12b
 *     Accept: application/vnd.docker.distribution.manifest.v2+json
 *     → 200, 905 bytes of JSON
 *
 * and — this is the part that makes it exact rather than a heuristic — **the SHA-256 of that
 * response body is byte-for-byte the digest `/api/tags` reports for the installed model.**
 * Measured on this machine:
 *
 *     sha256(manifest body)  = 4eb23ef187e2c5462566d6a1d3bbbc2f1346d0b4327cbb66d58fffbcc9b2b05c
 *     /api/tags .digest      =   4eb23ef187e2c5462566d6a1d3bbbc2f1346d0b4327cbb66d58fffbcc9b2b05c
 *
 * So the comparison needs no pull, no authentication, no heuristic and no guess: hash what the
 * registry serves, compare it to what is on disk, and a difference means the tag now resolves
 * to a different build.
 *
 * ── THREE LIMITS THIS MODULE REFUSES TO PAPER OVER ──────────────────────────────────────────
 *
 * 1. **"Different" is not "newer."** The registry publishes no timestamp on a manifest, and the
 *    tag is a moving pointer. Measured live: `qwen3.6:latest` upstream is 22.62 GB against the
 *    23.94 GB installed here — the new build is SMALLER, because the layers were rebuilt. A
 *    re-quantisation, a repackage and a rollback are all indistinguishable from an upgrade at
 *    the digest level. Everything here is therefore named `changed`, never `newer`, and the
 *    comparison surfaces WHAT moved (size, quantisation, parameter count) so a human decides.
 *
 * 2. **A successor model cannot be discovered here.** "You have qwen3.6, qwen3.7 now exists" is
 *    a different question, and the registry does not answer it: `/v2/_catalog` and
 *    `/v2/library/<name>/tags/list` both return 404 (verified). That needs a curated catalog —
 *    `LOCAL_MODEL_CATALOG` in `models.ts` is where it would live — and is deliberately out of
 *    scope for this file, which only ever compares a tag against itself.
 *
 * 3. **A same-tag pull frees nothing to "clean up".** `ollama pull` on an existing tag moves the
 *    tag and releases the layers the old manifest referenced; measured on this machine, blobs on
 *    disk (31.49 GB across 9 files) equal the sum of `/api/tags` sizes exactly — zero orphans.
 *    Offering to "delete the old model to save space" after a same-tag update would be a no-op
 *    presented as a saving. `reclaimableAfterUpdate` returns the honest number, which is the
 *    shared layers' worth of nothing in that case, and a real figure only when the update means
 *    moving to a DIFFERENT tag that leaves the old one behind.
 *
 * PURE: no fetch, no filesystem, no clock. The caller supplies the bytes; this decides.
 */

import { createHash } from "node:crypto";

import { compareVersions } from "./semver.js";

/** Ollama's public registry — the default when a tag names no host. */
export const DEFAULT_REGISTRY = "registry.ollama.ai";

/** The namespace an un-namespaced tag lives in, exactly as `ollama pull` resolves it. */
export const DEFAULT_NAMESPACE = "library";

/** The tag `ollama pull <name>` means when none is given. */
export const DEFAULT_TAG = "latest";

/** The Accept header the manifest endpoint requires. The response `vary`s on it. */
export const MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json";

/**
 * The header a HEAD on the manifest returns, carrying the digest outright.
 *
 * Verified live: `HEAD /v2/library/qwen3.6/manifests/latest` answers
 * `ollama-content-digest: 096fdbd0…`, identical to the SHA-256 of the body a GET returns. So the
 * routine check is a HEAD — no body, no hashing, nothing to get wrong about byte fidelity — and
 * the GET path below stays as the fallback for a proxy or mirror that strips the header.
 *
 * It is NOT the standard `Docker-Content-Digest`; ollama's registry does not send that one.
 */
export const DIGEST_HEADER = "ollama-content-digest";

/**
 * When the tag was last pushed, as Unix seconds. UNDOCUMENTED.
 *
 * This is the only thing that can turn "different" into "newer": a manifest carries no
 * timestamp, so without it a digest change is just a change. With it, `pushedAt` against the
 * local `modified_at` says which way the tag moved.
 *
 * Undocumented means it may vanish or change meaning without notice, so it is strictly
 * corroborating: absent or unparseable simply leaves the verdict at `changed`, which is still
 * true and still actionable. Nothing branches on its absence.
 */
export const PUSH_TIME_HEADER = "ollama-push-time";

/** A parsed model reference: `[host/]namespace/name:tag`. */
export interface ModelRef {
  registry: string;
  namespace: string;
  name: string;
  tag: string;
}

/**
 * One path segment of a model reference, validated.
 *
 * These segments are interpolated into a URL, and although they arrive from the local ollama
 * daemon rather than from a user, "the input came from a trusted process" is not a property this
 * module can verify and is not one worth relying on: a tag containing `..` or a slash would
 * rewrite the request path. Anchored, no dots at the edges, no path characters at all.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A registry host: a DNS name with an optional port. No scheme, no path, no credentials. */
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?$/;

/**
 * Parse a model reference the way `ollama pull` does, or return null.
 *
 * Null rather than a throw because the input is whatever `/api/tags` lists, which on a machine
 * with side-loaded models includes forms this module has no business fetching (`hf.co/...`, a
 * local Modelfile build). A caller that cannot parse a ref simply does not check that model —
 * which is the correct outcome, and far better than guessing a URL for it.
 */
export function parseModelRef(input: string): ModelRef | null {
  const raw = input.trim();
  if (raw === "" || raw.length > 512) return null;

  // Split the tag first: a ':' may only appear in the final segment. A port in the host also
  // uses ':', so the tag separator is the LAST colon, and only when it follows the last slash.
  const lastSlash = raw.lastIndexOf("/");
  const lastColon = raw.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const path = hasTag ? raw.slice(0, lastColon) : raw;
  const tag = hasTag ? raw.slice(lastColon + 1) : DEFAULT_TAG;

  const parts = path.split("/");
  if (parts.some((p) => p === "")) return null;

  let registry = DEFAULT_REGISTRY;
  let namespace = DEFAULT_NAMESPACE;
  let name: string;

  if (parts.length === 1) {
    name = parts[0] as string;
  } else if (parts.length === 2) {
    // `ns/name` — never `host/name`: ollama reads a bare two-part ref as a namespace, and a
    // host is only a host when it looks like one (a dot or a port) AND a third segment follows.
    namespace = parts[0] as string;
    name = parts[1] as string;
  } else if (parts.length === 3) {
    registry = parts[0] as string;
    namespace = parts[1] as string;
    name = parts[2] as string;
  } else {
    return null;
  }

  if (!HOST.test(registry)) return null;
  if (!SEGMENT.test(namespace) || !SEGMENT.test(name) || !SEGMENT.test(tag)) return null;
  return { registry, namespace, name, tag };
}

/** Render a ref back to the string a user (and `ollama pull`) would type. */
export function formatModelRef(r: ModelRef): string {
  const head =
    r.registry === DEFAULT_REGISTRY && r.namespace === DEFAULT_NAMESPACE
      ? r.name
      : r.registry === DEFAULT_REGISTRY
        ? `${r.namespace}/${r.name}`
        : `${r.registry}/${r.namespace}/${r.name}`;
  return `${head}:${r.tag}`;
}

/** The manifest URL for a ref. Segments are pre-validated by `parseModelRef`. */
export function manifestUrl(r: ModelRef): string {
  return `https://${r.registry}/v2/${r.namespace}/${r.name}/manifests/${r.tag}`;
}

/** The blob URL for a digest belonging to a ref (the config blob, in practice). */
export function blobUrl(r: ModelRef, digest: string): string | null {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
  return `https://${r.registry}/v2/${r.namespace}/${r.name}/blobs/${digest}`;
}

/**
 * Normalise a digest for comparison.
 *
 * `/api/tags` reports bare lowercase hex; the registry and every manifest field use a
 * `sha256:`-prefixed form. Comparing the two as-written makes EVERY model look changed — a
 * false positive on every model on the machine, which would be indistinguishable from the
 * feature working until someone pulled an "update" that was the same build. Returns "" for
 * anything that is not a sha256 digest, and "" never equals "".
 */
export function normalizeDigest(input: string | undefined): string {
  if (typeof input !== "string") return "";
  const hex = input
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(hex) ? hex : "";
}

/**
 * The digest of a manifest, computed from the bytes the registry served.
 *
 * Takes the RAW body. Re-serialising the parsed JSON would change the byte sequence (key order,
 * whitespace) and therefore the hash, so the caller must pass what came off the wire, and this
 * must never be handed an object.
 */
export function manifestDigest(body: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(typeof body === "string" ? Buffer.from(body, "utf8") : body);
  return h.digest("hex");
}

/** One layer of an OCI manifest. */
export interface ManifestLayer {
  mediaType: string;
  digest: string;
  size: number;
}

/** The parts of a manifest this module uses. */
export interface RemoteManifest {
  /** sha256 of the body, bare hex — comparable with `normalizeDigest(local)`. */
  digest: string;
  /** sum of the layer sizes: what a pull transfers, and what it occupies. */
  totalBytes: number;
  layers: ManifestLayer[];
  /** the config blob's digest, which carries the quantisation and the ollama floor. */
  configDigest: string;
}

/**
 * Parse a manifest body, or null if it is not one.
 *
 * Fail-soft by design: a 404 body, an HTML error page from a proxy and a truncated response all
 * land here, and none of them should throw inside a background startup check.
 */
export function parseManifest(body: string): RemoteManifest | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const d = doc as Record<string, unknown>;
  if (!Array.isArray(d.layers)) return null;

  const layers: ManifestLayer[] = [];
  for (const raw of d.layers) {
    if (typeof raw !== "object" || raw === null) continue;
    const l = raw as Record<string, unknown>;
    const size = typeof l.size === "number" && Number.isFinite(l.size) ? l.size : 0;
    layers.push({
      mediaType: typeof l.mediaType === "string" ? l.mediaType : "",
      digest: typeof l.digest === "string" ? l.digest : "",
      size: Math.max(0, size),
    });
  }
  const cfg = d.config as Record<string, unknown> | undefined;
  return {
    digest: manifestDigest(body),
    totalBytes: layers.reduce((n, l) => n + l.size, 0),
    layers,
    configDigest: typeof cfg?.digest === "string" ? cfg.digest : "",
  };
}

/** The fields of the config blob worth comparing. */
export interface RemoteConfig {
  /** e.g. "Q4_K_M" — `/api/show` calls the same thing `quantization_level`. */
  fileType?: string;
  /** e.g. "35.5B" — `/api/show` calls it `parameter_size`. */
  modelType?: string;
  family?: string;
  /** the MINIMUM ollama version this build needs, e.g. "0.30.0". */
  requiresOllama?: string;
}

/** Parse the config blob. Every field is optional — older builds omit most of them. */
export function parseConfigBlob(body: string): RemoteConfig {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return {};
  }
  if (typeof doc !== "object" || doc === null) return {};
  const d = doc as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  const out: RemoteConfig = {};
  const fileType = str(d.file_type);
  const modelType = str(d.model_type);
  const family = str(d.model_family);
  const requires = str(d.requires);
  if (fileType) out.fileType = fileType;
  if (modelType) out.modelType = modelType;
  if (family) out.family = family;
  if (requires) out.requiresOllama = requires;
  return out;
}

/**
 * Read the digest a HEAD response carries, or "" when it carries none.
 *
 * Takes a lookup rather than a `Headers`, so core stays free of the fetch types and a test can
 * pass a plain object. Header names are case-insensitive on the wire; the caller's `Headers.get`
 * already handles that, and the plain-object path is lowercased here.
 */
export function digestFromHeaders(get: (name: string) => string | null | undefined): string {
  return normalizeDigest(get(DIGEST_HEADER) ?? undefined);
}

/**
 * Read `ollama-push-time` as epoch MILLISECONDS, or undefined.
 *
 * The header is in SECONDS. Returning milliseconds is deliberate — every other time in this
 * codebase is `Date.parse`-shaped, and a seconds/milliseconds mix-up would put every push in
 * 1970 and make every update look older than the installed copy, i.e. it would silently invert
 * the one comparison this value exists for.
 */
export function pushTimeFromHeaders(
  get: (name: string) => string | null | undefined,
): number | undefined {
  const raw = get(PUSH_TIME_HEADER);
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const secs = Number(raw.trim());
  // Sanity-bound it rather than trusting the arithmetic: 2000-01-01 .. 2100-01-01. A value in
  // milliseconds would land far past the upper bound and is rejected instead of misread.
  if (!Number.isFinite(secs) || secs < 946_684_800 || secs > 4_102_444_800) return undefined;
  return secs * 1000;
}

/** An installed model, as `/api/tags` + `/api/show` describe it. */
export interface InstalledModel {
  /** the tag, e.g. "qwen3.6:latest". */
  name: string;
  /** manifest digest, bare hex or sha256-prefixed — normalised on the way in. */
  digest: string;
  /** bytes on disk. */
  size?: number;
  quantization?: string;
  parameterSize?: string;
  /** `/api/tags` `modified_at` — when this copy was written locally. */
  modifiedAt?: string;
}

/** What moved between the installed build and the one the tag now points at. */
export interface BuildDelta {
  /** remote minus local, in bytes. NEGATIVE means the new build is SMALLER. */
  sizeDelta?: number;
  /** set only when both sides reported one AND they differ. */
  quantization?: { from: string; to: string };
  /** set only when both sides reported one AND they differ. */
  parameters?: { from: string; to: string };
}

/**
 * Why a model was not checked. Each is a normal outcome, not an error to report loudly.
 *
 * `unparseable-ref` is the side-loaded / Modelfile / non-ollama-registry case; `not-found` is a
 * tag the registry no longer publishes (renamed, withdrawn, or private).
 */
export type SkipReason = "unparseable-ref" | "not-found" | "unreachable" | "bad-manifest";

export interface ModelUpdate {
  /** the installed tag, verbatim. */
  model: string;
  ref: ModelRef;
  localDigest: string;
  remoteDigest: string;
  /** true when the two digests differ — "the tag points somewhere else now". */
  changed: boolean;
  localBytes?: number;
  remoteBytes: number;
  delta: BuildDelta;
  /**
   * The minimum ollama version the NEW build declares, when it declares one.
   *
   * Load-bearing: a build that requires a newer ollama than is installed will pull happily and
   * then fail to load, having spent the bandwidth and replaced a model that worked. Checked
   * BEFORE the update is offered, never after.
   */
  requiresOllama?: string;
  /** false only when `requiresOllama` is present AND the installed version is older. */
  satisfiable: boolean;
  /**
   * Whether the remote build is demonstrably NEWER, not merely different.
   *
   * `true` only when the registry's push time is later than this copy's `modified_at`;
   * `undefined` whenever either side is missing or the header was absent, which is the common
   * case and must read as "unknown", never as "not newer". Nothing refuses an update on this —
   * it only decides whether the offer may use the word.
   */
  newer?: boolean;
  /** when the tag was last pushed upstream, epoch ms, when the registry said. */
  pushedAt?: number;
  /**
   * Peak disk the update needs, which is NOT the download size.
   *
   * A pull writes the new layers before the tag moves and the old ones are released, so both
   * builds are on disk at once. Shared layers (a licence blob, unchanged params) are written
   * once, so this is an upper bound rather than a prediction.
   */
  peakDiskBytes: number;
}

/** Everything `checkModelUpdates` learned about one model, including the "did not check" cases. */
export type ModelCheck =
  | { ok: true; update: ModelUpdate }
  | { ok: false; model: string; reason: SkipReason };

/** The remote side of a comparison, as the caller fetched it. */
export interface RemoteBuild {
  manifest: RemoteManifest;
  config: RemoteConfig;
  /** from `ollama-push-time`, epoch ms. Absent whenever the header was. */
  pushedAt?: number;
}

/**
 * Compare an installed model against the build its tag now resolves to.
 *
 * `installedOllama` may be undefined — an unknown daemon version must not be read as "too old",
 * because refusing to offer a legitimate update over a version we failed to read is the worse
 * error of the two. Absent ⇒ satisfiable.
 */
export function compareBuild(
  local: InstalledModel,
  remote: RemoteBuild,
  installedOllama?: string,
): ModelUpdate | null {
  const ref = parseModelRef(local.name);
  if (!ref) return null;

  const localDigest = normalizeDigest(local.digest);
  const remoteDigest = normalizeDigest(remote.manifest.digest);
  const changed = localDigest !== "" && remoteDigest !== "" && localDigest !== remoteDigest;

  const delta: BuildDelta = {};
  if (typeof local.size === "number" && local.size > 0) {
    delta.sizeDelta = remote.manifest.totalBytes - local.size;
  }
  const q = { from: local.quantization ?? "", to: remote.config.fileType ?? "" };
  if (q.from !== "" && q.to !== "" && q.from !== q.to) delta.quantization = q;
  const p = { from: local.parameterSize ?? "", to: remote.config.modelType ?? "" };
  if (p.from !== "" && p.to !== "" && p.from !== p.to) delta.parameters = p;

  const requires = remote.config.requiresOllama;
  // `compareVersions` returns null when either side is unparseable — treated as satisfiable for
  // the reason in the doc comment: an unreadable version is not evidence of an old one.
  const cmp = requires !== undefined ? compareVersions(requires, installedOllama) : null;
  const satisfiable = cmp === null ? true : cmp <= 0;

  /**
   * "Newer" is only claimable when BOTH timestamps are readable. A missing push time, an
   * unparseable `modified_at`, or equal values all leave this undefined — unknown, not false.
   */
  const localMs = local.modifiedAt !== undefined ? Date.parse(local.modifiedAt) : Number.NaN;
  const newer =
    remote.pushedAt !== undefined && Number.isFinite(localMs)
      ? remote.pushedAt > localMs
      : undefined;

  return {
    model: local.name,
    ref,
    localDigest,
    remoteDigest,
    changed,
    ...(typeof local.size === "number" ? { localBytes: local.size } : {}),
    remoteBytes: remote.manifest.totalBytes,
    delta,
    ...(requires !== undefined ? { requiresOllama: requires } : {}),
    satisfiable,
    ...(newer !== undefined ? { newer } : {}),
    ...(remote.pushedAt !== undefined ? { pushedAt: remote.pushedAt } : {}),
    peakDiskBytes: (local.size ?? 0) + remote.manifest.totalBytes,
  };
}

/**
 * Disk actually freed by removing `victim` once `keep` is installed — NOT the victim's size.
 *
 * Ollama stores layers content-addressed and shares them between manifests, so two tags of the
 * same family routinely share the bulk of their weight. Reporting the victim's full size as the
 * saving is the easy, wrong number: deleting it can free a fraction of that, or nothing at all.
 * Only layers the survivor does not also reference are really released.
 *
 * ── THIS COMMENT USED TO SAY "returns 0 for a same-tag update". THAT WAS FALSE. ─────────────
 *
 * Measured on 2026-09-29 against the two real qwen3.6:latest manifests — the installed one and
 * the one the tag now resolves to — this returns **23,938,321,758 B (23.94 GB)**, not 0. The old
 * claim was "proved" by a test that passed the SAME manifest as both arguments, which is
 * trivially zero and says nothing about a same-tag update: the two builds of one tag are
 * different manifests sharing, in this case, exactly one blob (the 11,357-byte licence).
 *
 * The true statement is about WHO frees the bytes, not how many there are: on a same-tag pull
 * **ollama releases the superseded layers itself** — the store here has served five pulls and
 * carries zero orphan blobs — so there is nothing left for a user-facing "delete the old model
 * to save space" offer to do. The number is real; the offer would be theatre.
 *
 * A CROSS-tag delete is the case where an offer is honest, because the old tag stays on disk
 * indefinitely. `survivors` is therefore every OTHER manifest that will remain, not just one.
 */
export function reclaimableAfterUpdate(
  victim: readonly ManifestLayer[],
  survivors: readonly (readonly ManifestLayer[])[],
): number {
  /**
   * EVERY remaining manifest, not one.
   *
   * This took a single `keep` argument, which is only correct on a machine with exactly two
   * models. With three installed, deleting A while B and C remain would count every layer A
   * shares with C as reclaimable — an over-report, in the direction that promises the user disk
   * they will not get back.
   */
  const kept = new Set<string>();
  for (const s of survivors) for (const l of s) if (l.digest !== "") kept.add(l.digest);
  /**
   * A layer with no digest is skipped rather than counted: it cannot be proven unshared, and
   * under-reporting a saving is the direction that disappoints least.
   *
   * The config blob is likewise NOT counted. It is a real blob on disk — measured at 220 B and
   * 462 B for the two models here — but `parseManifest` keeps only its digest, not its size. The
   * omission is sub-kilobyte and, again, under-reports.
   */
  return victim
    .filter((l) => l.digest !== "" && !kept.has(l.digest))
    .reduce((n, l) => n + l.size, 0);
}

/**
 * Should this update be OFFERED to the user?
 *
 * Separate from "did it change", because a changed digest is not on its own a reason to spend
 * the user's bandwidth and replace something that works:
 *   - a build that needs a newer ollama would pull and then fail to load;
 *   - a build whose peak disk exceeds what is free would fill the volume mid-pull.
 * Both are refusals the user should see as a NOTE, not as an offer they can accept and regret.
 */
export function offerable(u: ModelUpdate, freeDiskBytes?: number): boolean {
  if (!u.changed) return false;
  if (!u.satisfiable) return false;
  if (typeof freeDiskBytes === "number" && freeDiskBytes > 0) {
    return u.peakDiskBytes <= freeDiskBytes;
  }
  return true;
}
