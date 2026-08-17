/**
 * agent/repeat-guard.ts — stop a model that calls the SAME tool with the SAME arguments.
 *
 * The §3.4 permission engine already had a doom-loop guard (`doomLoopRunLength`), and it was
 * dead twice over. No host ever populated `PermissionContext.callHistory`, so the run length
 * was always zero; and its branch required `base.decision === "allow"`, which its only live
 * caller — `withRememberedGrants`, base default `"ask"`, with `baseRules` always empty because
 * `ctx.permissionRules` has no producer — cannot produce without a pre-existing grant. So the
 * guard was structurally unreachable in exactly the situation a doom loop occurs in: a fresh
 * session with no grants.
 *
 * It was also in the wrong PLACE, which is the part that matters. It sat under the broker's
 * `confirm` path, and the loop that actually happens is `read_file` on the same path forever —
 * a read-only tool the broker AUTO-approves, which never reaches a confirm at all. Driving the
 * real `runAgentTurn` with a model that emits `read_file{path:"a.txt"}` every round produced
 * thirty-two round-trips, zero guard events, and a turn that ended by inviting the human to
 * `/continue` the same loop.
 *
 * And it keyed on the tool NAME alone, so it could not express "the same call" at all: it
 * would have fired on three reads of three different files while missing a thousand reads of
 * one.
 *
 * So this guard lives ABOVE the broker, keys on the call's ARGUMENTS, and defaults ON. An
 * optional field that silently defaults to off is the defect this repo keeps shipping, not a
 * feature.
 *
 * PURE: no imports, no IO, no clock.
 */

/** Consecutive identical calls before one is refused. Calls 1–2 run, 3 is refused, 4 aborts. */
export const DEFAULT_REPEAT_LIMIT = 3;

/** Deterministic JSON — key order must not make one call look like two. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

/** The identity of a call: its name plus its canonical arguments. */
export function callFingerprint(call: { name: string; args?: Record<string, unknown> }): string {
  return `${call.name} ${stableStringify(call.args ?? {})}`;
}

export type RepeatVerdict = "ok" | "stop" | "abort";

/**
 * Consecutive-identical-call counter for ONE turn.
 *
 * Construct it ONCE, outside the round loop: a per-round counter cannot see a model that
 * repeats across rounds, which is the only way a doom loop actually happens.
 */
export class RepeatGuard {
  private readonly limit: number;
  private last = "";
  private run = 0;

  constructor(limit: number = DEFAULT_REPEAT_LIMIT) {
    this.limit = limit;
  }

  /**
   * Record a call and say what to do with it.
   *
   *   "ok"    — run it;
   *   "stop"  — the `limit`-th consecutive identical call: refuse it, and tell the MODEL why,
   *             because a refusal it cannot read is one it will simply repeat;
   *   "abort" — it repeated again after being refused. It is not listening; end the turn.
   */
  observe(call: { name: string; args?: Record<string, unknown> }): RepeatVerdict {
    if (this.limit <= 0) return "ok"; // explicit opt-out
    const fp = callFingerprint(call);
    if (fp === this.last) {
      this.run += 1;
    } else {
      this.last = fp;
      this.run = 1;
    }
    if (this.run < this.limit) return "ok";
    return this.run === this.limit ? "stop" : "abort";
  }
}

/** What the model is told when a repeated call is refused. Actionable, not scolding. */
export function repeatRefusal(call: { name: string }, limit: number): string {
  return [
    `${call.name} has now been called ${limit} times in a row with identical arguments and was`,
    "refused. Repeating it will not produce a different result. Either use what the earlier",
    "call already returned, call it with DIFFERENT arguments, or stop and explain what you",
    "are missing.",
  ].join(" ");
}
