// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/connectors/localServe.ts — Tier-A local connector (file 12 §1.2).
 *
 * Points file-07's client at a LOCAL OpenAI-compatible base URL handed out by the
 * Model Hub (file 05 ServeProfile). No secret, no cloud policy to clear, $0: this is
 * the DEFAULT brain. The OpenAI-compatible local servers (Ollama/llama.cpp/vLLM)
 * ignore the bearer, so no keychain ref is attached.
 */
import type { Provider } from "../providers/types.js";
import type { ConnectorConfig } from "../providers/types.js";
import { type ConnectorEndpoint, ConnectorError } from "./types.js";

/** The fallback local base URL when neither the connector nor an env override sets one. */
export const DEFAULT_LOCAL_BASEURL = "http://127.0.0.1:11434/v1";

export interface LocalServeOpts {
  /** an explicit base URL (a resolved Model Hub ServeProfile URL) overriding the config. */
  baseUrl?: string;
  /** the model's advertised context window, if known (defaults to a safe 8k). */
  contextWindow?: number;
  /** whether this local model supports tool calls (gates the agent pane). */
  supportsTools?: boolean;
}

/** Build the local-serve runtime endpoint. Throws if the connector is not local-serve. */
export function buildLocalServeConnector(
  connector: ConnectorConfig,
  provider: Provider,
  opts: LocalServeOpts = {},
): ConnectorEndpoint {
  if (connector.kind !== "local-serve") {
    throw new ConnectorError(
      `${provider.label}: buildLocalServeConnector needs a local-serve connector`,
      [`got kind "${connector.kind}"`],
    );
  }
  const baseUrl = opts.baseUrl ?? connector.baseUrl ?? DEFAULT_LOCAL_BASEURL;
  return {
    endpoint: {
      id: `local:${provider.id}:${connector.modelId}`,
      baseUrl,
      locality: "local",
      contextWindow: opts.contextWindow ?? 8192,
      supportsTools: opts.supportsTools ?? true,
      model: connector.modelId,
    },
  };
}
