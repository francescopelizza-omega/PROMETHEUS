// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * GateVerdictSheet.tsx — a THIN wrapper re-using the file-03 VerdictSheet (§3.3/§6).
 *
 * When a gated install returns a warn/block/error, the Environments tab shows the
 * SAME deep-red verdict sheet the Security Center uses — because the gate decision
 * is the ENGINE's, not a separate env-side surface. This component does NOT
 * re-implement the sheet: it adapts the lightweight `EnvGateBadge` (the camelCased
 * gate summary a gated-install result carries) into the structural `SecVerdict`
 * the shared `<VerdictSheet/>` consumes, then renders it. It NEVER scores, never
 * upgrades a tier toward allow, never decides "safe" (C5) — it only re-shapes what
 * the engine already produced and forwards the proceed/cancel/force callbacks.
 *
 * Imports only react + this package's security barrel (VerdictSheet) + env helpers.
 */

import type { ReactElement } from "react";
import { VerdictSheet } from "../security/VerdictSheet.js";
import type { EnvGateBadge } from "./types.js";
import { gateToVerdict } from "./util.js";

export interface GateVerdictSheetProps {
  /** the gate summary the engine produced for a package fetch. */
  gate: EnvGateBadge;
  /** the install target (a pip spec or env name) — shown as inert text. */
  target: string;
  /** reflects the policy tier the engine ran under (gates MEDIUM in warn). */
  strict?: boolean;
  /** proceed (allow/warn "install anyway") — the host wires the gated install. */
  onProceed?(): void;
  /** cancel / hold. */
  onCancel?(): void;
  /** open the force-override flow (block/error, under the Advanced disclosure). */
  onRequestForce?(): void;
  className?: string;
}

export function GateVerdictSheet({
  gate,
  target,
  strict,
  onProceed,
  onCancel,
  onRequestForce,
  className,
}: GateVerdictSheetProps): ReactElement {
  const verdict = gateToVerdict(gate, target);
  return (
    <VerdictSheet
      verdict={verdict}
      strict={strict}
      onProceed={onProceed}
      onCancel={onCancel}
      onRequestForce={onRequestForce}
      className={className}
    />
  );
}

export default GateVerdictSheet;
