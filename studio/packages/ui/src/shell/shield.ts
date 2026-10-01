// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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

/**
 * The shield states the chrome can show (file 08 §4.2).
 *
 * `armed`/`unarmed` answer a different question from the verdict tiers: not "what did
 * the last scan say" but "is there a scanner at all". A build with nemesis absent can
 * never produce a verdict, so without these two the shield would sit on its benign
 * `clean` placeholder forever — green, while nothing whatsoever was being gated.
 */
export type ShieldState = "clean" | "warn" | "block" | "error" | "stale" | "armed" | "unarmed";

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
 *   0. unarmed → the SCANNER ITSELF is absent; nothing is being gated at all.
 *   1. error  → SCAN FAILED (fail-closed; the scanner couldn't speak).
 *   2. block  → a blocking verdict outranks staleness (a real danger now).
 *   3. warn   → an active warning.
 *   4. stale  → DB is stale (signatures old) — only when the verdict is clean.
 *   5. armed  → a CONFIRMED-present scanner that has not scanned anything yet.
 *   6. clean  → allow, fresh DB.
 *
 * `verdict` may be null before the first gate ran; with a fresh DB that reads as
 * a benign "clean" placeholder, with a stale DB as "stale" (nudges a refresh).
 *
 * `opts.armed` is deliberately THREE-valued. `false` means the host has looked and the
 * scanner is missing — that outranks every verdict, because a `block` recorded by a
 * scanner that is now gone says nothing about what would happen next. `true` means the
 * host has looked and found it, which is what lets a null verdict read as the honest
 * "armed" rather than the ambiguous "clean". `undefined` means the caller has no probe
 * to offer and gets exactly the pre-existing behaviour.
 */
export function deriveShield(
  verdict: VerdictTier | null | undefined,
  opts: { dbStale?: boolean; armed?: boolean } = {},
): ShieldView {
  const dbStale = opts.dbStale === true;

  if (opts.armed === false) {
    return {
      state: "unarmed",
      role: "danger",
      glyph: VERDICT_GLYPH.block,
      label: "unarmed",
      aria: "nemesis scanner is absent — nothing is being gated",
    };
  }
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
  if (opts.armed === true && (verdict === null || verdict === undefined)) {
    return {
      state: "armed",
      role: "ok",
      glyph: VERDICT_GLYPH.allow,
      label: "armed",
      aria: "nemesis gate is armed — nothing scanned yet",
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
