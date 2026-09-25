/**
 * session/model-admission-host.ts — the memory gate in front of every model switch.
 *
 * `adoptEndpoint` is the one function both terminal hosts route every rebind through — session
 * start, `/setup`, `/model` and `/worker` alike — and it calls `warmupLocalModel`, which is
 * where a model that does not fit actually gets loaded. That makes it the narrowest place a
 * single admission check covers the whole surface.
 *
 * WHAT IS CHECKED, AND WHAT IS NOT:
 *
 *  - CLOUD endpoints are never checked. They cost this machine nothing, and refusing one on
 *    local RAM would be nonsense.
 *  - A LOCAL or REMOTE endpoint is checked against the memory of the host that would SERVE it —
 *    the endpoint's own `baseUrl` decides which machine that is, and the census + memory
 *    snapshot are taken there. A remote model is never judged by local RAM.
 *
 * A REFUSAL DOES NOT LEAVE THE USER STUCK. It names the shortfall, lists what would fit, and —
 * critically — still lets the session continue on whatever endpoint it already had. The only
 * thing withheld is the warm-up, because that is the part that would allocate.
 */
import { type AiEndpoint, ai } from "@prometheus/core";
import {
  type MemorySnapshot,
  type RunnerStatus,
  localMemorySnapshot,
  runnerCensus,
} from "@prometheus/engine-bridge";

/**
 * Memory held back on a REMOTE host.
 *
 * Smaller than the local reserve: that machine is not also running the user's editor, browser
 * and compositor — most likely it is running a model server and little else. Still non-zero,
 * because an OS needs room whatever else it is doing.
 */
export const REMOTE_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Look up a declared remote host. Injected by the host so this module stays free of the
 * settings store (and therefore testable without a filesystem).
 */
let findDeclaredHost: ((baseUrl: string) => ai.RemoteHost | undefined) | undefined;

/** Wire the declared-host lookup. Called once by each terminal host at startup. */
export function setRemoteHostLookup(
  fn: ((baseUrl: string) => ai.RemoteHost | undefined) | undefined,
): void {
  findDeclaredHost = fn;
}

/** Injected so a test never touches the network or the kernel. */
export interface AdmissionDeps {
  memory?: (host?: string) => Promise<MemorySnapshot>;
  census?: (baseUrl: string, host?: string) => Promise<RunnerStatus[]>;
  inventory?: (baseUrl: string, ctx: number) => Promise<ai.ModelCandidate[]>;
  /** opt-out for a user who genuinely wants two runners up. */
  allowSecondServer?: boolean;
}

export interface AdmissionOutcome {
  /** may the caller warm this model up? */
  allow: boolean;
  /** lines to print. Empty when everything is fine — a silent pass is the common case. */
  lines: string[];
}

/** The runner id behind a base URL, for the one-server rule. */
export function runnerIdFor(baseUrl: string): string {
  if (/:1234(\/|$)/.test(baseUrl)) return "lmstudio";
  return "ollama";
}

/**
 * The host an endpoint would actually load on.
 *
 * `undefined` means "this machine". Anything else is the hostname, which is both the label in
 * every message and the signal that the memory question must be asked THERE.
 */
export function servingHost(baseUrl: string): string | undefined {
  try {
    // `URL.hostname` keeps the brackets on an IPv6 literal, so "[::1]" never matched "::1"
    // and a loopback endpoint spelled that way was treated as a named remote host.
    const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return undefined;
    if (/^127\./.test(h)) return undefined;
    return h;
  } catch {
    return undefined;
  }
}

/**
 * May this endpoint's model be loaded?
 *
 * Never throws and never blocks for long: every probe is bounded, and any failure to MEASURE is
 * an allow. A gate that refuses because it could not read the memory would be worse than no
 * gate — it would make an unreachable probe look like an out-of-memory machine.
 */
export async function admitEndpoint(
  endpoint: AiEndpoint,
  contextTokens: number,
  deps: AdmissionDeps = {},
): Promise<AdmissionOutcome> {
  if (endpoint.locality === "cloud") return { allow: true, lines: [] };
  const baseUrl = endpoint.baseUrl;
  const host = servingHost(baseUrl);
  const runner = runnerIdFor(baseUrl);
  const modelId = endpoint.model ?? endpoint.id;

  let snapshot: MemorySnapshot;
  let census: RunnerStatus[];
  let candidates: ai.ModelCandidate[];
  try {
    /**
     * WHOSE memory is this?
     *
     * For a host that is not this machine, `localMemorySnapshot()` would be the wrong answer to
     * the right question — it would weigh a remote model against local RAM. A declared host
     * (`/remote add … --ram <GB>`) carries the only figure a model runner's HTTP API cannot
     * report: how much the box HAS. Its residency still comes from the live census, so the
     * budget is "declared total, minus what is loaded there right now".
     *
     * A remote host with no declared size cannot be judged, so it is allowed — refusing on a
     * number we do not have would be a guess wearing a refusal's clothes.
     */
    const declared = host ? findDeclaredHost?.(baseUrl) : undefined;
    const mem =
      deps.memory ??
      (async (): Promise<MemorySnapshot> => {
        if (!host) return localMemorySnapshot();
        if (!declared?.totalMemoryBytes) throw new Error("remote host size unknown");
        return {
          totalBytes: declared.totalMemoryBytes,
          // Filled in below from the census: what the box has, less what it is already holding.
          availableBytes: declared.totalMemoryBytes,
          headroomBytes: REMOTE_HEADROOM_BYTES,
          host,
          source: "os-freemem",
        };
      });
    const cen =
      deps.census ??
      ((url: string, h?: string) =>
        runnerCensus(
          [
            { id: "ollama", baseUrl: ai.ollamaRoot(url), api: "ollama" as const },
            ...(runner === "lmstudio"
              ? []
              : [
                  {
                    id: "lmstudio",
                    baseUrl: url.replace(/:\d+.*$/, ":1234"),
                    api: "openai" as const,
                  },
                ]),
          ],
          { host: h, timeoutMs: 1500 },
        ));
    [snapshot, census] = await Promise.all([mem(host), cen(baseUrl, host)]);
    const resident = census.flatMap((s) => s.models);
    if (host && deps.memory === undefined) {
      // The remote box's free memory is its declared total minus what the census says is
      // resident. That is the best obtainable figure: no runner API reports free RAM.
      const held = resident.reduce((n, m) => n + m.sizeBytes, 0);
      snapshot = { ...snapshot, availableBytes: Math.max(0, snapshot.totalBytes - held) };
    }
    const inv =
      deps.inventory ??
      ((url: string, ctx: number) =>
        ai.inventoryCandidates(url, ctx, { runner, resident, timeoutMs: 2500 }));
    candidates = await inv(baseUrl, contextTokens);
  } catch {
    // Could not measure ⇒ do not stand in the way. See the doc comment.
    return { allow: true, lines: [] };
  }

  const candidate =
    candidates.find((c) => c.id === modelId) ??
    ({ id: modelId, weightsBytes: 0, contextTokens, geometry: null, runner } as ai.ModelCandidate);
  // Weights of 0 means the model is not installed here (or `/api/tags` did not answer); there is
  // nothing to weigh, so there is nothing to refuse.
  if (candidate.weightsBytes <= 0) return { allow: true, lines: [] };

  const decision = ai.admitModelLoad({
    candidate,
    budget: {
      totalBytes: snapshot.totalBytes,
      availableBytes: snapshot.availableBytes,
      headroomBytes: snapshot.headroomBytes,
      ...(host ? { host } : {}),
    },
    resident: census.map((s) => ({
      runner: s.runner,
      models: s.models,
      ...(host ? { host } : {}),
    })),
    alternatives: candidates,
    ...(deps.allowSecondServer ? { allowSecondServer: true } : {}),
  });

  if (decision.ok) {
    // Silent on the happy path, except when a switch will evict something — that is a fact the
    // user should not have to infer from a pause.
    return {
      allow: true,
      lines: decision.evicting?.length
        ? [`unloading ${decision.evicting.join(", ")} to make room for ${modelId}`]
        : [],
    };
  }
  return { allow: false, lines: ai.renderRefusal(decision) };
}
