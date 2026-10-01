// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/scan.ts — the `scan` envelope (file 02 §3.3).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json scan` @ 0.15.0):
 *   {"command":"scan","ok":true,
 *    "os":{"family":"macos","pkg_manager":"brew"},
 *    "agents":[{"name":"claude","label":"Claude Code","kind":"cli",
 *               "present":true,"where":"/Users/.../claude"}, ...]}
 * `where` is "not found" when present:false (a string, never null).
 */
import type { EnvelopeBase } from "./envelope.js";

/** Host OS summary the engine reports at the top of scan/superscan. */
export interface ScanOs {
  family: string;
  pkg_manager: string;
}

/** One detected (or absent) agent row. */
export interface ScanAgent {
  name: string;
  label: string;
  /** "cli" | "ide" today; left open for future kinds. */
  kind: string;
  present: boolean;
  /** absolute path when present, the literal "not found" when absent. */
  where: string;
}

export type ScanEnvelope = EnvelopeBase<{
  command: "scan";
  os: ScanOs;
  agents: ScanAgent[];
}>;
