// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/arg-guards.ts — PURE structural validation for renderer-supplied IPC args.
 *
 * A renderer is the LEAST-TRUSTED surface in our own app (C5): even though our
 * own UI is the only intended caller, a compromised renderer (XSS in a rendered
 * repo README, a malicious devtools paste) could call `window.prometheus.*` with
 * arbitrary shapes. So EVERY argument that crosses the contextBridge into the
 * MAIN process is validated BEFORE it reaches the engine seam.
 *
 * This module is intentionally Node-stdlib-only (ZERO deps, no zod, no electron)
 * so it is unit-testable with node:test right now, and so the IpcBroker can call
 * it without dragging a validation framework into the broker's import graph. The
 * zod schemas in validate.ts (§6, the brief's seam requirement) are built ON TOP
 * of these same primitive rules — one source of truth for "what a valid arg is".
 *
 * Each validator returns a discriminated Result:
 *   - { ok: true,  value }                  → the coerced, trusted value
 *   - { ok: false, error: {kind,message,detail} } → a SERIALIZABLE rejection the
 *     broker re-throws across IPC so the renderer's onError fires (never a crash).
 *
 * The rejection is deliberately a PLAIN object (structured-clone safe): an Error
 * subclass would lose its prototype crossing the IPC boundary, so we ship data.
 */

/** A serializable validation/engine rejection that survives structured-clone. */
export interface IpcErrorShape {
  /** machine class — the renderer styles by kind, never parses the message. */
  kind: "invalid-args" | "unknown-channel" | "engine-error";
  /** short human message. */
  message: string;
  /** optional extra context (which field, the offending value's type). */
  detail?: string;
}

/** The discriminated validation outcome. */
export type GuardResult<T> = { ok: true; value: T } | { ok: false; error: IpcErrorShape };

/** Build an `invalid-args` rejection (the only kind these pure guards emit). */
export function invalidArgs(
  message: string,
  detail?: string,
): {
  ok: false;
  error: IpcErrorShape;
} {
  return detail === undefined
    ? { ok: false, error: { kind: "invalid-args", message } }
    : { ok: false, error: { kind: "invalid-args", message, detail } };
}

/** The runtime type word for an unknown value (for `detail`). */
function typeWord(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * A non-empty, trimmed plugin/agent NAME. Rejects non-strings, blank/whitespace,
 * over-long (>200) inputs, and any control character or shell metacharacter — a
 * defence-in-depth belt over engine-bridge's `shell:false` braces (§4.4). The
 * engine still validates names itself; this just stops obvious garbage at the seam.
 */
export function guardName(raw: unknown): GuardResult<string> {
  if (typeof raw !== "string") {
    return invalidArgs("name must be a string", `got ${typeWord(raw)}`);
  }
  const value = raw.trim();
  if (value.length === 0) return invalidArgs("name must not be empty");
  if (value.length > 200) {
    return invalidArgs("name is too long", `${value.length} chars (max 200)`);
  }
  // No control chars; no shell-injection metacharacters even though shell:false
  // already neutralises them — a name with these is never legitimate.
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return invalidArgs("name contains control characters");
  }
  if (/[;&|`$<>(){}\\]/.test(value)) {
    return invalidArgs("name contains forbidden characters");
  }
  return { ok: true, value };
}

/**
 * A gate TARGET: a path, git URL, or owner/repo. Looser than a name (URLs carry
 * `/`, `:`, `.`, `~`, `@`) but still string, non-empty, bounded, control-char free.
 * The engine + nemesis do the real parsing; this just rejects nonsense early.
 */
export function guardTarget(raw: unknown): GuardResult<string> {
  if (typeof raw !== "string") {
    return invalidArgs("target must be a string", `got ${typeWord(raw)}`);
  }
  const value = raw.trim();
  if (value.length === 0) return invalidArgs("target must not be empty");
  if (value.length > 2048) {
    return invalidArgs("target is too long", `${value.length} chars (max 2048)`);
  }
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return invalidArgs("target contains control characters");
  }
  return { ok: true, value };
}

/** A runId correlation token: optional, but if present must be a sane string. */
export function guardRunId(raw: unknown): GuardResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") {
    return invalidArgs("runId must be a string", `got ${typeWord(raw)}`);
  }
  const value = raw.trim();
  if (value.length === 0) return invalidArgs("runId must not be empty when supplied");
  if (value.length > 128) {
    return invalidArgs("runId is too long", `${value.length} chars (max 128)`);
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    return invalidArgs("runId has invalid characters", "allowed: A-Z a-z 0-9 . _ : -");
  }
  return { ok: true, value };
}

/** A non-runId required correlation token (cancel's argument). */
export function guardRequiredRunId(raw: unknown): GuardResult<string> {
  const r = guardRunId(raw);
  if (!r.ok) return r;
  if (r.value === undefined) return invalidArgs("runId is required");
  return { ok: true, value: r.value };
}

/** The validated install options shape (all fields normalised to booleans/id). */
export interface InstallArgs {
  name: string;
  dryRun: boolean;
  forced: boolean;
  runId?: string;
}

/** Validate `(name, opts?)` for the install channel. */
export function guardInstall(name: unknown, opts: unknown): GuardResult<InstallArgs> {
  const n = guardName(name);
  if (!n.ok) return n;
  const o = optsObject(opts);
  if (!o.ok) return o;
  const dryRun = boolField(o.value, "dryRun");
  if (!dryRun.ok) return dryRun;
  const forced = boolField(o.value, "forced");
  if (!forced.ok) return forced;
  const runId = guardRunId(o.value.runId);
  if (!runId.ok) return runId;
  const value: InstallArgs = {
    name: n.value,
    dryRun: dryRun.value,
    forced: forced.value,
  };
  if (runId.value !== undefined) value.runId = runId.value;
  return { ok: true, value };
}

/** The validated uninstall options shape. */
export interface UninstallArgs {
  name: string;
  dryRun: boolean;
  runId?: string;
}

/** Validate `(name, opts?)` for the uninstall channel. */
export function guardUninstall(name: unknown, opts: unknown): GuardResult<UninstallArgs> {
  const n = guardName(name);
  if (!n.ok) return n;
  const o = optsObject(opts);
  if (!o.ok) return o;
  const dryRun = boolField(o.value, "dryRun");
  if (!dryRun.ok) return dryRun;
  const runId = guardRunId(o.value.runId);
  if (!runId.ok) return runId;
  const value: UninstallArgs = { name: n.value, dryRun: dryRun.value };
  if (runId.value !== undefined) value.runId = runId.value;
  return { ok: true, value };
}

/** A component flag for enable/disable: optional, one of "hooks"|"mcp". */
export function guardComponent(raw: unknown): GuardResult<"hooks" | "mcp" | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (raw === "hooks" || raw === "mcp") return { ok: true, value: raw };
  return invalidArgs("component must be 'hooks' or 'mcp'", `got ${JSON.stringify(raw)}`);
}

/** The validated enable/disable shape. */
export interface ToggleArgs {
  name: string;
  component?: "hooks" | "mcp";
}

/** Validate `(name, component?)` for enable/disable. */
export function guardToggle(name: unknown, component: unknown): GuardResult<ToggleArgs> {
  const n = guardName(name);
  if (!n.ok) return n;
  const c = guardComponent(component);
  if (!c.ok) return c;
  const value: ToggleArgs = { name: n.value };
  if (c.value !== undefined) value.component = c.value;
  return { ok: true, value };
}

/* ── small shared primitives ───────────────────────────────────────────────*/

/** Coerce an opts argument to a plain record (undefined ⇒ {}). */
function optsObject(opts: unknown): GuardResult<Record<string, unknown>> {
  if (opts === undefined || opts === null) return { ok: true, value: {} };
  if (typeof opts !== "object" || Array.isArray(opts)) {
    return invalidArgs("options must be an object", `got ${typeWord(opts)}`);
  }
  return { ok: true, value: opts as Record<string, unknown> };
}

/** An optional boolean field (missing ⇒ false; non-boolean ⇒ reject). */
function boolField(o: Record<string, unknown>, key: string): GuardResult<boolean> {
  const v = o[key];
  if (v === undefined) return { ok: true, value: false };
  if (typeof v !== "boolean") {
    return invalidArgs(`${key} must be a boolean`, `got ${typeWord(v)}`);
  }
  return { ok: true, value: v };
}
