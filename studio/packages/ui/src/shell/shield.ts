/**
 * shell/shield.ts — the permanent nemesis SHIELD state model (file 08 §4.2/§4.3).
 *
 * The status-bar shield is the ambient embodiment of rule #2 (security is always
 * one glance away). Its visual state is derived PURELY from the latest gate
 * verdict tier PLUS the threat-DB freshness — so a clean verdict over a STALE DB
 * still reads as "stale" (you scanned, but against old signatures). No React, no
 * DOM: this is the testable core the desktop StatusBar binds to.
 *
 * Verdict color/glyph come from the canonical token maps (VERDICT_ROLE /
 * VERDICT_GLYPH); the shield never invents a color (08 §6, no raw hex).
 */

import {
  type RoleToken,
  VERDICT_GLYPH,
  VERDICT_LABEL,
  VERDICT_ROLE,
  type VerdictTier,
} from "../tokens.js";

/** The five shield states the status bar can show (file 08 §4.2). */
export type ShieldState = "clean" | "warn" | "block" | "error" | "stale";

/** The fully-resolved shield presentation the StatusBar renders. */
export interface ShieldView {
  state: ShieldState;
  /** the role token → CSS var the chrome tints with (never a raw hex). */
  role: RoleToken;
  /** the accessible glyph (carries meaning without color, 08 §7). */
  glyph: string;
  /** the short label, e.g. "clean" / "stale" (lowercased status-bar style). */
  label: string;
  /** a spoken sentence for aria-label (08 §7 screen readers). */
  aria: string;
}

const STALE_GLYPH = "⟳";

/**
 * Derive the shield view from the latest verdict tier + DB freshness.
 *
 * Priority (fail-toward-attention):
 *   1. error  → SCAN FAILED (fail-closed; the scanner couldn't speak).
 *   2. block  → a blocking verdict outranks staleness (a real danger now).
 *   3. warn   → an active warning.
 *   4. stale  → DB is stale (signatures old) — only when the verdict is clean.
 *   5. clean  → allow, fresh DB.
 *
 * `verdict` may be null before the first gate ran; with a fresh DB that reads as
 * a benign "clean" placeholder, with a stale DB as "stale" (nudges a refresh).
 */
export function deriveShield(
  verdict: VerdictTier | null | undefined,
  opts: { dbStale?: boolean } = {},
): ShieldView {
  const dbStale = opts.dbStale === true;

  if (verdict === "error") return view("error", "error", VERDICT_GLYPH.error, "scan failed");
  if (verdict === "block") return view("block", "block", VERDICT_GLYPH.block, "blocked");
  if (verdict === "warn") return view("warn", "warn", VERDICT_GLYPH.warn, "warnings");

  // verdict is allow / null / undefined here → clean, unless the DB is stale.
  if (dbStale) {
    return {
      state: "stale",
      role: "warn",
      glyph: STALE_GLYPH,
      label: "stale",
      aria: "nemesis threat database is stale — run a refresh",
    };
  }
  return view("clean", "allow", VERDICT_GLYPH.allow, "clean");
}

function view(state: ShieldState, tier: VerdictTier, glyph: string, label: string): ShieldView {
  return {
    state,
    role: VERDICT_ROLE[tier],
    glyph,
    label,
    aria: `nemesis security: ${VERDICT_LABEL[tier].toLowerCase()}`,
  };
}
