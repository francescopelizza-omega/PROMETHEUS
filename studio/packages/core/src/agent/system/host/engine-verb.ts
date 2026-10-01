// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/system/host/engine-verb.ts — running a `prometheus_*` verb, in ONE place.
 *
 * The 14 engine verbs are the product's own surface: scan a machine, list what is installed,
 * install or remove an integration. The CLI agent could call all 14; the desktop pane could
 * call none of them, because the pane had no seam to the engine and its allow-list said so in
 * a comment. So the GUI — the surface most people use — could not do the thing the product is
 * FOR, and a user had to drop to a terminal to ask the agent to install anything.
 *
 * WHY A SHARED MODULE RATHER THAN A SECOND DISPATCHER IN MAIN. The CLI's version of this is
 * four lines, and copying four lines is exactly how `run_command` came to mean two different
 * things. Two of those lines are the ones that matter:
 *
 *  - **the verdict**. `forced_danger` on the envelope means nemesis said BLOCK and the engine
 *    proceeded anyway; the loop aborts on it (`loop.ts`). A host that forgets to lift the
 *    verdict off the envelope does not fail loudly — the gate simply stops firing, which is
 *    the worst possible failure for a security control.
 *  - **the argv**. It comes from the tool's OWN `toArgv`, never re-derived, and the ToolDef is
 *    looked up HERE by name rather than accepted from the caller — a renderer that could pass
 *    its own `toArgv` could pass any argv at all.
 *
 * ARGS ARE VALIDATED FIRST, which the CLI did not do. `makeToolRunner` called `toArgv(args)`
 * directly, so a schema default never applied — and `prometheus_install`'s default is
 * `dryRun: true`. An agent that called `prometheus_install {name}` therefore ran a REAL
 * install where the schema promised a dry run. Validating here fixes that for both hosts.
 *
 * NODE-ONLY only by association: the injected runner spawns python. The logic is pure.
 */
import { getTool, validateArgs } from "../../../mcp/server/index.js";
import type { ToolOutcome } from "../../loop.js";
import { type ToolDef, isEngineVerb } from "../../tools.js";

/** The one gateway: `EngineClient.runPrometheus`, injected so tests never spawn python. */
export type RunPrometheus = (argv: string[]) => Promise<Record<string, unknown>>;

/**
 * Coerce an engine envelope's verdict tier into the loop's shape.
 *
 * `forced_danger` wins: it means the gate said block/error and the run was forced through, so
 * the tier it carries is the honest one. Only then does the envelope's own `verdict` apply.
 */
export function verdictFromEnvelope(env: Record<string, unknown>): ToolOutcome["verdict"] {
  const forced = env.forced_danger;
  if (Array.isArray(forced) && forced.length > 0) {
    const first = forced[0] as { verdict?: string; risk_score?: number };
    const tier = first.verdict === "error" ? "error" : "block";
    return typeof first.risk_score === "number"
      ? { verdict: tier, riskScore: first.risk_score }
      : { verdict: tier };
  }
  const verdict = env.verdict;
  if (verdict && typeof verdict === "object") {
    const v = verdict as { verdict?: string; risk_score?: number };
    if (v.verdict === "allow" || v.verdict === "warn" || v.verdict === "block") {
      return typeof v.risk_score === "number"
        ? { verdict: v.verdict, riskScore: v.risk_score }
        : { verdict: v.verdict };
    }
    if (v.verdict === "error") {
      return typeof v.risk_score === "number"
        ? { verdict: "error", riskScore: v.risk_score }
        : { verdict: "error" };
    }
  }
  return undefined;
}

/** A short human one-liner for an engine envelope. */
export function summarizeEnvelope(name: string, env: Record<string, unknown>): string {
  if (typeof env.error === "string" && env.error) return env.error;
  const command = typeof env.command === "string" ? env.command : name;
  return env.ok === false ? `${command}: failed` : `${command}: ok`;
}

/**
 * Run one `prometheus_*` verb, or return null when the name is not one.
 *
 * Null rather than a throw so a caller's dispatch chain can simply fall through, matching
 * `runSystemTool` / `runWebTool` / `runFsMutateTool`.
 *
 * `opts.tool` is the difference between the two hosts, and it is a TRUST boundary rather than
 * a convenience. The CLI already holds the ToolDef — the loop handed it one — so it passes it
 * and keeps its old behaviour of treating the engine as the terminal arm, including for a
 * host-declared tool that is not in the shipped catalogue. Main holds only a NAME that arrived
 * over IPC from a sandboxed renderer, so it passes none and the lookup happens here: a caller
 * that could supply its own `toArgv` could choose the argv outright, which is the whole
 * command line.
 */
export function runEngineVerb(
  name: string,
  args: Record<string, unknown>,
  run: RunPrometheus,
  opts: { tool?: ToolDef } = {},
): Promise<ToolOutcome> | null {
  const tool = opts.tool ?? getTool(name);
  if (!tool) {
    // A catalogued name that failed to resolve is a real error; anything else is simply not
    // an engine verb, and the caller's next arm should get a chance at it.
    return isEngineVerb(name)
      ? Promise.resolve({ ok: false, summary: `unknown engine verb "${name}"` })
      : null;
  }
  const v = validateArgs(tool.schema, args);
  if (!v.ok) {
    return Promise.resolve({ ok: false, summary: `${name}: ${v.errors.join("; ")}` });
  }
  return (async () => {
    let env: Record<string, unknown>;
    try {
      env = await run(tool.toArgv(v.value));
    } catch (err) {
      // Fail-closed: a wedged or missing engine is a refusal, never a fabricated success.
      return {
        ok: false,
        summary: `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const verdict = verdictFromEnvelope(env);
    return {
      ok: env.ok !== false,
      summary: summarizeEnvelope(name, env),
      data: env,
      ...(verdict ? { verdict } : {}),
    };
  })();
}
