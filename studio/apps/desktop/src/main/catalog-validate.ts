/**
 * main/catalog-validate.ts — the ZOD validation seam for the Catalog IPC
 * (file 06 §4 / §8). Mirrors model-validate.ts / env-validate.ts EXACTLY: every
 * renderer-supplied argument to a `catalog:*` channel is parsed by a zod schema
 * BEFORE catalog-ipc.ts routes it to the engine-bridge catalog/lifecycle client.
 *
 * A renderer is the least-trusted surface (C5); the INSTALL/UNINSTALL/BUNDLE/SYNC/
 * SCAFFOLD channels drive a REAL prepare_nemesis → enforce_gate pipeline in the
 * engine, so the seam is strict and fail-closed:
 *   - an UNKNOWN action/component/host is REJECTED (never dispatched);
 *   - `--force` is NOT a free-form flag: the validator REFUSES `force:true` unless
 *     the renderer ALSO sets `confirmForce:true` (the deep-red typed-confirm the
 *     UI captures via file-03's flow). Without the paired confirm, `force` is
 *     dropped — JS never silently force-overrides a nemesis BLOCK (C5/§8);
 *   - a malformed arg returns the SAME serializable {kind:"invalid-args",message,
 *     detail} GuardResult the rest of the IPC uses, so catalog-ipc.ts branches
 *     identically and the renderer's onError fires (never a crash, never a pass).
 *
 * Pure schema code (no electron, no engine-bridge): the real `zod` resolves in
 * production via electron-vite; node:test maps it to the local double (the same
 * zod-resolver.mjs the other validators use). Bounds mirror env-validate.ts /
 * model-validate.ts so the seams cannot drift.
 *
 * NOTE on the test-double zod surface: string/enum/bool/array/object only (no
 * z.number / z.record). The single numeric-ish field here is the install/audit
 * `name` which may carry the surgical `plugin:comp1,comp2` form — validated as a
 * bounded NAME string; the engine + nemesis do the real parsing (C5).
 */

import { type ZodTypeAny, z } from "zod";

import type { GuardResult, IpcErrorShape } from "./arg-guards.js";

/* ── leaf schemas (bounds aligned with model-validate.ts) ────────────────────*/

/**
 * A registry NAME / id (a plugin/app/worldsim/skill id). May carry the surgical
 * `plugin:comp1,comp2` install form, so `:` and `,` are allowed alongside the
 * `owner/repo`-ish punctuation; still non-empty, bounded, control-char free, and
 * free of shell metacharacters (inert argv under shell:false).
 */
const NAME = z
  .string()
  .trim()
  .min(1, "name must not be empty")
  .max(256, "name is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "name contains control characters")
  .regex(/^[A-Za-z0-9._:,/+-]+$/, "name has invalid characters");

/** A detected-agent / host id (claude, codex, cursor, gemini, windsurf, zed, …). */
const HOST = z
  .string()
  .trim()
  .min(1, "host must not be empty")
  .max(64, "host is too long")
  .regex(/^[A-Za-z0-9._-]+$/, "host has invalid characters");

/**
 * A comma-separated component selection for `--only` / `--skip` (the surgical
 * install surface). Each token is component-id shaped; the whole string is
 * bounded + control-char free + shell-meta free.
 */
const COMPONENTS = z
  .string()
  .trim()
  .min(1, "components must not be empty")
  .max(512, "components is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "components contains control characters")
  .regex(/^[A-Za-z0-9._,+-]+$/, "components has invalid characters");

/** A short free-text trigger / body / tools string for scaffold-skill (bounded). */
const TEXT = z
  .string()
  .trim()
  .min(1, "text must not be empty")
  .max(4096, "text is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f\x7f]*$/, "text contains control characters");

/** A filesystem path (apps/worldsim --path). */
const PATH = z
  .string()
  .trim()
  .min(1, "path must not be empty")
  .max(4096, "path is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "path contains control characters");

/** A version label (apps/worldsim --version, e.g. "2", "v2.1", "1.0.0"). */
const VERSION = z
  .string()
  .trim()
  .min(1, "version must not be empty")
  .max(64, "version is too long")
  .regex(/^[A-Za-z0-9._+-]+$/, "version has invalid characters");

const RUN_ID = z
  .string()
  .trim()
  .min(1, "runId must not be empty when supplied")
  .max(128, "runId is too long")
  .regex(/^[A-Za-z0-9._:-]+$/, "runId has invalid characters");

/** The lifecycle ACTION for the apps/worldsim/models verb sets (4th/8th/3rd fn). */
const APP_ACTION = z.enum([
  "list",
  "installed",
  "install",
  "uninstall",
  "update",
  "update-all",
  "enable",
  "disable",
  "restart",
  "status",
  "logs",
  "open",
  "versions",
  "rollback",
]);

/** The catalog SURFACE a generic `catalog:*` read targets. */
const CATALOG_SURFACE = z.enum(["apps", "worldsim", "models", "localai"]);

/** The localai sub-read. */
const LOCALAI_ACTION = z.enum(["audit", "models", "endpoints", "show"]);

/** The component a plugin enable/disable may target. */
const COMPONENT = z.enum(["hooks", "mcp"]);

/* ── per-channel argument schemas ───────────────────────────────────────────*/

/** catalog:info / where / audit / status — a single registry NAME. */
export const catalogNameSchema = z.object({ name: NAME });

/** catalog:audit — name + the GLOBAL strict / gate-fresh flags. */
export const catalogAuditSchema = z.object({
  name: NAME,
  strict: z.boolean().optional().default(false),
  gateFresh: z.boolean().optional().default(false),
});

/** catalog:status — accepts the literal "all" or a NAME (NAME already permits it). */
export const catalogStatusSchema = z.object({ name: NAME });

/** catalog:inventory — optional host filter. */
export const catalogInventorySchema = z.object({ host: HOST.optional() });

/** catalog:apps / catalog:worldsim READ — surface + action + tool + path/version. */
export const catalogRawSchema = z.object({
  surface: CATALOG_SURFACE,
  // an action reaches the engine as a subcommand positional — constrain the charset +
  // forbid a leading dash so it can never be read as an option (argv option-injection;
  // spawns are shell:false). Actions are short verbs ("list"/"info"/"run"/…).
  action: z
    .string()
    .trim()
    .min(1, "action must not be empty")
    .max(64, "action is too long")
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "action has invalid characters")
    .optional(),
  tool: NAME.optional(),
  path: PATH.optional(),
  version: VERSION.optional(),
  localaiAction: LOCALAI_ACTION.optional(),
});

/** catalog:install — name + host(s) + only/skip + arm + dryRun + yes + strict + force. */
export const catalogInstallSchema = z.object({
  name: NAME,
  host: z.array(HOST).max(16).optional(),
  only: COMPONENTS.optional(),
  skip: COMPONENTS.optional(),
  arm: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(true),
  yes: z.boolean().optional().default(false),
  strict: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  /** the deep-red typed-confirm; force is DROPPED unless this is true (C5/§8). */
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** catalog:uninstall — name + host(s) + only/skip + dryRun + yes. */
export const catalogUninstallSchema = z.object({
  name: NAME,
  host: z.array(HOST).max(16).optional(),
  only: COMPONENTS.optional(),
  skip: COMPONENTS.optional(),
  dryRun: z.boolean().optional().default(true),
  yes: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** catalog:enable / catalog:disable — name + only + component + host(s). */
export const catalogToggleSchema = z.object({
  name: NAME,
  only: COMPONENTS.optional(),
  component: COMPONENT.optional(),
  host: z.array(HOST).max(16).optional(),
});

/** catalog:bundle — only host(s). */
export const catalogBundleSchema = z.object({
  host: z.array(HOST).max(16).optional(),
  dryRun: z.boolean().optional().default(true),
  yes: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** catalog:sync — skill + the destination agent. */
export const catalogSyncSchema = z.object({ skill: NAME, to: HOST });

/** catalog:scaffoldSkill — name + trigger/body/tools + autoFire. */
export const catalogScaffoldSchema = z.object({
  name: NAME,
  trigger: TEXT.optional(),
  body: TEXT.optional(),
  tools: TEXT.optional(),
  autoFire: z.boolean().optional().default(true),
});

/** catalog:apps / catalog:worldsim / catalog:models LIFECYCLE — gated mutations. */
export const catalogAppLifecycleSchema = z.object({
  surface: z.enum(["apps", "worldsim", "models"]),
  action: APP_ACTION,
  tool: NAME.optional(),
  path: PATH.optional(),
  version: VERSION.optional(),
  runId: RUN_ID.optional(),
});

/* ── the parse→GuardResult bridge (identical to model-validate.ts) ───────────*/

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

/* ── typed validators (what catalog-ipc.ts calls) ───────────────────────────*/

export function validateCatalogName(arg: unknown): GuardResult<{ name: string }> {
  return runSchema(catalogNameSchema, asObject(arg));
}

export interface CatalogAuditArgs {
  name: string;
  strict: boolean;
  gateFresh: boolean;
}
export function validateCatalogAudit(arg: unknown): GuardResult<CatalogAuditArgs> {
  const r = runSchema(catalogAuditSchema, asObject(arg));
  if (!r.ok) return r;
  return {
    ok: true,
    value: { name: r.value.name, strict: r.value.strict, gateFresh: r.value.gateFresh },
  };
}

export function validateCatalogStatus(arg: unknown): GuardResult<{ name: string }> {
  return runSchema(catalogStatusSchema, asObject(arg));
}

export interface CatalogInventoryArgs {
  host?: string;
}
export function validateCatalogInventory(arg: unknown): GuardResult<CatalogInventoryArgs> {
  const r = runSchema(catalogInventorySchema, asObject(arg));
  if (!r.ok) return r;
  const v: CatalogInventoryArgs = {};
  if (r.value.host !== undefined) v.host = r.value.host;
  return { ok: true, value: v };
}

export interface CatalogRawArgs {
  surface: "apps" | "worldsim" | "models" | "localai";
  action?: string;
  tool?: string;
  path?: string;
  version?: string;
  localaiAction?: "audit" | "models" | "endpoints" | "show";
}
export function validateCatalogRaw(arg: unknown): GuardResult<CatalogRawArgs> {
  const r = runSchema(catalogRawSchema, asObject(arg));
  if (!r.ok) return r;
  const v: CatalogRawArgs = { surface: r.value.surface };
  if (r.value.action !== undefined) v.action = r.value.action;
  if (r.value.tool !== undefined) v.tool = r.value.tool;
  if (r.value.path !== undefined) v.path = r.value.path;
  if (r.value.version !== undefined) v.version = r.value.version;
  if (r.value.localaiAction !== undefined) v.localaiAction = r.value.localaiAction;
  return { ok: true, value: v };
}

export interface CatalogInstallArgs {
  name: string;
  host?: string[];
  only?: string;
  skip?: string;
  arm: boolean;
  dryRun: boolean;
  yes: boolean;
  strict: boolean;
  /** TRUE only when force:true AND confirmForce:true both arrived (C5/§8). */
  force: boolean;
  runId?: string;
}
export function validateCatalogInstall(arg: unknown): GuardResult<CatalogInstallArgs> {
  const r = runSchema(catalogInstallSchema, asObject(arg));
  if (!r.ok) return r;
  const v: CatalogInstallArgs = {
    name: r.value.name,
    arm: r.value.arm,
    dryRun: r.value.dryRun,
    yes: r.value.yes,
    strict: r.value.strict,
    // the GOLDEN GATE: force is honoured ONLY when the typed-confirm is also set.
    force: r.value.force && r.value.confirmForce,
  };
  if (r.value.host !== undefined) v.host = r.value.host;
  if (r.value.only !== undefined) v.only = r.value.only;
  if (r.value.skip !== undefined) v.skip = r.value.skip;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export interface CatalogUninstallArgs {
  name: string;
  host?: string[];
  only?: string;
  skip?: string;
  dryRun: boolean;
  yes: boolean;
  runId?: string;
}
export function validateCatalogUninstall(arg: unknown): GuardResult<CatalogUninstallArgs> {
  const r = runSchema(catalogUninstallSchema, asObject(arg));
  if (!r.ok) return r;
  const v: CatalogUninstallArgs = {
    name: r.value.name,
    dryRun: r.value.dryRun,
    yes: r.value.yes,
  };
  if (r.value.host !== undefined) v.host = r.value.host;
  if (r.value.only !== undefined) v.only = r.value.only;
  if (r.value.skip !== undefined) v.skip = r.value.skip;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export interface CatalogToggleArgs {
  name: string;
  only?: string;
  component?: "hooks" | "mcp";
  host?: string[];
}
export function validateCatalogToggle(arg: unknown): GuardResult<CatalogToggleArgs> {
  const r = runSchema(catalogToggleSchema, asObject(arg));
  if (!r.ok) return r;
  const v: CatalogToggleArgs = { name: r.value.name };
  if (r.value.only !== undefined) v.only = r.value.only;
  if (r.value.component !== undefined) v.component = r.value.component;
  if (r.value.host !== undefined) v.host = r.value.host;
  return { ok: true, value: v };
}

export interface CatalogBundleArgs {
  host?: string[];
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  runId?: string;
}
export function validateCatalogBundle(arg: unknown): GuardResult<CatalogBundleArgs> {
  const r = runSchema(catalogBundleSchema, asObject(arg));
  if (!r.ok) return r;
  const v: CatalogBundleArgs = {
    dryRun: r.value.dryRun,
    yes: r.value.yes,
    force: r.value.force && r.value.confirmForce,
  };
  if (r.value.host !== undefined) v.host = r.value.host;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}

export function validateCatalogSync(arg: unknown): GuardResult<{ skill: string; to: string }> {
  return runSchema(catalogSyncSchema, asObject(arg));
}

export interface CatalogScaffoldArgs {
  name: string;
  trigger?: string;
  body?: string;
  tools?: string;
  autoFire: boolean;
}
export function validateCatalogScaffold(arg: unknown): GuardResult<CatalogScaffoldArgs> {
  const r = runSchema(catalogScaffoldSchema, asObject(arg));
  if (!r.ok) return r;
  const v: CatalogScaffoldArgs = { name: r.value.name, autoFire: r.value.autoFire };
  if (r.value.trigger !== undefined) v.trigger = r.value.trigger;
  if (r.value.body !== undefined) v.body = r.value.body;
  if (r.value.tools !== undefined) v.tools = r.value.tools;
  return { ok: true, value: v };
}

export interface CatalogAppLifecycleArgs {
  surface: "apps" | "worldsim" | "models";
  action: string;
  tool?: string;
  path?: string;
  version?: string;
  runId?: string;
}
export function validateCatalogAppLifecycle(arg: unknown): GuardResult<CatalogAppLifecycleArgs> {
  const r = runSchema(catalogAppLifecycleSchema, asObject(arg));
  if (!r.ok) return r;
  const v: CatalogAppLifecycleArgs = { surface: r.value.surface, action: r.value.action };
  if (r.value.tool !== undefined) v.tool = r.value.tool;
  if (r.value.path !== undefined) v.path = r.value.path;
  if (r.value.version !== undefined) v.version = r.value.version;
  if (r.value.runId !== undefined) v.runId = r.value.runId;
  return { ok: true, value: v };
}
