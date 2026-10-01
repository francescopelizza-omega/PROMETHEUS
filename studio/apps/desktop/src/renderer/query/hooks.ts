// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/query/hooks.ts — the TanStack Query hooks over the contextBridge (§5).
 *
 * Every hook reaches the engine ONLY through `window.prometheus.*` (the typed
 * contextBridge seam). The renderer holds NO engine paths and never touches
 * child_process — Query just orchestrates the async I/O the MAIN process performs.
 *
 *   - useHealth()  → window.prometheus.health()     (also seeds the Zustand pill)
 *   - useScan()    → window.prometheus.scan()
 *   - useCatalog() → window.prometheus.list()
 *   - useStatus(n) → window.prometheus.status(n)
 *   - useInstall() → mutation: window.prometheus.install(name, {onProgress runId});
 *                    invalidates ['catalog'] + ['status', name] on settle.
 *
 * Imports: @tanstack/react-query + react + the PLAIN-DATA contract types only (C5).
 */

import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import type {
  EnvelopeResult,
  HealthResult,
  ProgressFeedEvent,
  ScanResult,
} from "../../shared/ipc-contract.js";
import { useEngineStore } from "../stores/engine.js";
import { qk } from "./client.js";

/** The window.prometheus surface this module depends on (typed via the contract). */
function bridge(): Window["prometheus"] {
  // The preload guarantees this exists in the real renderer; in tests the store's
  // own resolveApi handles absence. Hooks only run inside a mounted renderer.
  return window.prometheus;
}

/** Engine/scanner health (read-only). Also pushes the result into the Zustand pill. */
export function useHealth(): UseQueryResult<HealthResult> {
  const setHealth = useEngineStore((s) => s.setHealth);
  const query = useQuery({
    queryKey: qk.health(),
    queryFn: () => bridge().health(),
  });
  // Mirror the latest health into the Zustand slice so the title-bar pill (which
  // reads the store, not Query) stays in sync without prop-drilling.
  useEffect(() => {
    if (query.data) setHealth(query.data);
  }, [query.data, setHealth]);
  return query;
}

/** Detected agents (read-only). */
export function useScan(): UseQueryResult<ScanResult> {
  return useQuery({
    queryKey: qk.scan(),
    queryFn: () => bridge().scan(),
  });
}

/** The installable plugin/agent registry (read-only). */
export function useCatalog(): UseQueryResult<EnvelopeResult> {
  return useQuery({
    queryKey: qk.catalog(),
    queryFn: () => bridge().list(),
  });
}

/** Python environments via the envmgr sidecar (read-only) — the SAME qk.envs key
 *  the Environments route and Home share, so the shell's venv fact (APP-009) rides
 *  the existing cached read instead of adding a new IPC poll. */
export function useEnvList(): UseQueryResult<EnvelopeResult> {
  return useQuery({
    queryKey: qk.envs(),
    queryFn: () => bridge().envList(),
  });
}

/** Installed-state of one plugin (or "all"). Read-only. */
export function useStatus(name: string): UseQueryResult<EnvelopeResult> {
  return useQuery({
    queryKey: qk.status(name),
    queryFn: () => bridge().status(name),
    enabled: name.length > 0,
  });
}

/** The variables an install mutation takes. */
export interface InstallVars {
  name: string;
  dryRun?: boolean;
  forced?: boolean;
}

/**
 * Install a plugin (state-changing). Mints a runId, streams progress via
 * `onProgress` (filtered to this runId), and on settle invalidates the catalog +
 * this plugin's status so the panels refetch. The engine runs nemesis itself and
 * returns a forced_danger / ok:false envelope when blocked — the mutation result
 * carries that VALID outcome; the UI renders it, JS never pre-judges "safe" (C5).
 */
export function useInstall(
  onProgress?: (e: ProgressFeedEvent) => void,
): UseMutationResult<EnvelopeResult, Error, InstallVars> & { cancel: () => void } {
  const qc = useQueryClient();
  const runIdRef = useRef<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const mutation = useMutation<EnvelopeResult, Error, InstallVars>({
    mutationFn: async (vars: InstallVars): Promise<EnvelopeResult> => {
      const runId = mintRunId();
      runIdRef.current = runId;
      // Subscribe to the live progress feed for THIS runId only.
      if (onProgress) {
        unsubRef.current = bridge().onProgress((e: ProgressFeedEvent) => {
          if (e.runId === undefined || e.runId === runId) onProgress(e);
        });
      }
      try {
        const opts: { dryRun?: boolean; forced?: boolean; runId: string } = { runId };
        if (vars.dryRun !== undefined) opts.dryRun = vars.dryRun;
        if (vars.forced !== undefined) opts.forced = vars.forced;
        return await bridge().install(vars.name, opts);
      } finally {
        unsubRef.current?.();
        unsubRef.current = null;
        runIdRef.current = null;
      }
    },
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: qk.catalog() });
      void qc.invalidateQueries({ queryKey: qk.status(vars.name) });
    },
  });

  // Cancel the in-flight install (if any) by its runId (fire-and-forget, §4.3).
  const cancel = useCallback((): void => {
    const id = runIdRef.current;
    if (id) bridge().cancel(id);
  }, []);

  return Object.assign(mutation, { cancel });
}

/** A best-effort unique correlation id (crypto.randomUUID with a fallback). */
function mintRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
