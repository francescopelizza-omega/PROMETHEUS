// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * types/where.ts — the `where` envelope (file 02 §3.3).
 *
 * GROUND TRUTH (probed `python3 prometheus.py --json where caveman` @ 0.15.0):
 *   {"command":"where","ok":true,
 *    "plugin":{"name":"caveman","scope":"claude-only",
 *      "targets":[{"agent":"claude","method":"claude_plugin",
 *                  "dest":"~/.claude/plugins (+ enabledPlugins)",
 *                  "mcp_name":null,"repo_url":null,"universal_add":null}]}}
 * NOTE: `where`'s targets is an ARRAY (per-agent rows), unlike info's targets MAP.
 */
import type { EnvelopeBase } from "./envelope.js";
import type { CatalogScope } from "./list.js";

/** One per-agent destination row in a where payload. */
export interface WhereTarget {
  agent: string;
  method: string;
  /** human destination string (may contain "~" + a parenthetical hint). */
  dest: string;
  mcp_name: string | null;
  repo_url: string | null;
  universal_add: string | null;
}

/** The where plugin block: name + scope + the per-agent install destinations. */
export interface WherePlugin {
  name: string;
  scope: CatalogScope;
  targets: WhereTarget[];
}

export type WhereEnvelope = EnvelopeBase<{
  command: "where";
  plugin: WherePlugin;
}>;
