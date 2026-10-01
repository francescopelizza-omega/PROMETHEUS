// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
  remoteMemorySnapshot,
  runnerCensus,
} from "@prometheus/engine-bridge";

import { loadLedger, remember } from "./footprint-store.js";

/**
 * Memory held back on a REMOTE host.
 *
 * Smaller than the local reserve: that machine is not also running the user's editor, browser
 * and compositor — most likely it is running a model server and little else. Still non-zero,
 * because an OS needs room whatever else it is doing.
 */
export const REMOTE_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How long a residency/inventory probe may take — and why it depends on WHERE.
 *
 * The repo's probe budgets were all calibrated against loopback, where a round trip is
 * sub-millisecond: 900 ms in `ollama-autostart`, 1500 in `model-server`, 2000 in
 * `runner-census`. Those numbers are fine for a socket on this machine and wrong for one on a
 * LAN, and badly wrong through an ssh tunnel, where a handshake plus a WAN round trip can eat
 * the whole budget before the runner has said anything.
 *
 * A timed-out census does not fail loudly. It returns "nothing is loaded there" — a confident,
 * wrong answer that then feeds the admission decision. So the remote budget is several times
 * the local one: a slow probe costs a pause, a false one costs a bad verdict.
 */
export const LOCAL_PROBE_TIMEOUT_MS = 1_500;
export const REMOTE_PROBE_TIMEOUT_MS = 8_000;
export const LOCAL_INVENTORY_TIMEOUT_MS = 2_500;
export const REMOTE_INVENTORY_TIMEOUT_MS = 12_000;

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
        /**
         * ASK THE MACHINE, when we can reach it.
         *
         * A declared `--ram` is believed forever: it cannot notice RAM being added, a GPU
         * filling with someone else's job, or the box being rebooted into something smaller.
         * An SSH probe reads that kernel's own numbers — the same metric `localMemorySnapshot`
         * reads here — and on a discrete-GPU box it reads free VRAM, which is the constraint
         * that actually decides whether a model loads.
         */
        if (declared?.ssh) {
          const probed = await remoteMemorySnapshot(declared.ssh, { timeoutMs: 12_000 });
          if (probed.ok) return probed.snapshot;
        }
        if (!declared?.totalMemoryBytes) throw new Error("remote host size unknown");
        return {
          totalBytes: declared.totalMemoryBytes,
          // Filled in below from the census: what the box has, less what it is already holding.
          availableBytes: declared.totalMemoryBytes,
          headroomBytes: REMOTE_HEADROOM_BYTES,
          host,
          source: "declared",
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
          // A remote host gets a budget that fits a network round trip; see the constants.
          { host: h, timeoutMs: h ? REMOTE_PROBE_TIMEOUT_MS : LOCAL_PROBE_TIMEOUT_MS },
        ));
    [snapshot, census] = await Promise.all([mem(host), cen(baseUrl, host)]);
    const resident = census.flatMap((s) => s.models);
    if (host && deps.memory === undefined && snapshot.source === "declared") {
      // Only the DECLARED figure needs this correction: it describes the whole machine and knows
      // nothing about what is on it. A measured snapshot already reports what is free, and
      // subtracting the resident models from it again would count them twice.
      const held = resident.reduce((n, m) => n + m.sizeBytes, 0);
      snapshot = { ...snapshot, availableBytes: Math.max(0, snapshot.totalBytes - held) };
    }

    /**
     * Learn from what is loaded right now, before deciding anything.
     *
     * `/api/ps` is the only source that reports a model's TOTAL resident bytes — weights, cache
     * and the runner's own buffers together — which is precisely the term arithmetic cannot
     * reach. Writing it down here means the next admission for this model, at any context, is
     * anchored to a measurement instead of an allowance.
     */
    const ledger = rememberResident(resident, contextTokens, host);

    const inv =
      deps.inventory ??
      ((url: string, ctx: number) =>
        ai.inventoryCandidates(url, ctx, {
          runner,
          resident,
          timeoutMs: host ? REMOTE_INVENTORY_TIMEOUT_MS : LOCAL_INVENTORY_TIMEOUT_MS,
          observations: ledger,
          ...(host ? { host } : {}),
          ...(kvTypeFrom(ledger) ? { kvCacheType: kvTypeFrom(ledger) as ai.KvCacheType } : {}),
        }));
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
      // Carried, not dropped. Without it an LM Studio that is merely OPEN reports its whole
      // catalogue through `parseOpenAiModels` and the one-server rule refuses every load on a
      // machine holding nothing — see `ResidentServer.residencyKnown`.
      residencyKnown: s.residencyKnown,
      ...(host ? { host } : {}),
    })),
    alternatives: candidates,
    ...(deps.allowSecondServer ? { allowSecondServer: true } : {}),
  });

  if (decision.ok) {
    // Silent on the happy path, except when a switch will evict something, or when the figure
    // behind the decision was a range rather than a number — both are facts the user should not
    // have to infer from a pause.
    const lines: string[] = [];
    if (decision.evicting?.length) {
      lines.push(`unloading ${decision.evicting.join(", ")} to make room for ${modelId}`);
    }
    if (decision.uncertain) lines.push(decision.uncertain);
    return { allow: true, lines };
  }
  // The renderer clamps this itself; passing the real terminal width just lets a wide window
  // use more of itself than the 76-column default, and a narrow one stop short of its edge.
  return { allow: false, lines: ai.renderRefusal(decision, { width: terminalWidth() }) };
}

/** Columns available for a refusal block, leaving a small gutter. `undefined` when not a TTY. */
function terminalWidth(): number | undefined {
  const cols = process.stdout.columns;
  return typeof cols === "number" && cols > 0 ? cols - 4 : undefined;
}

/**
 * Fold what is resident right now into the ledger, and return it.
 *
 * Never throws: a ledger is an optimisation, and failing to write one must not stop a model from
 * loading. Returns the in-memory list either way so the caller's decision uses the fresh reading
 * even if the disk write failed.
 */
export function rememberResident(
  resident: readonly { id: string; sizeBytes: number; contextTokens?: number }[],
  contextTokens: number,
  host: string | undefined,
): ai.FootprintObservation[] {
  let ledger = loadLedger();
  for (const m of resident) {
    if (!(m.sizeBytes > 0)) continue;
    try {
      ledger = remember({
        model: m.id,
        // `/api/ps` reports the context the model was ACTUALLY loaded with, which may differ
        // from the one being asked about. Recording the request's number against the
        // measurement would file a true reading under the wrong context.
        contextTokens: m.contextTokens ?? contextTokens,
        totalBytes: m.sizeBytes,
        observedAt: new Date().toISOString(),
        via: "api-ps",
        ...(host ? { host } : {}),
      });
    } catch {
      /* a read-only home should never stop a model from loading */
    }
  }
  return ledger;
}

/**
 * The KV element type the runner is actually configured with.
 *
 * Not available from any HTTP API — but ollama's log records it with every cache it allocates
 * (`K (q8_0)`), and the harvester keeps it. Reading it from the most recent observation is
 * therefore free and beats assuming q8_0, which would mis-price an f16 cache by 2×.
 */
export function kvTypeFrom(ledger: readonly ai.FootprintObservation[]): ai.KvCacheType | undefined {
  for (const o of ledger) if (o.kvType) return o.kvType;
  return undefined;
}
