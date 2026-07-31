/**
 * migrations/migrations.ts — versioned state migration runner (Reliability & Polish pack).
 *
 * Durability across upgrades: persisted state (settings.json, sessions, themes, layouts)
 * evolves shape between releases. A `Migration` bumps a `version`d state from N→N+1; the
 * runner applies the ordered chain from the state's version up to the target, idempotently
 * (re-running applies nothing) and FAIL-SOFT (a throwing migration stops + reports, and
 * returns the LAST GOOD state — never a half-migrated corruption). Pure: no IO.
 */

/** Any persisted state carries a numeric schema `version` (absent ⇒ 0). */
export interface Versioned {
  version?: number;
  [key: string]: unknown;
}

/** One step that upgrades state from `toVersion - 1` to `toVersion`. */
export interface Migration<T extends Versioned = Versioned> {
  /** the version this step PRODUCES (must be > 0; the chain is ordered by this). */
  toVersion: number;
  description?: string;
  migrate: (state: T) => T;
}

/** The outcome of a migration run. */
export interface MigrationResult<T extends Versioned = Versioned> {
  /** the migrated state (or the last good state if one step failed). */
  state: T;
  /** the toVersions actually applied, in order. */
  applied: number[];
  ok: boolean;
  /** present iff a migration threw — the run stopped here (fail-soft). */
  error?: string;
  /** the failing migration's toVersion, if any. */
  failedAt?: number;
}

/** The version of a state (absent ⇒ 0). */
export function stateVersion(state: Versioned): number {
  return typeof state.version === "number" && Number.isFinite(state.version) ? state.version : 0;
}

/**
 * Apply the ordered migration chain to bring `state` up to `targetVersion`. Only steps
 * with `toVersion` in `(currentVersion, targetVersion]` run, ascending. Idempotent +
 * fail-soft: a throwing step stops the run and returns the last good state + an error.
 * The migrated state's `version` is stamped to the last applied step (or unchanged).
 */
export function runMigrations<T extends Versioned>(
  state: T,
  targetVersion: number,
  migrations: readonly Migration<T>[],
): MigrationResult<T> {
  const start = stateVersion(state);
  const chain = [...migrations]
    .filter((m) => m.toVersion > start && m.toVersion <= targetVersion)
    .sort((a, b) => a.toVersion - b.toVersion);

  let current: T = { ...state, version: start };
  const applied: number[] = [];
  for (const m of chain) {
    try {
      const next = m.migrate(current);
      current = { ...next, version: m.toVersion };
      applied.push(m.toVersion);
    } catch (err) {
      return {
        state: current, // the LAST GOOD state — never a partial corruption
        applied,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        failedAt: m.toVersion,
      };
    }
  }
  return { state: current, applied, ok: true };
}

/** Validate a migration set: contiguous, unique, ascending toVersions starting at 1. */
export function validateMigrations(migrations: readonly Migration[]): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  const versions = migrations.map((m) => m.toVersion);
  const seen = new Set<number>();
  for (const v of versions) {
    if (v <= 0) problems.push(`migration toVersion must be > 0 (got ${v})`);
    if (seen.has(v)) problems.push(`duplicate migration toVersion ${v}`);
    seen.add(v);
  }
  const sorted = [...versions].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) {
      problems.push(`migration chain is not contiguous from 1 (gap near ${sorted[i]})`);
      break;
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The highest toVersion in a migration set (the current schema version), or 0. */
export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, m) => Math.max(max, m.toVersion), 0);
}
