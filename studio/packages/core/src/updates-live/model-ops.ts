/**
 * updates-live/model-ops.ts — pull, remove, and the local facts no HTTP endpoint will tell you.
 *
 * The IO half of `updates/model-actions.ts`. Four operations, each with one thing about it that
 * is not obvious:
 *
 *  • **pull** — HTTP 200 does not mean it worked. ollama commits the response before it can
 *    fail, so an error arrives as an NDJSON line mid-stream. Success has exactly one witness:
 *    a final `{"status":"success"}`.
 *  • **remove** — the route is DELETE-only. A POST returns 405 (observed in this machine's
 *    `~/.ollama/logs/server.log`, 2026-09-28 20:08:47), and 405 with a PLAIN-TEXT body, so a
 *    caller that assumes JSON on failure gets a parse error instead of a diagnosis.
 *  • **local layers** — `/api/tags` and `/api/show` both omit them, verified against a live
 *    0.34.1 daemon. The on-disk manifest is the ONLY source, which is why a "free up space"
 *    offer cannot be computed from the API alone.
 *  • **loaded models** — `/api/ps`, because deleting a resident model is a different operation
 *    from the one the user agreed to.
 *
 * Nothing here decides anything. Whether an action may be offered, what it costs and whether a
 * saving is real are all in `model-actions.ts`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type PullEvent, parsePullLine } from "../updates/model-actions.js";
import { type ManifestLayer, parseManifest } from "../updates/model-registry.js";

/** The daemon PROMETHEUS talks to. Local only — see `assertLocal`. */
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export interface OpsDeps {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** where ollama keeps its store. `$OLLAMA_MODELS`, else `~/.ollama/models`. */
  modelsDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Refuse any non-loopback daemon.
 *
 * `ai-ipc.ts:1486` already refuses to PROBE a remote endpoint, for the same reason: a pull sends
 * no credentials but a delete destroys data, and neither belongs pointed at a host the user did
 * not configure here. A model name is user input that reaches a URL path, so the host half of
 * that URL must never be derived from it.
 */
function assertLocal(baseUrl: string): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`not a URL: ${baseUrl}`);
  }
  const host = u.hostname.toLowerCase();
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!local) throw new Error(`refused: model operations are local-only (got ${u.hostname})`);
}

function base(deps: OpsDeps): string {
  const b = deps.baseUrl ?? DEFAULT_OLLAMA_URL;
  assertLocal(b);
  return b.replace(/\/+$/, "");
}

/* ─────────────────────────────── pull ─────────────────────────────── */

export interface PullResult {
  ok: boolean;
  /** why it failed. Empty on success. */
  error: string;
  /** true when the failure was the caller aborting, which is not an error to report loudly. */
  aborted: boolean;
}

/**
 * Pull a tag, reporting progress as it streams.
 *
 * `signal` is the only cancellation there is: ollama exposes no cancel endpoint, and aborting
 * the request is what its handler selects on (`case <-ctx.Done()`). Note that downloads are
 * reference-counted per blob digest, so aborting stops the transfer only when no other client is
 * pulling the same layer — and a cancelled pull RESUMES from its partial file next time, which
 * is why an abort is not reported as a failure.
 */
export async function pullModel(
  tag: string,
  opts: { onEvent?: (e: PullEvent) => void; signal?: AbortSignal } = {},
  deps: OpsDeps = {},
): Promise<PullResult> {
  const f = deps.fetchImpl ?? globalThis.fetch;
  if (typeof f !== "function")
    return { ok: false, error: "no fetch in this runtime", aborted: false };
  /**
   * The locality check THROWS, and is deliberately outside the try below.
   *
   * Every other failure here is soft — a dead daemon, a timeout, a bad tag — and collapsing a
   * security refusal into the same `{ ok: false, error }` shape makes "I will not talk to that
   * host" indistinguishable from "that host did not answer". One of those is a configuration
   * mistake the caller must fix; the other is Tuesday.
   */
  const url = `${base(deps)}/api/pull`;
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: tag, stream: true }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    const aborted = opts.signal?.aborted === true;
    return { ok: false, error: aborted ? "cancelled" : errText(e), aborted };
  }

  if (!res.ok) {
    /**
     * A failure BEFORE any byte was streamed comes back as ordinary JSON — but `GET /api/pull`
     * returns a plain-text `405 method not allowed`, so the body is read as text and only then
     * hopefully parsed. Assuming JSON here turns a clear diagnosis into a parse error.
     */
    const body = await res.text().catch(() => "");
    return { ok: false, error: jsonError(body) || `HTTP ${res.status}`, aborted: false };
  }
  if (!res.body) return { ok: false, error: "the daemon returned no stream", aborted: false };

  let succeeded = false;
  let failure = "";
  try {
    for await (const line of ndjson(res.body)) {
      const e = parsePullLine(line);
      if (!e) continue;
      opts.onEvent?.(e);
      if (e.kind === "success") succeeded = true;
      if (e.kind === "error") failure = e.message;
    }
  } catch (e) {
    const aborted = opts.signal?.aborted === true;
    return { ok: false, error: aborted ? "cancelled" : errText(e), aborted };
  }

  if (failure) return { ok: false, error: failure, aborted: false };
  /**
   * A clean EOF with no `success` line is a FAILURE, not a success.
   *
   * This is the case that makes `res.ok` useless: the response was committed as 200, the stream
   * ended, and the model is not on disk. Reporting it as done is how a user is told a 22 GB
   * download finished when it did not.
   */
  if (!succeeded) {
    return { ok: false, error: "the stream ended without reporting success", aborted: false };
  }
  return { ok: true, error: "", aborted: false };
}

/** Split a byte stream into lines, tolerating chunk boundaries anywhere. */
async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  // A final line with no trailing newline is real data, not a remnant to discard.
  buf += decoder.decode();
  if (buf.trim() !== "") yield buf;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Pull `.error` out of a body that may or may not be JSON. "" when there is none. */
function jsonError(body: string): string {
  try {
    const o: unknown = JSON.parse(body);
    if (o && typeof o === "object" && typeof (o as { error?: unknown }).error === "string") {
      return (o as { error: string }).error;
    }
  } catch {
    /* plain text — fall through and use it directly */
  }
  return body.trim().slice(0, 200);
}

/* ─────────────────────────────── remove ─────────────────────────────── */

/**
 * Remove a model. DESTRUCTIVE and irreversible — the caller must have confirmed first.
 *
 * The HTTP verb is DELETE, not POST. ollama 0.34.1 routes `/api/delete` for DELETE only and
 * answers a POST with 405, which this machine's server log records happening.
 */
export async function removeModel(
  tag: string,
  deps: OpsDeps = {},
): Promise<{ ok: boolean; error: string }> {
  const f = deps.fetchImpl ?? globalThis.fetch;
  if (typeof f !== "function") return { ok: false, error: "no fetch in this runtime" };
  // Throws on a non-loopback host, outside the try — see the note in `pullModel`.
  const url = `${base(deps)}/api/delete`;
  try {
    const res = await f(url, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: tag }),
    });
    // Success is 200 with an EMPTY body — there is nothing to parse, and trying to would fail.
    if (res.ok) return { ok: true, error: "" };
    const body = await res.text().catch(() => "");
    return { ok: false, error: jsonError(body) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/* ─────────────────────────── local facts ─────────────────────────── */

/** Tags currently resident in memory, from `GET /api/ps`. [] when the daemon is unreachable. */
export async function loadedModels(deps: OpsDeps = {}): Promise<string[]> {
  const f = deps.fetchImpl ?? globalThis.fetch;
  if (typeof f !== "function") return [];
  try {
    const res = await f(`${base(deps)}/api/ps`, { method: "GET" });
    if (!res.ok) return [];
    const j = (await res.json()) as { models?: { name?: unknown; model?: unknown }[] };
    if (!Array.isArray(j.models)) return [];
    // `name` and `model` are both present and both the tag; prefer `name`, accept either.
    return j.models
      .map((m) =>
        typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : "",
      )
      .filter((s) => s !== "");
  } catch {
    return [];
  }
}

/** Where ollama keeps its store. `$OLLAMA_MODELS` wins, as it does for the daemon itself. */
export function ollamaModelsDir(deps: OpsDeps = {}): string {
  if (deps.modelsDir) return deps.modelsDir;
  const env = deps.env ?? process.env;
  return env.OLLAMA_MODELS && env.OLLAMA_MODELS.trim() !== ""
    ? env.OLLAMA_MODELS
    : join(homedir(), ".ollama", "models");
}

/**
 * The layer list for an INSTALLED tag, read from its on-disk manifest.
 *
 * The only source there is. Measured against a live 0.34.1 daemon: `/api/tags` carries a
 * digest and a total size but no layers, and `/api/show` carries license, modelfile, parameters,
 * template, details, model_info, capabilities and modified_at — and no layers either. So a
 * "deleting this frees N bytes" claim computed from the HTTP API is computed from nothing.
 *
 * Returns null when the manifest is absent or unreadable, which `honestReclaim` turns into a
 * refusal to make any claim rather than a claim of zero.
 */
export function readLocalManifest(tag: string, deps: OpsDeps = {}): ManifestLayer[] | null {
  const path = localManifestPath(tag, deps);
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = parseManifest(readFileSync(path, "utf8"));
    return parsed ? [...parsed.layers] : null;
  } catch {
    return null;
  }
}

/**
 * `<models>/manifests/<registry>/<namespace>/<name>/<tag>`.
 *
 * The tag is user input that becomes a PATH, so every segment is validated against a strict
 * character set before it is joined. A name of `../../../etc` must not be able to make this
 * read an arbitrary file, and a `parseModelRef`-style split is not on its own a defence.
 */
export function localManifestPath(tag: string, deps: OpsDeps = {}): string | null {
  const safe = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const [left, tagPart = "latest"] = splitTag(tag);
  const parts = left.split("/").filter((p) => p !== "");
  let registry = "registry.ollama.ai";
  let namespace = "library";
  let name: string;
  if (parts.length === 1) name = parts[0] as string;
  else if (parts.length === 2) {
    namespace = parts[0] as string;
    name = parts[1] as string;
  } else if (parts.length === 3) {
    registry = parts[0] as string;
    namespace = parts[1] as string;
    name = parts[2] as string;
  } else return null;

  for (const seg of [registry, namespace, name, tagPart]) {
    if (!safe.test(seg) || seg === "." || seg === "..") return null;
  }
  return join(ollamaModelsDir(deps), "manifests", registry, namespace, name, tagPart);
}

/** Split `name:tag`, being careful not to cut a `host:port` in the registry part. */
function splitTag(ref: string): [string, string?] {
  const lastColon = ref.lastIndexOf(":");
  const lastSlash = ref.lastIndexOf("/");
  if (lastColon > lastSlash && lastColon > 0) {
    return [ref.slice(0, lastColon), ref.slice(lastColon + 1)];
  }
  return [ref];
}

/** Every installed tag's layers, so a removal can subtract EVERY survivor rather than one. */
export function readAllLocalManifests(
  deps: OpsDeps = {},
): { tag: string; layers: ManifestLayer[] }[] {
  const root = join(ollamaModelsDir(deps), "manifests");
  const out: { tag: string; layers: ManifestLayer[] }[] = [];
  const walk = (dir: string, depth: number, parts: string[]): void => {
    // registry/namespace/name/tag — exactly four levels, so a stray file elsewhere is ignored.
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let isDir: boolean;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(p, depth + 1, [...parts, e]);
        continue;
      }
      if (depth !== 3) continue; // a file at any other depth is not a manifest
      try {
        const parsed = parseManifest(readFileSync(p, "utf8"));
        if (!parsed) continue;
        // parts = [registry, namespace, name]; `library` is elided the way ollama prints it.
        const ns = parts[1] === "library" ? "" : `${parts[1]}/`;
        out.push({ tag: `${ns}${parts[2]}:${e}`, layers: [...parsed.layers] });
      } catch {
        /* an unreadable manifest is skipped, never guessed at */
      }
    }
  };
  walk(root, 0, []);
  return out;
}
