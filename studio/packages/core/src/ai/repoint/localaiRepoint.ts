/**
 * ai/repoint/localaiRepoint.ts — the "run it free locally" escape hatch (file 12 §6).
 *
 * When a connector points at a METERED (Tier-C) open-weight model — DeepSeek on
 * OpenRouter, say — Studio can offer to repoint it at a LOCAL serve of the SAME open
 * weights: $0, offline, private, and promoted back to Tier A. This is the localai
 * repoint. `planLocalRepoint` is pure (decides eligibility + builds the local
 * ConnectorConfig); `repointToLocal` runs an INJECTED engine runner to actually pull
 * the weights, then returns the repointed connector.
 *
 * The local OpenAI-compatible servers want a non-empty bearer they then ignore, so the
 * repoint writes a DUMMY key (`OPENAI_API_KEY=ollama`) into env — never a real secret.
 */
import { DEFAULT_LOCAL_BASEURL } from "../connectors/localServe.js";
import { effectiveTier } from "../providers/registry.js";
import type { ConnectorConfig, Provider } from "../providers/types.js";

/** The dummy bearer a local OpenAI-compatible server expects but ignores (§6). */
export const DUMMY_LOCAL_KEY = "ollama";

export interface LocalRepointPlan {
  /** can this connector be repointed to a free local serve? */
  eligible: boolean;
  reason: string;
  /** the `ollama pull` tag to fetch the open weights (present when eligible). */
  ollamaTag?: string;
  /** the env var Studio writes for the local base URL (e.g. OPENAI_BASEURL). */
  baseUrlEnv: string;
  /** the dummy non-secret env the local server expects. */
  dummyKeyEnv: Record<string, string>;
  /** the repointed, Tier-A local-serve connector (present when eligible). */
  connector?: ConnectorConfig;
}

export interface LocalRepointOpts {
  /** the local base URL to point at (a resolved Model Hub ServeProfile); defaults local. */
  baseUrl?: string;
}

/**
 * Decide whether `connector` can be repointed to a local serve, and if so build the
 * Tier-A local-serve ConnectorConfig. Pure. Eligible iff the selected model is
 * open-weight (so it can actually run locally). The new connector drops the keyRef +
 * guardrail + cost-warning receipt (a local serve cannot spend money).
 */
export function planLocalRepoint(
  connector: ConnectorConfig,
  provider: Provider,
  opts: LocalRepointOpts = {},
): LocalRepointPlan {
  const baseUrlEnv = provider.baseUrlEnv ?? "OPENAI_BASEURL";
  const dummyKeyEnv = { OPENAI_API_KEY: DUMMY_LOCAL_KEY };
  const ineligible = (reason: string): LocalRepointPlan => ({
    eligible: false,
    reason,
    baseUrlEnv,
    dummyKeyEnv,
  });

  if (connector.kind === "local-serve") return ineligible("already a local serve");
  const model = provider.models?.find((m) => m.id === connector.modelId);
  if (!model)
    return ineligible(`model "${connector.modelId}" is not in ${provider.label}'s catalog`);
  if (!model.openWeight) {
    return ineligible(`${model.label} is not open-weight — it cannot be served locally`);
  }

  const ollamaTag = model.localOllamaTag ?? model.id;
  const local: ConnectorConfig = {
    providerId: connector.providerId,
    kind: "local-serve",
    modelId: ollamaTag,
    baseUrl: opts.baseUrl ?? DEFAULT_LOCAL_BASEURL,
    effectiveTier: effectiveTier("local-serve"),
    enabledFor: connector.enabledFor,
    // keyRef / oauthRef / guardrail / confirmedCostWarningAt are intentionally dropped.
  };
  return {
    eligible: true,
    reason: `${model.label} is open-weight — repoint to a free local serve (${ollamaTag})`,
    ollamaTag,
    baseUrlEnv,
    dummyKeyEnv,
    connector: local,
  };
}

/** The injected engine runner — pulls the open weights for a local serve (file 05/12 §6). */
export type EnsureLocalModel = (ollamaTag: string) => Promise<void>;

/**
 * Repoint a metered connector to a local serve: verify eligibility, run the injected
 * engine runner to pull the weights, and return the new Tier-A connector. Throws if
 * the connector is not eligible (so a UI never silently keeps spending).
 */
export async function repointToLocal(
  connector: ConnectorConfig,
  provider: Provider,
  ensureLocal: EnsureLocalModel,
  opts: LocalRepointOpts = {},
): Promise<ConnectorConfig> {
  const plan = planLocalRepoint(connector, provider, opts);
  if (!plan.eligible || !plan.connector || !plan.ollamaTag) {
    throw new Error(`cannot repoint to local: ${plan.reason}`);
  }
  await ensureLocal(plan.ollamaTag);
  return plan.connector;
}
