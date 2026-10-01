// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/methods.ts — the `methods <id>` envelope (every documented install method).
 *
 * GROUND TRUTH (`python3 prometheus.py --json methods ultralytics`):
 *   {"command":"methods","ok":true,"id":"ultralytics","section":"## Install ...markdown..."}
 */
import type { EnvelopeBase } from "./envelope.js";

export type MethodsEnvelope = EnvelopeBase<{
  command: "methods";
  id: string;
  /** the dossier's "## Install" section (markdown) listing every method. */
  section: string;
}>;
