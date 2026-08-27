/**
 * agent/idle-watchdog.ts — inactivity-based pausing for a long-running model request/turn.
 *
 * Replaces the flat, hardcoded 180s "abort and discard the turn" timeout that was duplicated
 * three ways (apps/cli/src/session/agent-runtime.ts, apps/desktop/src/renderer/ide/ai/
 * ai-client.ts, apps/desktop/src/main/ai-ipc.ts) with ONE shared primitive both CLI and Desktop
 * import: an activity clock that PAUSES (never discards) a turn after a bounded stretch of TRUE
 * inactivity — no bytes, no tokens, no retry response, nothing — rather than a fixed ceiling on
 * total time. A cold local-model load, or a queue wait behind another request, is normal and
 * must never be confused with a hung wrapper; the old HARD_TIMEOUT_MS conflated the two.
 *
 * PURE: no Node/Electron APIs, only `Date.now`/`setTimeout` (both exist in the browser sandbox
 * too), so this is safe for the renderer's C5 boundary exactly like `@prometheus/core/ai-effort`
 * already is.
 *
 * Event-driven by construction: `IdleWatchdog` holds exactly ONE re-armed `setTimeout`, never a
 * polling loop, and `raceTicks` holds exactly one `setTimeout` per iteration, raced against the
 * SAME pending promise it was given (never re-issued) — matching the pattern this repo already
 * used correctly for the post-connect stream-reading loop, just factored out so it isn't
 * hand-rolled a fourth and fifth time.
 */

/** Default: PAUSE (not abort-and-discard) a model turn after this much continuous silence.
 *  Single source of truth for CLI + Desktop — was a duplicated flat 180_000 literal. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/** Floor/ceiling for a user-supplied override (`/timeout`, or the desktop settings field) so a
 *  fat-fingered value can't produce an effectively-zero or effectively-infinite pause window. */
export const MIN_IDLE_TIMEOUT_MS = 30_000; // 30s
export const MAX_IDLE_TIMEOUT_MS = 60 * 60_000; // 60 min

/**
 * The auto-compaction summarizer call is a BACKGROUND helper the user's real turn is waiting
 * behind, not the user's own work — so it gets its own, much shorter default rather than
 * reusing the main turn's (possibly 10-minute) idle window. Not currently user-configurable
 * (no /setup surface) — see agent-runtime.ts's `makeSummarizer`.
 */
export const DEFAULT_COMPACT_IDLE_TIMEOUT_MS = 60_000; // 1 minute

/** Progress-tick cadence, unchanged from the CLI/desktop values this replaces. */
export const WATCHDOG_FIRST_TICK_MS = 8_000; // before the first byte/response
export const WATCHDOG_STREAM_TICK_MS = 15_000; // once the model is producing output

/** Clamp a user-supplied idle-timeout override into `[MIN_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS]`;
 *  `undefined`/non-finite ⇒ `DEFAULT_IDLE_TIMEOUT_MS`. */
export function clampIdleTimeoutMs(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(MIN_IDLE_TIMEOUT_MS, Math.round(ms)));
}

export interface IdleWatchdogOptions {
  /** ms of continuous inactivity before `onIdle` fires. Clamped via `clampIdleTimeoutMs`. */
  idleTimeoutMs?: number;
  /** Fires ONCE, the moment the idle window elapses with no `touch()`. The caller's job here
   *  is narrow and mechanical: abort ITS OWN transport (fetch/reader) so local resources are
   *  freed — the watchdog itself holds no socket, no reader, nothing to release beyond its
   *  own timer (see `dispose`). */
  onIdle: () => void;
  /** injectable clock (tests). */
  now?: () => number;
  /** injectable timer functions (tests) — lets a test drive a fake clock's `advance()` and
   *  have THIS class's real re-armed timer fire deterministically, instead of waiting out a
   *  real 10-minute default in wall-clock time. Both default to the real globals. */
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Tracks TRUE inactivity for one in-flight model request/turn. `touch()` — call it on every
 * byte/token/keepalive/retry-response, ANY positive evidence the request is alive — resets the
 * idle countdown. Nothing before the first `touch()` counts as activity either: the clock starts
 * ticking from `arm()` (i.e. from "the request was sent"), which is what makes the pre-first-byte
 * phase (a cold model load, a queue wait) subject to the SAME idle budget as the rest of the
 * turn, with no special-casing needed.
 */
export class IdleWatchdog {
  private readonly idleTimeoutMs: number;
  private readonly nowFn: () => number;
  private readonly onIdleCb: () => void;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private lastActivityAt: number;
  private fired = false;
  private disposed = false;

  constructor(opts: IdleWatchdogOptions) {
    this.idleTimeoutMs = clampIdleTimeoutMs(opts.idleTimeoutMs);
    this.nowFn = opts.now ?? Date.now;
    this.onIdleCb = opts.onIdle;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.lastActivityAt = this.nowFn();
  }

  /** Start the idle countdown. Call once, right after the request is sent. */
  arm(): void {
    this.reschedule();
  }

  /** ANY positive evidence the request is alive. Resets the idle countdown from now. */
  touch(): void {
    if (this.disposed || this.fired) return;
    this.lastActivityAt = this.nowFn();
    this.reschedule();
  }

  /** ms since the last `touch()` (or since construction, if never touched) — for a status
   *  line's "(idle Ns)" suffix, and for the `paused` event's `idleMs`. */
  idleForMs(): number {
    return this.nowFn() - this.lastActivityAt;
  }

  /** Did THIS watchdog fire the idle abort (as opposed to e.g. the user's own Ctrl-C, which
   *  aborts the same underlying controller through a different path)? */
  didFire(): boolean {
    return this.fired;
  }

  /** Tear down the timer. MUST run in the caller's `finally` — an uncleared timer keeps the
   *  process (and node:test) alive, exactly like the `hardTimer` it replaces. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = undefined;
  }

  private reschedule(): void {
    if (this.timer) this.clearTimeoutFn(this.timer);
    if (this.disposed || this.fired) return;
    this.timer = this.setTimeoutFn(() => {
      this.fired = true;
      this.onIdleCb();
    }, this.idleTimeoutMs);
  }
}

/**
 * Await `pending`, YIELDING a progress note every `tickMs` while it is still pending — never a
 * busy loop (one `setTimeout` per iteration, raced against the SAME `pending` promise, which is
 * never re-created or re-issued). Returns (as the generator's return value) whatever `pending`
 * resolves to; rejects exactly as `pending` would (the rejection surfaces through the `next()`
 * promise, so a caller awaiting `.next()` inside a try/catch sees it exactly as if it had awaited
 * `pending` directly).
 *
 * Deliberately an ASYNC GENERATOR, not a plain async function returning a value: a plain function
 * cannot `yield`, and every caller here needs to surface each tick LIVE (as it happens) rather
 * than batched after the wait completes — a cold-model-load status line that only appears once
 * the wait is already over is useless. Consumed via manual `.next()` (not `yield*`) because each
 * caller wraps a tick into its OWN event shape:
 *
 *     const ticker = raceTicks(pending, tickMs, () => `…`);
 *     let step = await ticker.next();
 *     while (!step.done) {
 *       yield { kind: "status", text: step.value };   // or: emit({ kind: "status", text: … })
 *       step = await ticker.next();
 *     }
 *     const result = step.value; // the resolved `pending`
 */
export async function* raceTicks<T>(
  pending: Promise<T>,
  tickMs: number,
  note: () => string,
): AsyncGenerator<string, T, void> {
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<"TICK">((resolve) => {
      timer = setTimeout(() => resolve("TICK"), tickMs);
    });
    // `finally`, not a bare post-await `clearTimeout`: `pending` REJECTING (the idle watchdog
    // firing and aborting the fetch/read this is racing — the primary scenario this whole
    // module exists for) would otherwise skip straight past the clear, leaking one live timer
    // per pause for up to `tickMs`. `dispose()`'s own doc comment on `IdleWatchdog` stresses
    // exactly this invariant; this loop has to honor it on the throw path too.
    let raced: T | "TICK";
    try {
      raced = await Promise.race([pending, tick]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (raced === "TICK") {
      yield note();
      continue;
    }
    return raced as T;
  }
}

/* ── (D) the orphaned-generation guard ──────────────────────────────────────────────────────
 *
 * Closing OUR side of the connection (abort the fetch, cancel the reader) does not necessarily
 * cancel the generation on the model server's side. See the design's confidence note: this is
 * NOT verified against a real Ollama instance from static analysis alone. Most local installs
 * run with num_parallel=1 (no concurrent generations), so a second request against the SAME
 * endpoint shortly after a pause can simply queue up BEHIND a generation Ollama may still be
 * running — hitting the same wall again. This guard is advisory only: it tracks the possibility
 * and lets a caller warn the user, rather than silently re-presenting the same "it's taking
 * forever" experience with no explanation. It does NOT block or delay the new request — actually
 * delaying a resume would only be justified if we were confident the delay improves anything;
 * without confirmation that the grace period corresponds to a real server-side effect, adding a
 * mandatory wait risks pure regression (making every resume slower for a benefit that may not
 * exist).
 */

export const DEFAULT_ORPHAN_GRACE_MS = 20_000;

const possibleOrphans = new Map<string, { pausedAt: number }>();

/** Record that `endpointId` was just paused (idle) — its previous generation may still be
 *  running/queued server-side. */
export function markPossibleOrphan(endpointId: string, now: () => number = Date.now): void {
  possibleOrphans.set(endpointId, { pausedAt: now() });
}

/** Positive confirmation the endpoint is responsive again (e.g. a NEW request to it just got its
 *  first byte) — clears the guard early rather than waiting out the full grace period. */
export function clearPossibleOrphan(endpointId: string): void {
  possibleOrphans.delete(endpointId);
}

/** ms remaining in the grace period for `endpointId`, or 0 if nothing is tracked / it has
 *  elapsed (which also clears the entry — a caller need not call `clearPossibleOrphan` itself
 *  just because the grace period ran out). */
export function orphanGraceRemainingMs(
  endpointId: string,
  graceMs: number = DEFAULT_ORPHAN_GRACE_MS,
  now: () => number = Date.now,
): number {
  const entry = possibleOrphans.get(endpointId);
  if (!entry) return 0;
  const remaining = graceMs - (now() - entry.pausedAt);
  if (remaining <= 0) {
    possibleOrphans.delete(endpointId);
    return 0;
  }
  return remaining;
}
