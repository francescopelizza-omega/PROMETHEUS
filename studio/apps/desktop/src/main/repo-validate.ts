/**
 * main/repo-validate.ts — the ZOD validation seam for the GitHub Repo Manager IPC
 * (file 06 §3 / FEATURE #5a). Mirrors model-validate.ts / catalog-validate.ts:
 * every renderer-supplied argument to a `repo:*` channel is parsed by a zod schema
 * BEFORE repo-ipc.ts routes it to the engine-bridge repo client (which spawns the
 * `repo.py` sidecar — the ONLY arbitrary-URL clone path, hard-wired through
 * `_GIT_SAFE_FLAGS` + the REAL nemesis gate, 00-INDEX C6).
 *
 * The CLONE channel triggers a REAL stage → nemesis → promote | quarantine
 * pipeline, so the seam is strict and fail-closed:
 *   - the URL must be an http(s) / ssh / scp-form git URL (no `file://`, no
 *     `ext::`, no shell metacharacters) — an inert argv under shell:false;
 *   - `--force` is gated EXACTLY like the catalog seam: `force:true` is honoured
 *     ONLY when the renderer also sets `confirmForce:true` (the deep-red typed-
 *     confirm). Without the paired confirm, force is dropped — JS never silently
 *     force-promotes a nemesis BLOCK (C5/§8);
 *   - a malformed arg returns the SAME serializable {kind:"invalid-args",…}
 *     GuardResult the rest of the IPC uses.
 *
 * Pure schema code (no electron, no engine-bridge): real `zod` in production via
 * electron-vite; node:test maps it to the local double.
 */

import { type ZodTypeAny, z } from "zod";

import type { GuardResult, IpcErrorShape } from "./arg-guards.js";

/* ── leaf schemas ────────────────────────────────────────────────────────────*/

/**
 * A git remote URL. Accepts https / http / ssh / git protocols and the scp-form
 * (`git@host:owner/repo.git`). Bounded, control-char free, and free of shell
 * metacharacters (inert argv; the sidecar applies _GIT_SAFE_FLAGS itself). We do
 * NOT accept `file://` / `ext::` here — the sidecar neutralizes those transports,
 * but rejecting at the seam keeps the surface minimal.
 */
const REPO_URL = z
  .string()
  .trim()
  .min(1, "url must not be empty")
  .max(2048, "url is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "url contains control characters")
  .regex(/^[^;&|`$<>(){}\\\s]*$/, "url contains forbidden characters")
  .regex(
    /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)[^\s]+$/,
    "url must be an http(s) / ssh / git remote",
  );

/** A Studio repo index id (the `owner__name` slug the sidecar mints). */
const REPO_ID = z
  .string()
  .trim()
  .min(1, "id must not be empty")
  .max(256, "id is too long")
  .regex(/^[A-Za-z0-9._-]+$/, "id has invalid characters");

/** A branch / ref name (bounded; control-char + shell-meta free). */
const BRANCH = z
  .string()
  .trim()
  .min(1, "branch must not be empty")
  .max(256, "branch is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "branch contains control characters")
  .regex(/^[^;&|`$<>(){}\\\s]+$/, "branch has invalid characters")
  // a branch reaches a bare `git checkout <branch>` positional — reject a leading dash
  // so it can never be read as a git option (argv option-injection; spawn is shell:false).
  .regex(/^[^-]/, "branch must not start with a dash");

/** A commit SHA (full or abbreviated, 7..64 hex). */
const SHA = z
  .string()
  .trim()
  .min(4, "sha is too short")
  .max(64, "sha is too long")
  .regex(/^[0-9a-fA-F]+$/, "sha must be hex");

/** A staged dir path (drives the gate offline / in tests). */
const PATH = z
  .string()
  .trim()
  .min(1, "path must not be empty")
  .max(4096, "path is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "path contains control characters");

/** A catalog-item id this clone may back (git_clone method). */
const LINKED = z
  .string()
  .trim()
  .min(1, "linked id must not be empty")
  .max(256, "linked id is too long")
  .regex(/^[A-Za-z0-9._:,/+-]+$/, "linked id has invalid characters");

const RUN_ID = z
  .string()
  .trim()
  .min(1, "runId must not be empty when supplied")
  .max(128, "runId is too long")
  .regex(/^[A-Za-z0-9._:-]+$/, "runId has invalid characters");

/* ── per-channel argument schemas ───────────────────────────────────────────*/

/** repo:clone — url + branch + pin + staged + linked + force(+confirm). */
export const repoCloneSchema = z.object({
  url: REPO_URL,
  branch: BRANCH.optional(),
  pin: SHA.optional(),
  staged: PATH.optional(),
  linkedCatalogItemId: LINKED.optional(),
  force: z.boolean().optional().default(false),
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** repo:update — id + force(+confirm). */
export const repoUpdateSchema = z.object({
  id: REPO_ID,
  force: z.boolean().optional().default(false),
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** repo:pin — id + sha + force(+confirm). */
export const repoPinSchema = z.object({
  id: REPO_ID,
  sha: SHA,
  force: z.boolean().optional().default(false),
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** repo:branch — id + branch + force(+confirm). */
export const repoBranchSchema = z.object({
  id: REPO_ID,
  branch: BRANCH,
  force: z.boolean().optional().default(false),
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** repo:rescan — id + gateFresh. */
export const repoRescanSchema = z.object({
  id: REPO_ID,
  gateFresh: z.boolean().optional().default(false),
});

/** repo:remove — id. */
export const repoRemoveSchema = z.object({ id: REPO_ID });

/* ── the parse→GuardResult bridge ───────────────────────────────────────────*/

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

/* ── typed validators (what repo-ipc.ts calls) ──────────────────────────────*/

export interface RepoCloneArgs {
  url: string;
  branch?: string;
  pin?: string;
  staged?: string;
  linkedCatalogItemId?: string;
  /** TRUE only when force:true AND confirmForce:true both arrived (C5/§8). */
  force: boolean;
  runId?: string;
}
export function validateRepoClone(arg: unknown): GuardResult<RepoCloneArgs> {
  const r = runSchema(repoCloneSchema, asObject(arg));
  if (!r.ok) return r;
  const v: RepoCloneArgs = { url: r.value.url, force: r.value.force && r.value.confirmForce };
  if (r.value.branch !== undefined) v.branch = r.value.branch;
  if (r.value.pin !== undefined) v.pin = r.value.pin;
  if (r.value.staged !== undefined) v.staged = r.value.staged;
  if (r.value.linkedCatalogItemId !== undefined)
    v.linkedCatalogItemId = r.value.linkedCatalogItemId;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export interface RepoUpdateArgs {
  id: string;
  force: boolean;
  runId?: string;
}
export function validateRepoUpdate(arg: unknown): GuardResult<RepoUpdateArgs> {
  const r = runSchema(repoUpdateSchema, asObject(arg));
  if (!r.ok) return r;
  const v: RepoUpdateArgs = { id: r.value.id, force: r.value.force && r.value.confirmForce };
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export interface RepoPinArgs {
  id: string;
  sha: string;
  force: boolean;
  runId?: string;
}
export function validateRepoPin(arg: unknown): GuardResult<RepoPinArgs> {
  const r = runSchema(repoPinSchema, asObject(arg));
  if (!r.ok) return r;
  const v: RepoPinArgs = {
    id: r.value.id,
    sha: r.value.sha,
    force: r.value.force && r.value.confirmForce,
  };
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export interface RepoBranchArgs {
  id: string;
  branch: string;
  force: boolean;
  runId?: string;
}
export function validateRepoBranch(arg: unknown): GuardResult<RepoBranchArgs> {
  const r = runSchema(repoBranchSchema, asObject(arg));
  if (!r.ok) return r;
  const v: RepoBranchArgs = {
    id: r.value.id,
    branch: r.value.branch,
    force: r.value.force && r.value.confirmForce,
  };
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export interface RepoRescanArgs {
  id: string;
  gateFresh: boolean;
}
export function validateRepoRescan(arg: unknown): GuardResult<RepoRescanArgs> {
  const r = runSchema(repoRescanSchema, asObject(arg));
  if (!r.ok) return r;
  return { ok: true, value: { id: r.value.id, gateFresh: r.value.gateFresh } };
}

export function validateRepoRemove(arg: unknown): GuardResult<{ id: string }> {
  return runSchema(repoRemoveSchema, asObject(arg));
}
