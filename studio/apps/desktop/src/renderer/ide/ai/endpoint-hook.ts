// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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

import { useCallback, useEffect, useRef, useState } from "react";

import { useAiSessionStore } from "../state/stores.js";
import type { RendererEndpoint } from "./ai-client.js";
import { toEndpoints } from "./endpoints.js";

function models(): Window["prometheus"]["models"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.models : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ModelsService = Window["prometheus"]["models"];

export interface EnsureLocalServerDeps {
  /** defaults to the real `window.prometheus.models` — injected so this is testable
   *  without a `window` global (no DOM/electron in node:test, per this file's C5 note). */
  svc?: ModelsService;
  /** defaults to a real timer-based sleep — injected so a test doesn't wait for real
   *  wall-clock seconds per poll tick. */
  sleepFn?: (ms: number) => Promise<void>;
  /** defaults to 20s — how long to poll before giving up on the runner becoming ready. */
  pollDeadlineMs?: number;
  /** defaults to 700ms — the interval between poll ticks. */
  pollIntervalMs?: number;
  /**
   * Resolves a live baseUrl to its picker-ready `RendererEndpoint` once the runner
   * reports ready — defaults to the real Model Hub probe (`expandServedModels` +
   * `toEndpoints`), which itself reaches `window.prometheus.ai.probeModels`. Injected
   * as ONE seam (not each lower-level piece) so a test can fake "the probe found it
   * live" without needing a `window` global — same one-seam-at-the-boundary shape as
   * `serve-supervisor.test.ts`'s injected `pollModels`.
   */
  resolveEndpoint?: (svc: ModelsService, baseUrl: string) => Promise<RendererEndpoint | null>;
}

async function resolveLocalEndpoint(
  svc: ModelsService,
  baseUrl: string,
): Promise<RendererEndpoint | null> {
  const eps = await expandServedModels(toEndpoints(await svc.endpoints()));
  return eps.find((e) => e.locality === "local" && e.baseUrl === baseUrl) ?? null;
}

/**
 * Auto-start the local model server when the chat has a KNOWN, previously-served
 * profile that just happens to be stopped right now — "it must start automatically
 * when prompting on AI chat" (the user's own words). Deliberately narrow: this never
 * guesses or pulls a NEW model — it only restarts one the user has already served
 * before (a real `serve-profiles.json` entry sitting at `status:"stopped"`).
 *
 * If there's no such KNOWN profile, falls back to `ensureRawOllamaStarted` — a model
 * pulled straight via `ollama pull` (never through Prometheus's own "Serve" button, so
 * there is no ServeProfile for it at all) is the common case for "I already have gemma
 * and qwen installed" and must not be treated as "nothing to auto-start" just because
 * Prometheus never built a profile for it.
 *
 * On success, calls `selectEndpoint` with the now-live local endpoint's id, which is
 * what makes `useActiveEndpoint`'s own effect re-fetch and populate `active` — this
 * function does not (and must not) touch React state directly.
 */
export async function ensureLocalServerStarted(
  selectEndpoint: (id: string | null) => void,
  deps: EnsureLocalServerDeps = {},
): Promise<boolean> {
  const svc = deps.svc ?? models();
  const sleepFn = deps.sleepFn ?? sleep;
  const pollDeadlineMs = deps.pollDeadlineMs ?? 20_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 700;
  const resolveEndpoint = deps.resolveEndpoint ?? resolveLocalEndpoint;
  if (!svc) return false;
  const serving = await svc.serving();
  /**
   * Restart the profile the SESSION ALREADY POINTS AT — never whichever stopped row happens to
   * sort first.
   *
   * `find(p => !p.external && p.status === "stopped")` took an arbitrary row in `model:serving`
   * order, so with several previously-served profiles this spawned a model the user had not
   * asked for (a 70B while they were pointed at an 8B, say) — and because the caller fires on
   * mount, they never chose to. The docstring's promise ("only restarts one the user has already
   * served before") was true of the SET but not of the pick within it.
   *
   * Correlating on the picker id, whose shape is `${runner} · ${model}` (see
   * `expandServedModels`): `args.servedModelName` first, because that is the name the runner
   * reports on `/v1/models` and therefore the one that ended up in the id — `modelId` is the
   * catalog id and often differs (`qwen3-8b` vs `qwen3:8b`).
   *
   * No positive correlation and more than one candidate ⇒ do NOT guess: fall through to the raw
   * Ollama path rather than spawning real model weights on a coin flip.
   */
  const stopped = serving.ok
    ? serving.profiles.filter((p) => !p.external && p.status === "stopped")
    : [];
  const [wantRunner, wantModel] = (useAiSessionStore.getState().endpointId ?? "").split(" · ");
  const candidate =
    stopped.find(
      (p) =>
        wantModel !== undefined &&
        (p.args.servedModelName === wantModel || p.modelId === wantModel) &&
        (wantRunner === undefined || p.runner === wantRunner),
    ) ?? (stopped.length === 1 ? stopped[0] : undefined);
  if (!candidate) return ensureRawOllamaStarted(svc, selectEndpoint, resolveEndpoint);

  try {
    await svc.serve({ id: candidate.modelId, quant: candidate.quant });
  } catch {
    return false;
  }

  // Poll for readiness rather than trusting the fire-and-forget serve() call — a
  // runner takes real seconds to bind its port, and the caller needs to know whether
  // to expect a live endpoint or not, not just that the spawn was attempted.
  const deadline = Date.now() + pollDeadlineMs;
  let ready = false;
  while (Date.now() < deadline) {
    await sleepFn(pollIntervalMs);
    const s = await svc.serving();
    if (!s.ok) return false;
    const row = s.profiles.find((p) => p.id === candidate.id);
    if (row?.status === "ready") {
      ready = true;
      break;
    }
    if (row?.status === "error" || row === undefined) return false;
  }
  if (!ready) return false;

  const started = await resolveEndpoint(svc, candidate.endpoint.baseUrl);
  if (!started) return false;
  selectEndpoint(started.id);
  return true;
}

/**
 * The raw-Ollama fallback `ensureLocalServerStarted` takes when there's no known
 * ServeProfile to restart. `svc.library()` runs the sidecar's `model.list`, which as of
 * this fix calls `_ensure_ollama_daemon()` (starts `ollama serve` if it's installed but
 * stopped) BEFORE it decides there's nothing installed — so this doubles as both "is
 * anything actually there" AND "make sure it's actually running" in one round trip.
 * Deliberately checks for an `ollama`-sourced row before even trying to resolve an
 * endpoint: a library scan that legitimately found nothing (ollama not installed, or
 * installed with zero models pulled) must fall through to the normal "no backend"
 * notice, not spend the full endpoint-probe timeout confirming what `library()` already
 * just told us.
 */
async function ensureRawOllamaStarted(
  svc: ModelsService,
  selectEndpoint: (id: string | null) => void,
  resolveEndpoint: NonNullable<EnsureLocalServerDeps["resolveEndpoint"]>,
): Promise<boolean> {
  let lib: Awaited<ReturnType<ModelsService["library"]>>;
  try {
    lib = await svc.library();
  } catch {
    return false;
  }
  if (!lib.ok || !lib.models.some((m) => m.source === "ollama")) return false;
  // Ollama serves every installed model through the SAME endpoint (unlike a ServeProfile,
  // one process per model) — there is no per-model baseUrl to target, just the daemon's.
  const started = await resolveEndpoint(svc, "http://localhost:11434/v1");
  if (!started) return false;
  selectEndpoint(started.id);
  return true;
}

function ai(): Window["prometheus"]["ai"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ai : undefined;
}

export interface ActiveEndpoint {
  endpoints: RendererEndpoint[];
  active: RendererEndpoint | null;
  neverSendToCloud: boolean;
  /**
   * Has the endpoint fetch ANSWERED yet?
   *
   * `endpoints.length === 0` cannot express this: the list starts empty and is only filled by an
   * async effect, so on the first commit an empty list means "not asked yet", not "there are
   * none". Anything whose precondition is "there is no endpoint at all" — notably AgentPane's
   * auto-start, which spawns a real model runner — must wait for this rather than read emptiness.
   * Set true even when the fetch is impossible (no bridge outside Electron) or throws: otherwise
   * such a consumer would wait forever.
   */
  loaded: boolean;
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
function probeKey(ep: Pick<RendererEndpoint, "baseUrl" | "model">): string {
  return `${ep.baseUrl}\x00${ep.model ?? ""}`;
}

/** What one successful probe learned — folded into every rebuild of the endpoint list. */
interface ProbedMeta {
  contextWindow?: number;
  probedCapabilities?: readonly string[];
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
  /**
   * Measurements that have SUCCEEDED this mount, keyed by `probeKey`.
   *
   * `probed` above only remembers that a target was attempted. The endpoint list is rebuilt from
   * scratch by the effect below whenever the active id changes (`toEndpoints`/`expandServedModels`
   * carry no probed data), so without this the measurement for model A was wiped the moment the
   * user switched to B — and switching back could not re-measure, because A's key was still in
   * `probed`. Keeping the RESULTS, not just the keys, makes the fold survive a list replacement.
   */
  const measured = useRef<Map<string, ProbedMeta>>(new Map());
  const [loaded, setLoaded] = useState(false);
  /** Apply everything measured so far to a freshly built list. Reads only refs, so it is stable
   *  — both effects below call it and neither needs to re-run when a measurement lands. */
  const applyMeasured = useCallback(
    (eps: RendererEndpoint[]): RendererEndpoint[] =>
      measured.current.size === 0
        ? eps
        : eps.map((e) => {
            // `probeKey` ignores locality, and only a LOCAL row is ever probed — so gate on it,
            // or a cloud row sharing a baseUrl+model would inherit another row's measurement.
            if (e.locality !== "local") return e;
            const m = measured.current.get(probeKey(e));
            if (!m) return e;
            return {
              ...e,
              ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
              ...(m.probedCapabilities ? { probedCapabilities: m.probedCapabilities } : {}),
            };
          }),
    [],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await models()?.endpoints();
        if (!alive) return;
        const eps = applyMeasured(await expandServedModels(toEndpoints(res)));
        if (!alive) return;
        setEndpoints(eps);
        // auto-select the first when none chosen OR the persisted choice no longer exists
        // (e.g. a stale runner id from before per-model expansion, or a model since removed).
        const stale = endpointId != null && !eps.some((e) => e.id === endpointId);
        if ((endpointId == null || stale) && eps.length > 0) selectEndpoint(eps[0]?.id ?? null);
      } catch {
        /* fail-soft: leave the list as it was. Nothing here was guarded before, so a rejecting
           `endpoints()` / `expandServedModels` left `loaded` unset forever. */
      } finally {
        // ALWAYS, including the no-bridge and throwing paths — see `ActiveEndpoint.loaded`.
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [endpointId, selectEndpoint, applyMeasured]);

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
    // The SAME helper both sides of the fold use. These two were built with different separators
    // — a space here, a NUL in `probeKey` — so `probeKey(e) === key` below could never be true
    // and every successful measurement was silently discarded, while `probed` still recorded the
    // key so the probe was never retried. That left `probedCapabilities` permanently unset (the
    // effort chip reporting "not available" for models that advertise `thinking`) and the 8192
    // context floor in place for the preamble/compaction budget.
    const key = probeKey({ baseUrl: activeBaseUrl, model: activeModel });
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
      measured.current.set(key, {
        ...(meta.contextWindow ? { contextWindow: meta.contextWindow } : {}),
        ...(meta.capabilities ? { probedCapabilities: meta.capabilities } : {}),
      });
      setEndpoints((prev) => applyMeasured(prev));
    })();
    return () => {
      alive = false;
    };
  }, [activeBaseUrl, activeModel, applyMeasured]);

  return {
    endpoints,
    active,
    neverSendToCloud,
    loaded,
  };
}
