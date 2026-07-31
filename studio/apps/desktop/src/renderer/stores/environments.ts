/**
 * renderer/stores/environments.ts — the Environments-tab Zustand slice (file 04 §3).
 *
 * Zustand owns UI/SESSION state; TanStack Query owns fetching/caching (query/).
 * This slice holds ONLY the tab's selection + open-panel state: which env is
 * selected, whether the create wizard is open, and the latest gate verdict to
 * surface in the GateVerdictSheet (with the pending install request the user must
 * confirm). It reaches the engine through NOTHING — every fetch/mutation goes
 * through `window.prometheus.env.*` from the route, not from here (C5).
 *
 * GOLDEN RULE (C5): nothing here decides "safe". A gate verdict stored here is the
 * one the ENGINE returned; the slice only remembers it so the sheet can render it
 * and the user can confirm/cancel. It never upgrades a tier toward allow.
 *
 * Imports: zustand + PLAIN-DATA contract types only. No engine-bridge, no node:*.
 */

import { create } from "zustand";

import type { EnvGateSummary, PkgInstallRequest } from "../../shared/ipc-contract.js";

/** A pending gated op awaiting the user's confirm/cancel (the sheet's subject). */
export interface PendingGate {
  /** the gate verdict the engine returned for this fetch. */
  gate: EnvGateSummary;
  /** the install request to re-run with `confirm:true` (or `force:true`) on proceed. */
  request: PkgInstallRequest;
  /** a human label of the target (a spec / env name) shown in the sheet. */
  target: string;
}

export interface EnvironmentsStore {
  /** the selected env id (matches `Env.id`), or null. */
  selectedEnvId: string | null;
  /** is the create-env wizard open? */
  wizardOpen: boolean;
  /** the gate verdict + pending request the GateVerdictSheet renders, or null. */
  pendingGate: PendingGate | null;
  /** a transient per-op progress line (cosmetic; cleared on settle). */
  lastProgress: string | null;

  selectEnv(id: string | null): void;
  openWizard(): void;
  closeWizard(): void;
  /** stash a gate verdict + the request to confirm (warn/block flow). */
  setPendingGate(p: PendingGate): void;
  clearPendingGate(): void;
  setProgress(line: string | null): void;
}

export const useEnvironmentsStore = create<EnvironmentsStore>((set) => ({
  selectedEnvId: null,
  wizardOpen: false,
  pendingGate: null,
  lastProgress: null,

  selectEnv: (id: string | null): void => set({ selectedEnvId: id }),
  openWizard: (): void => set({ wizardOpen: true }),
  closeWizard: (): void => set({ wizardOpen: false }),
  setPendingGate: (p: PendingGate): void => set({ pendingGate: p }),
  clearPendingGate: (): void => set({ pendingGate: null }),
  setProgress: (line: string | null): void => set({ lastProgress: line }),
}));

/**
 * PURE selector: does a gated result need the user's confirm before it can
 * proceed? (warn with no force, or a block/error the user may force-override).
 * The decision is the ENGINE's — this only reads the tier it already set (C5).
 */
export function gateNeedsConfirm(gate: EnvGateSummary | undefined): boolean {
  if (!gate) return false;
  return gate.verdict === "warn" || gate.verdict === "block" || gate.verdict === "error";
}
