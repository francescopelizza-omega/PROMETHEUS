/**
 * types/doctor.ts — the `doctor` "envelope" (file 02 §3.3, with a CAVEAT).
 *
 * IMPORTANT GROUND TRUTH (probed `python3 prometheus.py --json doctor` @ 0.15.0):
 *   `doctor` does NOT emit a JSON object — even under --json it prints HUMAN text
 *   to stdout/stderr (OS / pkg manager / python / git / detected agents) and
 *   exits 0. So there is NO `{command:"doctor", ok:true, ...}` envelope to type.
 *
 * Consequences (load-bearing — drives sidecar.health()):
 *   - The sidecar MUST NOT use `doctor` to test the --json CONTRACT; it is not a
 *     machine command. health() uses `scan` (a real JSON read-only command) to
 *     verify the contract, and may run `doctor` only as a human diagnostic whose
 *     RAW TEXT it captures (not parsed).
 *   - DoctorEnvelope below is the OPTIMISTIC shape for a *future* engine that
 *     emits a real doctor envelope (so the union stays total); today a `doctor`
 *     run that is forced through the JSON parser would not yield this — callers
 *     should treat doctor as text, see DoctorReport.
 */
import type { EnvelopeBase } from "./envelope.js";

/**
 * What `doctor` actually gives us today: raw human text + the exit code. The
 * sidecar captures this for the health pill WITHOUT pretending it is JSON.
 */
export interface DoctorReport {
  /** the human stdout text doctor printed (NOT JSON). */
  text: string;
  /** process exit code (0 healthy on the probed host). */
  exitCode: number;
}

/**
 * Optimistic typed envelope for a future engine that emits a machine `doctor`.
 * Present so the discriminated union is total; not produced by 0.15.0.
 */
export type DoctorEnvelope = EnvelopeBase<{
  command: "doctor";
  /** key/value diagnostics a future engine might surface (os, python, git, …). */
  checks?: Record<string, unknown>;
}>;
