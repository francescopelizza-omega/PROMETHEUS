// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/metadata-validate.ts — the zod seam for the `metadata:*` IPC (file 0C).
 *
 * Mirrors repo-validate.ts: every renderer-supplied arg to a metadata channel is parsed
 * by a strict, fail-closed zod schema BEFORE metadata-ipc.ts relays it to the metadata.py
 * sidecar. The renderer is the least-trusted surface (C5); the path is bounded, control-
 * char-free, and may NOT start with a dash (argv option-injection defense — the sidecar
 * spawns shell:false, but the value is an argv positional). Pure schema code (no electron).
 */
import { type ZodTypeAny, z } from "zod";

import type { GuardResult, IpcErrorShape } from "./arg-guards.js";

/** A filesystem path to a single file. Bounded; control-char free; no leading dash. */
const URI = z
  .string()
  .trim()
  .min(1, "path must not be empty")
  .max(4096, "path is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "path contains control characters")
  .regex(/^[^-]/, "path must not start with a dash");

/** An exiftool field id, e.g. "EXIF:Artist" / "XMP:Creator". Conservative charset. */
const FIELD = z
  .string()
  .trim()
  .min(1, "field must not be empty")
  .max(128, "field is too long")
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/, "field has invalid characters");

/** A field value. Bounded; control-char free; no leading dash (argv safety). */
const VALUE = z
  .string()
  .max(4096, "value is too long")
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f]*$/, "value contains control characters")
  .regex(/^[^-]/, "value must not start with a dash");

export const metadataInspectSchema = z.object({ uri: URI });

export const metadataScrubSchema = z.object({
  uri: URI,
  confirm: z.boolean().optional().default(false),
});

export const metadataEditSchema = z.object({
  uri: URI,
  field: FIELD,
  value: VALUE,
  confirm: z.boolean().optional().default(false),
});

export const metadataTimestompSchema = z.object({
  uri: URI,
  mtime: z.number().finite("mtime must be epoch seconds"),
  atime: z.number().finite().optional(),
  confirm: z.boolean().optional().default(false),
});

export const fileOpenSchema = z.object({
  /** dialog title (cosmetic). */
  title: z.string().max(200).optional(),
});

export type MetadataInspectArgs = z.infer<typeof metadataInspectSchema>;
export type MetadataScrubArgs = z.infer<typeof metadataScrubSchema>;
export type MetadataEditArgs = z.infer<typeof metadataEditSchema>;
export type MetadataTimestompArgs = z.infer<typeof metadataTimestompSchema>;
export type FileOpenArgs = z.infer<typeof fileOpenSchema>;

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function runSchema<S extends ZodTypeAny>(schema: S, input: unknown): GuardResult<z.infer<S>> {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0];
  const error: IpcErrorShape = {
    kind: "invalid-args",
    message: issue?.message ?? "invalid arguments",
    ...(issue?.path?.length ? { detail: issue.path.join(".") } : {}),
  };
  return { ok: false, error };
}

export function validateMetadataInspect(arg: unknown): GuardResult<MetadataInspectArgs> {
  return runSchema(metadataInspectSchema, asObject(arg));
}
export function validateMetadataScrub(arg: unknown): GuardResult<MetadataScrubArgs> {
  return runSchema(metadataScrubSchema, asObject(arg));
}
export function validateMetadataEdit(arg: unknown): GuardResult<MetadataEditArgs> {
  return runSchema(metadataEditSchema, asObject(arg));
}
export function validateMetadataTimestomp(arg: unknown): GuardResult<MetadataTimestompArgs> {
  return runSchema(metadataTimestompSchema, asObject(arg));
}
export function validateFileOpen(arg: unknown): GuardResult<FileOpenArgs> {
  return runSchema(fileOpenSchema, asObject(arg));
}
