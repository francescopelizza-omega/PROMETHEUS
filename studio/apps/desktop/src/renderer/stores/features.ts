/**
 * renderer/stores/features.ts — the per-FEATURE Zustand slice STUBS (§5).
 *
 * §5 maps one Zustand slice per feature: securityStore (verdicts/quarantine — 03),
 * packagesStore (04), modelsStore (05), reposStore (06). The FETCHING/caching of
 * engine data lives in TanStack Query (query/hooks); these slices hold only the
 * UI/SESSION state each feature owns (selection, open panels, the latest verdict
 * to highlight, a pending typed-confirm). They are intentionally THIN stubs the
 * feature files (03–06) flesh out — wired now so the store topology exists and is
 * testable, none of them reach the engine directly (C5).
 *
 * Imports: zustand + PLAIN-DATA contract types only. No engine-bridge, no node:*.
 */

import { create } from "zustand";

import type { GateResult } from "../../shared/ipc-contract.js";

/**
 * The verdict tier the shield is tinted by. Sourced from GateResult (a plain-data
 * contract type) so this renderer store imports NOTHING from engine-bridge (C5) —
 * the tier union is `GateResult["verdict"]`, kept in lockstep with the engine via
 * the contract's own re-statement.
 */
type VerdictTier = GateResult["verdict"];

/* ── security (03): the latest verdict to highlight + a pending force-confirm ─*/
export interface SecurityStore {
  /** the most recent gate verdict the user ran (drives the StatusBar shield). */
  lastVerdict: GateResult | null;
  /** the verdict tier currently tinting the permanent nemesis shield. */
  shieldTier: VerdictTier | null;
  /** a plugin name awaiting a typed-confirm before a `--force` override. */
  pendingForce: string | null;
  setVerdict(v: GateResult): void;
  requestForce(name: string): void;
  clearForce(): void;
}

export const useSecurityStore = create<SecurityStore>((set) => ({
  lastVerdict: null,
  shieldTier: null,
  pendingForce: null,
  setVerdict: (v: GateResult): void => set({ lastVerdict: v, shieldTier: v?.verdict ?? null }),
  requestForce: (name: string): void => set({ pendingForce: name }),
  clearForce: (): void => set({ pendingForce: null }),
}));

/* ── packages (04): catalog selection + which plugin's detail pane is open ───*/
export interface PackagesStore {
  selected: string | null;
  /** plugin names whose install is currently in flight (by runId). */
  installing: Record<string, string>; // name -> runId
  select(name: string | null): void;
  markInstalling(name: string, runId: string): void;
  clearInstalling(name: string): void;
}

export const usePackagesStore = create<PackagesStore>((set) => ({
  selected: null,
  installing: {},
  select: (name: string | null): void => set({ selected: name }),
  markInstalling: (name: string, runId: string): void =>
    set((s) => ({ installing: { ...s.installing, [name]: runId } })),
  clearInstalling: (name: string): void =>
    set((s) => {
      const next = { ...s.installing };
      delete next[name];
      return { installing: next };
    }),
}));

/* ── models (05): the model-hub UI selection ─────────────────────────────────*/
export interface ModelsStore {
  selected: string | null;
  select(id: string | null): void;
}

export const useModelsStore = create<ModelsStore>((set) => ({
  selected: null,
  select: (id: string | null): void => set({ selected: id }),
}));

/* ── repos (06): the repo/worldsim UI selection ──────────────────────────────*/
export interface ReposStore {
  selected: string | null;
  select(id: string | null): void;
}

export const useReposStore = create<ReposStore>((set) => ({
  selected: null,
  select: (id: string | null): void => set({ selected: id }),
}));
