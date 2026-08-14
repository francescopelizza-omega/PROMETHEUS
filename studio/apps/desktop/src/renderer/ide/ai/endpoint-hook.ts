/**
 * ide/ai/endpoint-hook.ts — the React hook that resolves the ACTIVE Model Hub endpoint.
 *
 * Wraps the pure endpoints helpers (endpoints.ts) + the ai-session store so every AI
 * surface (agent pane, Cmd-K inline edit, ghost-text) shares one resolution path: fetch
 * the Model Hub endpoints, auto-select the first if none chosen, and expose the active
 * endpoint + the per-workspace no-cloud policy. Kept apart from endpoints.ts so that
 * module stays react-free + unit-testable.
 *
 * Renderer-SANDBOXED (C5): react + the store + window.prometheus only.
 */

import { useEffect, useState } from "react";

import { useAiSessionStore } from "../state/stores.js";
import type { RendererEndpoint } from "./ai-client.js";
import { toEndpoints } from "./endpoints.js";

function models(): Window["prometheus"]["models"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.models : undefined;
}

function ai(): Window["prometheus"]["ai"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ai : undefined;
}

export interface ActiveEndpoint {
  endpoints: RendererEndpoint[];
  active: RendererEndpoint | null;
  neverSendToCloud: boolean;
}

/**
 * Probe a LOCAL OpenAI-compatible runner for its served models (GET /v1/models).
 * Returns model ids, or [] if unreachable/empty (fail-soft) — a down runner is dropped.
 *
 * Task #18: this used to `fetch` the runner directly from the renderer, which the production
 * CSP (`connect-src 'self'`, `main/index.ts`) REFUSES for `http://127.0.0.1:<port>` — a
 * `TypeError: Failed to fetch` in the packaged app, silently dropping every local runner from
 * this list (caught below, same as any other probe failure). Routed through `ai:probeModels`
 * (`main/ai-ipc.ts`) instead — the same MAIN-process detour `ai-client.ts`'s chat streaming
 * already takes for the identical reason. `connect-src` is unchanged; the renderer still never
 * reaches the network on its own (C5).
 */
async function probeServedModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await ai()?.probeModels(baseUrl);
    return res?.models ?? [];
  } catch {
    return [];
  }
}

/**
 * Expand each LOCAL endpoint into one picker entry PER served model — this is what makes
 * "ollama · qwen3.6:latest" selectable and, crucially, sets `.model` so the `/v1` request
 * carries the real model name (Ollama rejects a bare runner id). A local endpoint whose
 * probe finds no models (runner down/empty) is DROPPED, so the picker shows only LIVE
 * local models. Cloud endpoints pass through unprobed (their id IS the model).
 */
export async function expandServedModels(eps: RendererEndpoint[]): Promise<RendererEndpoint[]> {
  const parts = await Promise.all(
    eps.map(async (e): Promise<RendererEndpoint[]> => {
      if (e.locality !== "local") return [e];
      const served = await probeServedModels(e.baseUrl);
      return served.map((model) => ({
        id: `${e.id} · ${model}`,
        baseUrl: e.baseUrl,
        locality: "local" as const,
        model,
      }));
    }),
  );
  return parts.flat();
}

/** Resolve the Model Hub endpoints + the active one (auto-selecting the first). */
export function useActiveEndpoint(): ActiveEndpoint {
  const [endpoints, setEndpoints] = useState<RendererEndpoint[]>([]);
  const endpointId = useAiSessionStore((s) => s.endpointId);
  const selectEndpoint = useAiSessionStore((s) => s.selectEndpoint);
  const neverSendToCloud = useAiSessionStore((s) => s.neverSendToCloud);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await models()?.endpoints();
      if (!alive) return;
      const eps = await expandServedModels(toEndpoints(res));
      if (!alive) return;
      setEndpoints(eps);
      // auto-select the first when none chosen OR the persisted choice no longer exists
      // (e.g. a stale runner id from before per-model expansion, or a model since removed).
      const stale = endpointId != null && !eps.some((e) => e.id === endpointId);
      if ((endpointId == null || stale) && eps.length > 0) selectEndpoint(eps[0]?.id ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [endpointId, selectEndpoint]);

  return {
    endpoints,
    active: endpoints.find((e) => e.id === endpointId) ?? null,
    neverSendToCloud,
  };
}
