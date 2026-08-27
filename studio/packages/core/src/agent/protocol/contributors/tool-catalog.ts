/**
 * agent/protocol/contributors/tool-catalog.ts — the existing tool catalog, as a contributor.
 *
 * Wraps `renderToolPreamble` (`protocol/preamble.ts`) UNCHANGED — its ladder is already tuned
 * and tested. This file only gives it a `PreambleContributor` face so it sits in the SAME
 * priority-ordered, shared-budget pipeline as every other contributor instead of owning an
 * isolated 8%-of-context-window budget with no idea steering/memory/repo-map/tool-discipline
 * also exist.
 *
 * `preambleBudget(contextWindow)` — the catalog's own historically-tuned ceiling — is still
 * respected: this contributor's ceiling is `min(sharedBudgetRemaining,
 * preambleBudget(contextWindow))`, so a bigger OUTER pool (`instructionBudget`, see
 * `preamble-dispatch.ts`) never balloons the tool listing past the size it was tuned for; it
 * only ever gets LESS than that, when something higher-priority already spent the shared pool.
 *
 * ROUND-SCOPE: `ctx.transport` is only known once transport negotiation has run for THIS
 * round (`protocol/negotiate.ts`), so — unlike every other built-in contributor — this one is
 * assembled from inside `LLMClient.turn()`, once per round, not once per turn. See the CLI/
 * Desktop wiring diffs.
 */
import { preambleModeFor } from "../negotiate.js";
import type { PreambleContributor, PreambleCtx, PreambleUnit } from "../preamble-dispatch.js";
import { preambleBudget, renderToolPreamble } from "../preamble.js";

export const toolCatalogContributor: PreambleContributor = {
  id: "tool-catalog",
  // Last among the "persona" contributors: the single biggest consumer, and the only one with
  // its own internal degrade ladder — it should get whatever the small, fixed-cost, safety
  // contributors above it did NOT need, not the other way around.
  priority: 70,
  applies: (ctx: PreambleCtx): boolean =>
    ctx.tools.length > 0 && ctx.transport !== undefined && ctx.transport !== "none",
  render: (ctx: PreambleCtx, budgetTokens: number): PreambleUnit | null => {
    if (ctx.transport === undefined || ctx.transport === "none") return null;
    const ceiling = Math.min(budgetTokens, preambleBudget(ctx.contextWindow));
    const rendered = renderToolPreamble(ctx.tools, {
      mode: preambleModeFor(ctx.transport),
      maxTokens: ceiling,
      ...(ctx.charsPerToken ? { charsPerToken: ctx.charsPerToken } : {}),
      ...(ctx.demonstratedToolSyntax ? { demonstrated: true } : {}),
    });
    return {
      text: rendered.text,
      mergeTarget: "persona",
      ...(rendered.omitted.length > 0
        ? { degraded: { detail: rendered.detail, omitted: rendered.omitted } }
        : {}),
    };
  },
};
