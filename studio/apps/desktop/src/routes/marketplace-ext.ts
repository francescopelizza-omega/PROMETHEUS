/**
 * routes/marketplace-ext.ts — PURE row-mapping + verdict-flow for the extensions
 * marketplace (APP-060). Node:test-able: no React, no window, no core.
 *
 * The container renders the gated-install flow the MarketplaceView header prescribes; this
 * module holds the two pieces that must not drift: the ExtInfoView → MarketplaceRow
 * projection (so the chip reads the STORED verdict, never a fake GREEN) and the verdict-tier
 * → install-decision reducer (GREEN → proceed-after-confirm, WARN → typed-confirm, RED →
 * hard block, no force path).
 */
import type { MarketplaceRow, WorstVerdict } from "@prometheus/ui";

import type { ExtInfoView } from "../shared/ipc-contract.js";

/** Map a nemesis tier string → the marketplace WorstVerdict; unknown → undefined (never GREEN). */
export function gateTierToWorst(tier: string | undefined): WorstVerdict | undefined {
  return tier === "allow" || tier === "warn" || tier === "block" || tier === "error"
    ? tier
    : undefined;
}

/**
 * Project one installed extension → a marketplace row. `worstVerdict` is the STORED scan
 * tier (undefined → the chip shows unknown, never a fabricated clean). `installable:false`
 * so the row's button reads "Manage" (enable/disable/rescan), not a re-install.
 */
export function extInfoToRow(info: ExtInfoView): MarketplaceRow {
  return {
    id: info.id,
    name: info.label,
    tier: "external",
    installed: true,
    installable: false,
    ...(gateTierToWorst(info.verdict?.tier)
      ? { worstVerdict: gateTierToWorst(info.verdict?.tier) }
      : {}),
    summary: `v${info.version}${info.active ? " · active" : " · disabled"}${info.permissions.length ? ` · ${info.permissions.length} permission(s)` : ""}`,
  };
}

/** The verdict-gated install decision. */
export type InstallDecision = "proceed" | "confirm-warn" | "blocked";

/**
 * The verdict tier → install decision. RED (`block`/`error`) is a HARD block with no force
 * path; WARN needs an explicit typed confirm; anything else (allow/clean) proceeds after the
 * user confirms the permissions. A MISSING tier is treated as blocked (fail-closed — never
 * coalesce unknown to proceed).
 */
export function installDecision(tier: string | undefined): InstallDecision {
  if (tier === "block" || tier === "error" || tier === undefined) return "blocked";
  if (tier === "warn") return "confirm-warn";
  return "proceed";
}

/** The exact literal a user must type to confirm a WARN-tier install (defeats one-click). */
export const WARN_CONFIRM_PHRASE = "INSTALL ANYWAY";

/** Is the typed confirmation an exact match for the required literal? (trimmed, case-sensitive) */
export function warnConfirmAccepted(typed: string): boolean {
  return typed.trim() === WARN_CONFIRM_PHRASE;
}
