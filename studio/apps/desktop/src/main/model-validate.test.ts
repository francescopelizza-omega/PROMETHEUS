/**
 * model-validate.test.ts — node:test for the Model-Hub IPC zod seam (file 05 §1/§7/§8).
 *
 * model-ipc.ts is RELAY-ONLY and imports electron (so it is not unit-tested at the
 * seam, exactly like env-ipc.ts / ipc.ts). The testable invariant is the validation
 * seam: every `model:*` channel arg flows through these zod validators BEFORE
 * routing (a renderer is the least-trusted surface, C5; download drives a REAL
 * stage→nemesis pipeline and serve drives a child SPAWN). This file pins:
 *
 *   1. valid args parse to the coerced typed value (numbers parsed from the
 *      digit-string surface the test-double supports),
 *   2. invalid args reject with a SERIALIZABLE {kind:"invalid-args",message,…},
 *   3. an UNKNOWN runner/source is REJECTED (fail-closed — never dispatched),
 *   4. shell-metacharacter / control-char ids are REJECTED at the seam (inert argv).
 *
 * model-validate.ts imports the REAL `zod`; the decoupled runner maps it to the
 * same faithful double security-validate.test.ts uses (via zod-resolver.mjs
 * registered BEFORE the dynamic import). Production resolves the real zod via
 * electron-vite.
 *
 * Run: node --import ../../../apps/cli/dev-register.mjs --test model-validate.test.ts
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// Map `zod` to the local double BEFORE importing model-validate.ts.
register(new URL("./__test-doubles__/zod-resolver.mjs", import.meta.url));

const {
  validateModelHardware,
  validateModelSearch,
  validateModelInfo,
  validateModelFit,
  validateModelDownload,
  validateModelRemove,
  validateModelServe,
  validateModelUnserve,
  validateModelRepoint,
  validateModelFetchHf,
  validateModelInstallHfCli,
  validateModelConvert,
  validateModelInstallConverter,
  validateModelInstallTarget,
} = await import("./model-validate.js");

/** The shared discriminated outcome the validators return. */
type GuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { kind: string; message: string; detail?: string } };

/** Assert a result rejected with a serializable invalid-args error. */
function assertInvalidArgs(r: GuardResult<unknown>): void {
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, "invalid-args");
    assert.equal(typeof r.error.message, "string");
    assert.ok(r.error.message.length > 0);
    // must structured-clone (plain data, no Error prototype crossing IPC).
    assert.deepEqual(JSON.parse(JSON.stringify(r.error)), r.error);
  }
}

/* ── hardware ────────────────────────────────────────────────────────────────*/

test("validateModelHardware defaults rescan to false; honours true", () => {
  assert.deepEqual(validateModelHardware({}), { ok: true, value: { rescan: false } });
  assert.deepEqual(validateModelHardware({ rescan: true }), { ok: true, value: { rescan: true } });
});

/* ── search ──────────────────────────────────────────────────────────────────*/

test("validateModelSearch accepts a bare query + defaults freeOnly false", () => {
  const r = validateModelSearch({ q: "qwen3" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.q, "qwen3");
    assert.equal(r.value.freeOnly, false);
  }
});

test("validateModelSearch coerces a digit-string limit to a number", () => {
  const r = validateModelSearch({ q: "qwen3", limit: "25" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.limit, 25);
});

test("validateModelSearch REJECTS an unknown source (fail-closed)", () => {
  assertInvalidArgs(validateModelSearch({ q: "x", source: "torrent" }) as GuardResult<unknown>);
});

test("validateModelSearch REJECTS a non-digit limit", () => {
  assertInvalidArgs(validateModelSearch({ q: "x", limit: "lots" }) as GuardResult<unknown>);
});

/* ── info ────────────────────────────────────────────────────────────────────*/

test("validateModelInfo accepts an owner/repo id", () => {
  assert.deepEqual(validateModelInfo({ id: "Qwen/Qwen3-8B-GGUF" }), {
    ok: true,
    value: { id: "Qwen/Qwen3-8B-GGUF" },
  });
});

test("validateModelInfo REJECTS a shell-metacharacter id (inert argv, C5)", () => {
  assertInvalidArgs(validateModelInfo({ id: "evil; rm -rf /" }) as GuardResult<unknown>);
  assertInvalidArgs(validateModelInfo({ id: "x$(whoami)" }) as GuardResult<unknown>);
  assertInvalidArgs(validateModelInfo({ id: "a`b`" }) as GuardResult<unknown>);
});

/* ── fit ─────────────────────────────────────────────────────────────────────*/

test("validateModelFit accepts an id; coerces ctx", () => {
  const r = validateModelFit({ id: "qwen3-8b", ctx: "32768" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.id, "qwen3-8b");
    assert.equal(r.value.ctx, 32768);
  }
});

test("validateModelFit accepts params-only (no id)", () => {
  const r = validateModelFit({ params: "8b" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.params, "8b");
});

test("validateModelFit REJECTS when neither id nor params is supplied (fail-closed)", () => {
  assertInvalidArgs(validateModelFit({ ctx: "4096" }) as GuardResult<unknown>);
});

/* ── download (the GATED path) ──────────────────────────────────────────────*/

test("validateModelDownload accepts id+quant; defaults force false", () => {
  const r = validateModelDownload({ id: "Qwen/Qwen3-8B-GGUF", quant: "Q4_K_M" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.id, "Qwen/Qwen3-8B-GGUF");
    assert.equal(r.value.quant, "Q4_K_M");
    assert.equal(r.value.force, false);
  }
});

test("validateModelDownload threads a staged dir + runId, and PAIRS force with confirmForce", () => {
  const r = validateModelDownload({
    id: "x/y",
    quant: "Q8_0",
    staged: "/tmp/stage",
    force: true,
    confirmForce: true,
    runId: "dl-1",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.staged, "/tmp/stage");
    assert.equal(r.value.force, true);
    assert.equal(r.value.runId, "dl-1");
  }
});

test("model:download DROPS a bare force with no typed confirm (§9a fail-safe)", () => {
  // A download is nemesis-GATED, so `force` overrides a BLOCK. This seam used to honour it
  // unpaired, which made the renderer's typed-confirm dialog friction rather than a gate.
  const r = validateModelDownload({ id: "x/y", force: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.force, false);
});

test("model:remove's force is NOT paired — it means 'in use', not 'override the gate'", () => {
  const r = validateModelRemove({ id: "x/y", force: true });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.force, true);
});

test("validateModelDownload REJECTS an unknown source + a missing id", () => {
  assertInvalidArgs(validateModelDownload({ id: "x/y", source: "ftp" }) as GuardResult<unknown>);
  assertInvalidArgs(validateModelDownload({ quant: "Q4_K_M" }) as GuardResult<unknown>);
});

/* ── remove ──────────────────────────────────────────────────────────────────*/

test("validateModelRemove accepts id (+optional quant); defaults force false", () => {
  const r = validateModelRemove({ id: "x/y" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.force, false);
});

/* ── serve (drives the C8 supervisor) ───────────────────────────────────────*/

test("validateModelServe accepts id+quant+runner; coerces ctx+port", () => {
  const r = validateModelServe({
    id: "qwen3-8b",
    quant: "Q4_K_M",
    runner: "llamacpp",
    ctx: "32768",
    port: "8080",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.runner, "llamacpp");
    assert.equal(r.value.ctx, 32768);
    assert.equal(r.value.port, 8080);
    assert.equal(r.value.autostart, false);
  }
});

test("validateModelServe REJECTS an unknown runner (fail-closed — never spawned)", () => {
  assertInvalidArgs(validateModelServe({ id: "x", runner: "tensorrt" }) as GuardResult<unknown>);
});

test("validateModelServe REJECTS a control-char id", () => {
  assertInvalidArgs(validateModelServe({ id: "a\x00b" }) as GuardResult<unknown>);
});

/* ── unserve / repoint ──────────────────────────────────────────────────────*/

test("validateModelUnserve accepts a profile id", () => {
  assert.deepEqual(validateModelUnserve({ profileId: "qwen3-8b-q4-k-m-llamacpp" }), {
    ok: true,
    value: { profileId: "qwen3-8b-q4-k-m-llamacpp" },
  });
});

test("validateModelRepoint accepts a tool + an http base url", () => {
  const r = validateModelRepoint({ tool: "ide", baseUrl: "http://127.0.0.1:8080/v1" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.tool, "ide");
    assert.equal(r.value.baseUrl, "http://127.0.0.1:8080/v1");
  }
});

test("validateModelRepoint REJECTS a non-http base url (no file:// / data: smuggling)", () => {
  assertInvalidArgs(
    validateModelRepoint({ tool: "ide", baseUrl: "file:///etc/passwd" }) as GuardResult<unknown>,
  );
});

/* ── /hug: fetch → convert → install-target ─────────────────────────────────*/

test("validateModelFetchHf accepts a repo id; out/revision optional", () => {
  const r = validateModelFetchHf({ repo: "acme/tiny-model" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.repo, "acme/tiny-model");
    assert.equal(r.value.out, undefined);
  }
});

test("validateModelFetchHf accepts a local-path-shaped repo (spaces/parens allowed)", () => {
  // the /hug source can be a local folder with a name MODEL_ID's tighter charset
  // would reject (e.g. macOS's common "Name (v2)" pattern) — PATH is the right bound.
  const r = validateModelFetchHf({ repo: "/Users/me/Models/Tiny (v2)" });
  assert.equal(r.ok, true);
});

test("validateModelFetchHf REJECTS a missing repo", () => {
  assertInvalidArgs(validateModelFetchHf({}) as GuardResult<unknown>);
});

test("validateModelFetchHf REJECTS a control-char repo", () => {
  assertInvalidArgs(validateModelFetchHf({ repo: "a\nb" }) as GuardResult<unknown>);
});

test("validateModelInstallHfCli accepts an empty request", () => {
  assert.deepEqual(validateModelInstallHfCli({}), { ok: true, value: {} });
});

test("validateModelConvert accepts src (+optional quant/id/out)", () => {
  const r = validateModelConvert({
    src: "/tmp/hf-src/acme__tiny",
    quant: "q4_k_m",
    id: "acme/tiny",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.src, "/tmp/hf-src/acme__tiny");
    assert.equal(r.value.quant, "q4_k_m");
    assert.equal(r.value.id, "acme/tiny");
  }
});

test("validateModelConvert REJECTS a missing src", () => {
  assertInvalidArgs(validateModelConvert({}) as GuardResult<unknown>);
});

test("validateModelConvert REJECTS a control-char src", () => {
  assertInvalidArgs(validateModelConvert({ src: "/tmp/a\nb" }) as GuardResult<unknown>);
});

test("validateModelInstallConverter accepts an empty request", () => {
  assert.deepEqual(validateModelInstallConverter({}), { ok: true, value: {} });
});

test("validateModelInstallTarget accepts llamacpp/lmstudio/ollama with gguf", () => {
  const r = validateModelInstallTarget({
    target: "llamacpp",
    id: "acme/tiny",
    gguf: "/tmp/models/acme-tiny.gguf",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.target, "llamacpp");
    assert.equal(r.value.gguf, "/tmp/models/acme-tiny.gguf");
  }
});

test("validateModelInstallTarget accepts vllm with src (not gguf)", () => {
  const r = validateModelInstallTarget({
    target: "vllm",
    id: "acme/tiny",
    src: "/tmp/hf-src/acme__tiny",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.src, "/tmp/hf-src/acme__tiny");
});

test("validateModelInstallTarget REJECTS vllm without src", () => {
  assertInvalidArgs(
    validateModelInstallTarget({ target: "vllm", id: "acme/tiny" }) as GuardResult<unknown>,
  );
});

test("validateModelInstallTarget REJECTS a non-vllm target without gguf", () => {
  assertInvalidArgs(
    validateModelInstallTarget({ target: "ollama", id: "acme/tiny" }) as GuardResult<unknown>,
  );
});

test("validateModelInstallTarget REJECTS an unknown target (fail-closed)", () => {
  assertInvalidArgs(
    validateModelInstallTarget({
      target: "tensorrt",
      id: "acme/tiny",
      gguf: "/tmp/x.gguf",
    }) as GuardResult<unknown>,
  );
});
