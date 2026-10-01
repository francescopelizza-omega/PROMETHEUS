// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * shell/ForceGate.tsx — the typed confirm in front of every BLOCK override (§9, HIGH).
 *
 * THE DEFECT THIS CLOSES. `prometheus.py` refuses a nemesis BLOCK and, on a TTY, demands
 * the operator type `install-dangerous` before `--force` is honoured
 * (`_confirm_dangerous_override`). Studio could never reach that prompt — twice over:
 * the sidecar is spawned with `stdio: ["pipe","pipe","pipe"]`, so `sys.stdin.isatty()`
 * is always false, and the GUI sends `--yes`, which short-circuits the prompt anyway.
 * The result was that the "☠ Force install at my own risk" button in the catalog, repos,
 * models and environments routes was a ONE-CLICK bypass of a deep-red block. The engine's
 * friction existed; the GUI simply routed around it.
 *
 * So the confirm has to live here, in the renderer, and it has to be the SAME component
 * in all four places — four hand-rolled confirms is how three of them end up subtly
 * weaker than the fourth.
 *
 * This is friction, not enforcement. The main process still drops `force` unless
 * `confirmForce` is paired with it (catalog-validate / repo-validate / security-ipc), and
 * the engine still re-runs its own gate. This component cannot authorise anything; it can
 * only make sure a human typed the words before the request is sent.
 *
 * Usage:
 *   const force = useForceGate();
 *   …
 *   onRequestForce={() => force.ask({ target, blockingReasons, onConfirm })}
 *   …
 *   <ForceGate gate={force} />
 */

import { ForceOverrideDialog } from "@prometheus/ui";
import { type ReactElement, useCallback, useState } from "react";

import { useSecurityStore } from "../stores/features.js";

/** One pending override: what is being forced, why it was blocked, and what to run. */
export interface ForceRequest {
  /** the artifact the override applies to — shown inert in the dialog. */
  target: string;
  /** the engine's blocking reasons, restated verbatim. */
  blockingReasons: string[];
  /** run the forced operation. Called ONLY after an exact typed-token match. */
  onConfirm(): void;
}

export interface ForceGateHandle {
  pending: ForceRequest | null;
  /** raise the typed confirm for `req`. */
  ask(req: ForceRequest): void;
  /** dismiss without forcing. */
  cancel(): void;
  /** the dialog's confirm path (exported for tests; the component wires it). */
  confirm(): void;
}

export function useForceGate(): ForceGateHandle {
  const [pending, setPending] = useState<ForceRequest | null>(null);
  const noteForced = useSecurityStore((s) => s.noteForced);

  const ask = useCallback((req: ForceRequest): void => setPending(req), []);
  const cancel = useCallback((): void => setPending(null), []);
  const confirm = useCallback((): void => {
    setPending((p) => {
      if (p) {
        noteForced();
        p.onConfirm();
      }
      return null;
    });
  }, [noteForced]);

  return { pending, ask, cancel, confirm };
}

/** Renders the pending confirm, if any. Mount once per route, beside its other overlays. */
export function ForceGate({ gate }: { gate: ForceGateHandle }): ReactElement | null {
  const forcedThisSession = useSecurityStore((s) => s.forcedThisSession);
  if (!gate.pending) return null;
  return (
    <ForceOverrideDialog
      target={gate.pending.target}
      blockingReasons={gate.pending.blockingReasons}
      forcedThisSession={forcedThisSession}
      onConfirm={gate.confirm}
      onCancel={gate.cancel}
    />
  );
}

export default ForceGate;
