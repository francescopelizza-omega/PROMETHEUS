/**
 * agent/protocol/contributors/host-tools.ts — "these external tools exist on this machine".
 *
 * Priority 85 puts it after the repo map (80) and before token-economy (90): it is reference
 * data about the environment, the same class as the repo map, and like the repo map it should
 * be the thing that goes when a large AGENTS.md is competing for the pool — never the tool
 * discipline (10) or the tool catalog (70).
 *
 * `mergeTarget: "block"` — its own trailing system message, like steering/memory/repo-map.
 * Reference data does not belong in the persona.
 *
 * The text arrives PRE-RENDERED on `ctx.hostTools`. That is not indirection for its own sake:
 * `PreambleCtx` is documented pure ("no node, no IO, no randomness"), and the probe reads the
 * filesystem — so the host probes once, off this path, and hands the string in. It also makes
 * the field trivially serialisable, which is what lets the sandboxed desktop renderer receive
 * a manifest that only the main process could have computed.
 */
import type { PreambleContributor, PreambleCtx, PreambleUnit } from "../preamble-dispatch.js";

export const hostToolsContributor: PreambleContributor = {
  id: "host-tools",
  priority: 85,
  applies: (ctx: PreambleCtx): boolean => Boolean(ctx.hostTools?.trim()),
  render: (ctx: PreambleCtx, budgetTokens: number): PreambleUnit | null => {
    const text = ctx.hostTools?.trim();
    if (!text) return null;
    // No internal ladder: it is ~100 tokens of names. If it genuinely does not fit, being
    // dropped whole is the right outcome — a half-list would be worse than none, because the
    // model would read a truncated list as an exhaustive one.
    const approx = Math.ceil(text.length / (ctx.charsPerToken ?? 4));
    if (approx > budgetTokens) return null;
    return { text, mergeTarget: "block" };
  },
};
