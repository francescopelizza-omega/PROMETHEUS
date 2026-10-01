// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/env-validate.ts — the ZOD validation seam for the env IPC (file 04 §1/§3).
 *
 * Mirrors security-validate.ts exactly: every renderer-supplied argument to an
 * `env:*` / `pkg:*` / `cuda:*` channel is parsed by a zod schema BEFORE env-ipc.ts
 * routes it to engine-bridge's env client. A renderer is the least-trusted surface
 * (C5); these channels drive REAL pip/conda/nemesis operations (every fetch is
 * RCE), so the seam is strict and fail-closed:
 *   - an UNKNOWN sub-op is REJECTED (never dispatched — no silent fall-through);
 *   - a malformed arg returns the SAME serializable {kind:"invalid-args",message,
 *     detail} GuardResult the rest of the IPC uses, so env-ipc.ts branches
 *     identically and the renderer's onError fires (never a crash, never a pass).
 *
 * Pure schema code (no electron, no engine-bridge): the real `zod` resolves in
 * production via electron-vite; node:test maps it to the local double (the same
 * zod-resolver.mjs security-validate.test.ts uses). Bounds mirror
 * security-validate.ts's NAME / PATH / RUN_ID so the two seams cannot drift.
 */

import { type ZodTypeAny, z } from "zod";

import type { GuardResult, IpcErrorShape } from "./arg-guards.js";

/* ── leaf schemas (bounds aligned with security-validate.ts) ─────────────────*/

/**
 * An env id (`env_<hash>`) OR an env name/path the sidecar resolves. Looser than a
 * plugin NAME (paths carry `/`, `:`, `.`, `~`) but still string, non-empty,
 * bounded, control-char free. The sidecar does the real resolution; this rejects
 * obvious garbage at the seam.
 */
const ENV_REF = z
  .string()
  .trim()
  .min(1, "env reference must not be empty")
  .max(4096, "env reference is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "env reference contains control characters");

/** A display name for a new env (no path separators / control / shell metachars). */
const ENV_NAME = z
  .string()
  .trim()
  .min(1, "name must not be empty")
  .max(128, "name is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "name contains control characters")
  .regex(/^[^/\\;&|`$<>(){}]*$/, "name contains forbidden characters");

/**
 * A pip/conda SPEC (e.g. "transformers>=4.40", "torch", "git+https://…"). Specs
 * carry operators (<>=!~), extras ([cu121]), and URLs, so this is a conservative
 * allowlist of the metacharacters a spec legitimately needs — and NOTHING that
 * could break out of `shell:false` argv (no spaces-as-separators ambiguity, no
 * shell metacharacters). The engine + nemesis do the real parsing.
 */
const PKG_SPEC = z
  .string()
  .trim()
  .min(1, "spec must not be empty")
  .max(512, "spec is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "spec contains control characters")
  // NOTE: `<` and `>` are NOT forbidden — pip version operators (>=, <=, !=)
  // use them and engine-bridge spawns with shell:false, so they are inert as
  // argv. We DO block shell-substitution / command-chaining metacharacters.
  .regex(/^[^;&|`$(){}\\]*$/, "spec contains forbidden shell characters");

/** A filesystem path (requirements.txt / environment.yml / export target). */
const PATH = z
  .string()
  .trim()
  .min(1, "path must not be empty")
  .max(4096, "path is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "path contains control characters");

/** A python version hint (e.g. "3.11", "3.12.4"). */
const PY_VERSION = z
  .string()
  .trim()
  .min(1, "python version must not be empty")
  .max(16, "python version is too long")
  .regex(/^[0-9][0-9.]*$/, "python version has invalid characters");

/** An index URL for a CUDA torch wheel line (https only, bounded). */
const INDEX_URL = z
  .string()
  .trim()
  .min(1, "index url must not be empty")
  .max(2048, "index url is too long")
  .regex(/^https?:\/\/\S+$/, "index url must be an http(s) url");

/** A CUDA toolkit version hint (e.g. "12.1"). */
const TOOLKIT = z
  .string()
  .trim()
  .min(1, "toolkit version must not be empty")
  .max(16, "toolkit version is too long")
  .regex(/^[0-9][0-9.]*$/, "toolkit version has invalid characters");

const RUN_ID = z
  .string()
  .trim()
  .min(1, "runId must not be empty when supplied")
  .max(128, "runId is too long")
  .regex(/^[A-Za-z0-9._:-]+$/, "runId has invalid characters");

/** A list of one-or-more pip specs (install/update/upgrade/remove). */
const SPEC_LIST = z.array(PKG_SPEC).min(1, "at least one spec is required").max(256);

/** A package scope target (in-venv / global / conda). */
const SCOPE = z.enum(["venv", "global", "conda", "project", "engine"]);

/* ── per-channel argument schemas ───────────────────────────────────────────*/

/** env:list — no args. */
export const envListSchema = z.object({});

/** env:create — name + kind + python hint + location. */
export const envCreateSchema = z.object({
  name: ENV_NAME,
  kind: z.enum(["venv", "virtualenv", "conda"]).optional().default("venv"),
  python: PY_VERSION.optional(),
  location: z.enum(["project", "global"]).optional().default("project"),
  templateId: z.string().trim().max(128).optional(),
  confirm: z.boolean().optional().default(false),
});

/** env:clone — from + to + confirm/force (GATED reinstall). */
export const envCloneSchema = z.object({
  from: ENV_REF,
  to: ENV_NAME,
  confirm: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   *
   * `force` alone is not enough: it overrides a nemesis BLOCK, and anything that reaches
   * the preload bridge could set it. The pair travels together or the override does not
   * happen — see the `force && confirmForce` fold in the validator below.
   */
  confirmForce: z.boolean().optional().default(false),
});

/** env:delete — id + confirm (typed confirm collected by the renderer). */
export const envDeleteSchema = z.object({
  id: ENV_REF,
  confirm: z.boolean().optional().default(false),
});

/** env:use — id. */
export const envUseSchema = z.object({ id: ENV_REF });

/** env:export — id + optional target file. */
export const envExportSchema = z.object({ id: ENV_REF, to: PATH.optional() });

/** env:import — file + name + python hint + confirm/force (GATED installs). */
export const envImportSchema = z.object({
  file: PATH,
  name: ENV_NAME,
  python: PY_VERSION.optional(),
  confirm: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   *
   * `force` alone is not enough: it overrides a nemesis BLOCK, and anything that reaches
   * the preload bridge could set it. The pair travels together or the override does not
   * happen — see the `force && confirmForce` fold in the validator below.
   */
  confirmForce: z.boolean().optional().default(false),
});

/** env:doctor — id. */
export const envDoctorSchema = z.object({ id: ENV_REF });

/** pkg:list — env ref. */
export const pkgListSchema = z.object({ envId: ENV_REF });

/** pkg:install / pkg:update — env + specs + scope + confirm/force (GATED). */
export const pkgInstallSchema = z.object({
  envId: ENV_REF,
  spec: SPEC_LIST,
  scope: SCOPE.optional(),
  confirm: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   *
   * `force` alone is not enough: it overrides a nemesis BLOCK, and anything that reaches
   * the preload bridge could set it. The pair travels together or the override does not
   * happen — see the `force && confirmForce` fold in the validator below.
   */
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** pkg:upgrade — env + OPTIONAL specs (bulk; sidecar resolves outdated when empty). */
export const pkgUpgradeSchema = z.object({
  envId: ENV_REF,
  spec: z.array(PKG_SPEC).max(256).optional(),
  confirm: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   *
   * `force` alone is not enough: it overrides a nemesis BLOCK, and anything that reaches
   * the preload bridge could set it. The pair travels together or the override does not
   * happen — see the `force && confirmForce` fold in the validator below.
   */
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** pkg:remove / pkg:uninstall — env + one-or-more package names + confirm. */
export const pkgRemoveSchema = z.object({
  envId: ENV_REF,
  pkgs: SPEC_LIST,
  confirm: z.boolean().optional().default(false),
});

/** pkg:enable / pkg:disable — env + a single package name + confirm. */
export const pkgToggleSchema = z.object({
  envId: ENV_REF,
  pkg: PKG_SPEC,
  confirm: z.boolean().optional().default(false),
});

/** cuda:info — no args. */
export const cudaInfoSchema = z.object({});

/** cuda:torch — env + optional index url + confirm/force (GATED). */
export const cudaTorchSchema = z.object({
  envId: ENV_REF,
  index: INDEX_URL.optional(),
  confirm: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   *
   * `force` alone is not enough: it overrides a nemesis BLOCK, and anything that reaches
   * the preload bridge could set it. The pair travels together or the override does not
   * happen — see the `force && confirmForce` fold in the validator below.
   */
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** cuda:install — optional toolkit version + confirm/force (gated installer). */
export const cudaInstallSchema = z.object({
  toolkit: TOOLKIT.optional(),
  confirm: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  /**
   * Proof the user typed the FORCE_TOKEN into ForceGate for THIS action (§9a).
   *
   * `force` alone is not enough: it overrides a nemesis BLOCK, and anything that reaches
   * the preload bridge could set it. The pair travels together or the override does not
   * happen — see the `force && confirmForce` fold in the validator below.
   */
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/* ── the parse→GuardResult bridge (identical to security-validate.ts) ────────*/

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

/* ── typed validators (what env-ipc.ts calls) ───────────────────────────────*/

export interface EnvCreateArgs {
  name: string;
  kind: "venv" | "virtualenv" | "conda";
  python?: string;
  location: "project" | "global";
  templateId?: string;
  confirm: boolean;
}
export function validateEnvCreate(arg: unknown): GuardResult<EnvCreateArgs> {
  const r = runSchema(envCreateSchema, asObject(arg));
  if (!r.ok) return r;
  const v: EnvCreateArgs = {
    name: r.value.name,
    kind: r.value.kind,
    location: r.value.location,
    confirm: r.value.confirm,
  };
  if (r.value.python !== undefined) v.python = r.value.python;
  if (r.value.templateId !== undefined) v.templateId = r.value.templateId;
  return { ok: true, value: v };
}

export interface EnvCloneArgs {
  from: string;
  to: string;
  confirm: boolean;
  force: boolean;
}
export function validateEnvClone(arg: unknown): GuardResult<EnvCloneArgs> {
  const r = runSchema(envCloneSchema, asObject(arg));
  if (!r.ok) return r;
  return {
    ok: true,
    value: {
      from: r.value.from,
      to: r.value.to,
      confirm: r.value.confirm,
      force: r.value.force && r.value.confirmForce,
    },
  };
}

export interface EnvDeleteArgs {
  id: string;
  confirm: boolean;
}
export function validateEnvDelete(arg: unknown): GuardResult<EnvDeleteArgs> {
  const r = runSchema(envDeleteSchema, asObject(arg));
  if (!r.ok) return r;
  return { ok: true, value: { id: r.value.id, confirm: r.value.confirm } };
}

export function validateEnvUse(arg: unknown): GuardResult<{ id: string }> {
  return runSchema(envUseSchema, asObject(arg));
}

export interface EnvExportArgs {
  id: string;
  to?: string;
}
export function validateEnvExport(arg: unknown): GuardResult<EnvExportArgs> {
  const r = runSchema(envExportSchema, asObject(arg));
  if (!r.ok) return r;
  const v: EnvExportArgs = { id: r.value.id };
  if (r.value.to !== undefined) v.to = r.value.to;
  return { ok: true, value: v };
}

export interface EnvImportArgs {
  file: string;
  name: string;
  python?: string;
  confirm: boolean;
  force: boolean;
}
export function validateEnvImport(arg: unknown): GuardResult<EnvImportArgs> {
  const r = runSchema(envImportSchema, asObject(arg));
  if (!r.ok) return r;
  const v: EnvImportArgs = {
    file: r.value.file,
    name: r.value.name,
    confirm: r.value.confirm,
    force: r.value.force && r.value.confirmForce,
  };
  if (r.value.python !== undefined) v.python = r.value.python;
  return { ok: true, value: v };
}

export function validateEnvDoctor(arg: unknown): GuardResult<{ id: string }> {
  return runSchema(envDoctorSchema, asObject(arg));
}

export function validatePkgList(arg: unknown): GuardResult<{ envId: string }> {
  return runSchema(pkgListSchema, asObject(arg));
}

export interface PkgInstallArgs {
  envId: string;
  spec: string[];
  scope?: "venv" | "global" | "conda" | "project" | "engine";
  confirm: boolean;
  force: boolean;
  runId?: string;
}
export function validatePkgInstall(arg: unknown): GuardResult<PkgInstallArgs> {
  const r = runSchema(pkgInstallSchema, asObject(arg));
  if (!r.ok) return r;
  const v: PkgInstallArgs = {
    envId: r.value.envId,
    spec: r.value.spec,
    confirm: r.value.confirm,
    force: r.value.force && r.value.confirmForce,
  };
  if (r.value.scope !== undefined) v.scope = r.value.scope;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export interface PkgUpgradeArgs {
  envId: string;
  spec?: string[];
  confirm: boolean;
  force: boolean;
  runId?: string;
}
export function validatePkgUpgrade(arg: unknown): GuardResult<PkgUpgradeArgs> {
  const r = runSchema(pkgUpgradeSchema, asObject(arg));
  if (!r.ok) return r;
  const v: PkgUpgradeArgs = {
    envId: r.value.envId,
    confirm: r.value.confirm,
    force: r.value.force && r.value.confirmForce,
  };
  if (r.value.spec !== undefined) v.spec = r.value.spec;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export interface PkgRemoveArgs {
  envId: string;
  pkgs: string[];
  confirm: boolean;
}
export function validatePkgRemove(arg: unknown): GuardResult<PkgRemoveArgs> {
  const r = runSchema(pkgRemoveSchema, asObject(arg));
  if (!r.ok) return r;
  return {
    ok: true,
    value: { envId: r.value.envId, pkgs: r.value.pkgs, confirm: r.value.confirm },
  };
}

export interface PkgToggleArgs {
  envId: string;
  pkg: string;
  confirm: boolean;
}
export function validatePkgToggle(arg: unknown): GuardResult<PkgToggleArgs> {
  const r = runSchema(pkgToggleSchema, asObject(arg));
  if (!r.ok) return r;
  return { ok: true, value: { envId: r.value.envId, pkg: r.value.pkg, confirm: r.value.confirm } };
}

export interface CudaTorchArgs {
  envId: string;
  index?: string;
  confirm: boolean;
  force: boolean;
  runId?: string;
}
export function validateCudaTorch(arg: unknown): GuardResult<CudaTorchArgs> {
  const r = runSchema(cudaTorchSchema, asObject(arg));
  if (!r.ok) return r;
  const v: CudaTorchArgs = {
    envId: r.value.envId,
    confirm: r.value.confirm,
    force: r.value.force && r.value.confirmForce,
  };
  if (r.value.index !== undefined) v.index = r.value.index;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export interface CudaInstallArgs {
  toolkit?: string;
  confirm: boolean;
  force: boolean;
  runId?: string;
}
export function validateCudaInstall(arg: unknown): GuardResult<CudaInstallArgs> {
  const r = runSchema(cudaInstallSchema, asObject(arg));
  if (!r.ok) return r;
  const v: CudaInstallArgs = {
    confirm: r.value.confirm,
    force: r.value.force && r.value.confirmForce,
  };
  if (r.value.toolkit !== undefined) v.toolkit = r.value.toolkit;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}
