/**
 * repl/panes.ts — REPL pane ids + Ctrl+G cycle order (file 11 §3/§7, PURE).
 */
export type PaneId =
  | "transcript"
  | "catalog"
  | "env"
  | "model"
  | "repo"
  | "app"
  | "worldsim"
  | "vault"
  | "audit"
  | "matrix"
  | "skills"
  | "scan";

/** The Ctrl+G global cycle (§3: transcript ↔ catalog ↔ env ↔ model ↔ repo). */
export const PANE_CYCLE: readonly PaneId[] = Object.freeze([
  "transcript",
  "catalog",
  "env",
  "model",
  "repo",
]);

/** Cycle to the next/previous pane in PANE_CYCLE (wraps; off-cycle → first). */
export function cyclePane(current: PaneId, dir: 1 | -1 = 1): PaneId {
  const i = PANE_CYCLE.indexOf(current);
  if (i === -1) return PANE_CYCLE[0] as PaneId;
  const n = (i + dir + PANE_CYCLE.length) % PANE_CYCLE.length;
  return PANE_CYCLE[n] as PaneId;
}
