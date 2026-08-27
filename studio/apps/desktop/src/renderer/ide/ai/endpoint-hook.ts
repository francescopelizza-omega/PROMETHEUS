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

import { useEffect, useRef, useState } from "react";

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

/**
 * MEASURE one local model: its real context window and the runner's capability array.
 *
 * Deliberately NOT folded into `expandServedModels`: that runs for every served model on every
 * endpoint refresh, and one `/api/show` POST per model would turn a 30-model Ollama install
 * into a 30-request burst on mount. Only the ACTIVE endpoint's numbers are ever read, so only
 * the active endpoint is measured — the same one-request-per-switch shape the CLI hosts use.
 *
 * Fail-soft: an unreachable runner (or a build without the IPC channel) yields nothing and the
 * endpoint keeps whatever it had, exactly as before this existed.
 */
async function probeEndpointMeta(
  baseUrl: string,
  model: string,
): Promise<{ contextWindow?: number; capabilities?: readonly string[] } | null> {
  try {
    const res = await ai()?.probeEndpoint(baseUrl, model);
    // `source:"default"` means the probe RAN and got nothing usable — not that this model has
    // an 8192 window. Adopting it would be indistinguishable, forever after, from a real
    // measurement, so a failed probe writes nothing at all.
    if (!res?.ok || res.source === "default") return null;
    return {
      ...(res.contextWindow > 0 ? { contextWindow: res.contextWindow } : {}),
      ...(res.capabilities && res.capabilities.length > 0
        ? { capabilities: res.capabilities }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Identity of a probe target. The model name is part of it: one runner serves many models,
 *  with wildly different windows and capabilities. */
function probeKey(ep: RendererEndpoint): string {
  return `${ep.baseUrl}\x00${ep.model ?? ""}`;
}

/** Resolve the Model Hub endpoints + the active one (auto-selecting the first). */
export function useActiveEndpoint(): ActiveEndpoint {
  const [endpoints, setEndpoints] = useState<RendererEndpoint[]>([]);
  const endpointId = useAiSessionStore((s) => s.endpointId);
  const selectEndpoint = useAiSessionStore((s) => s.selectEndpoint);
  const neverSendToCloud = useAiSessionStore((s) => s.neverSendToCloud);
  /**
   * Probe targets already attempted this mount.
   *
   * A ref, not state: it must not re-render, and it must survive the state update the probe
   * itself causes. It is also what makes a FAILED probe terminate — a failure writes nothing to
   * the endpoint, so the "has it been probed?" question cannot be answered by looking at the
   * endpoint, and without this the effect would re-fire on every render, forever, against a
   * runner that is down.
   */
  const probed = useRef<Set<string>>(new Set());

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

  const active = endpoints.find((e) => e.id === endpointId) ?? null;

  // Measure the ACTIVE endpoint once per (baseUrl, model), then fold the answer back into the
  // list so every consumer — the effort chip, the tool preamble budget, compaction — reads a
  // measured endpoint rather than the 8192 floor `toEndpoints` hands out.
  // Depend on PRIMITIVES, not the endpoint object: `endpoints.find` mints a fresh reference
  // every time the list is replaced — including by this effect's own `setEndpoints` — so an
  // object dependency would re-run the effect on its own result.
  const activeBaseUrl = active?.locality === "local" ? active.baseUrl : null;
  const activeModel = active?.locality === "local" ? (active.model ?? null) : null;
  useEffect(() => {
    if (activeBaseUrl === null || activeModel === null) return;
    const key = `${activeBaseUrl} ${activeModel}`;
    if (probed.current.has(key)) return;
    probed.current.add(key);
    let alive = true;
    void (async () => {
      const meta = await probeEndpointMeta(activeBaseUrl, activeModel);
      if (!alive) return;
      if (!meta) {
        // A FAILURE is not cached — the same rule core's probe follows. A runner that was still
        // booting when the pane mounted must be re-askable, and the ref is only here to stop a
        // render loop, not to blacklist a model for the lifetime of the component. Removing the
        // key cannot re-fire this effect on its own (the deps have not changed), so the retry
        // happens the next time the user switches back to this model — which is exactly when
        // they would expect it.
        probed.current.delete(key);
        return;
      }
      setEndpoints((prev) =>
        prev.map((e) =>
          probeKey(e) === key
            ? {
                ...e,
                ...(meta.contextWindow ? { contextWindow: meta.contextWindow } : {}),
                ...(meta.capabilities ? { probedCapabilities: meta.capabilities } : {}),
              }
            : e,
        ),
      );
    })();
    return () => {
      alive = false;
    };
  }, [activeBaseUrl, activeModel]);

  return {
    endpoints,
    active,
    neverSendToCloud,
  };
}
