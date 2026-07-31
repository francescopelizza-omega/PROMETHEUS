/**
 * types/harden.ts — the `harden` envelope (defensive self-audit of THIS machine).
 *
 * GROUND TRUTH (`python3 prometheus.py --json harden`):
 *   {"command":"harden","ok":true,
 *    "findings":[{"severity":"warn","message":"...","fix":"..."}, ...],
 *    "warnings":3}
 */
import type { EnvelopeBase } from "./envelope.js";

/** One posture check result. severity ∈ ok | warn | info | err. */
export interface HardenFinding {
  severity: string;
  message: string;
  fix: string;
}

export type HardenEnvelope = EnvelopeBase<{
  command: "harden";
  findings: HardenFinding[];
  /** count of `warn` findings (items to harden). */
  warnings: number;
}>;
