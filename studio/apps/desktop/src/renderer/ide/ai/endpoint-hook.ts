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

export interface ActiveEndpoint {
  endpoints: RendererEndpoint[];
  active: RendererEndpoint | null;
  neverSendToCloud: boolean;
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
      const eps = toEndpoints(res);
      setEndpoints(eps);
      if (!endpointId && eps.length > 0) selectEndpoint(eps[0]?.id ?? null);
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
