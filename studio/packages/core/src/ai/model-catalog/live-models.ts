// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-catalog/live-models.ts — reconcile a catalogued model id with what the provider
 * serves TODAY.
 *
 * Catalogue ids rot (Groq retired three of its free models in 2026 alone). Once a key exists,
 * the provider's own `GET /models` is the authority, and the picker should never hand the
 * session an id that list does not contain — that would be a 404 several seconds into the
 * first turn, reported as a broken model rather than a stale catalogue row.
 */

/** Normalise an id for comparison: lowercase, drop an org prefix, a `:free` tag, a date stamp. */
function stem(id: string): string {
  let s = id
    .toLowerCase()
    .replace(/^[^/]+\//, "")
    .replace(/:free$/, "");
  // Suffixes stack ("kimi-k2-instruct-0905"), so strip until nothing more comes off.
  for (;;) {
    const next = s.replace(/[-_](\d{4}|\d{6}|\d{8}|latest|preview|instruct)$/, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/[-_.:]/g, "");
}

export type LiveModelMatch =
  | { kind: "exact"; model: string }
  /** a different spelling or a newer dated build of the same model. */
  | { kind: "renamed"; model: string }
  | { kind: "missing" };

/** Find `wanted` in the provider's live list. An empty live list is "unknown", not "missing". */
export function matchLiveModel(wanted: string, live: readonly string[]): LiveModelMatch {
  if (live.length === 0) return { kind: "exact", model: wanted };
  if (live.includes(wanted)) return { kind: "exact", model: wanted };
  const lower = wanted.toLowerCase();
  const ci = live.find((m) => m.toLowerCase() === lower);
  if (ci) return { kind: "renamed", model: ci };
  const want = stem(wanted);
  if (want.length >= 4) {
    // Prefer the LONGEST live id with the same stem: a dated build over a bare alias is the
    // more specific of the two, and both name the same weights.
    const same = live.filter((m) => stem(m) === want).sort((a, b) => b.length - a.length);
    if (same[0]) return { kind: "renamed", model: same[0] };
  }
  return { kind: "missing" };
}

/** The models path for a provider row (`verifyPath`, defaulting to `/models`). */
export function modelsPathFor(p: { verifyPath?: string }): string {
  return p.verifyPath ?? "/models";
}
