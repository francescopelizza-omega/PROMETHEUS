/**
 * main/model-validate.ts — the ZOD validation seam for the Model-Hub IPC
 * (file 05 §1/§7/§8). Mirrors env-validate.ts / security-validate.ts exactly:
 * every renderer-supplied argument to a `model:*` channel is parsed by a zod
 * schema BEFORE model-ipc.ts routes it to the engine-bridge modelhub client.
 *
 * A renderer is the least-trusted surface (C5); the DOWNLOAD channel drives a REAL
 * stage → nemesis → admit pipeline and SERVE drives the MAIN-process supervisor to
 * spawn a child, so the seam is strict and fail-closed:
 *   - an UNKNOWN runner/source/modality is REJECTED (never dispatched);
 *   - a malformed arg returns the SAME serializable {kind:"invalid-args",message,
 *     detail} GuardResult the rest of the IPC uses, so model-ipc.ts branches
 *     identically and the renderer's onError fires (never a crash, never a pass).
 *
 * Pure schema code (no electron, no engine-bridge): the real `zod` resolves in
 * production via electron-vite; node:test maps it to the local double (the same
 * zod-resolver.mjs security-validate.test.ts uses). Bounds mirror
 * env-validate.ts's NAME / PATH / RUN_ID so the seams cannot drift.
 *
 * NOTE on numeric / opaque fields: the test-double zod surface is string/enum/
 * bool/array/object only (no z.number / z.record). Numeric fields (limit/ctx/port)
 * are validated as bounded DIGIT STRINGS and coerced; the opaque `hw` (an hw.scan
 * envelope) + the `sha256` map are passed through UNVALIDATED here and serialized
 * by model-ipc.ts as JSON — they are inert argv to the sidecar (shell:false), and
 * the sidecar + nemesis do the real parsing (C5: JS never decides "safe").
 */

import { type ZodTypeAny, z } from "zod";

import { type GuardResult, type IpcErrorShape, invalidArgs } from "./arg-guards.js";

/* ── leaf schemas (bounds aligned with env-validate.ts) ──────────────────────*/

/**
 * A model id (`owner/repo`, `ollama:qwen3:8b`, a catalog id). Looser than a plugin
 * NAME (carries `/`, `:`, `.`, `-`) but still string, non-empty, bounded,
 * control-char free, and no shell metacharacters (inert argv under shell:false).
 */
const MODEL_ID = z
  .string()
  .trim()
  .min(1, "model id must not be empty")
  .max(512, "model id is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "model id contains control characters")
  .regex(/^[^;&|`$<>(){}\\]*$/, "model id contains forbidden shell characters");

/** A quant label (e.g. "Q4_K_M", "FP8", "AWQ-4bit", "F16"). */
const QUANT = z
  .string()
  .trim()
  .min(1, "quant must not be empty")
  .max(64, "quant is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "quant contains control characters")
  .regex(/^[A-Za-z0-9._+-]+$/, "quant has invalid characters");

/** A filesystem path (a staged dir / a local .gguf). */
const PATH = z
  .string()
  .trim()
  .min(1, "path must not be empty")
  .max(4096, "path is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "path contains control characters");

/** A SPDX-ish license string (surfaced + policy-gated; never executed). */
const LICENSE = z
  .string()
  .trim()
  .min(1, "license must not be empty")
  .max(128, "license is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "license contains control characters");

/** A free-text search query (bounded; control-char free). */
const QUERY = z
  .string()
  .trim()
  .max(256, "query is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "query contains control characters");

/** A nominal-params hint (e.g. "8b", "70B", "30B-A3B"). */
const PARAMS = z
  .string()
  .trim()
  .min(1, "params must not be empty")
  .max(32, "params is too long")
  .regex(/^[0-9A-Za-z._-]+$/, "params has invalid characters");

/** A model family / modality facet token (e.g. "qwen3", "text", "embedding"). */
const FACET = z
  .string()
  .trim()
  .min(1, "facet must not be empty")
  .max(64, "facet is too long")
  .regex(/^[A-Za-z0-9._-]+$/, "facet has invalid characters");

/** A bounded non-negative integer expressed as a digit string (no z.number in the double). */
function intString(maxDigits: number, label: string) {
  return z
    .string()
    .trim()
    .min(1, `${label} must not be empty`)
    .max(maxDigits, `${label} is too long`)
    .regex(/^[0-9]+$/, `${label} must be a non-negative integer`);
}

const LIMIT = intString(4, "limit");
const CTX = intString(8, "ctx");
const PORT = intString(5, "port");

const RUN_ID = z
  .string()
  .trim()
  .min(1, "runId must not be empty when supplied")
  .max(128, "runId is too long")
  .regex(/^[A-Za-z0-9._:-]+$/, "runId has invalid characters");

const SOURCE = z.enum(["hf", "ollama"]);
const DL_SOURCE = z.enum(["hf", "ollama", "url"]);
const RUNNER = z.enum(["llamacpp", "vllm", "ollama"]);

/* ── per-channel argument schemas ───────────────────────────────────────────*/

/** model:hardware — optional rescan flag. */
export const modelHardwareSchema = z.object({
  rescan: z.boolean().optional().default(false),
});

/** model:search — query + modality + source + free-only + limit. */
export const modelSearchSchema = z.object({
  q: QUERY.optional(),
  modality: FACET.optional(),
  source: SOURCE.optional(),
  freeOnly: z.boolean().optional().default(false),
  limit: LIMIT.optional(),
});

/** model:info — id. */
export const modelInfoSchema = z.object({ id: MODEL_ID });

/** model:fit — id | params/family + ctx + (opaque hw threaded by model-ipc). */
export const modelFitSchema = z.object({
  id: MODEL_ID.optional(),
  params: PARAMS.optional(),
  family: FACET.optional(),
  ctx: CTX.optional(),
});

/** model:download — id + quant + source + license + staged + force (GATED). */
export const modelDownloadSchema = z.object({
  id: MODEL_ID,
  quant: QUANT.optional(),
  source: DL_SOURCE.optional(),
  license: LICENSE.optional(),
  staged: PATH.optional(),
  force: z.boolean().optional().default(false),
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS download (§9a).
   *
   * A model download is nemesis-GATED (see the "staging … for the nemesis gate" progress
   * line in model-ipc), so `force` here overrides a BLOCK. It is honoured only paired.
   * NOTE: `model:remove`'s `force` is deliberately NOT paired — that one means "delete even
   * though a ServeProfile references it", which is not a gate override.
   */
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** model:library — optional modality filter. */
export const modelLibrarySchema = z.object({ modality: FACET.optional() });

/** model:remove — id + optional quant + force. */
export const modelRemoveSchema = z.object({
  id: MODEL_ID,
  quant: QUANT.optional(),
  force: z.boolean().optional().default(false),
});

/** model:serve — id + quant + runner + gguf + ctx + port + autostart (C8). */
export const modelServeSchema = z.object({
  id: MODEL_ID,
  quant: QUANT.optional(),
  runner: RUNNER.optional(),
  gguf: PATH.optional(),
  ctx: CTX.optional(),
  port: PORT.optional(),
  autostart: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** model:unserve — the serve-profile id. */
export const modelUnserveSchema = z.object({ profileId: MODEL_ID });

/** model:repoint — tool + base-url (§6). */
export const modelRepointSchema = z.object({
  tool: FACET,
  baseUrl: z
    .string()
    .trim()
    .min(1, "base url must not be empty")
    .max(2048, "base url is too long")
    .regex(/^https?:\/\/\S+$/, "base url must be an http(s) url"),
});

/* ── the parse→GuardResult bridge (identical to env-validate.ts) ─────────────*/

function toIpcError(err: z.ZodError): IpcErrorShape {
  const first = err.issues[0];
  const message = first?.message ?? "invalid arguments";
  const path = first?.path?.join(".") ?? "";
  return path
    ? { kind: "invalid-args", message, detail: `at "${path}"` }
    : { kind: "invalid-args", message };
}

export function runSchema<S extends ZodTypeAny>(
  schema: S,
  input: unknown,
): GuardResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: toIpcError(parsed.error) };
}

function asObject(arg: unknown): Record<string, unknown> {
  return arg && typeof arg === "object" && !Array.isArray(arg)
    ? (arg as Record<string, unknown>)
    : {};
}

/* ── typed validators (what model-ipc.ts calls) ─────────────────────────────*/

export interface ModelHardwareArgs {
  rescan: boolean;
}
export function validateModelHardware(arg: unknown): GuardResult<ModelHardwareArgs> {
  const r = runSchema(modelHardwareSchema, asObject(arg));
  if (!r.ok) return r;
  return { ok: true, value: { rescan: r.value.rescan } };
}

export interface ModelSearchArgs {
  q?: string;
  modality?: string;
  source?: "hf" | "ollama";
  freeOnly: boolean;
  limit?: number;
}
export function validateModelSearch(arg: unknown): GuardResult<ModelSearchArgs> {
  const r = runSchema(modelSearchSchema, asObject(arg));
  if (!r.ok) return r;
  const v: ModelSearchArgs = { freeOnly: r.value.freeOnly };
  if (r.value.q !== undefined) v.q = r.value.q;
  if (r.value.modality !== undefined) v.modality = r.value.modality;
  if (r.value.source !== undefined) v.source = r.value.source;
  if (r.value.limit !== undefined) v.limit = Number.parseInt(r.value.limit, 10);
  return { ok: true, value: v };
}

export function validateModelInfo(arg: unknown): GuardResult<{ id: string }> {
  return runSchema(modelInfoSchema, asObject(arg));
}

export interface ModelFitArgs {
  id?: string;
  params?: string;
  family?: string;
  ctx?: number;
}
export function validateModelFit(arg: unknown): GuardResult<ModelFitArgs> {
  const r = runSchema(modelFitSchema, asObject(arg));
  if (!r.ok) return r;
  // require at least one of id / params (the sidecar fails closed otherwise).
  if (r.value.id === undefined && r.value.params === undefined) {
    return { ok: false, error: { kind: "invalid-args", message: "fit needs an id or params" } };
  }
  const v: ModelFitArgs = {};
  if (r.value.id !== undefined) v.id = r.value.id;
  if (r.value.params !== undefined) v.params = r.value.params;
  if (r.value.family !== undefined) v.family = r.value.family;
  if (r.value.ctx !== undefined) v.ctx = Number.parseInt(r.value.ctx, 10);
  return { ok: true, value: v };
}

export interface ModelDownloadArgs {
  id: string;
  quant?: string;
  source?: "hf" | "ollama" | "url";
  license?: string;
  staged?: string;
  force: boolean;
  runId?: string;
}
export function validateModelDownload(arg: unknown): GuardResult<ModelDownloadArgs> {
  const r = runSchema(modelDownloadSchema, asObject(arg));
  if (!r.ok) return r;
  const v: ModelDownloadArgs = { id: r.value.id, force: r.value.force && r.value.confirmForce };
  if (r.value.quant !== undefined) v.quant = r.value.quant;
  if (r.value.source !== undefined) v.source = r.value.source;
  if (r.value.license !== undefined) v.license = r.value.license;
  if (r.value.staged !== undefined) v.staged = r.value.staged;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export interface ModelPullArgs {
  id: string;
  tag?: string;
  runId?: string;
}
/** Validate a `model:pull` (real ollama install) request — a bare id + optional tag. */
export function validateModelPull(arg: unknown): GuardResult<ModelPullArgs> {
  const o = asObject(arg);
  if (typeof o.id !== "string" || o.id.trim() === "") {
    return invalidArgs("model pull requires a string id");
  }
  const v: ModelPullArgs = { id: o.id };
  if (typeof o.tag === "string") v.tag = o.tag;
  if (typeof o.runId === "string") v.runId = o.runId;
  return { ok: true, value: v };
}

export interface ModelInstallRunnerArgs {
  runner: "ollama";
  runId?: string;
}
/** Validate a `model:installRunner` request — an optional runner (only "ollama"). */
export function validateModelInstallRunner(arg: unknown): GuardResult<ModelInstallRunnerArgs> {
  const o = asObject(arg);
  if (o.runner !== undefined && o.runner !== "ollama") {
    return invalidArgs("only the 'ollama' runner is supported");
  }
  const v: ModelInstallRunnerArgs = { runner: "ollama" };
  if (typeof o.runId === "string") v.runId = o.runId;
  return { ok: true, value: v };
}

export interface ModelLibraryArgs {
  modality?: string;
}
export function validateModelLibrary(arg: unknown): GuardResult<ModelLibraryArgs> {
  const r = runSchema(modelLibrarySchema, asObject(arg));
  if (!r.ok) return r;
  const v: ModelLibraryArgs = {};
  if (r.value.modality !== undefined) v.modality = r.value.modality;
  return { ok: true, value: v };
}

export interface ModelRemoveArgs {
  id: string;
  quant?: string;
  force: boolean;
}
export function validateModelRemove(arg: unknown): GuardResult<ModelRemoveArgs> {
  const r = runSchema(modelRemoveSchema, asObject(arg));
  if (!r.ok) return r;
  const v: ModelRemoveArgs = { id: r.value.id, force: r.value.force };
  if (r.value.quant !== undefined) v.quant = r.value.quant;
  return { ok: true, value: v };
}

export interface ModelServeArgs {
  id: string;
  quant?: string;
  runner?: "llamacpp" | "vllm" | "ollama";
  gguf?: string;
  ctx?: number;
  port?: number;
  autostart: boolean;
  runId?: string;
}
export function validateModelServe(arg: unknown): GuardResult<ModelServeArgs> {
  const r = runSchema(modelServeSchema, asObject(arg));
  if (!r.ok) return r;
  const v: ModelServeArgs = { id: r.value.id, autostart: r.value.autostart };
  if (r.value.quant !== undefined) v.quant = r.value.quant;
  if (r.value.runner !== undefined) v.runner = r.value.runner;
  if (r.value.gguf !== undefined) v.gguf = r.value.gguf;
  if (r.value.ctx !== undefined) v.ctx = Number.parseInt(r.value.ctx, 10);
  if (r.value.port !== undefined) v.port = Number.parseInt(r.value.port, 10);
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export function validateModelUnserve(arg: unknown): GuardResult<{ profileId: string }> {
  return runSchema(modelUnserveSchema, asObject(arg));
}

export interface ModelRepointArgs {
  tool: string;
  baseUrl: string;
}
export function validateModelRepoint(arg: unknown): GuardResult<ModelRepointArgs> {
  const r = runSchema(modelRepointSchema, asObject(arg));
  if (!r.ok) return r;
  return { ok: true, value: { tool: r.value.tool, baseUrl: r.value.baseUrl } };
}
