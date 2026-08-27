/**
 * agent/protocol/contributors/tool-discipline.ts — "call the tool, don't just describe it."
 *
 * Promotes `agent/loop.ts`'s `AGENT_TOOL_DISCIPLINE` into a `PreambleContributor`. That text
 * existed, was correct, and reached the model on exactly two paths: a unit test, and Desktop's
 * hand-assembled `AGENT_PANE_SYSTEM`. The real CLI session (`cliProfiles.resolveTuning`) never
 * calls `defaultTuning()`, so it was dead for the surface most people actually run. Registering
 * it here is what makes it universal: every host that runs the pipeline gets it, including
 * every `spawn_agent` role (which, before this, got NONE of it — see `subagent.ts`'s diff).
 *
 * `agent/loop.ts` keeps exporting the original `AGENT_TOOL_DISCIPLINE` string UNCHANGED, for
 * the existing importers that compose their own persona text with it inline. This file re-uses
 * that same constant rather than forking the wording.
 */
import { AGENT_TOOL_DISCIPLINE } from "../../loop.js";
import type { PreambleContributor, PreambleCtx, PreambleUnit } from "../preamble-dispatch.js";

/**
 * The read-only-safe variant: drops the write/edit-tool-specific sentences (smallest hunks,
 * "printing does nothing on disk", "don't rewrite a whole file") because a read-only sub-agent
 * (explore/scout/plan) has no write tool at all — telling it those rules would imply it does.
 */
export const READ_ONLY_TOOL_DISCIPLINE =
  "To DO anything you MUST call the matching tool — describing an action in prose does not " +
  "perform it. Prefer reading the relevant files before answering; when you have enough " +
  "information, answer directly without calling a tool.";

export function toolDisciplineText(ctx: Pick<PreambleCtx, "readOnly">): string {
  return ctx.readOnly ? READ_ONLY_TOOL_DISCIPLINE : AGENT_TOOL_DISCIPLINE;
}

export const toolDisciplineContributor: PreambleContributor = {
  id: "tool-discipline",
  // Lowest priority number = claims the shared budget FIRST. One sentence (~45 tokens): it
  // must never be what gets squeezed out when a large AGENTS.md is competing for the pool.
  priority: 10,
  applies: (): boolean => true,
  render: (ctx: PreambleCtx): PreambleUnit => ({
    text: toolDisciplineText(ctx),
    mergeTarget: "persona",
  }),
};
