/**
 * agent/protocol/contributors/pre-write-recheck.ts — the "flight-check" contributor.
 *
 * Diagnosed gap: nothing in the live preamble ever told the model to verify a file's FULL
 * intended correctness before calling `write_file`/`propose_edit`. Observed failure mode: a
 * local qwen3.6-class session wrote a rough version of a file, then spent many follow-up
 * rounds re-correcting it piecemeal — each round its own model call, its own tool round-trip,
 * its own chance to introduce a NEW small mistake while patching the last one.
 *
 * Deliberately a short, NUMBERED CHECKLIST rather than a paragraph of prose: a small local
 * model follows an enumerated procedure far more reliably than it extracts the same intent
 * from a longer sentence — and this contributor exists precisely because a model already
 * showed it loses the thread over many rounds, so asking it to hold MORE nuance in one breath
 * is the wrong fix. It does not vary by effort TIER: the failure was a workflow-discipline gap,
 * not a comprehension gap, so a "high effort" model gets the same fixed checklist as a "low
 * effort" one. It DOES vary by locality/small-model signal — see `FLIGHT_CHECK_LOCAL_SUFFIX`.
 *
 * Read-only sub-agent roles (explore/scout/plan) never call a write tool at all, so this does
 * not fire for them — same `!ctx.readOnly` gate as `tool-discipline`'s read-only variant.
 */
import type { PreambleContributor, PreambleCtx, PreambleUnit } from "../preamble-dispatch.js";

export const FLIGHT_CHECK_TEXT =
  "Before calling write_file or propose_edit, silently run this checklist: " +
  "(1) Do I have the COMPLETE intended content, not just the next line or two? " +
  "(2) Does it match every import, type, and call site it touches? " +
  "(3) Am I editing the file's ACTUAL current content (re-read it if unsure), not my memory of it? " +
  "(4) Is this the SMALLEST correct change, or am I rewriting more than needed? " +
  "Write it once, fully correct — do not ship a rough version and fix it piecemeal over several follow-up turns.";

/**
 * Appended only in a local/small-model context. The failure this contributor exists for was
 * observed on a local model guessing at content instead of re-reading it — a strong hosted
 * model rarely needs telling twice; a small one benefits from the explicit PERMISSION to slow
 * down and check rather than press ahead confidently wrong.
 *
 * This is the one place effort/locality DOES vary this contributor's text — not the checklist
 * itself (kept identical everywhere), only this one extra sentence.
 */
export const FLIGHT_CHECK_LOCAL_SUFFIX =
  " If you are not fully sure of the file's current content, call read_file first — do not guess.";

export function flightCheckText(ctx: Pick<PreambleCtx, "locality" | "effortTier">): string {
  const smallModelSignal =
    ctx.locality === "local" || ctx.effortTier === "off" || ctx.effortTier === "low";
  return smallModelSignal ? `${FLIGHT_CHECK_TEXT}${FLIGHT_CHECK_LOCAL_SUFFIX}` : FLIGHT_CHECK_TEXT;
}

export const preWriteRecheckContributor: PreambleContributor = {
  id: "pre-write-recheck",
  priority: 20,
  applies: (ctx: PreambleCtx): boolean => !ctx.readOnly,
  render: (ctx: PreambleCtx): PreambleUnit => ({
    text: flightCheckText(ctx),
    mergeTarget: "persona",
  }),
};
