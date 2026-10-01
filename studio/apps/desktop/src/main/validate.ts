// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/validate.ts — the ZOD validation seam (file 02 §6).
 *
 * The brief mandates: "validate EVERY renderer-supplied argument with a zod
 * schema BEFORE routing". A renderer is the least-trusted surface in our own app
 * (C5), so this is the choke point every renderer→main argument flows through.
 *
 * Why zod here AND pure guards in arg-guards.ts:
 *   - zod is the declarative, self-documenting seam the brief asks for, and gives
 *     rich error issues for free. It lives ONLY in this file (a runtime dep).
 *   - arg-guards.ts is the Node-stdlib-only, zero-dep mirror used by node:test
 *     (zod-free) and importable by the broker without dragging zod into its graph.
 *   Both encode the SAME rules; validate.ts is the production wire, arg-guards is
 *   the tested invariant. Each zod schema's bounds match a guard's bounds 1:1.
 *
 * Every validator returns the SAME discriminated `GuardResult<T>` shape the pure
 * guards return, so callers (main/ipc.ts handlers) branch identically regardless
 * of which validator they were handed. On failure the error is a SERIALIZABLE
 * `{ kind:"invalid-args", message, detail }` (zod's first issue), re-thrown across
 * IPC so the renderer's TanStack-Query onError fires — never an unhandled crash.
 *
 * This module imports `zod` (added to apps/desktop deps); it is MAIN-process only.
 */

import { type ZodTypeAny, z } from "zod";

import type {
  GuardResult,
  InstallArgs,
  IpcErrorShape,
  ToggleArgs,
  UninstallArgs,
} from "./arg-guards.js";

/* ── leaf schemas (bounds mirror arg-guards.ts exactly) ─────────────────────*/

const NAME = z
  .string()
  .trim()
  .min(1, "name must not be empty")
  .max(200, "name is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "name contains control characters")
  .regex(/^[^;&|`$<>(){}\\]*$/, "name contains forbidden characters");

const TARGET = z
  .string()
  .trim()
  .min(1, "target must not be empty")
  .max(2048, "target is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "target contains control characters");

const RUN_ID = z
  .string()
  .trim()
  .min(1, "runId must not be empty when supplied")
  .max(128, "runId is too long")
  .regex(/^[A-Za-z0-9._:-]+$/, "runId has invalid characters");

const COMPONENT = z.enum(["hooks", "mcp"]);

/* ── argument schemas (one per channel surface) ─────────────────────────────*/

/** install(name, opts?) */
export const installSchema = z.object({
  name: NAME,
  dryRun: z.boolean().optional().default(false),
  forced: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** uninstall(name, opts?) */
export const uninstallSchema = z.object({
  name: NAME,
  dryRun: z.boolean().optional().default(false),
  runId: RUN_ID.optional(),
});

/** enable/disable(name, component?) */
export const toggleSchema = z.object({
  name: NAME,
  component: COMPONENT.optional(),
});

/** A bare required name (info/audit/status/where). */
export const nameSchema = z.object({ name: NAME });

/** A bare gate target. */
export const targetSchema = z.object({ target: TARGET });

/** A required cancel runId. */
export const cancelSchema = z.object({ runId: RUN_ID });

/* ── the parse→GuardResult bridge ───────────────────────────────────────────*/

/** Turn a zod SafeParse failure into our serializable IpcErrorShape. */
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

/* ── typed channel validators (what main/ipc.ts calls) ──────────────────────
 * Each accepts the RAW positional args the renderer sent and returns the coerced,
 * trusted value — identical signatures to arg-guards' guard* functions so a test
 * can assert zod and the pure guards agree.
 */

export function validateName(name: unknown): GuardResult<string> {
  const r = runSchema(nameSchema, { name });
  return r.ok ? { ok: true, value: r.value.name } : r;
}

export function validateTarget(target: unknown): GuardResult<string> {
  const r = runSchema(targetSchema, { target });
  return r.ok ? { ok: true, value: r.value.target } : r;
}

export function validateInstall(name: unknown, opts: unknown): GuardResult<InstallArgs> {
  const merged = { ...asObject(opts), name };
  const r = runSchema(installSchema, merged);
  if (!r.ok) return r;
  const value: InstallArgs = {
    name: r.value.name,
    dryRun: r.value.dryRun,
    forced: r.value.forced,
  };
  if (r.value.runId !== undefined) value.runId = r.value.runId;
  return { ok: true, value };
}

export function validateUninstall(name: unknown, opts: unknown): GuardResult<UninstallArgs> {
  const merged = { ...asObject(opts), name };
  const r = runSchema(uninstallSchema, merged);
  if (!r.ok) return r;
  const value: UninstallArgs = { name: r.value.name, dryRun: r.value.dryRun };
  if (r.value.runId !== undefined) value.runId = r.value.runId;
  return { ok: true, value };
}

export function validateToggle(name: unknown, component: unknown): GuardResult<ToggleArgs> {
  const r = runSchema(toggleSchema, { name, component: component ?? undefined });
  if (!r.ok) return r;
  const value: ToggleArgs = { name: r.value.name };
  if (r.value.component !== undefined) value.component = r.value.component;
  return { ok: true, value };
}

export function validateCancel(runId: unknown): GuardResult<string> {
  const r = runSchema(cancelSchema, { runId });
  return r.ok ? { ok: true, value: r.value.runId } : r;
}

/** Coerce an opts argument to a plain record so it can be spread (rejects later). */
function asObject(opts: unknown): Record<string, unknown> {
  return opts && typeof opts === "object" && !Array.isArray(opts)
    ? (opts as Record<string, unknown>)
    : {};
}
