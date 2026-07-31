/**
 * session/repo-map-state.ts — the host-side holder for the built-in repo map (CLI-053).
 *
 * The PURE walk/render lives in `@prometheus/core` (token-economy/repo-map.ts); THIS file binds
 * the real `node:fs` adapter (apps/cli is where IO is allowed) and owns the session-scoped toggle
 * + the last rendered map. The map is rebuilt ONLY on explicit refresh (walking the tree is the
 * cost) and defaults OFF so the first turn in a huge repo never pays an unexpected full walk.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";

import { tokenEconomy } from "@prometheus/core";

type RepoFs = tokenEconomy.RepoFs;
type RepoMap = tokenEconomy.RepoMap;
const { renderRepoMap, walkRepo } = tokenEconomy;

/** The real filesystem adapter — the ONLY node:fs binding for the repo map (core stays IO-free). */
function nodeRepoFs(): RepoFs {
  return {
    readdir: (dir) =>
      readdirSync(dir || ".", { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
      })),
    readFile: (p) => readFileSync(p, "utf8"),
    statSize: (p) => statSync(p).size,
  };
}

export interface RepoMapState {
  /** whether the map is injected into the agent's context (default false — see module note). */
  enabled: boolean;
  /** the walk root (the session cwd at build time). */
  root: string;
  /** the token budget the render trims to (CLI-052 meter uses the same estimator). */
  budget: number;
  /** the last walked map, or null before the first refresh. */
  map: RepoMap | null;
  /** the last rendered map string, or null before the first refresh. */
  rendered: string | null;
}

/** A fresh, EMPTY state (OFF, unbuilt). Call `refreshRepoMap` to walk + render. */
export function makeRepoMapState(root: string, budget = 2048): RepoMapState {
  return { enabled: false, root, budget, map: null, rendered: null };
}

/**
 * Walk the root (via the real node:fs adapter) and render the budgeted map into `state`. Mutates
 * and returns the same object so the host's `ctx.repoMap` getter sees the update live. Never
 * throws: a walk failure leaves the previous map in place and records nothing new.
 */
export function refreshRepoMap(state: RepoMapState, fs: RepoFs = nodeRepoFs()): RepoMapState {
  try {
    const map = walkRepo(fs, state.root);
    state.map = map;
    state.rendered = renderRepoMap(map, state.budget);
  } catch {
    // keep the last good map; a transient fs error must not blank an already-built map.
  }
  return state;
}

/**
 * Apply `/repomap on|off|refresh` (or bare toggle). Refresh (and turning ON when unbuilt) walks
 * the tree; toggling uses the cached render. Returns a one-line human status.
 */
export function applyRepoMapVerb(
  state: RepoMapState,
  verb: string,
  fs: RepoFs = nodeRepoFs(),
): string {
  const v = verb.trim().toLowerCase();
  if (v === "refresh") {
    refreshRepoMap(state, fs);
    state.enabled = true;
    return repoMapStats(state);
  }
  if (v === "off") {
    state.enabled = false;
    return "repo map OFF";
  }
  if (v === "on" || v === "") {
    state.enabled = true;
    if (!state.rendered) refreshRepoMap(state, fs); // build on first enable (explicit action)
    return repoMapStats(state);
  }
  return `repo map: unknown "${verb}" — use on | off | refresh`;
}

/** A compact stats line: on/off · files · tokens · truncated? — for the no-arg `/repomap`. */
export function repoMapStats(state: RepoMapState): string {
  const onoff = state.enabled ? "on" : "off";
  if (!state.map) return `repo map ${onoff} — not built yet (run: /repomap refresh)`;
  const tokens = state.rendered ? Math.ceil(state.rendered.length / 4) : 0;
  const trunc = state.map.truncated ? " · truncated (file cap hit)" : "";
  return `repo map ${onoff} — ${state.map.fileCount} files · ~${tokens} tok${trunc}`;
}
