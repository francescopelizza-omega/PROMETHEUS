// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/info.ts — the `info` envelope (file 02 §3.3).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json info caveman` @ 0.15.0):
 *   {"command":"info","ok":true,
 *    "plugin":{"name","summary","tier","scope","repo","license",
 *              "stars":num|null,"category","recommend_rank":num|null,
 *              "automation","security_note","caveats":[..],"post_install_note",
 *              "supported_os":[..],
 *              "targets":{ "<agent>": {method, marketplace_name, marketplace_repo,
 *                          mcp_name, repo_url, dest, universal_add, shell_steps}},
 *              "components":[{"name","kind","desc"}]}}
 * Many target sub-fields are str|null; typed loosely (string|null) to match.
 */
import type { EnvelopeBase } from "./envelope.js";
import type { CatalogScope, CatalogTier } from "./list.js";

/** One selectable component (sub-plugin/skill) of a plugin. */
export interface InfoComponent {
  name: string;
  kind: string;
  desc: string;
}

/** Full per-agent install target descriptor inside an info payload. */
export interface InfoTarget {
  method: string;
  marketplace_name: string | null;
  marketplace_repo: string | null;
  mcp_name: string | null;
  repo_url: string | null;
  dest: string | null;
  universal_add: string | null;
  shell_steps: string[] | null;
}

/** The rich plugin metadata block. */
export interface InfoPlugin {
  name: string;
  summary: string;
  tier: CatalogTier;
  scope: CatalogScope;
  repo: string;
  license: string | null;
  stars: number | null;
  category: string;
  recommend_rank: number | null;
  automation: string;
  security_note: string;
  caveats: string[];
  post_install_note: string;
  supported_os: string[];
  targets: Record<string, InfoTarget>;
  components: InfoComponent[];
}

export type InfoEnvelope = EnvelopeBase<{
  command: "info";
  plugin: InfoPlugin;
}>;
