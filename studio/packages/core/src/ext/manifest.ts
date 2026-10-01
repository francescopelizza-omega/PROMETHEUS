// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ext/manifest.ts — parse + structurally validate `prometheus.extension.json` (§5.1).
 *
 * Fail-soft (the theme.ts pattern, file 08): a malformed manifest returns null, the
 * caller surfaces a toast — never a crash. The validator mirrors the JSON Schema
 * (schemas/extension/v1.json) so the runtime + the schema cannot drift. A tiny
 * dependency-free semver subset (`^`, `>=`, `>`, `=`/bare) gates `engines.studio`.
 */
import type { ExtContributes, ExtPermissions, ExtensionManifest } from "./types.js";

const ID_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Validate `contributes` loosely (drop malformed sub-entries; never throw). */
function validateContributes(v: unknown): ExtContributes | undefined {
  if (!isRecord(v)) return undefined;
  const out: ExtContributes = {};
  if (Array.isArray(v.commands)) {
    out.commands = v.commands
      .filter(isRecord)
      .filter((c) => typeof c.id === "string" && typeof c.title === "string")
      .map((c) => ({ id: c.id as string, title: c.title as string, category: str(c.category) }));
  }
  if (Array.isArray(v.themes)) {
    out.themes = v.themes
      .filter(isRecord)
      .filter(
        (t) => typeof t.id === "string" && typeof t.path === "string" && typeof t.base === "string",
      )
      .map((t) => ({
        id: t.id as string,
        label: str(t.label) ?? (t.id as string),
        base: t.base as "dark" | "light" | "high-contrast",
        path: t.path as string,
      }));
  }
  if (Array.isArray(v.agents)) {
    out.agents = v.agents
      .filter(isRecord)
      .filter((a) => typeof a.path === "string")
      .map((a) => ({ path: a.path as string }));
  }
  return out;
}

/** Validate `permissions` (default-deny shape; unknown keys ignored). */
function validatePermissions(v: unknown): ExtPermissions | undefined {
  if (!isRecord(v)) return undefined;
  const out: ExtPermissions = {};
  if (isRecord(v.fs)) {
    out.fs = {
      ...(isStringArray(v.fs.read) ? { read: v.fs.read } : {}),
      ...(isStringArray(v.fs.write) ? { write: v.fs.write } : {}),
    };
  }
  if (v.network === "none" || v.network === "mcp-only") out.network = v.network;
  else if (isStringArray(v.network)) out.network = v.network;
  if (isStringArray(v.engine)) out.engine = v.engine;
  if (isStringArray(v.secrets)) out.secrets = v.secrets;
  if (typeof v.shell === "boolean") out.shell = v.shell;
  return out;
}

/**
 * Validate a parsed object as an extension@1 manifest. Returns the typed manifest or
 * null (fail-soft). Enforces: schema discriminator, id pattern, non-empty label,
 * semver version. Optional fields are validated when present, dropped when malformed.
 */
export function validateManifest(value: unknown): ExtensionManifest | null {
  if (!isRecord(value)) return null;
  if (value.schema !== "extension@1") return null;
  const id = str(value.id);
  if (!id || !ID_RE.test(id)) return null;
  const label = str(value.label);
  if (!label) return null;
  const version = str(value.version);
  if (!version || !VERSION_RE.test(version)) return null;

  const manifest: ExtensionManifest = { schema: "extension@1", id, label, version };
  const publisher = str(value.publisher);
  if (publisher) manifest.publisher = publisher;
  const description = str(value.description);
  if (description) manifest.description = description;
  if (isRecord(value.engines) && typeof value.engines.studio === "string") {
    manifest.engines = { studio: value.engines.studio };
  }
  const main = str(value.main);
  if (main) manifest.main = main;
  if (isRecord(value.ui) && Array.isArray(value.ui.panels)) {
    const panels = value.ui.panels
      .filter(isRecord)
      .filter(
        (p) =>
          typeof p.id === "string" && typeof p.title === "string" && typeof p.entry === "string",
      )
      .map((p) => {
        const loc = str(p.location);
        const location: "primary-sidebar" | "secondary-sidebar" | "panel" =
          loc === "primary-sidebar" || loc === "panel" ? loc : "secondary-sidebar";
        return { id: p.id as string, title: p.title as string, location, entry: p.entry as string };
      });
    manifest.ui = { panels };
  }
  const contributes = validateContributes(value.contributes);
  if (contributes) manifest.contributes = contributes;
  const permissions = validatePermissions(value.permissions);
  if (permissions) manifest.permissions = permissions;
  const repo = str(value.repo);
  if (repo) manifest.repo = repo;
  const license = str(value.license);
  if (license) manifest.license = license;
  return manifest;
}

/** Parse a manifest from JSON text (fail-soft on parse error or schema mismatch). */
export function parseManifest(text: string): ExtensionManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validateManifest(parsed);
}

/* ── tiny semver subset (no dep) — enough for engines.studio gates ───────────── */

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Does `version` satisfy `range`? Supports `^X.Y.Z`, `>=X.Y.Z`, `>X.Y.Z`,
 * `=X.Y.Z`, and a bare `X.Y.Z` (exact). Unknown ranges → false (fail-closed).
 */
export function semverSatisfies(version: string, range: string): boolean {
  const ver = parseVersion(version);
  if (!ver) return false;
  const r = range.trim();
  const op = r.startsWith(">=")
    ? ">="
    : r.startsWith(">")
      ? ">"
      : r.startsWith("^")
        ? "^"
        : r.startsWith("=")
          ? "="
          : "";
  const base = parseVersion(r.slice(op.length).trim() || r);
  if (!base) return false;
  switch (op) {
    case ">=":
      return cmp(ver, base) >= 0;
    case ">":
      return cmp(ver, base) > 0;
    case "^":
      // same major, and ≥ base (npm caret for X.Y.Z with X≥1).
      return ver[0] === base[0] && cmp(ver, base) >= 0;
    default:
      return cmp(ver, base) === 0;
  }
}

/** Is the manifest compatible with the running Studio version (engines.studio)? */
export function isCompatible(manifest: ExtensionManifest, studioVersion: string): boolean {
  const range = manifest.engines?.studio;
  if (!range) return true; // no constraint declared
  return semverSatisfies(studioVersion, range);
}
