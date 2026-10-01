// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/security-validate.ts — the ZOD validation seam for the security IPC (§5,§7).
 *
 * Mirrors validate.ts exactly: every renderer-supplied argument to a
 * `security:*` channel is parsed by a zod schema BEFORE security-ipc.ts routes it
 * to engine-bridge. A renderer is the least-trusted surface (C5); these channels
 * drive the highest-stakes engine operations (force-install, disinfect, purge),
 * so the seam is strict and fail-closed:
 *   - an UNKNOWN sub-op is REJECTED (never dispatched — no silent fall-through);
 *   - a malformed arg returns the SAME serializable {kind:"invalid-args",message,
 *     detail} GuardResult the rest of the IPC uses, so security-ipc.ts branches
 *     identically and the renderer's onError fires (never a crash, never a
 *     "safe" default).
 *
 * Pure schema code (no electron, no engine-bridge): the real `zod` resolves in
 * production via electron-vite; node:test maps it to the local double (the same
 * zod-resolver.mjs validate.test.ts uses). Bounds mirror validate.ts's NAME /
 * TARGET / RUN_ID exactly so the two seams cannot drift.
 */

import { type ZodTypeAny, z } from "zod";

import type { GuardResult, IpcErrorShape } from "./arg-guards.js";

/* ── leaf schemas (bounds identical to validate.ts) ─────────────────────────*/

const NAME = z
  .string()
  .trim()
  .min(1, "name must not be empty")
  .max(200, "name is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f]*$/, "name contains control characters")
  .regex(/^[^;&|`$<>(){}\\]*$/, "name contains forbidden characters")
  // a plugin id is an engine POSITIONAL — reject a leading dash so it can never be
  // read as an option (argv option-injection defense; spawns are shell:false already).
  .regex(/^[^-]/, "name must not start with a dash");

const TARGET = z
  .string()
  .trim()
  .min(1, "target must not be empty")
  .max(2048, "target is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f]*$/, "target contains control characters");

const RUN_ID = z
  .string()
  .trim()
  .min(1, "runId must not be empty when supplied")
  .max(128, "runId is too long")
  .regex(/^[A-Za-z0-9._:-]+$/, "runId has invalid characters");

/**
 * A filesystem-ish path arg (quarantine dir, --out dir, a finding path, a verify
 * file). Looser than TARGET (it allows in-archive "!" members and dir paths) but
 * still blocks control chars and over-long inputs. NEVER blank.
 */
const PATH = z
  .string()
  .trim()
  .min(1, "path must not be empty")
  .max(4096, "path is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f]*$/, "path contains control characters");

/**
 * A feed NAME (e.g. "clamav-daily", "osv", "cisa-kev"). Conservative allowlist
 * charset (alnum + . _ -); hyphens are valid mid-id, but a LEADING dash is rejected
 * so a feed id can never be read as an option in the engine argv (option-injection).
 */
const FEED = z
  .string()
  .trim()
  .min(1, "feed name must not be empty")
  .max(64, "feed name is too long")
  .regex(/^[A-Za-z0-9._-]+$/, "feed name has invalid characters")
  .regex(/^[^-]/, "feed name must not start with a dash");

/** A nemesis rule_id (e.g. "RSHELL-001", "SCA-OSV-HIGH"). Conservative charset. */
const RULE_ID = z
  .string()
  .trim()
  .min(1, "rule_id must not be empty")
  .max(128, "rule_id is too long")
  .regex(/^[A-Za-z0-9._:-]+$/, "rule_id has invalid characters");

/** A quarantine id, or the literal "all". Same conservative charset as RUN_ID. */
const QUARANTINE_ID = z
  .string()
  .trim()
  .min(1, "quarantine id must not be empty")
  .max(256, "quarantine id is too long")
  .regex(/^[A-Za-z0-9._:/@-]+$/, "quarantine id has invalid characters");

/* ── per-channel argument schemas ───────────────────────────────────────────*/

/** security:gate / security:gateFull / security:audit core target/name. */
export const gateFullSchema = z.object({
  target: TARGET,
  fresh: z.boolean().optional().default(false),
  sign: z.boolean().optional().default(false),
  tier: z.enum(["default", "pentest"]).optional(),
  policyFile: PATH.optional(),
});

export const securityAuditSchema = z.object({ name: NAME });

/** security:install — name + dry-run/force flags + runId for the progress feed.
 *  `forced` is honored ONLY when paired with `confirmForce` (the deep-red typed-confirm
 *  the UI captures, file-03 flow) — mirrors the catalog/repo seams. The handler DROPS
 *  `forced` to false without it; JS never silently force-overrides a nemesis BLOCK
 *  (C5/§8). */
export const securityInstallSchema = z.object({
  name: NAME,
  dryRun: z.boolean().optional().default(true), // §2.1 / §5.1: preview-first.
  forced: z.boolean().optional().default(false),
  confirmForce: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/* ── remediate sub-ops (disinfect|quarantineList|restore|purge|acceptFinding) ─*/

export const disinfectSchema = z.object({
  op: z.enum(["disinfect"]),
  target: TARGET,
  out: PATH,
  runId: RUN_ID.optional(),
});

export const quarantineListSchema = z.object({
  op: z.enum(["quarantineList"]),
  target: PATH.optional(),
  quarantineDir: PATH.optional(),
});

export const restoreSchema = z.object({
  op: z.enum(["restore"]),
  id: QUARANTINE_ID,
  quarantineDir: PATH,
  /**
   * The EXACT string the human typed in the restore confirm (§4).
   *
   * Restore had a renderer-side dialog and nothing else, while its irreversible sibling
   * purge was gated in three places. Restore lifts an artifact nemesis refused back into the
   * workspace, executable again — one renderer bug, or one caller that arms the target and
   * immediately calls the restore, and the artifact is back with no independent check.
   */
  typedName: z.string().optional(),
  /**
   * The item's PATH, so the confirm can be keyed to the filename the human was shown.
   *
   * A vault `id` is opaque (`nemesis restore --list` prints `id [kind] path`), and asking
   * someone to retype an opaque id is a confirmation nobody reads. The dialog shows the
   * path; main verifies against the same path.
   */
  path: PATH.optional(),
});

export const purgeSchema = z.object({
  op: z.enum(["purge"]),
  target: TARGET,
  kind: z.enum(["source", "file", "quarantine"]),
  /** the typed-name confirmation the renderer collected (§9.3). */
  typedName: z.string().optional(),
  runId: RUN_ID.optional(),
});

export const acceptFindingSchema = z.object({
  op: z.enum(["acceptFinding"]),
  target: TARGET,
  ruleId: RULE_ID,
  path: PATH,
});

/* ── threatdb sub-ops (status|update|authKey|cache) ──────────────────────────*/

export const threatdbStatusSchema = z.object({ op: z.enum(["status"]) });

export const threatdbUpdateSchema = z.object({
  op: z.enum(["update"]),
  force: z.boolean().optional().default(false),
  all: z.boolean().optional().default(false),
  feeds: z.array(FEED).optional(),
  runId: RUN_ID.optional(),
});

export const threatdbAuthKeySchema = z.object({
  op: z.enum(["authKey"]),
  /** the abuse.ch Auth-Key. NEVER bounded by charset (opaque secret) but length-capped. */
  key: z.string().min(1, "key must not be empty").max(512, "key is too long"),
});

export const threatdbCacheSchema = z.object({
  op: z.enum(["cache"]),
  /** "status" reads the cache; "clear" empties it. */
  action: z.enum(["status", "clear"]),
});

/* ── trust sub-ops (list|revoke|auditLog|verify) ────────────────────────────*/

export const trustListSchema = z.object({ op: z.enum(["list"]) });

export const trustRevokeSchema = z.object({ op: z.enum(["revoke"]), name: NAME });

export const trustAuditLogSchema = z.object({
  op: z.enum(["auditLog"]),
  forcedDanger: z.boolean().optional(),
  blocks: z.boolean().optional(),
  last24h: z.boolean().optional(),
  /** opt IN to the heavyweight signed verdict blob — see the handler for why. */
  includeVerdictFull: z.boolean().optional(),
});

export const trustVerifySchema = z.object({ op: z.enum(["verify"]), file: PATH });

/* ── the parse→GuardResult bridge (identical to validate.ts) ─────────────────*/

/** Turn a zod failure into our serializable IpcErrorShape. */
function toIpcError(err: z.ZodError): IpcErrorShape {
  const first = err.issues[0];
  const message = first?.message ?? "invalid arguments";
  const path = first?.path?.join(".") ?? "";
  return path
    ? { kind: "invalid-args", message, detail: `at "${path}"` }
    : { kind: "invalid-args", message };
}

/** Run a zod schema and adapt the result to the shared GuardResult shape. */
export function runSchema<S extends ZodTypeAny>(
  schema: S,
  input: unknown,
): GuardResult<z.infer<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: toIpcError(parsed.error) };
}

/** Coerce an arg to a plain record so it can be parsed (rejects non-objects later). */
function asObject(arg: unknown): Record<string, unknown> {
  return arg && typeof arg === "object" && !Array.isArray(arg)
    ? (arg as Record<string, unknown>)
    : {};
}

/* ── typed validators (what security-ipc.ts calls) ──────────────────────────*/

/** Coerced gate/gateFull arg. */
export interface GateArgs {
  target: string;
  fresh: boolean;
  sign: boolean;
  tier?: "default" | "pentest";
  policyFile?: string;
}

export function validateGate(arg: unknown): GuardResult<GateArgs> {
  const r = runSchema(gateFullSchema, asObject(arg));
  if (!r.ok) return r;
  const value: GateArgs = { target: r.value.target, fresh: r.value.fresh, sign: r.value.sign };
  if (r.value.tier !== undefined) value.tier = r.value.tier;
  if (r.value.policyFile !== undefined) value.policyFile = r.value.policyFile;
  return { ok: true, value };
}

export function validateSecurityAudit(arg: unknown): GuardResult<{ name: string }> {
  return runSchema(securityAuditSchema, asObject(arg));
}

export interface SecurityInstallArgs {
  name: string;
  dryRun: boolean;
  forced: boolean;
  /** the paired typed-confirm — `forced` is honored ONLY when this is true (§8/C5). */
  confirmForce: boolean;
  runId?: string;
}

export function validateSecurityInstall(arg: unknown): GuardResult<SecurityInstallArgs> {
  const r = runSchema(securityInstallSchema, asObject(arg));
  if (!r.ok) return r;
  const value: SecurityInstallArgs = {
    name: r.value.name,
    dryRun: r.value.dryRun,
    forced: r.value.forced,
    confirmForce: r.value.confirmForce,
  };
  if (r.value.runId !== undefined) value.runId = r.value.runId;
  return { ok: true, value };
}

/** The discriminated remediate arg (one of the five sub-ops). */
export type RemediateArgs =
  | { op: "disinfect"; target: string; out: string; runId?: string }
  | { op: "quarantineList"; target?: string; quarantineDir?: string }
  | { op: "restore"; id: string; quarantineDir: string; typedName?: string; path?: string }
  | {
      op: "purge";
      target: string;
      kind: "source" | "file" | "quarantine";
      typedName?: string;
      runId?: string;
    }
  | { op: "acceptFinding"; target: string; ruleId: string; path: string };

const REMEDIATE_OPS = new Set(["disinfect", "quarantineList", "restore", "purge", "acceptFinding"]);

/**
 * Validate a remediate arg by its `op` discriminator. An UNKNOWN op is REJECTED
 * (fail-closed — never dispatched). Each op routes to its own schema.
 */
export function validateRemediate(arg: unknown): GuardResult<RemediateArgs> {
  const o = asObject(arg);
  const op = typeof o.op === "string" ? o.op : "";
  if (!REMEDIATE_OPS.has(op)) {
    return {
      ok: false,
      error: { kind: "invalid-args", message: `unknown remediate op: ${op || "(none)"}` },
    };
  }
  switch (op) {
    case "disinfect": {
      const r = runSchema(disinfectSchema, o);
      if (!r.ok) return r;
      const v: RemediateArgs = { op: "disinfect", target: r.value.target, out: r.value.out };
      if (r.value.runId !== undefined) v.runId = r.value.runId;
      return { ok: true, value: v };
    }
    case "quarantineList": {
      const r = runSchema(quarantineListSchema, o);
      if (!r.ok) return r;
      const v: RemediateArgs = { op: "quarantineList" };
      if (r.value.target !== undefined) v.target = r.value.target;
      if (r.value.quarantineDir !== undefined) v.quarantineDir = r.value.quarantineDir;
      return { ok: true, value: v };
    }
    case "restore": {
      const r = runSchema(restoreSchema, o);
      if (!r.ok) return r;
      // field-by-field on purpose (nothing unvalidated reaches the handler) — which also
      // means a field missing from THIS list is dropped silently, schema or no schema.
      const v: RemediateArgs = {
        op: "restore",
        id: r.value.id,
        quarantineDir: r.value.quarantineDir,
      };
      if (r.value.typedName !== undefined) v.typedName = r.value.typedName;
      if (r.value.path !== undefined) v.path = r.value.path;
      return { ok: true, value: v };
    }
    case "purge": {
      const r = runSchema(purgeSchema, o);
      if (!r.ok) return r;
      const v: RemediateArgs = { op: "purge", target: r.value.target, kind: r.value.kind };
      if (r.value.typedName !== undefined) v.typedName = r.value.typedName;
      if (r.value.runId !== undefined) v.runId = r.value.runId;
      return { ok: true, value: v };
    }
    default: {
      // acceptFinding (REMEDIATE_OPS guard guarantees this is the only remainder).
      const r = runSchema(acceptFindingSchema, o);
      if (!r.ok) return r;
      return {
        ok: true,
        value: {
          op: "acceptFinding",
          target: r.value.target,
          ruleId: r.value.ruleId,
          path: r.value.path,
        },
      };
    }
  }
}

/** The discriminated threatdb arg (status|update|authKey|cache). */
export type ThreatDbArgs =
  | { op: "status" }
  | { op: "update"; force: boolean; all: boolean; feeds?: string[]; runId?: string }
  | { op: "authKey"; key: string }
  | { op: "cache"; action: "status" | "clear" };

const THREATDB_OPS = new Set(["status", "update", "authKey", "cache"]);

export function validateThreatDb(arg: unknown): GuardResult<ThreatDbArgs> {
  const o = asObject(arg);
  const op = typeof o.op === "string" ? o.op : "";
  if (!THREATDB_OPS.has(op)) {
    return {
      ok: false,
      error: { kind: "invalid-args", message: `unknown threatdb op: ${op || "(none)"}` },
    };
  }
  switch (op) {
    case "status": {
      const r = runSchema(threatdbStatusSchema, o);
      return r.ok ? { ok: true, value: { op: "status" } } : r;
    }
    case "update": {
      const r = runSchema(threatdbUpdateSchema, o);
      if (!r.ok) return r;
      const v: ThreatDbArgs = { op: "update", force: r.value.force, all: r.value.all };
      if (r.value.feeds !== undefined) v.feeds = r.value.feeds;
      if (r.value.runId !== undefined) v.runId = r.value.runId;
      return { ok: true, value: v };
    }
    case "authKey": {
      const r = runSchema(threatdbAuthKeySchema, o);
      return r.ok ? { ok: true, value: { op: "authKey", key: r.value.key } } : r;
    }
    default: {
      const r = runSchema(threatdbCacheSchema, o);
      return r.ok ? { ok: true, value: { op: "cache", action: r.value.action } } : r;
    }
  }
}

/** The discriminated trust arg (list|revoke|auditLog|verify). */
export type TrustArgs =
  | { op: "list" }
  | { op: "revoke"; name: string }
  | {
      op: "auditLog";
      forcedDanger?: boolean;
      blocks?: boolean;
      last24h?: boolean;
      includeVerdictFull?: boolean;
    }
  | { op: "verify"; file: string };

const TRUST_OPS = new Set(["list", "revoke", "auditLog", "verify"]);

export function validateTrust(arg: unknown): GuardResult<TrustArgs> {
  const o = asObject(arg);
  const op = typeof o.op === "string" ? o.op : "";
  if (!TRUST_OPS.has(op)) {
    return {
      ok: false,
      error: { kind: "invalid-args", message: `unknown trust op: ${op || "(none)"}` },
    };
  }
  switch (op) {
    case "list": {
      const r = runSchema(trustListSchema, o);
      return r.ok ? { ok: true, value: { op: "list" } } : r;
    }
    case "revoke": {
      const r = runSchema(trustRevokeSchema, o);
      return r.ok ? { ok: true, value: { op: "revoke", name: r.value.name } } : r;
    }
    case "auditLog": {
      const r = runSchema(trustAuditLogSchema, o);
      if (!r.ok) return r;
      const v: TrustArgs = { op: "auditLog" };
      if (r.value.forcedDanger !== undefined) v.forcedDanger = r.value.forcedDanger;
      if (r.value.blocks !== undefined) v.blocks = r.value.blocks;
      if (r.value.last24h !== undefined) v.last24h = r.value.last24h;
      // this allowlist is rebuilt field-by-field on purpose (nothing unvalidated reaches
      // the handler) — which also means a new field that is not listed here is silently
      // dropped, schema or no schema.
      if (r.value.includeVerdictFull !== undefined)
        v.includeVerdictFull = r.value.includeVerdictFull;
      return { ok: true, value: v };
    }
    default: {
      const r = runSchema(trustVerifySchema, o);
      return r.ok ? { ok: true, value: { op: "verify", file: r.value.file } } : r;
    }
  }
}
