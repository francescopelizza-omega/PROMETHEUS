// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/tutorial.ts — the `tutorial <id>` envelope (the "Learn more" deep dossier).
 *
 * GROUND TRUTH (`python3 prometheus.py --json tutorial firecrawl`):
 *   {"command":"tutorial","ok":true,"id":"firecrawl","text":"# ...markdown..."}
 */
import type { EnvelopeBase } from "./envelope.js";

export type TutorialEnvelope = EnvelopeBase<{
  command: "tutorial";
  id: string;
  /** the full dossier markdown (rendered by the GUI Learn-more drawer). */
  text: string;
}>;
