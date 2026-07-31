/**
 * ai/connectors/apiKey.ts — Tier-C metered connector (file 12 §1.2 / §4).
 *
 * A static key → a metered endpoint. This is the ONLY kind that can spend money, so
 * it is the most guarded: the connector MUST pass validation (which requires a
 * CostGuardrail AND the typed-confirm receipt `confirmedCostWarningAt`), the secret
 * NEVER touches the descriptor — `resolveKey` reads the OS keychain lazily at request
 * time — and the endpoint is marked cloud so the workspace privacy guard can refuse it.
 */
import type { SecretsStore } from "../../secrets/keychain.js";
import { validateConnector } from "../providers/resolver.js";
import type { ConnectorConfig, Provider } from "../providers/types.js";
import { type ConnectorEndpoint, ConnectorError } from "./types.js";

/**
 * Build the api-key runtime endpoint. Runs the full policy gate first (§4): a metered
 * connector with no guardrail or no typed-confirm receipt is REFUSED here, not just in
 * the UI. The raw key stays in the keychain — `resolveKey` fetches it only when a
 * request is actually sent.
 */
export function buildApiKeyConnector(
  connector: ConnectorConfig,
  provider: Provider,
  store: SecretsStore,
): ConnectorEndpoint {
  if (connector.kind !== "api-key") {
    throw new ConnectorError(`${provider.label}: buildApiKeyConnector needs an api-key connector`, [
      `got kind "${connector.kind}"`,
    ]);
  }
  const issues = validateConnector(connector, [provider]);
  if (issues.length > 0) {
    throw new ConnectorError(
      `${provider.label}: api-key connector is not safe to use`,
      issues.map((i) => i.message),
    );
  }
  const ref = connector.keyRef;
  if (!ref) {
    // validateConnector already guarantees this; belt-and-braces for callers passing a single provider.
    throw new ConnectorError(`${provider.label}: api-key connector needs a keychain ref`);
  }
  const model = provider.models?.find((m) => m.id === connector.modelId);
  const baseUrl = connector.baseUrl ?? (provider.baseUrlEnv ? `\${${provider.baseUrlEnv}}` : "");
  if (!baseUrl) {
    throw new ConnectorError(`${provider.label}: api-key connector needs a baseUrl`);
  }
  return {
    endpoint: {
      id: `cloud:${provider.id}:${connector.modelId}`,
      baseUrl,
      locality: "cloud",
      apiKeyRef: `${ref.service}:${ref.account}`,
      contextWindow: model?.contextLen ?? 8192,
      supportsTools: true,
      model: connector.modelId,
    },
    // LAZY: the secret is read from the keychain only when a request fires, never stored.
    resolveKey: async () => {
      const secret = await store.get(ref.service, ref.account);
      if (!secret) {
        throw new ConnectorError(
          `${provider.label}: no key in the keychain for ${ref.service}/${ref.account}`,
        );
      }
      return secret;
    },
  };
}
