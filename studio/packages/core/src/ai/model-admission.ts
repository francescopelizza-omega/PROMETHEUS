// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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

import { type FootprintObservation, ledgerFootprint } from "./footprint-ledger.js";
import {
  FALLBACK_KV_BYTES_PER_TOKEN,
  type KvCacheType,
  type MemoryBudget,
  type ModelFootprint,
  admitModel,
  humanBytes,
  type modelFootprint,
  servedContext,
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
  /**
   * What this model has actually been measured at before, on this host.
   *
   * The reason the footprint is not a guess. One past observation solves the runner-overhead
   * term outright and a log-derived one prices the cache without needing the architecture at
   * all — see `ai/footprint-ledger.ts`. Empty or absent simply falls back to arithmetic.
   */
  observations?: readonly FootprintObservation[];
  /** the host these observations belong to, so a remote model is not judged by local readings. */
  host?: string;
  /** the KV element type the runner is configured with, when it could be read. */
  kvCacheType?: KvCacheType;
}

/** A model server that is up right now. */
export interface ResidentServer {
  /** runner id — "ollama", "lmstudio", … */
  runner: string;
  /** the models it currently holds in memory, if known. */
  models: readonly { id: string; sizeBytes: number }[];
  /** the host it runs on; omitted means the same host as the budget. */
  host?: string;
  /**
   * Does `models` mean "HOLDING these in memory", or only "could serve these"?
   *
   * The distinction decides Rule 1 and the type could not express it, so every caller had to
   * remember that one runner's list means something different from another's. They did not.
   *
   * Ollama's `/api/ps` reports what is RESIDENT, with real sizes — `residencyKnown: true`.
   * LM Studio's OpenAI-shaped `/v1/models` reports its CATALOGUE with `sizeBytes: 0`, and
   * `parseOpenAiModels`' own doc says it answers "is a runner up" honestly and "how much is it
   * holding" not at all — `residencyKnown: false`.
   *
   * Rule 1 counts only servers whose residency is KNOWN. Without this, an LM Studio that is
   * merely RUNNING AND IDLE reports its whole catalogue, Rule 1 sees `models.length > 0` on a
   * different runner, and every single load is refused with "lmstudio is already serving a
   * model" — forever, on a machine where nothing is loaded at all. The terminal never hit it
   * because its admission call only skips a warm-up (`apps/cli/src/session/host.ts:774` is a
   * `void` after the endpoint is already adopted), so the refusal had no teeth to show. Any
   * surface that makes this gate real hits the bug immediately.
   *
   * `undefined` is treated as KNOWN, so the existing ollama-only callers keep their behaviour.
   */
  residencyKnown?: boolean;
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
  /**
   * `fits` is true only because the optimistic floor fits — the headline figure does not, and
   * the headline figure is an admitted ceiling. Surfaces mark these rows so "fits" never reads
   * as a promise it cannot keep.
   */
  uncertain?: boolean;
}

export type AdmissionDecision =
  | {
      ok: true;
      footprint: ModelFootprint;
      spareBytes: number;
      evicting?: readonly string[];
      /**
       * Present when the load was allowed DESPITE the headline figure not fitting, because that
       * figure is an admitted ceiling rather than a measurement. Callers print it; they do not
       * stop. See `admitModelLoad`.
       */
      uncertain?: string;
    }
  | {
      ok: false;
      code: "too-big" | "second-server";
      /**
       * The whole refusal as prose — `headline` and `detail` joined.
       *
       * Kept as the contract because not every surface can lay out a block: a log line, a tool
       * result and an IPC payload all want one string. The two fields below are the SAME words,
       * pre-split, for the surfaces that can.
       */
      reason: string;
      /**
       * The fact, in one sentence: what happened and to which model.
       *
       * Its own field because the first sentence is the only part a user reads before deciding
       * whether to care, and burying it at the head of a four-line paragraph makes them read all
       * four to find it. Splitting on `.` at render time would be worse — `gpu-box.lan` and
       * `qwen3.6:latest` both carry dots.
       */
      headline: string;
      /** the explanation and the way out, one sentence per entry. */
      detail: readonly string[];
      footprint: ModelFootprint;
      shortfallBytes: number;
      /**
       * Memory the decision was actually made against — available minus headroom — so a
       * renderer can show "needed vs free" without recomputing the budget it was not given.
       * Omitted when the refusal was not about size.
       */
      usableBytes?: number;
      /** what WOULD fit, biggest first. Empty means nothing installed fits. */
      affordable: readonly AffordableModel[];
    };

/**
 * Footprint a candidate against a context.
 *
 * Routed through the ledger, so everything ever measured about this model is used before any
 * arithmetic is. The context is CLAMPED to what the model was actually trained for: a runner
 * serves `min(requested, trained)`, so pricing a cache at a 262,144-token setting for a model
 * trained at 8,192 over-counts by 32× and refuses a model over memory it would never ask for.
 */
export function footprintOf(c: ModelCandidate): ModelFootprint {
  const contextTokens = servedContext(c.contextTokens, c.geometry);
  return ledgerFootprint({
    model: c.id,
    weightsBytes: c.weightsBytes,
    contextTokens,
    geometry: c.geometry ?? null,
    fallbackKvBytesPerToken: FALLBACK_KV_BYTES_PER_TOKEN,
    ...(c.host !== undefined ? { host: c.host } : {}),
    ...(c.kvCacheType !== undefined ? { kvCacheType: c.kvCacheType } : {}),
    ...(c.measuredTotalBytes !== undefined ? { residentTotalBytes: c.measuredTotalBytes } : {}),
    ...(c.observations !== undefined ? { ledger: c.observations } : {}),
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
    .map((candidate): AffordableModel => {
      const footprint = footprintOf(candidate);
      const a = admitModel(footprint, budget);
      if (a.ok) return { candidate, footprint, fits: true, spareBytes: a.spareBytes };
      // Same rule as `admitModelLoad`: a ceiling that does not fit is not the same as a model
      // that does not fit. If the floor fits, the honest answer is "probably", not "no".
      const floor = footprint.lowerBoundBytes;
      const usable = Math.max(0, budget.availableBytes - budget.headroomBytes);
      if (footprint.source === "estimated" && floor !== undefined && floor <= usable) {
        return { candidate, footprint, fits: true, spareBytes: usable - floor, uncertain: true };
      }
      return { candidate, footprint, fits: false, spareBytes: -a.shortfallBytes };
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
  // `residencyKnown === false` means the probe could only see a CATALOGUE, not what is held
  // (LM Studio). A runner we cannot prove is holding weights must not block a load — see
  // `ResidentServer.residencyKnown`. Erring the other way turns an idle app into a permanent
  // refusal, which is strictly worse than missing one over-commit the RAM arithmetic below
  // still has a chance to catch.
  const others = resident.filter(
    (s) => s.runner !== candidate.runner && s.models.length > 0 && s.residencyKnown !== false,
  );
  if (others.length > 0 && !req.allowSecondServer) {
    const names = others.map((s) => s.runner).join(", ");
    const headline = `${names} is already serving a model on ${budget.host ?? "this machine"}.`;
    const detail = [
      "Prometheus keeps one model server running at a time so two of them cannot each hold a full set of weights.",
      "Stop it first, or allow a second server explicitly.",
    ];
    return {
      ok: false,
      code: "second-server",
      reason: [headline, ...detail].join(" "),
      headline,
      detail,
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

  /**
   * ── THE ESTIMATE IS NOT ALLOWED TO REFUSE INSIDE ITS OWN ERROR BAR ────────────────────────
   *
   * An `estimated` footprint has no geometry behind it: its KV term is a blanket per-token
   * allowance chosen to be a CEILING. Refusing a model because a deliberate ceiling did not fit
   * is refusing it on a number we do not have — the precise failure the user named, where a
   * model that would have run fine is discarded as too big.
   *
   * So when the optimistic floor DOES fit, this is not a refusal. It is a warning and a load:
   * the arithmetic that is actually trustworthy (weights, which are known) fits, and the part
   * that is guessed is the part being deferred to reality. The costs are asymmetric in both
   * directions and this is where they balance — a wrong refusal is certain and permanent, a
   * wrong admission is probabilistic and recoverable (the runner's own allocation fails, and
   * `ram-guard.sh` is watching regardless).
   *
   * A `computed`, `calibrated` or `measured` footprint gets no such benefit. Those numbers have
   * been verified to the megabyte against ollama's own allocation; if one says no, it means no.
   */
  const floor = footprint.lowerBoundBytes;
  if (footprint.source === "estimated" && floor !== undefined) {
    const usable = Math.max(0, effective.availableBytes - effective.headroomBytes);
    if (floor <= usable) {
      return {
        ok: true,
        footprint,
        spareBytes: usable - floor,
        uncertain: `${candidate.id}'s size could not be computed — no architecture data from the runner — so this is a range, not a figure: between ${humanBytes(floor)} and ${humanBytes(footprint.totalBytes)}, against ${humanBytes(usable)} free. Loading it anyway, because refusing on a guess would be worse than finding out.`,
      };
    }
  }

  const where = budget.host ? ` on ${budget.host}` : "";
  const headline =
    `${candidate.id} needs about ${humanBytes(footprint.totalBytes)}${where}, ` +
    `which is ${humanBytes(verdict.shortfallBytes)} more than is free.`;
  /**
   * The same breakdown `renderRefusal` draws as a column, written out as a sentence.
   *
   * Both exist on purpose. A terminal can align three figures and read them at a glance; a log
   * line, a notification or a pane that wraps at an unknown width cannot, and a column that
   * wraps is worse than no column. Neither is the "real" one — they are one fact, twice.
   */
  const detail = [
    `That is ${humanBytes(footprint.weightsBytes)} of weights plus ` +
      `${humanBytes(footprint.kvBytes)} of context cache at ` +
      `${footprint.contextTokens.toLocaleString("en-US")} tokens.`,
  ];
  return {
    ok: false,
    code: "too-big",
    reason: [headline, ...detail].join(" "),
    headline,
    detail,
    footprint,
    shortfallBytes: verdict.shortfallBytes,
    usableBytes: Math.max(0, footprint.totalBytes - verdict.shortfallBytes),
    affordable: affordableModels(req.alternatives ?? [], effective),
  };
}

/**
 * How a size figure should be qualified, in the user's terms rather than the code's.
 *
 * The words matter: "measured" and "estimated" are already English, and a user reading a list of
 * models does not need to learn a vocabulary to know which numbers to trust.
 */
export function footprintNote(source: ModelFootprint["source"]): string {
  if (source === "measured") return "(measured)";
  if (source === "calibrated") return "(from a past load)";
  if (source === "estimated") return "(rough — no architecture data)";
  return "";
}

/**
 * Word-wrap plain prose to `width` columns, with a fixed indent.
 *
 * Deliberately naive — no ANSI, no East-Asian width table — because everything this module
 * produces is plain ASCII prose plus model ids, and the surfaces that add colour do it per line
 * AFTER wrapping. `apps/cli/src/tui/width.ts` has the ANSI- and wide-char-aware version; core
 * cannot import it (it lives in an app) and does not need it.
 *
 * A word longer than the line is left long rather than hard-broken: the only words that get
 * near the limit here are model ids and env-var names, and both are worth more unbroken than
 * they cost in overflow.
 */
function wrapPlain(text: string, width: number, indent = ""): string[] {
  const max = Math.max(24, width - indent.length);
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      out.push(indent + line);
      line = word;
    }
  }
  if (line !== "") out.push(indent + line);
  return out;
}

/** Byte units, smallest first, for the figures column. */
const COLUMN_UNITS: readonly (readonly [string, number])[] = Object.freeze([
  ["B", 1],
  ["KB", 1024],
  ["MB", 1024 ** 2],
  ["GB", 1024 ** 3],
  ["TB", 1024 ** 4],
] as const);

/**
 * Format several byte figures for ONE column: same unit throughout, one decimal each.
 *
 * `humanBytes` is right for prose and wrong here, for two reasons that only show up in a
 * column. It picks a unit per value, so a row of 900 MB sits under a row of 22 GB with nothing
 * to compare; and it drops the decimal above 10, so `22 GB + 2.7 GB + 1.6 GB` prints under a
 * rule against a total of `27 GB` — three figures that do not reach the number they are ruled
 * into. The gap is pure display rounding, but a reader cannot know that, and a table whose
 * visible arithmetic is wrong discredits the figures in it that are right.
 *
 * One decimal leaves at most 0.05 of slack per row, so the column ties as printed.
 */
function columnBytes(values: readonly number[]): string[] {
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);
  let i = 0;
  while (i < COLUMN_UNITS.length - 1 && max >= (COLUMN_UNITS[i + 1] as [string, number])[1]) i++;
  const [suffix, div] = COLUMN_UNITS[i] as [string, number];
  return values.map(
    (v) =>
      `${(v / div).toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      })} ${suffix}`,
  );
}

/**
 * The refusal, rendered for a terminal or a pane.
 *
 * ── WHY THIS IS LAID OUT RATHER THAN PRINTED ────────────────────────────────────────────────
 *
 * A refusal arrives unasked-for, in the middle of a session the user was doing something else
 * in. It gets about one second of attention before they decide whether to read it — so the
 * shape has to do the work that reading would otherwise have to:
 *
 *   - the FACT is its own line, at the left margin, so it is the first thing the eye lands on;
 *   - the EXPLANATION is indented and wrapped, so it reads as subordinate and never runs to the
 *     terminal's right edge (an 80-column terminal wrapped the old single-string paragraph at
 *     an arbitrary column, mid-word, with no indent to show the lines belonged together);
 *   - the FIGURES are a column, because three numbers that must be compared to each other are a
 *     table, not a sentence;
 *   - the MODELS are aligned on name and right-aligned on size, so "which is biggest" is
 *     answered by looking down a column rather than by reading every row. The old
 *     `id  —  size  (note)` put the sizes at a different x for every row, which is exactly the
 *     comparison the list exists to support.
 *
 * Deliberately ends with what the user CAN do. A refusal is only useful if the next step is on
 * the same screen.
 */
export function renderRefusal(
  d: Extract<AdmissionDecision, { ok: false }>,
  opts: { contextHint?: boolean; width?: number } = {},
): string[] {
  // Clamped, not trusted: a 400-column terminal would produce prose no one can track a line of,
  // and a 20-column one would produce a word per line. 76 is the default because it is the
  // widest a wrapped paragraph stays comfortable at, and leaves room for a prompt's own gutter.
  const width = Math.max(52, Math.min(96, opts.width ?? 76));
  const lines = wrapPlain(d.headline, width);
  const fits = d.affordable.filter((a) => a.fits);
  const tooBig = d.affordable.filter((a) => !a.fits);

  if (d.code === "too-big") {
    /**
     * The breakdown as a column. `detail` says the same thing in prose for surfaces that cannot
     * align — printing both here would be saying it twice.
     *
     * All THREE addends are shown, including the runner's own overhead, and a rule separates
     * them from the total. Listing only weights and cache under a total they do not add up to
     * reads as an arithmetic mistake, and the missing term is the one a user is least likely to
     * guess at: a 1–2 GB process is not obvious from a model's name.
     */
    const f = d.footprint;
    /**
     * The third addend is the RESIDUAL, not `overheadBytes`.
     *
     * They are the same number on a computed footprint, and different on a measured one: there,
     * `totalBytes` is a real reading and `overheadBytes` is set to 0 because nothing separated
     * the runner's own memory out of it. Printing that 0 under a rule would show three figures
     * that visibly do not add up to the total above them — and a table whose arithmetic is
     * wrong discredits the numbers that are right. `total − weights − cache` IS the buffers and
     * the process, whichever tier produced the figure.
     */
    const other = f.totalBytes - f.weightsBytes - f.kvBytes;
    const note = footprintNote(f.source);
    const labels = [
      "weights",
      `context cache at ${f.contextTokens.toLocaleString("en-US")} tokens`,
      ...(other > 0 ? ["compute buffers and the runner itself"] : []),
      `needed in total${note ? ` ${note}` : ""}`,
      ...(d.usableBytes !== undefined ? ["free right now"] : []),
    ];
    const values = [
      f.weightsBytes,
      f.kvBytes,
      ...(other > 0 ? [other] : []),
      f.totalBytes,
      ...(d.usableBytes !== undefined ? [d.usableBytes] : []),
    ];
    // Everything above the total is an addend; the rule goes between them.
    const ruleAt = other > 0 ? 3 : 2;
    const cells = columnBytes(values);
    const numW = Math.max(...cells.map((c) => c.length));
    lines.push("");
    cells.forEach((cell, i) => {
      // The rule claims "these add up". Only drawn when they do — a measured total below the
      // weights alone (a runner reporting something odd) gets the figures without the claim.
      if (i === ruleAt && other >= 0) lines.push(`    ${"─".repeat(numW)}`);
      lines.push(`    ${cell.padStart(numW)}   ${labels[i]}`);
    });
  } else {
    lines.push("");
    for (const sentence of d.detail) lines.push(...wrapPlain(sentence, width, "  "));
  }

  if (fits.length > 0) {
    const sizes = fits.map((a) =>
      a.uncertain
        ? `${humanBytes(a.footprint.lowerBoundBytes ?? a.footprint.totalBytes)}–${humanBytes(a.footprint.totalBytes)}`
        : humanBytes(a.footprint.totalBytes),
    );
    const nameW = Math.max(...fits.map((a) => a.candidate.id.length));
    const sizeW = Math.max(...sizes.map((s) => s.length));
    lines.push("", "Models that fit right now:");
    fits.forEach((a, i) => {
      const note = footprintNote(a.footprint.source);
      lines.push(
        `    ${a.candidate.id.padEnd(nameW)}   ${(sizes[i] as string).padStart(sizeW)}   ${note}`.trimEnd(),
      );
    });
  } else if (d.affordable.length > 0) {
    lines.push(
      "",
      ...wrapPlain("Nothing installed fits in the memory that is free right now.", width),
    );
  }
  if (tooBig.length > 0 && fits.length > 0) {
    lines.push(
      ...wrapPlain(
        `${tooBig.length} other${tooBig.length === 1 ? "" : "s"} too large: ` +
          `${tooBig.map((a) => a.candidate.id).join(", ")}`,
        width,
        "    ",
      ),
    );
  }
  if (d.code === "too-big" && opts.contextHint !== false) {
    // The context cache is often the difference, and it is the one term the user controls
    // without changing model.
    lines.push(
      "",
      ...wrapPlain(
        "A smaller context would also reduce the cache: /context window, or PROMETHEUS_OLLAMA_CTX.",
        width,
      ),
    );
  }
  return lines;
}
