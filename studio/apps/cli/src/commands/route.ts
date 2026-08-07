/**
 * route.ts — route a prometheus command through the CANONICAL parity registry
 * (@prometheus/core COMMAND_SPECS / invoke).
 *
 * This is what makes "anything you can do in the GUI you can do in prometheus"
 * STRUCTURAL: the CLI maps its verb to a CommandSpec id and invokes the SAME
 * run() the GUI palette uses, over the SAME EngineClient (C5 — the one gateway).
 * Verbs with a richer hand-written renderer (scan/gate/list/info/env/model/
 * provider) are still handled in index.ts; everything else routes through here,
 * so new engine surfaces (describe/tutorial/methods/harden/chat/apps/worldsim/
 * localai/vault/pentest/install/…) reach full parity with zero per-verb glue.
 */
// NOTE: the canonical PARITY router is exported from @prometheus/core under the
// `*Spec` aliases (getCommandSpec / invoke / RawArgs) so it coexists with the M1
// `commands/registry.ts` (plain getCommand = 6 hand-tuned summaries). We want the
// FULL-surface registry here, hence getCommandSpec — NOT getCommand.
import { type RawArgs, getCommandSpec, invoke } from "@prometheus/core";

import type { CliContext, CommandOutcome } from "../context.js";
import { renderEnvelope } from "../render/envelope-view.js";
import { renderVerdictCard } from "../verdict-view.js";

/**
 * Resolve a parsed command path to a CommandSpec id (or undefined).
 *
 * ONLY single-token verbs route through the registry (e.g. `describe`, `harden`,
 * `chat`, `install`, `apps`). Multi-word nouns (`repo add`, `model pull`,
 * `plugin install`, `secure audit`) keep the existing §2 tree mapping in index.ts
 * / generic.ts — which already knows their engine subcommand + the not-yet-wired
 * (sidecar-owned) cases — so registry routing never hijacks them.
 */
export function specIdFor(path: readonly string[]): string | undefined {
  if (path.length !== 1) return undefined;
  const head = path[0];
  if (!head) return undefined;
  return getCommandSpec(head) ? head : undefined;
}

/** Build the registry's RawArgs from the parsed CLI args (+ lifted globals). */
function toRawArgs(ctx: CliContext): RawArgs {
  const flags: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(ctx.args.flags)) flags[k] = v;
  // parse.ts hoists the engine globals OFF `flags` into typed fields — lift them
  // back so specs that declare them (install --dry-run/--force) still receive them.
  if (ctx.args.dryRun) flags["dry-run"] = true;
  if (ctx.args.yes) flags.yes = true;
  if (ctx.args.strict) flags.strict = true;
  if (ctx.args.force) flags.force = true;
  return { positionals: ctx.args.positionals, flags };
}

/** Route through the registry and render the RouterResult to a CommandOutcome. */
export async function routeViaRegistry(id: string, ctx: CliContext): Promise<CommandOutcome> {
  const res = await invoke(id, { client: ctx.client }, toRawArgs(ctx));
  // json surface: the raw verdict / engine envelope (machine channel), unchanged.
  const payload = {
    ...((res.verdict ?? res.envelope ?? {}) as Record<string, unknown>),
    ok: res.ok,
  };
  // TEXT surface: the ENVELOPE, rendered. `res.summary` is a one-line toast ("<id>: ok") —
  // correct as a summary, wrong as the only thing a human sees, which is why `superscan`,
  // `matrix`, `inventory`, `vault`, `where` and `describe` printed one word while their
  // payload (and, for `audit`, a live nemesis verdict) was thrown away. The summary stays
  // as the fallback for an envelope with no renderable body, so nothing is ever invented.
  const text = ctx.json
    ? res.summary // --json never prints text; don't pay for the render (or the ANSI)
    : ((res.verdict ? renderVerdictCard(res.verdict) : null) ??
      (res.envelope ? renderEnvelope(id, res.envelope) : null) ??
      res.summary);
  return {
    text,
    json: payload,
    exitCode: res.ok ? 0 : 2,
  };
}
