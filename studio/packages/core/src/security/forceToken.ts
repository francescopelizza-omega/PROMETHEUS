/**
 * core/security/forceToken.ts — the deep-red override token + typed-name guards.
 *
 * Two distinct typed-confirmation guards, both PURE and both EXACT-MATCH ONLY:
 *
 *  1. FORCE_TOKEN ("install-dangerous") + matchesForceToken — the §5.3 Force
 *     Override flow. To install over a nemesis BLOCK/error the user must type the
 *     engine's EXACT token. This is the SAME literal the engine demands on a TTY
 *     (prometheus.py `_confirm_dangerous_override`: `if ans != "install-dangerous"`),
 *     so the GUI's typed-confirm is byte-for-byte the engine's. We compare ONLY
 *     for exact equality — no trim, no case-fold, no "looks close enough". The
 *     button is enabled solely on an exact match; the engine ALSO re-checks on
 *     its side (the GUI never weakens the gate — C5).
 *
 *  2. purgeNameMatches — the §9.3 PURGE confirmation. Purge is the only
 *     irreversible destruction in the app; the CTA stays disabled until the user
 *     types the exact filename (basename) of the artifact being deleted. Exact
 *     compare of the user's input against the artifact's basename.
 *
 * NOTHING here decides "safe" (C5): these are friction gates that only enable a
 * destructive/override button once the user has typed an exact string. The engine
 * still performs (or refuses) the actual operation.
 */

/**
 * The engine's EXACT deep-red override token. Typing this (and only this) enables
 * the "Force install at my own risk" CTA on a BLOCK/error verdict (§5.3). Keep it
 * byte-identical to prometheus.py's `_confirm_dangerous_override` literal.
 */
export const FORCE_TOKEN = "install-dangerous" as const;

/**
 * Does the user's typed input EXACTLY match the force token? Exact compare only —
 * no trim, no case normalisation, no partial match. A wrong case, leading space,
 * or near-miss returns false (the CTA stays disabled). A non-string is false.
 */
export function matchesForceToken(input: unknown): boolean {
  return input === FORCE_TOKEN;
}

/**
 * The basename of a logical path (the part after the last "/" or "\\"). Used by
 * the purge guard so the user confirms by the FILE NAME, not the whole path
 * (§9.3 shows "Type the filename to confirm: [ agent.py ]"). In-archive members
 * ("pkg.zip!member") keep the member tail as their name. Pure string work.
 */
export function purgeBasename(path: string): string {
  if (typeof path !== "string" || path.length === 0) return "";
  // Strip any trailing slashes (a directory path), then take the last segment.
  const trimmed = path.replace(/[/\\]+$/, "");
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

/**
 * Does the user's typed name EXACTLY match the artifact's filename (basename),
 * gating the §9.3 Purge CTA? Exact compare of `typed` against `purgeBasename(
 * filename)`. A non-string `typed`, an empty typed/filename, or any mismatch
 * returns false (the irreversible CTA stays disabled — fail toward safety).
 */
export function purgeNameMatches(typed: unknown, filename: string): boolean {
  if (typeof typed !== "string") return false;
  const expected = purgeBasename(filename);
  if (expected.length === 0) return false; // nothing to confirm against ⇒ never enable.
  return typed === expected;
}
