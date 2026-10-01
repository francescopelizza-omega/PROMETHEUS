// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/describe.ts — the `describe <id>` envelope (catalog card).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json describe crewai`):
 *   {"command":"describe","ok":true,"id":"crewai","kind":"model_tool","name":"CrewAI",
 *    "summary":"...","repo":"...","license":"","category":"library","tier":"",
 *    "security":"...","installable":true,"has_tutorial":true}
 */
import type { EnvelopeBase } from "./envelope.js";

export type DescribeEnvelope = EnvelopeBase<{
  command: "describe";
  id: string;
  /** plugin | model_tool | app | model | documented */
  kind: string;
  name: string;
  summary: string;
  repo: string;
  license: string;
  category: string;
  tier: string;
  security: string;
  /** false for documented-only/excluded entries (no install path). */
  installable: boolean;
  /** whether a deep tutorial (dossier) exists for `tutorial <id>`. */
  has_tutorial: boolean;
}>;
