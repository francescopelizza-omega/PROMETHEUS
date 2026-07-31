/**
 * catalog/reconcile.ts — PURE installed-state reconciliation (file 06 §7).
 *
 * The engine is authoritative for installed-state; Studio caches an optimistic guess for a
 * snappy UI, then RECONCILES it against the truth from `status`/`apps status`/`skills list`.
 * This module owns ONLY the projection + optimistic↔truth merge — it does NO I/O and makes
 * NO security decision (C5). The last gate verdict is the engine's SIGNED ref; we store the
 * ref, never a recomputed verdict (file 06 §2).
 *
 * Grounded against LIVE `prometheus.py --json` output @ 0.15.0:
 *   - `status <name>` → {plugin:{name,tier,agents:[{name,method,installed,
 *                       marketplace_present}],components:[{name,kind,state}]}}
 *   - `status all`    → {plugins:[ …same plugin shape… ]}
 *   - component.state ∈ {absent|present|enabled|disabled|…} (engine-defined).
 */

import type { NemesisVerdictRef } from "@prometheus/engine-bridge";

import type { CatalogItem, InstallPresence, InstallState, PerAgentState } from "./types.js";

// ── loose engine input shapes ──────────────────────────────────────────────────

interface StatusAgentRow {
  name: string;
  method?: string;
  installed?: boolean;
  marketplace_present?: boolean;
  enabled?: boolean;
  dest?: string;
}

interface StatusComponentRow {
  name: string;
  kind?: string;
  state?: string; // absent | present | enabled | disabled | …
}

/** One plugin's status block (from `status <name>.plugin` or `status all.plugins[]`). */
export interface StatusPluginBlock {
  name: string;
  tier?: string;
  agents?: StatusAgentRow[];
  components?: StatusComponentRow[];
}

/** The `status` envelope — single (`plugin`) OR bulk (`plugins[]`). */
export interface StatusEnvelopeLike {
  command?: string;
  plugin?: StatusPluginBlock;
  plugins?: StatusPluginBlock[];
}

// ── status → InstallState ───────────────────────────────────────────────────────

/** Component states the engine reports as "armed/active" (vs absent/disabled). */
const ENABLED_STATES = new Set(["enabled", "armed", "active", "on"]);
const PRESENT_STATES = new Set(["present", "enabled", "armed", "active", "on", "installed"]);

/**
 * Project one `status` plugin block into an `InstallState`. `installed` is true if ANY agent
 * reports installed; `enabled` is derived from the components (true if any component is in an
 * enabled state, when components are reported). Per-agent rows carry the method + dest.
 */
export function statusToInstallState(block: StatusPluginBlock): InstallState {
  const perAgent: PerAgentState[] = (block.agents ?? []).map((a) => ({
    agent: a.name,
    installed: Boolean(a.installed),
    // when the engine does not split enabled from installed, treat installed as armed
    enabled: typeof a.enabled === "boolean" ? a.enabled : Boolean(a.installed),
    method: String(a.method ?? ""),
    dest: typeof a.dest === "string" ? a.dest : undefined,
  }));

  const installed = perAgent.some((a) => a.installed);

  // Tri-state presence from the RAW engine truth (boolean | null): any true → present;
  // else any explicit false → absent; else (all null/undetermined) → unknown. Never coerce
  // unknown to absent — that would paint a false red ✗ for shell-installers etc.
  const raw = (block.agents ?? []).map((a) => a.installed);
  const presence: InstallPresence = raw.some((v) => v === true)
    ? "present"
    : raw.some((v) => v === false)
      ? "absent"
      : "unknown";

  const components = block.components ?? [];
  let enabled: boolean | undefined;
  if (components.length > 0) {
    const present = components.filter((c) => PRESENT_STATES.has(String(c.state ?? "")));
    if (present.length > 0) {
      enabled = present.some((c) => ENABLED_STATES.has(String(c.state ?? "")));
    } else {
      enabled = false;
    }
  } else if (perAgent.length > 0) {
    enabled = perAgent.some((a) => a.enabled);
  }

  return {
    installed,
    presence,
    enabled,
    perAgent: perAgent.length ? perAgent : undefined,
  };
}

/** The tri-state presence for an item's state (status mark source of truth). */
export function presenceOf(state: {
  presence?: InstallPresence;
  installed?: boolean;
}): InstallPresence {
  if (state.presence) return state.presence;
  return state.installed ? "present" : "absent";
}

/** Index a `status` envelope (single or bulk) by plugin name → its `InstallState`. */
export function indexStatus(env: StatusEnvelopeLike | undefined): Map<string, InstallState> {
  const out = new Map<string, InstallState>();
  if (!env) return out;
  const blocks: StatusPluginBlock[] = [];
  if (env.plugin) blocks.push(env.plugin);
  if (Array.isArray(env.plugins)) blocks.push(...env.plugins);
  for (const b of blocks) out.set(b.name, statusToInstallState(b));
  return out;
}

// ── merge truth into items ──────────────────────────────────────────────────────

/**
 * Merge a reconciled `InstallState` into an item, PRESERVING the previously-bound verdict
 * ref + any state-only fields (version/running/port) the status envelope does not carry.
 * The new install/enabled/perAgent truth wins; the verdict ref is sticky until re-bound.
 */
export function mergeState(prev: InstallState, next: InstallState): InstallState {
  return {
    installed: next.installed,
    presence: next.presence ?? prev.presence,
    enabled: next.enabled ?? prev.enabled,
    perAgent: next.perAgent ?? prev.perAgent,
    installedVersion: next.installedVersion ?? prev.installedVersion,
    availableVersions: next.availableVersions ?? prev.availableVersions,
    running: next.running ?? prev.running,
    port: next.port ?? prev.port,
    lastVerdict: next.lastVerdict ?? prev.lastVerdict,
  };
}

/**
 * Reconcile a list of items against a `status` envelope: replace each item's `state` with the
 * authoritative engine truth (merged over the prior state so verdict/version/port survive).
 * Items absent from the status envelope are returned UNCHANGED (the engine did not report on
 * them — we do NOT infer them uninstalled, file 06 §7).
 */
export function reconcileItems(
  items: CatalogItem[],
  status: StatusEnvelopeLike | undefined,
): CatalogItem[] {
  const idx = indexStatus(status);
  return items.map((it) => {
    const truth = idx.get(it.id);
    if (!truth) return it;
    return { ...it, state: mergeState(it.state, truth) };
  });
}

// ── optimistic UI (file 06 §7: optimistic, then truth) ──────────────────────────

/** The optimistic mutation kinds the GUI applies before the `status` reconcile lands. */
export type OptimisticOp =
  | { op: "install" }
  | { op: "uninstall" }
  | { op: "enable" }
  | { op: "disable" };

/**
 * Apply an OPTIMISTIC state change to an item (instant UI feedback). This is a GUESS — it is
 * ALWAYS followed by a `status` reconcile that overwrites it with truth (file 06 §7, §10
 * "optimistic UI is always followed by a status reconcile"). It NEVER touches the verdict ref
 * (only a real gate binds that) and NEVER fabricates an install where the engine blocked one.
 */
export function applyOptimistic(item: CatalogItem, change: OptimisticOp): CatalogItem {
  const s = item.state;
  switch (change.op) {
    case "install":
      return { ...item, state: { ...s, installed: true, presence: "present" } };
    case "uninstall":
      return { ...item, state: { ...s, installed: false, enabled: false, presence: "absent" } };
    case "enable":
      return { ...item, state: { ...s, enabled: true } };
    case "disable":
      return { ...item, state: { ...s, enabled: false } };
    default:
      return item;
  }
}

// ── verdict-ref binding (file 06 §2 — store the ref, never recompute) ───────────

/**
 * Bind the engine's last SIGNED gate verdict ref onto an item's state (after an audit/install
 * gate). We store the REF the engine produced — JS never recomputes a verdict (C5). The rest
 * of the install state is untouched.
 */
export function bindVerdict(item: CatalogItem, ref: NemesisVerdictRef): CatalogItem {
  return { ...item, state: { ...item.state, lastVerdict: ref } };
}
