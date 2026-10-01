// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/health.ts — `prometheus health`: the engine/scanner RUNTIME posture pill the
 * GUI's System Health panel renders, in the terminal. Distinct from `prometheus doctor`
 * (OS/agents/git/paths) and `prometheus doctor --bridge` (engine path discovery): this is
 * the live posture of the engine, the version contract, and the nemesis scanner.
 *
 * PURE-ish: it probes through the injected EngineClient + a nemesis presence probe,
 * folds the rows through core `health.aggregateHealth` (the authority the main
 * process uses), and renders a banded 0–100 score + per-component table. Fail-closed
 * in spirit: an unreachable engine is `down`, an absent scanner is `degraded`.
 */
import { health } from "@prometheus/core";
import { cacheStatus as ebCacheStatus } from "@prometheus/engine-bridge";

import type { CliContext, CommandOutcome } from "../context.js";
import { c, heading, table } from "../render.js";

/** Injected probes so the command is unit-testable without a real spawn. */
export interface HealthDeps {
  /** true when the nemesis scanner answers (presence signal). */
  nemesisPresent: (ctx: CliContext) => Promise<boolean>;
}

export const defaultHealthDeps: HealthDeps = {
  nemesisPresent: async () => {
    try {
      const s = await ebCacheStatus({});
      return s.ok;
    } catch {
      return false;
    }
  },
};

/** Tint a 0–100 score: ≥85 green, ≥60 yellow, else red. */
function scoreTint(score: number): (s: string) => string {
  return score >= 85 ? c.green : score >= 60 ? c.yellow : c.red;
}

/** A small ASCII band so the score reads at a glance in any terminal. */
function band(score: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * 20);
  return `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
}

function statusCell(status: string): string {
  return status === "ok"
    ? c.green("ok")
    : status === "down"
      ? c.red("down")
      : status === "degraded"
        ? c.yellow("degraded")
        : c.dim(status);
}

export async function runHealth(
  ctx: CliContext,
  deps: HealthDeps = defaultHealthDeps,
): Promise<CommandOutcome> {
  const components: ReturnType<typeof health.boolComponent>[] = [];

  // 1. Engine reachability + version (down when unreachable/unparseable).
  let version: string | null = null;
  try {
    const v = await ctx.client.version();
    version = v.scriptVersion;
  } catch {
    version = null;
  }
  components.push(
    health.boolComponent("engine", "Engine", version !== null, {
      ...(version ? { detail: `v${version}` } : {}),
      remediation: "run `prometheus doctor --bridge` to locate the engine",
    }),
  );

  // 2. Version contract (capabilities negotiated against the bundle MIN_ENGINE).
  try {
    const caps = await ctx.client.capabilities();
    const ok = caps.scriptVersion !== null && caps.jsonContract;
    components.push(
      health.boolComponent("contract", "Version contract", ok, {
        softFail: true,
        detail: caps.scriptVersion ? `negotiated v${caps.scriptVersion}` : "unknown",
        remediation: "engine older than this bundle expects — update prometheus.py",
      }),
    );
  } catch {
    components.push(
      health.boolComponent("contract", "Version contract", false, {
        softFail: true,
        remediation: "could not negotiate the engine contract",
      }),
    );
  }

  // 3. Nemesis scanner presence (soft-fail: absent → gating degrades, not down).
  const present = await deps.nemesisPresent(ctx);
  components.push(
    health.boolComponent("nemesis", "Nemesis scanner", present, {
      softFail: true,
      remediation: "install/locate nemesis to enable fail-closed gating",
    }),
  );

  const sys = health.aggregateHealth(components);

  if (ctx.json) return { json: { ok: true, health: sys }, exitCode: 0 };

  const tint = scoreTint(sys.score);
  const tierLabel =
    sys.tier === "ok" ? c.green("OK") : sys.tier === "down" ? c.red("DOWN") : c.yellow("DEGRADED");
  const lines = [heading(`System health  ${tierLabel}`), ""];
  lines.push(`  ${tint(band(sys.score))}  ${tint(`${sys.score}/100`)}`);
  lines.push("");
  lines.push(
    table(
      [{ header: "COMPONENT" }, { header: "STATUS" }, { header: "DETAIL" }],
      sys.components.map((cm) => [
        cm.label,
        statusCell(cm.status),
        c.dim(cm.detail ?? cm.remediation ?? ""),
      ]),
    ),
  );
  lines.push("");
  lines.push(c.dim(sys.summary));
  return { text: lines.join("\n"), exitCode: sys.tier === "down" ? 2 : 0 };
}
