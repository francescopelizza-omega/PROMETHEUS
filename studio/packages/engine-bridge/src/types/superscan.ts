// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/superscan.ts — the `superscan` envelope (file 02 §3.3 fallthrough set).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json superscan` @ 0.15.0):
 *   {"command":"superscan","ok":true,
 *    "os":{"family":"macos","pkg_manager":"brew"},
 *    "agents":[{"name","label","kind","present","binary":str|null,
 *               "version":str|null,"config_dir":str|null,
 *               "stale_days":num|null,"forgotten":bool,
 *               "counts":{plugins,skills,mcp,extensions,rules,commands},
 *               "total":num}, ...]}
 * A deep inventory; richer than scan's per-agent row.
 */
import type { EnvelopeBase } from "./envelope.js";
import type { ScanOs } from "./scan.js";

/** Per-category install counts inside one superscan agent row. */
export interface SuperscanCounts {
  plugins: number;
  skills: number;
  mcp: number;
  extensions: number;
  rules: number;
  commands: number;
}

/** One deep-inventory agent row. Absent agents carry nulls + zeroed counts. */
export interface SuperscanAgent {
  name: string;
  label: string;
  kind: string;
  present: boolean;
  binary: string | null;
  version: string | null;
  config_dir: string | null;
  stale_days: number | null;
  forgotten: boolean;
  counts: SuperscanCounts;
  total: number;
}

export type SuperscanEnvelope = EnvelopeBase<{
  command: "superscan";
  os: ScanOs;
  agents: SuperscanAgent[];
}>;
