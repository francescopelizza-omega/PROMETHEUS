/**
 * model-ops.test.ts — pull, remove, and the local reads, with a fake daemon.
 *
 * No network and no real ollama. Every response shape here was taken from a live 0.34.1 daemon
 * or from ollama's own `server/routes.go` — the ones that look paranoid are the ones that were
 * observed: a 200 that later fails, a 405 with a plain-text body, and a DELETE-only route.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  loadedModels,
  localManifestPath,
  ollamaModelsDir,
  pullModel,
  readAllLocalManifests,
  readLocalManifest,
  removeModel,
} from "./model-ops.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "prom-ops-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fake daemon that replies with a fixed NDJSON body. */
function fakeStream(lines: readonly string[], status = 200): typeof fetch {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const l of lines) c.enqueue(enc.encode(`${l}\n`));
      c.close();
    },
  });
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    body,
  })) as unknown as typeof fetch;
}

/** Records the request so the VERB and body can be asserted. */
function recorder(response: { ok: boolean; status: number; text?: string }) {
  const seen: { url: string; method?: string; body?: string }[] = [];
  const impl = (async (url: string, init?: RequestInit) => ({
    ok: response.ok,
    status: response.status,
    text: async () => response.text ?? "",
    json: async () => JSON.parse(response.text ?? "null"),
    body: null,
    ...((): unknown => {
      seen.push({
        url,
        ...(init?.method ? { method: init.method } : {}),
        body: String(init?.body ?? ""),
      });
      return {};
    })(),
  })) as unknown as typeof fetch;
  return { impl, seen };
}

/* ─────────────────────────────── pull ─────────────────────────────── */

test("a pull succeeds ONLY on a terminal success line", async () => {
  const r = await pullModel(
    "qwen3.6:latest",
    {},
    {
      fetchImpl: fakeStream([
        '{"status":"pulling manifest"}',
        '{"status":"pulling abc","digest":"sha256:abc","total":100,"completed":100}',
        '{"status":"writing manifest"}',
        '{"status":"success"}',
      ]),
    },
  );
  assert.deepEqual(r, { ok: true, error: "", aborted: false });
});

test("REGRESSION: HTTP 200 with an error LINE is a failure, not a success", async () => {
  /**
   * ollama's `streamResponse()` commits the response before it can fail, so once bytes are on
   * the wire an error is appended as an NDJSON line and the stream stops — with the status
   * already 200. A caller that trusts `res.ok` reports a completed 22 GB download of a model
   * that is not on disk.
   */
  const r = await pullModel(
    "qwen3.6:latest",
    {},
    {
      fetchImpl: fakeStream([
        '{"status":"pulling manifest"}',
        '{"error":"pull model manifest: file does not exist"}',
      ]),
    },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /file does not exist/);
});

test("REGRESSION: a clean EOF with no success line is a FAILURE", async () => {
  // The other half of the same trap: the stream simply ends. Nothing errored, nothing succeeded.
  const r = await pullModel("x", {}, { fetchImpl: fakeStream(['{"status":"pulling manifest"}']) });
  assert.equal(r.ok, false);
  assert.match(r.error, /ended without reporting success/);
});

test("progress events reach the caller in order", async () => {
  const seen: string[] = [];
  await pullModel(
    "x",
    { onEvent: (e) => seen.push(e.kind === "progress" ? `p:${e.completed}` : e.kind) },
    {
      fetchImpl: fakeStream([
        '{"status":"pulling manifest"}',
        '{"status":"pulling a","digest":"sha256:a","total":10,"completed":5}',
        '{"status":"success"}',
      ]),
    },
  );
  assert.deepEqual(seen, ["status", "p:5", "success"]);
});

test("a line split across chunk boundaries is still parsed whole", async () => {
  // NDJSON arrives in arbitrary chunks; a naive decoder loses the line that straddles two.
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('{"status":"pulling man'));
      c.enqueue(enc.encode('ifest"}\n{"status":"suc'));
      c.enqueue(enc.encode('cess"}'));
      c.close();
    },
  });
  const impl = (async () => ({ ok: true, status: 200, body })) as unknown as typeof fetch;
  const seen: string[] = [];
  const r = await pullModel("x", { onEvent: (e) => seen.push(e.kind) }, { fetchImpl: impl });
  assert.equal(r.ok, true, "a final line with no trailing newline is real data");
  assert.deepEqual(seen, ["status", "success"]);
});

test("a pre-stream failure is reported from a PLAIN-TEXT body without a parse error", async () => {
  // `GET /api/pull` answers `405 method not allowed` as text/plain. Assuming JSON on failure
  // turns a clear diagnosis into "Unexpected token".
  const { impl } = recorder({ ok: false, status: 405, text: "405 method not allowed" });
  const r = await pullModel("x", {}, { fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.match(r.error, /method not allowed/);
});

test("an abort is reported as cancelled, not as an error", async () => {
  /**
   * ollama has no cancel endpoint; aborting the request IS the cancel, and a cancelled pull
   * resumes from its partial file next time. Reporting that as a failure would tell the user
   * something broke when they chose to stop.
   */
  const ctrl = new AbortController();
  ctrl.abort();
  const impl = (async () => {
    throw new Error("The operation was aborted");
  }) as unknown as typeof fetch;
  const r = await pullModel("x", { signal: ctrl.signal }, { fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.equal(r.error, "cancelled");
});

/* ─────────────────────────────── remove ─────────────────────────────── */

test("remove uses the DELETE verb — ollama answers a POST with 405", async () => {
  // Observed in this machine's ~/.ollama/logs/server.log, 2026-09-28 20:08:47.
  const { impl, seen } = recorder({ ok: true, status: 200 });
  const r = await removeModel("old:tag", { fetchImpl: impl });
  assert.equal(r.ok, true);
  assert.equal(seen[0]?.method, "DELETE");
  assert.match(seen[0]?.url ?? "", /\/api\/delete$/);
  assert.equal(seen[0]?.body, JSON.stringify({ model: "old:tag" }));
});

test("a successful remove has an EMPTY body, and parsing it must not fail the call", async () => {
  const { impl } = recorder({ ok: true, status: 200, text: "" });
  assert.deepEqual(await removeModel("x", { fetchImpl: impl }), { ok: true, error: "" });
});

test("a missing model surfaces the daemon's own message", async () => {
  const { impl } = recorder({ ok: false, status: 404, text: '{"error":"model \'x\' not found"}' });
  const r = await removeModel("x", { fetchImpl: impl });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});

/* ─────────────────────────── local-only guard ─────────────────────────── */

test("a non-loopback daemon is REFUSED for both operations", async () => {
  /**
   * A pull sends no credentials but a remove destroys data, and neither belongs pointed at a
   * host the user did not configure here. `ai-ipc.ts` already refuses a remote endpoint PROBE
   * for the same reason.
   */
  const impl = (async () => {
    throw new Error("should never be called");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => pullModel("x", {}, { baseUrl: "http://evil.example", fetchImpl: impl }),
    /local-only/,
  );
  await assert.rejects(
    () => removeModel("x", { baseUrl: "https://10.0.0.5:11434", fetchImpl: impl }),
    /local-only/,
  );
  // …and the loopback spellings are all accepted.
  for (const b of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"]) {
    const { impl: ok } = recorder({ ok: true, status: 200 });
    assert.equal((await removeModel("x", { baseUrl: b, fetchImpl: ok })).ok, true);
  }
});

/* ─────────────────────────── local manifests ─────────────────────────── */

const MANIFEST = JSON.stringify({
  schemaVersion: 2,
  config: { digest: "sha256:cfg", size: 220 },
  layers: [
    { digest: "sha256:weights", size: 1000 },
    { digest: "sha256:license", size: 11 },
  ],
});

function store(): string {
  const root = tmp();
  const dir = join(root, "manifests", "registry.ollama.ai", "library", "qwen3.6");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "latest"), MANIFEST);
  return root;
}

test("layers come from the ON-DISK manifest — no HTTP endpoint carries them", () => {
  /**
   * Verified against a live 0.34.1 daemon: `/api/tags` has a digest and a total size but no
   * layers, and `/api/show` returns license/modelfile/parameters/template/details/model_info/
   * capabilities/modified_at — also no layers. A "deleting this frees N bytes" claim computed
   * from the API is computed from nothing.
   */
  const layers = readLocalManifest("qwen3.6:latest", { modelsDir: store() });
  assert.equal(layers?.length, 2);
  assert.equal(layers?.[0]?.size, 1000);
});

test("a bare name defaults to the `latest` tag and the library namespace", () => {
  assert.equal(readLocalManifest("qwen3.6", { modelsDir: store() })?.length, 2);
});

test("an absent manifest returns null, so no saving may be claimed from it", () => {
  assert.equal(readLocalManifest("nope:1", { modelsDir: store() }), null);
});

test("SECURITY: a crafted model name cannot escape the store directory", () => {
  /**
   * The tag is user input that becomes a filesystem PATH. Splitting it into ref components is
   * not on its own a defence — every segment is validated against a strict character set.
   */
  const d = { modelsDir: "/store" };
  assert.equal(localManifestPath("../../../etc/passwd", d), null);
  assert.equal(localManifestPath("lib/../../etc:latest", d), null);
  assert.equal(localManifestPath("ok:../../../etc", d), null);
  assert.equal(localManifestPath(".:latest", d), null);
  assert.equal(localManifestPath("a/b/c/d:latest", d), null, "too many path components");
  assert.equal(localManifestPath("", d), null);
  // …and the legitimate shapes still resolve.
  assert.equal(
    localManifestPath("qwen3.6:latest", d),
    "/store/manifests/registry.ollama.ai/library/qwen3.6/latest",
  );
  assert.equal(
    localManifestPath("hf.co/user/repo:Q4_K_M", d),
    "/store/manifests/hf.co/user/repo/Q4_K_M",
  );
});

test("every installed manifest is enumerable, so a removal can subtract EVERY survivor", () => {
  const root = store();
  const other = join(root, "manifests", "registry.ollama.ai", "library", "gemma4");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "12b"), MANIFEST);
  const all = readAllLocalManifests({ modelsDir: root });
  assert.deepEqual(
    all.map((m) => m.tag).sort(),
    ["gemma4:12b", "qwen3.6:latest"],
    "the `library` namespace is elided, the way ollama prints it",
  );
});

test("a non-library namespace keeps its prefix", () => {
  const root = tmp();
  const dir = join(root, "manifests", "hf.co", "someone", "model");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Q4"), MANIFEST);
  assert.deepEqual(
    readAllLocalManifests({ modelsDir: root }).map((m) => m.tag),
    ["someone/model:Q4"],
  );
});

test("an unreadable or junk manifest is skipped, never guessed at", () => {
  const root = store();
  const dir = join(root, "manifests", "registry.ollama.ai", "library", "broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "1"), "not json");
  const all = readAllLocalManifests({ modelsDir: root });
  assert.deepEqual(
    all.map((m) => m.tag),
    ["qwen3.6:latest"],
  );
});

test("a missing store yields an empty list rather than throwing", () => {
  assert.deepEqual(readAllLocalManifests({ modelsDir: "/definitely/not/here" }), []);
});

test("$OLLAMA_MODELS wins, as it does for the daemon itself", () => {
  assert.equal(ollamaModelsDir({ env: { OLLAMA_MODELS: "/custom" } }), "/custom");
  assert.match(ollamaModelsDir({ env: {} }), /\.ollama\/models$/);
  assert.match(ollamaModelsDir({ env: { OLLAMA_MODELS: "  " } }), /\.ollama\/models$/);
});

/* ─────────────────────────────── ps ─────────────────────────────── */

test("loaded models are read from /api/ps, and a dead daemon yields []", async () => {
  const impl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ models: [{ name: "qwen3.6:latest", model: "qwen3.6:latest" }] }),
  })) as unknown as typeof fetch;
  assert.deepEqual(await loadedModels({ fetchImpl: impl }), ["qwen3.6:latest"]);

  const dead = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.deepEqual(await loadedModels({ fetchImpl: dead }), []);
});
