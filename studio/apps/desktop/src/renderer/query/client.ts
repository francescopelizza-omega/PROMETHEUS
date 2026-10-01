// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/query/client.ts — the TanStack Query client + canonical query keys (§5).
 *
 * TanStack Query owns the FETCHING/caching of engine reads (scan/catalog/status);
 * Zustand owns UI/session state. The bridge calls ARE async I/O with caching +
 * invalidation needs, so Query handles staleness, dedupe, and retries for us.
 *
 * Defaults are tuned for a LOCAL engine (no network flakiness): a modest staleTime
 * so panels don't refetch on every focus, ONE retry (a transient spawn race), and
 * NO refetch-on-window-focus (the engine doesn't change behind our back mid-op).
 *
 * The query KEYS live here as a typed factory so hooks + mutations invalidate the
 * exact same tuples (a typo would be a silent cache miss otherwise).
 *
 * Imports: @tanstack/react-query only. No engine-bridge, no node:* (C5).
 */

import { QueryClient } from "@tanstack/react-query";

/** Construct the app's QueryClient (called once at the renderer root). */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000, // engine reads are cheap but stable; 30s avoids churn.
        gcTime: 5 * 60_000,
        retry: 1, // one retry covers a transient python spawn race; no retry storm.
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0, // never silently re-run a state-changing op (install/uninstall).
      },
    },
  });
}

/**
 * Canonical query keys. Functions (not bare arrays) so call sites can't drift on
 * the tuple shape, and so `invalidateQueries` targets the exact same key a hook
 * registered under.
 */
export const qk = {
  health: () => ["health"] as const,
  scan: () => ["scan"] as const,
  catalog: () => ["catalog"] as const,
  status: (name: string) => ["status", name] as const,
  audit: (name: string) => ["audit", name] as const,
  matrix: () => ["matrix"] as const,
  where: (name: string) => ["where", name] as const,
  // ── file 04 Environments tab reads ──────────────────────────────────────
  envs: () => ["envs"] as const,
  pkgs: (envId: string) => ["pkgs", envId] as const,
  cuda: () => ["cuda"] as const,
  // ── file 05 Model Hub tab reads ─────────────────────────────────────────
  modelHardware: () => ["model", "hardware"] as const,
  modelSearch: (q: string, modality: string, source: string, freeOnly: boolean) =>
    ["model", "search", q, modality, source, freeOnly] as const,
  modelFit: (id: string) => ["model", "fit", id] as const,
  modelLibrary: (modality: string) => ["model", "library", modality] as const,
  /** The PREFIX — invalidates every modality at once. Models registers its query under
   *  "all" and Home under "text", so invalidating `modelLibrary("all")` after a pull left
   *  Home showing a stale library until a reload. */
  modelLibraryAll: () => ["model", "library"] as const,
  modelServing: () => ["model", "serving"] as const,
  modelEndpoints: () => ["model", "endpoints"] as const,
  // ── Home "Recent projects" (file 06 repos read) ─────────────────────────
  repos: () => ["repos", "list"] as const,
  // Home reads the supervised-servers list (shape {servers}); kept separate from
  // modelServing() which the Models route fills with a {profiles} payload — same
  // key would collide two incompatible shapes on one cache entry.
  homeServers: () => ["servers", "supervised"] as const,
} as const;
