/**
 * types/matrix.ts — the `matrix` envelope (file 02 §3.3).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json matrix` @ 0.15.0):
 *   {"command":"matrix","ok":true,
 *    "agents":["claude","codex","cursor",...],
 *    "reach":[{"plugin":"...","scope":"C"|"U",
 *              "native":["claude"],"sync":[],"unavailable":["codex",...]}]}
 * `scope` here is the COMPACT code (C=claude-only, U=universal), distinct from
 * the long "claude-only"/"universal" used elsewhere — typed open as a string.
 */
import type { EnvelopeBase } from "./envelope.js";

/** One plugin's reach across the agent set. */
export interface MatrixReach {
  plugin: string;
  /** compact scope code: "C" (claude-only) | "U" (universal). */
  scope: string;
  /** agents the plugin installs into natively. */
  native: string[];
  /** agents reached via a sync bridge. */
  sync: string[];
  /** agents the plugin cannot reach. */
  unavailable: string[];
}

export type MatrixEnvelope = EnvelopeBase<{
  command: "matrix";
  agents: string[];
  reach: MatrixReach[];
}>;
