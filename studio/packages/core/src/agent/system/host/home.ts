// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/host/home.ts — the canonical Prometheus home root (Phase 6).
 *
 * Extracted from `apps/cli/src/home.ts` because the exec audit is written by BOTH hosts now
 * and they must agree on where it lives. Only this resolver moved; the CLI's paths/settings/
 * first-run machinery stays in the CLI, where it belongs.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Expand a leading `~`/`~/` to $HOME (path.resolve does NOT do this). */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** The canonical Prometheus home root: $PROMETHEUS_HOME, else `~/.prometheus`. */
export function prometheusHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PROMETHEUS_HOME?.trim();
  return override ? resolve(expandTilde(override)) : join(homedir(), ".prometheus");
}
