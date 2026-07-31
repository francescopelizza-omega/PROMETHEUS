/**
 * ai/connectors/oauthBridge.ts — Tier-B subscription connector (file 12 §1.2 / §3.1).
 *
 * The vendor OAuth flow: the user signs in, the token rides their existing
 * subscription, and inference is bounded by the plan — no per-token meter. The token
 * lives in the OS keychain (an `oauthRef`), resolved LAZILY; the provider's
 * `betaHeader` (e.g. Anthropic's `anthropic-beta: oauth-2025-04-20`) rides as an extra
 * header. The OAuth dance itself (authUrl/tokenUrl/PKCE) is performed by the desktop
 * shell and is OUT of core — core only consumes the resulting stored token.
 */
import type { SecretsStore } from "../../secrets/keychain.js";
import type { ConnectorConfig, Provider } from "../providers/types.js";
import { type ConnectorEndpoint, ConnectorError } from "./types.js";

/** Build the oauth-bridge runtime endpoint (Tier B). Throws on a mis-wired connector. */
export function buildOauthConnector(
  connector: ConnectorConfig,
  provider: Provider,
  store: SecretsStore,
): ConnectorEndpoint {
  if (connector.kind !== "oauth-subscription-bridge") {
    throw new ConnectorError(`${provider.label}: buildOauthConnector needs an oauth connector`, [
      `got kind "${connector.kind}"`,
    ]);
  }
  const ref = connector.oauthRef;
  if (!ref) {
    throw new ConnectorError(`${provider.label}: oauth connector needs a token keychain ref`);
  }
  if (!provider.oauth) {
    throw new ConnectorError(`${provider.label}: provider has no oauth descriptor in the matrix`);
  }
  const model = provider.models?.find((m) => m.id === connector.modelId);
  const baseUrl = connector.baseUrl ?? (provider.baseUrlEnv ? `\${${provider.baseUrlEnv}}` : "");
  if (!baseUrl) {
    throw new ConnectorError(`${provider.label}: oauth connector needs a baseUrl`);
  }
  const extraHeaders: Record<string, string> = {};
  if (provider.oauth.betaHeader) {
    extraHeaders["anthropic-beta"] = provider.oauth.betaHeader;
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
    ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    resolveKey: async () => {
      const token = await store.get(ref.service, ref.account);
      if (!token) {
        throw new ConnectorError(
          `${provider.label}: no oauth token in the keychain for ${ref.service}/${ref.account}`,
        );
      }
      return token;
    },
  };
}
