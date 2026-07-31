/**
 * updates/semver.ts — a tiny, tolerant semver parse + compare for update checks.
 *
 * Tolerant of a leading `v` (GitHub tags), pre-release/build metadata (dropped for the
 * comparison), and arbitrary surrounding text (a CLI `--version` line). PURE, no deps —
 * the monorepo carries no `semver` package and the test runner is stdlib-only.
 */

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** the pre-release tag (e.g. "beta.1"), or "" for a stable release. */
  prerelease: string;
}

const SEMVER_RE = /\bv?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\b/;

/** Parse the FIRST semver found in `input` (handles "v1.2.3", "prom 0.0.0", "2.0.0-rc.1"). */
export function parseVersion(input: unknown): SemverParts | null {
  if (typeof input !== "string") return null;
  const m = SEMVER_RE.exec(input);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? "",
  };
}

/**
 * Compare two pre-release identifier strings per semver §11: numeric identifiers
 * compare numerically, alphanumerics lexically, numeric < alphanumeric, and a
 * larger set of fields wins when all shared fields are equal.
 */
function comparePrerelease(a: string, b: string): -1 | 0 | 1 {
  // A stable release (no prerelease) outranks a prerelease of the same x.y.z.
  if (a === b) return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  const as = a.split(".");
  const bs = b.split(".");
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const ai = as[i];
    const bi = bs[i];
    if (ai === undefined) return -1; // a has fewer fields → lower precedence
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** Compare two version strings. Returns -1 (a<b), 0 (equal), 1 (a>b), or null if either is unparseable. */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** Is `latest` strictly newer than `current`? false when equal, older, or unparseable. */
export function isNewer(latest: unknown, current: unknown): boolean {
  return compareVersions(latest, current) === 1;
}
