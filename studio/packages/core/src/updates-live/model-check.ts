/**
 * updates/model-check.ts — the network seam for "is there a newer build of this model".
 *
 * Core (`packages/core/src/updates/model-registry.ts`) owns every decision; this file owns the
 * requests and nothing else. It never throws: a background startup check that can fail the boot
 * is worse than one that occasionally says "I don't know".
 *
 * ── THE REQUEST BUDGET, WHICH IS THE WHOLE DESIGN ───────────────────────────────────────────
 *
 * Two stages, because the answer for most models is "nothing changed" and that answer is free:
 *
 *   1. HEAD every installed model's manifest. The response carries `ollama-content-digest`,
 *      which IS the digest `/api/tags` reports locally (verified byte-for-byte), so one header
 *      request per model settles it with no body at all.
 *   2. Only for the models whose digest actually MOVED, GET the manifest and its config blob to
 *      learn the size, the quantisation and the minimum ollama version.
 *
 * On a typical machine that is N cheap HEADs and zero or one GET pair. The naive version — GET
 * every manifest and hash it — costs a kilobyte per model and has to get byte-fidelity right;
 * this does neither.
 */

import * as u from "../updates/index.js";

/** Per-request ceiling. A background check must never be the reason a startup feels slow. */
export const PROBE_TIMEOUT_MS = 4_000;

/**
 * How many registry requests may be in flight at once.
 *
 * Not a performance knob — a courtesy one. A user with thirty models should not open thirty
 * sockets to someone else's registry in the first second of a session, and the whole sweep is
 * off the critical path anyway.
 */
export const PROBE_CONCURRENCY = 4;

/** Injected so a test never touches the network. Mirrors the shape of global `fetch`. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface ProbeDeps {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** the installed ollama version, for the `requires` gate. */
  ollamaVersion?: string;
}

/** One request, bounded and fail-soft. Returns null for every failure mode alike. */
async function req(
  fetchImpl: FetchLike,
  url: string,
  method: "GET" | "HEAD",
  timeoutMs: number,
): Promise<{ status: number; headers: { get(n: string): string | null }; body: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { accept: u.MANIFEST_ACCEPT },
      signal: ctrl.signal,
    });
    // A HEAD has no body; reading it is still safe and returns "".
    const body = method === "GET" && res.ok ? await res.text() : "";
    return { status: res.status, headers: res.headers, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What a HEAD told us about a tag. */
export interface HeadProbe {
  digest: string;
  pushedAt?: number;
}

/**
 * HEAD a manifest: the digest, and the push time when the registry offers it.
 *
 * A 404 is NOT a failure worth reporting loudly — it is a tag the registry no longer publishes
 * (renamed, withdrawn, private, or a model built locally from a Modelfile), which is an ordinary
 * thing to find on a real machine.
 */
export async function headManifest(
  ref: u.ModelRef,
  deps: ProbeDeps = {},
): Promise<HeadProbe | { skip: u.SkipReason }> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== "function") return { skip: "unreachable" };
  const r = await req(fetchImpl, u.manifestUrl(ref), "HEAD", deps.timeoutMs ?? PROBE_TIMEOUT_MS);
  if (!r) return { skip: "unreachable" };
  if (r.status === 404) return { skip: "not-found" };
  if (r.status < 200 || r.status >= 300) return { skip: "unreachable" };

  const digest = u.digestFromHeaders((n) => r.headers.get(n));
  // A mirror or corporate proxy may strip the header. That is not an error — it just means the
  // digest has to come from the body, which `fetchBuild` does anyway.
  if (digest === "") return { skip: "bad-manifest" };
  const pushedAt = u.pushTimeFromHeaders((n) => r.headers.get(n));
  return { digest, ...(pushedAt !== undefined ? { pushedAt } : {}) };
}

/**
 * GET the manifest and its config blob — the detail behind a digest that moved.
 *
 * The config blob is a second request and is allowed to fail on its own: without it the
 * comparison loses the quantisation, the parameter count and `requires`, but the size and the
 * digest still stand. A partial answer here is far better than none.
 */
export async function fetchBuild(
  ref: u.ModelRef,
  deps: ProbeDeps = {},
): Promise<u.RemoteBuild | { skip: u.SkipReason }> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== "function") return { skip: "unreachable" };
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

  const r = await req(fetchImpl, u.manifestUrl(ref), "GET", timeoutMs);
  if (!r) return { skip: "unreachable" };
  if (r.status === 404) return { skip: "not-found" };
  if (r.status < 200 || r.status >= 300) return { skip: "unreachable" };

  const manifest = u.parseManifest(r.body);
  if (!manifest) return { skip: "bad-manifest" };

  let config: u.RemoteConfig = {};
  const cfgUrl = u.blobUrl(ref, manifest.configDigest);
  if (cfgUrl) {
    const c = await req(fetchImpl, cfgUrl, "GET", timeoutMs);
    if (c && c.status >= 200 && c.status < 300) config = u.parseConfigBlob(c.body);
  }
  const pushedAt = u.pushTimeFromHeaders((n) => r.headers.get(n));
  return { manifest, config, ...(pushedAt !== undefined ? { pushedAt } : {}) };
}

/** Run `jobs` with at most `limit` in flight, preserving input order in the output. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await run(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Check every installed model against its upstream tag.
 *
 * Order is preserved so a caller can zip the results back against its own list. Every element is
 * a decision or an explicit skip — never a thrown error, and never a silent omission, because
 * "this model was not checked" is information the user is entitled to.
 */
export async function checkModelUpdates(
  models: readonly u.InstalledModel[],
  deps: ProbeDeps = {},
): Promise<u.ModelCheck[]> {
  return pooled(models, PROBE_CONCURRENCY, async (m): Promise<u.ModelCheck> => {
    const ref = u.parseModelRef(m.name);
    // Side-loaded, Modelfile-built, or pointing at a registry we have no business probing.
    if (!ref) return { ok: false, model: m.name, reason: "unparseable-ref" };

    const head = await headManifest(ref, deps);
    if ("skip" in head) {
      // A stripped digest header is recoverable — fall through to the body path.
      if (head.skip !== "bad-manifest") return { ok: false, model: m.name, reason: head.skip };
    } else if (u.normalizeDigest(m.digest) === head.digest) {
      /**
       * Up to date, settled by one header request and nothing else.
       *
       * Synthesised rather than fetched: the caller wants a uniform row for every model, and
       * spending a manifest GET to fill in a size nobody will read — on the model that did NOT
       * change — is the cost this two-stage design exists to avoid.
       */
      const same: u.RemoteBuild = {
        manifest: { digest: head.digest, totalBytes: 0, layers: [], configDigest: "" },
        config: {},
        ...(head.pushedAt !== undefined ? { pushedAt: head.pushedAt } : {}),
      };
      const update = u.compareBuild(m, same, deps.ollamaVersion);
      return update
        ? { ok: true, update }
        : { ok: false, model: m.name, reason: "unparseable-ref" };
    }

    const build = await fetchBuild(ref, deps);
    if ("skip" in build) return { ok: false, model: m.name, reason: build.skip };
    /**
     * Carry the HEAD's push time forward. MEASURED: `ollama-push-time` is returned on the HEAD
     * and NOT on the GET — so reading it only from the build, as this did at first, produced
     * `undefined` for precisely the models that changed, which are the only ones where the
     * question "is it actually newer?" is ever asked.
     *
     * Every unit test passed through that bug because a hand-written fake returns whatever
     * headers it is told to on both verbs. Only the live run against the real registry showed
     * it. The build's own value still wins if the registry ever starts sending it on the GET.
     */
    const withPush: u.RemoteBuild =
      build.pushedAt === undefined && !("skip" in head) && head.pushedAt !== undefined
        ? { ...build, pushedAt: head.pushedAt }
        : build;
    const update = u.compareBuild(m, withPush, deps.ollamaVersion);
    return update ? { ok: true, update } : { ok: false, model: m.name, reason: "unparseable-ref" };
  });
}

/**
 * The running daemon's version, for the `requires` gate. `undefined` when it cannot be read —
 * which core treats as satisfiable, because a failed read is not evidence of an old daemon.
 */
export async function fetchOllamaVersion(
  baseUrl = "http://127.0.0.1:11434",
  deps: ProbeDeps = {},
): Promise<string | undefined> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchImpl !== "function") return undefined;
  const r = await req(fetchImpl, `${baseUrl}/api/version`, "GET", deps.timeoutMs ?? 1_500);
  if (!r || r.status < 200 || r.status >= 300) return undefined;
  try {
    const v = (JSON.parse(r.body) as { version?: unknown }).version;
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}
