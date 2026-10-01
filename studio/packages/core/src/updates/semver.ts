// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * updates/semver.ts — a tiny, tolerant semver parse + compare for update checks.
 *
 * Tolerant of a leading `v` (GitHub tags), pre-release/build metadata (dropped for the
 * comparison), and arbitrary surrounding text (a CLI `--version` line). PURE, no deps —
 * the monorepo carries no `semver` package and the test runner is stdlib-only.
 */

export interface SemverParts {
  /**
   * The Debian/RPM epoch — the `2` in `2:9.1.866-1.fc41`.
   *
   * It exists precisely to force an ordering the version number contradicts, so dropping it (as
   * this did) inverts the comparison for exactly the packages a maintainer went out of their way
   * to mark. `1:1.0.0` and `2:1.0.0` compared EQUAL. Defaults to 0 when absent, which is the
   * documented meaning.
   */
  epoch: number;
  major: number;
  minor: number;
  patch: number;
  /**
   * A fourth numeric component, `null` when there is none.
   *
   * `1.2.3.4` and `1.2.3.5` both parsed as `1.2.3` and compared EQUAL — so a four-component
   * version could never be reported as out of date, only ever as current.
   */
  build: number | null;
  /**
   * A packaging revision that is NOT a new upstream release: Homebrew's `_1` rebuild suffix
   * (`26.10.0_1`) and a cask's `,1` (`0.4.25,1`).
   *
   * Kept separate rather than folded into the version because the two callers want opposite
   * things from it. `brew outdated` reporting `26.10.0 -> 26.10.0_1` IS an update worth applying,
   * so `compareVersions` ranks it higher. Shadow detection must NOT treat it as a newer program —
   * a rebuild of the same release is the same release — so `install-owner.ts` strips it before
   * comparing. Both behaviours are correct; one field serves both.
   */
  revision: number;
  /** the pre-release tag (e.g. "beta.1"), or "" for a stable release. */
  prerelease: string;
}

/**
 * The version grammar, widened to what real tools actually print.
 *
 * The trailing `\b` this replaced was itself a bug: `\b` requires a word/non-word transition, and
 * `_` is a word character, so `26.10.0_1` — an ordinary Homebrew keg version — failed to match
 * the boundary and parsed unpredictably. The lookarounds below anchor on "not part of a longer
 * alphanumeric token" instead, which is the property that was actually wanted.
 */
const SEMVER_RE =
  /(?<![\w.])(?:(\d+):)?v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:[-~]([0-9A-Za-z.-]+?))?(?:[_,](\d+))?(?:\+[0-9A-Za-z.-]+)?(?![0-9A-Za-z.])/;

/**
 * Parse the FIRST version found in `input`.
 *
 * Handles "v1.2.3", "prometheus 0.0.0", "2.0.0-rc.1", "2:9.1.866-1.fc41", "26.10.0_1",
 * "0.4.25,1" and "2026.09.01".
 */
export function parseVersion(input: unknown): SemverParts | null {
  if (typeof input !== "string") return null;
  const m = SEMVER_RE.exec(input);
  if (!m) return null;
  return {
    epoch: m[1] ? Number(m[1]) : 0,
    major: Number(m[2]),
    minor: Number(m[3]),
    patch: Number(m[4]),
    build: m[5] !== undefined ? Number(m[5]) : null,
    revision: m[7] !== undefined ? Number(m[7]) : 0,
    prerelease: m[6] ?? "",
  };
}

/**
 * Drop a packaging revision, for callers comparing PROGRAMS rather than packages.
 *
 * `26.10.0_1` is a rebuild of `26.10.0` — same upstream release, repackaged. Shadow detection
 * must not read that as one copy being newer than another, or every machine with a rebuilt keg
 * reports a phantom shadow.
 */
export function withoutRevision(v: string): string {
  return (v.split(",")[0] as string).split("_")[0] as string;
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
  // Epoch first — that is the entire reason it exists.
  for (const k of ["epoch", "major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  /**
   * A missing fourth component is LOWER than a present one: `1.2.3` precedes `1.2.3.1`, the same
   * way `1.2` would precede `1.2.1`. Treating absent as 0 gives the same ordering and is what
   * the coercion below does.
   */
  const ba = pa.build ?? 0;
  const bb = pb.build ?? 0;
  if (ba !== bb) return ba < bb ? -1 : 1;

  const pre = comparePrerelease(pa.prerelease, pb.prerelease);
  if (pre !== 0) return pre;
  // Last, and only as a tiebreaker: a repackaging of an identical release.
  if (pa.revision !== pb.revision) return pa.revision < pb.revision ? -1 : 1;
  return 0;
}

/** Is `latest` strictly newer than `current`? false when equal, older, or unparseable. */
export function isNewer(latest: unknown, current: unknown): boolean {
  return compareVersions(latest, current) === 1;
}
