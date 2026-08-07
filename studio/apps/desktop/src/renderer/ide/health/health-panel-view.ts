/**
 * health-panel-view.ts — PURE: derive the System Health view from the engine probe.
 *
 * The renderer reaches the engine ONLY through `window.prometheus.health()` (C5); this
 * folds that `HealthResult` + the derived pill into the `SystemHealthView` the panel +
 * @prometheus/ui's <HealthGauge> render. Pure + node:test-tested (no DOM, no IPC). The
 * core `health.aggregateHealth` is the authority for main-process consumers; the renderer
 * can't import core, so this is the slim renderer-side mirror (same fail-closed bias).
 */
import type { HealthRow, SystemHealthView } from "@prometheus/ui";

import type { HealthResult } from "../../../shared/ipc-contract.js";
import type { HealthPill } from "../../stores/health-derive.js";

/** pill → overall tier (ready→ok; down→down; degraded/unknown→degraded, fail-closed). */
export function tierFromPill(pill: HealthPill): SystemHealthView["tier"] {
  return pill === "ready" ? "ok" : pill === "down" ? "down" : "degraded";
}

const TIER_SCORE: Record<SystemHealthView["tier"], number> = { ok: 100, degraded: 55, down: 0 };

/** Build the System Health view from the latest probe + pill. Null probe → unknown rows. */
export function deriveSystemHealthView(
  health: HealthResult | null,
  pill: HealthPill,
): SystemHealthView {
  const components: HealthRow[] = [];

  if (health === null) {
    components.push({ id: "engine", label: "Engine", status: "unknown", detail: "no probe yet" });
  } else {
    // engine: down if unreachable / no version; degraded on a contract mismatch; else ok
    const engineStatus: HealthRow["status"] =
      !health.ok || !health.version ? "down" : health.contractOk ? "ok" : "degraded";
    components.push({
      id: "engine",
      label: "Engine",
      status: engineStatus,
      ...(health.version
        ? { detail: `v${health.version}${health.contractOk ? "" : " · contract mismatch"}` }
        : {}),
      ...(engineStatus !== "ok"
        ? { remediation: "run `prometheus doctor` to diagnose the engine" }
        : {}),
    });
    // nemesis presence (security scanner) — degraded (soft) when absent
    components.push({
      id: "nemesis",
      label: "Nemesis scanner",
      status: health.nemesisPresent ? "ok" : "degraded",
      ...(health.nemesisPresent ? {} : { remediation: "install/locate nemesis to enable gating" }),
    });
    // surface any engine-reported problems as a row (guard: `problems` may be absent on
    // a partial HealthResult — the only prior guard was `health === null`).
    if (Array.isArray(health.problems) && health.problems.length > 0) {
      components.push({
        id: "problems",
        label: "Diagnostics",
        status: "degraded",
        detail: `${health.problems.length} issue${health.problems.length === 1 ? "" : "s"}`,
      });
    }
  }

  const tier = tierFromPill(pill);
  // score: blend the pill tier with a penalty per non-ok component (clamped 0..100)
  const penalty = components.filter((c) => c.status !== "ok").length * 12;
  const score = Math.max(0, Math.min(100, TIER_SCORE[tier] - (tier === "ok" ? 0 : penalty)));
  const bad = components.filter((c) => c.status !== "ok");
  const summary =
    bad.length === 0
      ? `all systems nominal (${components.length})`
      : `${bad.length}/${components.length} need attention`;
  return { tier, score, components, summary };
}
