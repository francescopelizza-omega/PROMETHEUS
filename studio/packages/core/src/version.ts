/**
 * version.ts — reconcile the Studio + engine + nemesis versions for About (file 10 §5).
 *
 * Studio and the engine version independently (§5): `engine/VERSION.json` carries
 * prometheus.py's SCRIPT_VERSION (0.15.0), written at build time by stage-engine.mjs.
 * The Settings → About panel shows all three:
 *   "Studio 0.4.2 · Engine 0.15.0 · Nemesis DB seeded 2026-06-14"
 * Pure: parse the JSON fail-soft, reconcile, format. No fs here (the host reads the
 * file + nemesis DB freshness and passes the strings in).
 */

/** The committed VERSION.json shape (stage-engine.mjs writes it, §1). */
export interface EngineVersionFile {
  engine: string;
  studioBuilt?: string;
  builtAt?: string;
}

/** The reconciled version triple shown in About. */
export interface VersionInfo {
  studio: string;
  engine: string;
  studioBuilt?: string;
  builtAt?: string;
  nemesisDbSeeded?: string;
}

/** Parse VERSION.json fail-soft (a bad/missing file → null, never throws). */
export function parseEngineVersion(json: string): EngineVersionFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.engine !== "string" || o.engine.length === 0) return null;
  return {
    engine: o.engine,
    ...(typeof o.studioBuilt === "string" ? { studioBuilt: o.studioBuilt } : {}),
    ...(typeof o.builtAt === "string" ? { builtAt: o.builtAt } : {}),
  };
}

/** Reconcile the three version sources into one VersionInfo (engine unknown if absent). */
export function reconcileVersions(opts: {
  studio: string;
  engineFile?: EngineVersionFile | null;
  nemesisDbSeeded?: string;
}): VersionInfo {
  const ef = opts.engineFile ?? null;
  return {
    studio: opts.studio,
    engine: ef?.engine ?? "unknown",
    ...(ef?.studioBuilt ? { studioBuilt: ef.studioBuilt } : {}),
    ...(ef?.builtAt ? { builtAt: ef.builtAt } : {}),
    ...(opts.nemesisDbSeeded ? { nemesisDbSeeded: opts.nemesisDbSeeded } : {}),
  };
}

/** The one-line About string (file 10 §5). */
export function formatAbout(v: VersionInfo): string {
  const parts = [`Studio ${v.studio}`, `Engine ${v.engine}`];
  if (v.nemesisDbSeeded) parts.push(`Nemesis DB seeded ${v.nemesisDbSeeded}`);
  return parts.join(" · ");
}
