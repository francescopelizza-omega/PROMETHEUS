/**
 * health/health.ts — system-health aggregation (Reliability & Polish pack).
 *
 * Folds the live status of Studio's moving parts (engine, nemesis DB, sidecars, LSP,
 * serve profiles, providers, …) into ONE `SystemHealth`: an overall tier + a 0–100
 * score + per-component rows with remediation hints. PURE + neutral — adapters turn
 * domain shapes (server states, a breaker snapshot, booleans) into `HealthComponent`s,
 * and `aggregate` rolls them up. FAIL-CLOSED bias: `unknown` never reads as healthy.
 */

export type ComponentStatus = "ok" | "degraded" | "down" | "unknown";
export type HealthTier = "ok" | "degraded" | "down";

/** One subsystem's health row (rendered in the System Health panel). */
export interface HealthComponent {
  id: string;
  label: string;
  status: ComponentStatus;
  /** a short live detail ("3/3 running", "DB 4d stale"). */
  detail?: string;
  /** an actionable hint shown when not ok ("run threatdb update"). */
  remediation?: string;
}

/** The aggregated whole-system health. */
export interface SystemHealth {
  tier: HealthTier;
  /** 0–100, weighted average of component scores (higher = healthier). */
  score: number;
  components: HealthComponent[];
  summary: string;
}

const STATUS_SCORE: Record<ComponentStatus, number> = {
  ok: 100,
  degraded: 50,
  unknown: 40,
  down: 0,
};

/** Roll component rows into a SystemHealth (worst-tier + weighted score + summary). */
export function aggregateHealth(components: readonly HealthComponent[]): SystemHealth {
  if (components.length === 0) {
    return { tier: "degraded", score: 0, components: [], summary: "no components reporting" };
  }
  const hasDown = components.some((c) => c.status === "down");
  const hasSoft = components.some((c) => c.status === "degraded" || c.status === "unknown");
  const tier: HealthTier = hasDown ? "down" : hasSoft ? "degraded" : "ok";
  const score = Math.round(
    components.reduce((s, c) => s + STATUS_SCORE[c.status], 0) / components.length,
  );
  const bad = components.filter((c) => c.status !== "ok");
  const summary =
    bad.length === 0
      ? `all systems nominal (${components.length})`
      : `${bad.length}/${components.length} need attention: ${bad.map((c) => c.label).join(", ")}`;
  return { tier, score, components: [...components], summary };
}

/* ── adapters (domain shape → HealthComponent), all pure ───────────────────── */

/** A boolean component (e.g. nemesis present, contract ok). false → `down` by default. */
export function boolComponent(
  id: string,
  label: string,
  ok: boolean,
  opts: { detail?: string; remediation?: string; softFail?: boolean } = {},
): HealthComponent {
  return {
    id,
    label,
    status: ok ? "ok" : opts.softFail ? "degraded" : "down",
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(!ok && opts.remediation ? { remediation: opts.remediation } : {}),
  };
}

/** The engine component from a doctor-style probe (reuses HealthResult-shaped fields). */
export function engineComponent(probe: {
  ok: boolean;
  contractOk: boolean;
  version?: string;
}): HealthComponent {
  if (!probe.ok || !probe.version) {
    return boolComponent("engine", "Engine", false, {
      remediation: "run `prometheus doctor` — engine not reachable",
    });
  }
  if (!probe.contractOk) {
    return {
      id: "engine",
      label: "Engine",
      status: "degraded",
      detail: `v${probe.version} · contract mismatch`,
      remediation: "update Studio or the engine so the JSON contract matches",
    };
  }
  return { id: "engine", label: "Engine", status: "ok", detail: `v${probe.version}` };
}

/** Serve-profile health from supervised server states (running/errored counts). */
export function serveComponent(states: readonly string[]): HealthComponent {
  if (states.length === 0)
    return { id: "serve", label: "Model servers", status: "ok", detail: "none running" };
  const running = states.filter((s) => s === "running").length;
  const errored = states.filter((s) => s === "errored").length;
  const status: ComponentStatus =
    errored > 0 ? "down" : running === states.length ? "ok" : "degraded";
  return {
    id: "serve",
    label: "Model servers",
    status,
    detail: `${running}/${states.length} running${errored ? ` · ${errored} errored` : ""}`,
    ...(errored > 0 ? { remediation: "restart the errored model server(s) from Services" } : {}),
  };
}

/** Map a circuit-breaker state to a component status (open = down). */
export function breakerStatus(state: "closed" | "open" | "half-open"): ComponentStatus {
  return state === "open" ? "down" : state === "half-open" ? "degraded" : "ok";
}

/** Threat-DB freshness: stale past `staleDays` → degraded with a refresh hint. */
export function threatDbComponent(
  seeded: boolean,
  ageDays: number | undefined,
  staleDays = 7,
): HealthComponent {
  if (!seeded) {
    return boolComponent("nemesis-db", "Nemesis DB", false, {
      softFail: true,
      remediation: "seed the threat DB: `prometheus secure-scan --refresh`",
    });
  }
  if (ageDays !== undefined && ageDays > staleDays) {
    return {
      id: "nemesis-db",
      label: "Nemesis DB",
      status: "degraded",
      detail: `${Math.round(ageDays)}d old`,
      remediation: "refresh the threat DB to keep detections current",
    };
  }
  return {
    id: "nemesis-db",
    label: "Nemesis DB",
    status: "ok",
    ...(ageDays !== undefined ? { detail: `${Math.round(ageDays)}d old` } : {}),
  };
}
