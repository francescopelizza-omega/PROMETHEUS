// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/state/inspection-profile-store.ts — the live wrapper around the PURE inspection
 * profile model (inspection-profile.ts, plan 03). Holds the active profile; the Problems
 * panel reads it to filter/re-rank diagnostics + offers suppress/severity actions. The
 * active profile PERSISTS to localStorage (APP-062) so per-rule overrides survive a reload,
 * and can be exported to / imported from JSON.
 *
 * Kept separate so inspection-profile.ts stays react/zustand-free + node:test-ed.
 */

import { create } from "zustand";

import {
  type InspectionProfile,
  type Severity,
  clearOverride,
  defaultProfile,
  deserializeProfile,
  serializeProfile,
  setOverride,
} from "./inspection-profile.js";

const STORAGE_KEY = "prometheus.inspectionProfile";

/** Load the persisted profile (fail-soft → Default; no-DOM safe for node:test). */
function loadProfile(): InspectionProfile {
  if (typeof window === "undefined" || !window.localStorage) return defaultProfile();
  try {
    return deserializeProfile(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return defaultProfile();
  }
}

function persist(profile: InspectionProfile): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeProfile(profile));
  } catch {
    /* quota / disabled storage — the override stays in-memory this session */
  }
}

interface InspectionProfileStore {
  profile: InspectionProfile;
  /** count of active overrides (drives the "N suppressed · reset" header affordance). */
  overrideCount(): number;
  setSeverity(id: string, severity: Severity): void;
  suppress(id: string): void;
  clear(id: string): void;
  reset(): void;
  /** APP-062: export the active profile as JSON (for the header "Export" action). */
  exportJson(): string;
  /** APP-062: replace the active profile from an imported JSON blob (validated, fail-soft). */
  importJson(raw: string): void;
}

/** Apply a pure profile transform, persist it, and commit. */
function apply(set: (p: { profile: InspectionProfile }) => void, next: InspectionProfile): void {
  persist(next);
  set({ profile: next });
}

export const useInspectionProfileStore = create<InspectionProfileStore>((set, get) => ({
  profile: loadProfile(),
  overrideCount: () => Object.keys(get().profile.overrides).length,
  setSeverity: (id, severity) => apply(set, setOverride(get().profile, id, severity)),
  suppress: (id) => apply(set, setOverride(get().profile, id, "off")),
  clear: (id) => apply(set, clearOverride(get().profile, id)),
  reset: () => apply(set, defaultProfile()),
  exportJson: () => serializeProfile(get().profile),
  importJson: (raw) => apply(set, deserializeProfile(raw)),
}));
