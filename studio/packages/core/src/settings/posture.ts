// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * settings/posture.ts — turn the security settings into decisions something can enforce.
 *
 * `cloudModelsEnabled`, `defaultNetwork`, `gateStrict` and `allowForce` were declared in the
 * schema, set by three shipped profiles (`power-dev`, `security-strict`, `local-only`), and read
 * by NOTHING. A user selecting "Local-only" — which sets `cloudModelsEnabled: false` and
 * `defaultNetwork: "none"` — reasonably concluded that cloud calls were off. They were not.
 *
 * A security control that does nothing is worse than an absent one, because it is believed. This
 * module is the single place those four keys become answers, and the enforcement points call it
 * rather than re-reading the settings and each inventing their own interpretation.
 *
 * TIGHTEN-ONLY, everywhere. Each helper takes what the caller was already going to do and can
 * only make it stricter — never looser. That is what lets a per-session control (the pane's
 * "never send to cloud" checkbox) coexist with a global policy: the checkbox may add a
 * restriction, and can never remove one the policy imposed.
 *
 * PURE: no IO, no environment, no fetch. The layers are resolved by `layerSettings` before this
 * sees them.
 */

import type { Settings } from "./schema.js";

/** What network egress a posture permits. */
export type NetworkPolicy = "none" | "mcp-only" | "allow";

/** The resolved, enforceable security posture. Every field is a decision, not a preference. */
export interface SecurityPosture {
  /** false ⇒ no cloud endpoint may be used, whatever the session-level control says. */
  allowCloud: boolean;
  /** what may reach the network. */
  network: NetworkPolicy;
  /** the WEAKEST gate posture allowed. A caller may run stricter, never looser. */
  minGateMode: "off" | "warn" | "enforce";
  /** false ⇒ `--force` and its kin are refused. (They already are; this keeps the two agreeing.) */
  allowForce: boolean;
  /** false ⇒ the authorisation ladder may auto-approve NOTHING; every action is asked. */
  autoApprove: boolean;
}

/** The gate postures ordered by how much they protect. Higher = stricter. */
const GATE_RANK: Readonly<Record<"off" | "warn" | "enforce", number>> = Object.freeze({
  off: 0,
  warn: 1,
  enforce: 2,
});

/** How permissive each network policy is. Higher = more egress. */
const NETWORK_RANK: Readonly<Record<NetworkPolicy, number>> = Object.freeze({
  none: 0,
  "mcp-only": 1,
  allow: 2,
});

function isNetworkPolicy(v: unknown): v is NetworkPolicy {
  return v === "none" || v === "mcp-only" || v === "allow";
}

/**
 * Read the effective posture out of resolved settings.
 *
 * The DEFAULTS here are the permissive ones on purpose — they mirror `DEFAULT_SETTINGS`, so
 * turning this on changes nothing for a user who has configured nothing. The tightening only
 * happens when someone actually asked for it.
 */
export function securityPosture(settings: Settings | undefined): SecurityPosture {
  const s = settings ?? {};
  return {
    allowCloud: s.cloudModelsEnabled !== false,
    network: isNetworkPolicy(s.defaultNetwork) ? s.defaultNetwork : "mcp-only",
    // `gateStrict` is a floor, not a value: it says "never weaker than enforce". Without it the
    // caller's own gate mode stands, which is why the floor is `off` rather than `warn`.
    minGateMode: s.gateStrict === true ? "enforce" : "off",
    allowForce: s.allowForce !== false,
    /**
     * May the authorisation ladder auto-approve anything at all?
     *
     * `Settings.autoApprove` was declared, defaulted, validated and SET by the Security-strict
     * profile — whose whole stated posture is "gate --strict, NO auto-approve" — and then read
     * by nothing. Every other `autoApprove` in the codebase is the unrelated per-grant
     * `AgentToolGrant.autoApprove` the tool broker uses, which is driven by the ladder and never
     * consults settings. So selecting that profile tightened the gate and the force ban while
     * leaving auto-approval exactly as it was.
     */
    autoApprove: s.autoApprove !== false,
  };
}

/**
 * Apply the posture's gate floor to a requested gate mode. The result is the STRICTER of the two.
 *
 * Note the direction: this cannot be used to turn a gate down. A caller asking for `enforce`
 * under a posture whose floor is `off` still gets `enforce`.
 */
export function effectiveGateMode(
  requested: "off" | "warn" | "enforce" | undefined,
  posture: SecurityPosture,
): "off" | "warn" | "enforce" {
  const want = requested ?? "enforce";
  return GATE_RANK[want] >= GATE_RANK[posture.minGateMode] ? want : posture.minGateMode;
}

/**
 * Whether an endpoint of this locality may be used.
 *
 * `sessionNeverSendToCloud` is the per-session control. It can only ADD the restriction — a
 * session that unticks it does not get cloud back when the policy forbids it.
 */
export function cloudAllowed(
  locality: string | undefined,
  posture: SecurityPosture,
  sessionNeverSendToCloud = false,
): { allowed: boolean; reason?: string } {
  if (locality !== "cloud") return { allowed: true };
  if (!posture.allowCloud) {
    return {
      allowed: false,
      reason: "cloud models are disabled by the active security profile (cloudModelsEnabled)",
    };
  }
  if (sessionNeverSendToCloud) {
    return { allowed: false, reason: 'this workspace has "never send to cloud" on' };
  }
  return { allowed: true };
}

/** The kinds of egress a policy distinguishes. `model` is the inference endpoint itself. */
export type EgressKind = "model" | "mcp" | "web" | "update";

/**
 * Whether a given kind of network access is permitted.
 *
 * `"mcp-only"` is the shipped default and is the interesting case: it permits the model endpoint
 * and MCP connectors — the things the product cannot function without — and refuses open web
 * access. `"none"` refuses everything remote; a LOCAL model endpoint is not remote and stays
 * allowed, which is what makes `local-only` a usable profile rather than a brick.
 */
export function egressAllowed(
  kind: EgressKind,
  posture: SecurityPosture,
  opts: { locality?: string } = {},
): { allowed: boolean; reason?: string } {
  const deny = (what: string): { allowed: false; reason: string } => ({
    allowed: false,
    reason: `${what} is blocked by the active security profile (defaultNetwork: "${posture.network}")`,
  });
  if (posture.network === "allow") return { allowed: true };
  if (kind === "model") {
    // A local runner is on this machine. Refusing it would make "no network" mean "no product".
    if (opts.locality !== "cloud") return { allowed: true };
    return posture.network === "none" ? deny("a cloud model endpoint") : { allowed: true };
  }
  if (kind === "mcp") {
    return posture.network === "none" ? deny("MCP network access") : { allowed: true };
  }
  // web + update: refused by everything except "allow".
  return deny(kind === "web" ? "web access" : "the update check");
}

/**
 * Strip anything from a WORKSPACE settings layer that would weaken the security posture.
 *
 * The workspace layer is `<repo>/.prometheus/settings.json` — a file that lives in the
 * repository and arrives with the code, exactly like `.prometheus.toml`. It is also the LAST
 * layer, so it wins over the global settings AND over the active profile. Without this, a repo
 * could ship `{"cloudModelsEnabled": true}` and undo a user's "Local-only" profile simply by
 * being opened, which would make the whole profile mechanism decorative again one level down.
 *
 * TIGHTEN-ONLY, per key: a workspace may turn cloud OFF, narrow the network, raise the gate and
 * withdraw force. It may not do the reverse. Every other key passes through untouched — a repo
 * pinning its theme or its format-on-save is exactly what this layer is for.
 *
 * PURE. Returns the filtered layer plus the keys that were refused, so a caller can say so.
 */
export function sanitizeWorkspaceLayer(
  workspace: Record<string, unknown>,
  base: Settings,
): { layer: Record<string, unknown>; refused: string[] } {
  const basePosture = securityPosture(base);
  const out: Record<string, unknown> = { ...workspace };
  const refused: string[] = [];
  const refuse = (key: string): void => {
    delete out[key];
    refused.push(key);
  };

  if ("cloudModelsEnabled" in workspace && workspace.cloudModelsEnabled !== false) {
    if (!basePosture.allowCloud) refuse("cloudModelsEnabled");
  }
  if ("defaultNetwork" in workspace) {
    const want = workspace.defaultNetwork;
    // An unrecognised value is refused rather than defaulted: defaulting would resolve to
    // "mcp-only", which is a WIDENING when the base is "none".
    if (!isNetworkPolicy(want) || NETWORK_RANK[want] > NETWORK_RANK[basePosture.network]) {
      refuse("defaultNetwork");
    }
  }
  if ("gateStrict" in workspace && workspace.gateStrict !== true) {
    if (basePosture.minGateMode === "enforce") refuse("gateStrict");
  }
  if ("allowForce" in workspace && workspace.allowForce !== false) {
    if (!basePosture.allowForce) refuse("allowForce");
  }
  return { layer: out, refused };
}

/** True when this posture is stricter than the defaults — worth telling the user about. */
export function isRestrictive(posture: SecurityPosture): boolean {
  return (
    !posture.allowCloud ||
    NETWORK_RANK[posture.network] < NETWORK_RANK["mcp-only"] ||
    posture.minGateMode !== "off" ||
    !posture.allowForce
  );
}

/** A one-line description of what the posture actually forbids, for a banner. */
export function describePosture(posture: SecurityPosture): string {
  const parts: string[] = [];
  if (!posture.allowCloud) parts.push("cloud models off");
  if (posture.network !== "allow") parts.push(`network: ${posture.network}`);
  if (posture.minGateMode !== "off") parts.push(`gate ≥ ${posture.minGateMode}`);
  if (!posture.allowForce) parts.push("force refused");
  return parts.join(" · ");
}
