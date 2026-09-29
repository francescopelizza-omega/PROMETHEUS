/**
 * updates/model-actions.ts — what may be DONE about a model, and how to read a pull's progress.
 *
 * The pure half of phase 4. `model-registry.ts` decides whether an update exists; this decides
 * which actions follow from it, what they cost, and — for the destructive one — whether the
 * saving being advertised is real. Every spawn, socket and file read is the caller's.
 *
 * ── THE ONE THING THAT SURPRISES EVERYONE ABOUT /api/pull ───────────────────────────────────
 *
 * **HTTP 200 does not mean the pull worked.** Verified against ollama's `server/routes.go`:
 * `streamResponse()` writes a normal JSON error only if it fails BEFORE any byte is sent; once
 * the NDJSON stream has started, a failure is appended as a line `{"error":"…"}` and the stream
 * simply stops — with the response already committed as 200. A caller that checks `res.ok` and
 * walks away reports a successful download of a model that is not on disk.
 *
 * So success has exactly one definition here: a terminal line whose `status` is `"success"`.
 * Anything else that ends the stream is a failure, including a clean EOF.
 *
 * ── AND THE THING THAT SURPRISES PEOPLE ABOUT "ALREADY INSTALLED" ───────────────────────────
 *
 * Pulling a tag you already have is NOT a no-op. It re-resolves the remote manifest, and if the
 * tag has moved it downloads the new layers and removes the superseded ones. That is a feature —
 * it is how a same-tag update is applied — but it means a pull of an up-to-date tag can still spend
 * 22 GB of bandwidth, so the caller must say what it is about to do.
 *
 * (The command is `/updates pull`, not `/models`: `models` is an engine verb and `/model` already
 * means "switch the active one" — see `slash-registry.ts:1886`.)
 */

import type { ModelCheck, ModelUpdate } from "./model-registry.js";

/* ───────────────────────────── pull progress ───────────────────────────── */

/**
 * One line of ollama's NDJSON pull stream.
 *
 * `total` and `completed` are `omitempty` int64 in `api/types.go`, so they are ABSENT — not
 * zero — on the manifest, verify, write and success lines. A parser that defaults them to 0
 * renders "0%" for four of the six phases and a progress bar that lurches backwards.
 */
export type PullEvent =
  /** a phase with no byte counter: pulling manifest, verifying, writing, removing. */
  | { kind: "status"; status: string }
  /** a layer download, with bytes so far. `total` may still be absent on the first line. */
  | { kind: "progress"; status: string; digest: string; completed: number; total?: number }
  /** the stream said it finished. The ONLY evidence a pull worked. */
  | { kind: "success" }
  /** an error line — which may arrive AFTER a 200, mid-stream. */
  | { kind: "error"; message: string };

/**
 * Parse one NDJSON line. Returns null for a blank line or unparseable JSON.
 *
 * Deliberately tolerant of shape and strict about meaning: an object with no `status` and no
 * `error` is not a progress event we understand, and inventing one from it would put a phantom
 * phase on the user's screen.
 */
export function parsePullLine(line: string): PullEvent | null {
  const t = line.trim();
  if (t === "") return null;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(t);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  // Checked FIRST: an error line may also carry a status, and the error is the meaning.
  if (typeof o.error === "string" && o.error.trim() !== "") {
    return { kind: "error", message: o.error.trim() };
  }
  const status = typeof o.status === "string" ? o.status : "";
  if (status === "") return null;
  if (status === "success") return { kind: "success" };

  const digest = typeof o.digest === "string" ? o.digest : "";
  const completed = typeof o.completed === "number" ? o.completed : undefined;
  const total = typeof o.total === "number" ? o.total : undefined;
  if (digest !== "" && completed !== undefined) {
    return {
      kind: "progress",
      status,
      digest,
      completed,
      ...(total !== undefined ? { total } : {}),
    };
  }
  return { kind: "status", status };
}

/** Running totals across every layer of a pull, for one progress line the user can read. */
export interface PullProgress {
  /** the phase text from the most recent line. */
  phase: string;
  /** bytes fetched across every layer seen so far. */
  completed: number;
  /** bytes expected, when every layer seen so far has declared a total. */
  total?: number;
  /** 0..1, or undefined while any layer's total is unknown — never a fabricated 0. */
  fraction?: number;
}

/**
 * Fold pull events into a single progress line.
 *
 * Per-DIGEST accumulation, not a running sum: ollama re-sends the same layer's `completed` as an
 * absolute figure on every tick, so adding them produces a number that races past the total and
 * a bar that fills several times over.
 */
export class PullProgressTracker {
  private readonly layers = new Map<string, { completed: number; total?: number }>();
  private phase = "starting";

  apply(event: PullEvent): void {
    if (event.kind === "status") this.phase = event.status;
    if (event.kind === "progress") {
      this.phase = event.status;
      this.layers.set(event.digest, {
        completed: event.completed,
        ...(event.total !== undefined ? { total: event.total } : {}),
      });
    }
  }

  snapshot(): PullProgress {
    let completed = 0;
    let total = 0;
    let everyTotalKnown = this.layers.size > 0;
    for (const l of this.layers.values()) {
      completed += l.completed;
      if (l.total === undefined) everyTotalKnown = false;
      else total += l.total;
    }
    return {
      phase: this.phase,
      completed,
      ...(everyTotalKnown ? { total } : {}),
      // Undefined, not 0, while anything is unknown: a 0% that is really "don't know" reads as
      // a stalled download.
      ...(everyTotalKnown && total > 0 ? { fraction: Math.min(1, completed / total) } : {}),
    };
  }
}

/* ───────────────────────────── what may be done ───────────────────────────── */

/** An action the user can take about one model. */
export type ModelActionKind =
  /** download the build the tag now points at. */
  | "pull"
  /** make it the active model for this session. */
  | "use"
  /** remove it from disk. Destructive, and the only one that needs a confirmation. */
  | "remove";

export interface ModelAction {
  kind: ModelActionKind;
  model: string;
  /** the exact command a user could run themselves, so nothing here is a black box. */
  equivalent: string;
  /**
   * The authorisation rung this action needs, on the 0–7 ladder.
   *
   * From `agent/authorization.ts`'s ordering — read < write < config < command < install <
   * destructive. A pull is an INSTALL (network + many GB written), a removal is DESTRUCTIVE,
   * and switching the active model is config.
   */
  minAuthLevel: number;
  /** bytes this will download, when known. */
  downloadBytes?: number;
  /** bytes this will free, when the saving is real — see `honestReclaim`. */
  freesBytes?: number;
  /** why the action is unavailable. When set, the action must not be offered. */
  blocked?: string;
}

/** The ladder rungs these actions sit on. Named, not spelled inline at each call site. */
export const AUTH_CONFIG = 3;
export const AUTH_INSTALL = 5;
export const AUTH_DESTRUCTIVE = 6;

/** The actions that follow from one checked model. */
export function actionsFor(
  check: ModelCheck,
  opts: { active?: string; freeDiskBytes?: number } = {},
): ModelAction[] {
  if (!check.ok) return [];
  const u = check.update;
  const out: ModelAction[] = [];

  if (u.changed) {
    const blocked = pullBlockedReason(u, opts.freeDiskBytes);
    out.push({
      kind: "pull",
      model: u.model,
      equivalent: `ollama pull ${u.model}`,
      minAuthLevel: AUTH_INSTALL,
      downloadBytes: u.remoteBytes,
      ...(blocked ? { blocked } : {}),
    });
  }
  if (opts.active !== u.model) {
    out.push({
      kind: "use",
      model: u.model,
      equivalent: `/models use ${u.model}`,
      minAuthLevel: AUTH_CONFIG,
    });
  }
  return out;
}

/**
 * Why a pull must not be offered, or "" when it may be.
 *
 * Both reasons are things the user would otherwise discover only after spending the bandwidth:
 * a build that needs a newer daemon pulls happily and then fails to load — having already
 * replaced a model that worked — and a build whose peak exceeds free disk fills the volume
 * mid-write.
 */
export function pullBlockedReason(u: ModelUpdate, freeDiskBytes?: number): string {
  if (!u.satisfiable && u.requiresOllama) {
    return `needs ollama ${u.requiresOllama}; upgrade the daemon first`;
  }
  if (typeof freeDiskBytes === "number" && freeDiskBytes > 0 && u.peakDiskBytes > freeDiskBytes) {
    return "not enough free disk for both builds at once";
  }
  return "";
}

/* ───────────────────────────── the deletion rule ───────────────────────────── */

export interface ReclaimInput {
  /** the tag being removed. */
  victim: string;
  /** its layer digests + sizes, read from the ON-DISK manifest — no API exposes them. */
  victimLayers: readonly { digest: string; size: number }[];
  /** every OTHER manifest that will remain on disk, same source. */
  survivorLayers: readonly (readonly { digest: string; size: number }[])[];
  /** tags currently loaded into memory, from `GET /api/ps`. */
  loaded: readonly string[];
}

export type ReclaimVerdict =
  | { honest: true; bytes: number }
  | { honest: false; reason: string; bytes: 0 };

/**
 * May PROMETHEUS offer to delete this model to free space, and how much would it actually free?
 *
 * Five conditions, every one of which has a way of being quietly wrong:
 *
 *  1. **The model must not be loaded.** Deleting a resident model is a different operation from
 *     the one the user agreed to, and `GET /api/ps` is the only thing that knows.
 *  2. **The victim's layers must have been READ, not assumed.** Local layer digests appear in
 *     neither `/api/tags` nor `/api/show` — measured — so an implementation that "computes" this
 *     from an API response is computing it from nothing.
 *  3. **Every survivor must be counted.** Subtracting one other manifest when three remain
 *     over-reports, which promises disk the user will not get back.
 *  4. **A layer with no digest is not counted.** It cannot be proven unshared.
 *  5. **The number must be non-zero.** Two tags of a family often share nearly everything;
 *     "free up 0 bytes" is not an offer, it is a chore.
 *
 * NOT on this list, deliberately: same-tag updates. Those never reach here, because ollama
 * releases the superseded layers itself on pull — see `reclaimableAfterUpdate`'s header for the
 * measurement, and for the false claim this replaced.
 */
export function honestReclaim(input: ReclaimInput): ReclaimVerdict {
  if (input.loaded.includes(input.victim)) {
    return { honest: false, reason: `${input.victim} is loaded right now`, bytes: 0 };
  }
  if (input.victimLayers.length === 0) {
    return {
      honest: false,
      reason: "its layers could not be read from disk, so the saving cannot be computed",
      bytes: 0,
    };
  }
  const kept = new Set<string>();
  for (const s of input.survivorLayers) for (const l of s) if (l.digest !== "") kept.add(l.digest);
  const bytes = input.victimLayers
    .filter((l) => l.digest !== "" && !kept.has(l.digest))
    .reduce((n, l) => n + l.size, 0);
  if (bytes <= 0) {
    return {
      honest: false,
      reason: "every layer is shared with a model you are keeping — removing it frees nothing",
      bytes: 0,
    };
  }
  return { honest: true, bytes };
}

/** The removal action, offered only when the saving survives `honestReclaim`. */
export function removalAction(input: ReclaimInput): ModelAction {
  const verdict = honestReclaim(input);
  return {
    kind: "remove",
    model: input.victim,
    equivalent: `ollama rm ${input.victim}`,
    minAuthLevel: AUTH_DESTRUCTIVE,
    ...(verdict.honest ? { freesBytes: verdict.bytes } : { blocked: verdict.reason }),
  };
}
