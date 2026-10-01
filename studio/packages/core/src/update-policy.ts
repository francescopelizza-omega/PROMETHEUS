// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * update-policy.ts — the PURE auto-update policy (file 10 §5).
 *
 * The desktop's electron-updater wiring (apps/desktop/src/main/updater.ts) is a thin
 * shell over these decisions, so the load-bearing rules are unit-testable without
 * Electron: which channel a tag maps to, the "never auto-install" invariant, and the
 * staged-rollout gate. A security IDE silently swapping its own binary contradicts the
 * ethos — so AUTO_DOWNLOAD and AUTO_INSTALL are both false, by design.
 */

export type UpdateChannel = "latest" | "beta" | "alpha";

/** Map a release tag (vX.Y.Z · vX.Y.Z-beta.N · vX.Y.Z-alpha.N) → its channel (§5). */
export function channelForTag(tag: string): UpdateChannel {
  const t = tag.trim().replace(/^v/, "");
  if (/-beta\.\d+/.test(t)) return "beta";
  if (/-alpha\.\d+/.test(t)) return "alpha";
  return "latest";
}

/** A prerelease tag is opt-in only — never offered to the stable channel. */
export function isPrerelease(tag: string): boolean {
  return channelForTag(tag) !== "latest";
}

/** Download only on consent (§5) — electron-updater.autoDownload is set to this. */
export const AUTO_DOWNLOAD = false;
/** Install only on an explicit click (§5) — we NEVER quitAndInstall automatically. */
export const AUTO_INSTALL = false;

/**
 * Staged rollout (§5): a stable release ships at stagingPercentage 10→50→100 over
 * 48h. Given the published percentage and this install's stable 0..99 bucket, is the
 * update offered yet? Missing/≥100 → everyone; ≤0 → no one.
 */
export function stagedRolloutAllows(
  stagingPercentage: number | undefined,
  bucket: number,
): boolean {
  if (stagingPercentage === undefined || stagingPercentage >= 100) return true;
  if (stagingPercentage <= 0) return false;
  return bucket < stagingPercentage;
}
