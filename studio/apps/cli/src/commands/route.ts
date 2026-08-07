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
  // text surface: the spec's one-line summary; json surface: the raw verdict /
  // engine envelope (machine channel). A non-ok routed command exits 2 (C5).
  const payload = {
    ...((res.verdict ?? res.envelope ?? {}) as Record<string, unknown>),
    ok: res.ok,
  };
  return {
    text: res.summary,
    json: payload,
    exitCode: res.ok ? 0 : 2,
  };
}
