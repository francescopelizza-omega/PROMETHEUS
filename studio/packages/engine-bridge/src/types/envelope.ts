/**
 * types/envelope.ts — the typed-envelope base (file 02 §3.3).
 *
 * This is a RE-EXPORT hub, NOT a second definition. The canonical wire base is
 * the generic `EngineEnvelope<T>` already defined in ../contract.ts (file 01
 * §11.2); the verdict axes live in ../security/verdict.ts (C3). file 02 calls
 * the base `EnvelopeBase`, so we alias it here so per-command modules can write
 *   `interface ScanEnvelope extends EnvelopeBase<{...}> { command: "scan" }`
 * without redefining any shared key.
 *
 * Nothing in src/types/ defines `command`/`ok`/`error`/`_exit`/`forced_danger`
 * itself — those come from EngineEnvelope. The per-command modules only narrow
 * `command` to a string-literal and add the payload fields the real engine emits.
 */

// The generic base every typed envelope extends. `EnvelopeBase` is just file
// 02's name for the canonical `EngineEnvelope<T>` from contract.ts. ONE shape.
export type { EngineEnvelope as EnvelopeBase } from "../contract.js";

// The same loose base run.ts actually produces (index-signature preserved), for
// the fallthrough arm of the discriminated union.
export type { EngineEnvelope as LooseEnvelope } from "../run.js";

// Verdict axes + the forced-danger override block (single source of truth, C3).
export type {
  VerdictTier,
  Severity,
  ForcedDanger,
} from "../security/verdict.js";
