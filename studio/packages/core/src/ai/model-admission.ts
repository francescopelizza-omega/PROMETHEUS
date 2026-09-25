/**
 * ai/model-admission.ts — may this model load on this host, and if not, what can?
 *
 * ONE decision function, because the scout count was six: `startModelServer`,
 * `ensureLocalRunnerRunning`, `createServeHost().start()`, `ServerSupervisor.start()`,
 * `spawnWatchdogIfNeeded` and the Python sidecar's own `_ensure_ollama_daemon` can each bring a
 * model server up, and not one of them asks whether the model fits. `detectBackends` even runs
 * the probe-and-start over every known runner in a `Promise.all`, so a single CLI boot can
 * cold-start Ollama AND LM Studio concurrently — each sampling free memory before the other has
 * loaded anything.
 *
 * ── THE TWO RULES ───────────────────────────────────────────────────────────────────────────
 *
 *  1. **One model server at a time.** Not one model — one SERVER. `OLLAMA_MAX_LOADED_MODELS=1`
 *     already keeps ollama to a single resident model and evicts on switch, but it says nothing
 *     about LM Studio starting alongside it. Two runners each holding weights is how a machine
 *     with room for one 24 GB model ends up trying to hold two.
 *
 *  2. **A model must fit before it is started.** Computed from real geometry
 *     (`ai/model-footprint.ts`, verified to the megabyte against ollama's own allocation), against
 *     memory that is AVAILABLE rather than a fraction of TOTAL — because "70% of 64 GB" says yes
 *     to a second 24 GB model while the first one is still resident.
 *
 * ── WHAT A REFUSAL OWES THE USER ────────────────────────────────────────────────────────────
 *
 * A refusal that only says "no" moves the problem rather than solving it. Every refusal here
 * carries the shortfall AND the models that WOULD fit, sorted biggest-first, so the answer to
 * "then what can I run?" is already on screen.
 *
 * ── LOCAL AND REMOTE ARE THE SAME QUESTION ──────────────────────────────────────────────────
 *
 * The budget carries a `host`. When Prometheus drives a model server on another machine, the
 * memory that matters is THAT machine's — so the caller supplies a snapshot describing the
 * remote host and every rule below applies unchanged. Nothing in this module reads the local
 * machine; it cannot accidentally judge a remote model by local RAM.
 */

import {
  type MemoryBudget,
  type ModelFootprint,
  admitModel,
  humanBytes,
  modelFootprint,
} from "./model-footprint.js";

/** A model the caller might load. */
export interface ModelCandidate {
  /** the id a user and a runner both recognise, e.g. "qwen3.6:latest". */
  id: string;
  /** on-disk weights (ollama `/api/tags` `size`). */
  weightsBytes: number;
  /** the context it would be served at. */
  contextTokens: number;
  /** `/api/show` geometry, when it could be fetched. */
  geometry?: Parameters<typeof modelFootprint>[0]["geometry"];
  /** a real total from a previous load or `/api/ps`. */
  measuredTotalBytes?: number;
  /** which runner would serve it ("ollama", "lmstudio", …). */
  runner?: string;
}

/** A model server that is up right now. */
export interface ResidentServer {
  /** runner id — "ollama", "lmstudio", … */
  runner: string;
  /** the models it currently holds in memory, if known. */
  models: readonly { id: string; sizeBytes: number }[];
  /** the host it runs on; omitted means the same host as the budget. */
  host?: string;
}

export interface AdmissionRequest {
  candidate: ModelCandidate;
  budget: MemoryBudget;
  /** servers already up on the SAME host as `budget`. */
  resident?: readonly ResidentServer[];
  /** other models the user could pick instead, for the "what fits?" list. */
  alternatives?: readonly ModelCandidate[];
  /**
   * Allow a second runner to come up beside an existing one. Off by default: the one-server
   * rule is the point. A user who really wants two can say so.
   */
  allowSecondServer?: boolean;
}

export interface AffordableModel {
  candidate: ModelCandidate;
  footprint: ModelFootprint;
  fits: boolean;
  /** how much would be left over (negative = shortfall). */
  spareBytes: number;
}

export type AdmissionDecision =
  | { ok: true; footprint: ModelFootprint; spareBytes: number; evicting?: readonly string[] }
  | {
      ok: false;
      code: "too-big" | "second-server";
      /** one sentence, already phrased for a human. */
      reason: string;
      footprint: ModelFootprint;
      shortfallBytes: number;
      /** what WOULD fit, biggest first. Empty means nothing installed fits. */
      affordable: readonly AffordableModel[];
    };

/** Footprint a candidate against a context. */
export function footprintOf(c: ModelCandidate): ModelFootprint {
  return modelFootprint({
    weightsBytes: c.weightsBytes,
    contextTokens: c.contextTokens,
    geometry: c.geometry ?? null,
    ...(c.measuredTotalBytes !== undefined ? { measuredTotalBytes: c.measuredTotalBytes } : {}),
  });
}

/**
 * Which of `candidates` fit, biggest first.
 *
 * Biggest-first because the user asking "what can I run?" almost always wants the most capable
 * thing that fits, not the smallest. Models that do NOT fit are still returned (with
 * `fits: false`) so a caller can show them greyed out rather than pretending they do not exist —
 * "my model vanished from the list" is a worse bug than "my model is listed as too big".
 */
export function affordableModels(
  candidates: readonly ModelCandidate[],
  budget: MemoryBudget,
): AffordableModel[] {
  return candidates
    .map((candidate) => {
      const footprint = footprintOf(candidate);
      const a = admitModel(footprint, budget);
      return {
        candidate,
        footprint,
        fits: a.ok,
        spareBytes: a.ok ? a.spareBytes : -a.shortfallBytes,
      };
    })
    .sort((x, y) => {
      if (x.fits !== y.fits) return x.fits ? -1 : 1;
      return y.footprint.totalBytes - x.footprint.totalBytes;
    });
}

/**
 * The memory a resident server would GIVE BACK if it were evicted first.
 *
 * Only counts servers on the same host, and only the same runner: ollama evicting its own model
 * to load another is routine (`OLLAMA_MAX_LOADED_MODELS=1` does exactly that), while a DIFFERENT
 * runner's memory is not ours to plan around — that is the second-server rule's job.
 */
export function reclaimableBytes(
  resident: readonly ResidentServer[] | undefined,
  runner: string | undefined,
): number {
  if (!resident || !runner) return 0;
  return resident
    .filter((s) => s.runner === runner)
    .flatMap((s) => s.models)
    .reduce((sum, m) => sum + m.sizeBytes, 0);
}

/** Decide. Never throws; every outcome is a value the caller renders. */
export function admitModelLoad(req: AdmissionRequest): AdmissionDecision {
  const { candidate, budget } = req;
  const footprint = footprintOf(candidate);
  const resident = req.resident ?? [];

  // ── Rule 1: one model server at a time ────────────────────────────────────
  const others = resident.filter((s) => s.runner !== candidate.runner && s.models.length > 0);
  if (others.length > 0 && !req.allowSecondServer) {
    const names = others.map((s) => s.runner).join(", ");
    return {
      ok: false,
      code: "second-server",
      reason: `${names} is already serving a model on ${budget.host ?? "this machine"}. Prometheus keeps one model server running at a time so two of them cannot each hold a full set of weights. Stop it first, or allow a second server explicitly.`,
      footprint,
      shortfallBytes: 0,
      affordable: affordableModels(req.alternatives ?? [], budget),
    };
  }

  // ── Rule 2: it has to fit ─────────────────────────────────────────────────
  // A same-runner model already resident will be evicted to make room, so its memory counts as
  // available — that is what actually happens on the switch, and pretending otherwise refuses
  // every swap on a machine sized for exactly one model.
  const reclaim = reclaimableBytes(resident, candidate.runner);
  const effective: MemoryBudget = {
    ...budget,
    availableBytes: budget.availableBytes + reclaim,
  };
  const verdict = admitModel(footprint, effective);
  if (verdict.ok) {
    const evicting = resident
      .filter((s) => s.runner === candidate.runner)
      .flatMap((s) => s.models.map((m) => m.id))
      .filter((id) => id !== candidate.id);
    return {
      ok: true,
      footprint,
      spareBytes: verdict.spareBytes,
      ...(evicting.length > 0 ? { evicting } : {}),
    };
  }

  const where = budget.host ? ` on ${budget.host}` : "";
  return {
    ok: false,
    code: "too-big",
    reason:
      `${candidate.id} needs about ${humanBytes(footprint.totalBytes)}${where} ` +
      `(${humanBytes(footprint.weightsBytes)} of weights plus ` +
      `${humanBytes(footprint.kvBytes)} of context cache at ` +
      `${footprint.contextTokens.toLocaleString("en-US")} tokens), ` +
      `which is ${humanBytes(verdict.shortfallBytes)} more than is free.`,
    footprint,
    shortfallBytes: verdict.shortfallBytes,
    affordable: affordableModels(req.alternatives ?? [], effective),
  };
}

/**
 * The refusal, rendered for a terminal or a pane.
 *
 * Deliberately ends with what the user CAN do. A refusal is only useful if the next step is on
 * the same screen.
 */
export function renderRefusal(
  d: Extract<AdmissionDecision, { ok: false }>,
  opts: { contextHint?: boolean } = {},
): string[] {
  const lines = [d.reason];
  const fits = d.affordable.filter((a) => a.fits);
  const tooBig = d.affordable.filter((a) => !a.fits);
  if (fits.length > 0) {
    lines.push("", "Models that fit right now:");
    for (const a of fits) {
      lines.push(
        `  ${a.candidate.id}  —  ${humanBytes(a.footprint.totalBytes)}` +
          `${a.footprint.source === "estimated" ? " (estimated)" : ""}`,
      );
    }
  } else if (d.affordable.length > 0) {
    lines.push("", "Nothing installed fits in the memory that is free right now.");
  }
  if (tooBig.length > 0 && fits.length > 0) {
    lines.push(
      `  (${tooBig.length} other${tooBig.length === 1 ? "" : "s"} too large: ` +
        `${tooBig.map((a) => a.candidate.id).join(", ")})`,
    );
  }
  if (d.code === "too-big" && opts.contextHint !== false) {
    // The context cache is often the difference, and it is the one term the user controls
    // without changing model.
    lines.push(
      "",
      "A smaller context would also reduce the cache: /context window, or PROMETHEUS_OLLAMA_CTX.",
    );
  }
  return lines;
}
