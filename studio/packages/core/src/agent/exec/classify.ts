/**
 * agent/exec/classify.ts — how dangerous is this parsed command?
 *
 * Layer 2 of the five (full_wrapper_compose §6). The parser has already guaranteed we know
 * the exact argv of every stage; this decides the tier, using the SAME `AuthCategory`
 * vocabulary the A0–A7 ladder speaks, so no new permission concept is needed.
 *
 * Three rules, in order of how much they matter:
 *
 *  1. A FORBIDDEN program (`sudo`, `sh`, `dd`, `nc`…) refuses the whole command outright. Not
 *     a tier, not a prompt — a refusal, at every authorization level including A7. There is
 *     no level at which the agent may run a shell, because a shell is precisely the thing
 *     every layer above is trying to be.
 *  2. A DENIED FLAG refuses too, and the refusal names the escape. `git -c core.pager=sh` is
 *     not "git, which is read-only" — it is a shell wearing git's name.
 *  3. Otherwise the tier is the MAXIMUM over the stages. `cat file | rm -rf x` is destructive
 *     even though it starts with a read: a pipeline is as dangerous as its worst member.
 *
 * An UNKNOWN program is not an error. It classifies as `destructive`, so it always reaches a
 * human, and the reason says so. That is what lets the registry stay honest — it grows when
 * someone looks at a real command, not when someone guesses.
 *
 * PURE.
 */

import type { AuthCategory } from "../authorization.js";
import { authLevelMeta } from "../authorization.js";
import type { ParsedCommand, Stage } from "./parse.js";
import { allStages, formatCommand } from "./parse.js";
import { type ExecTier, basename, forbiddenReason, programSpec } from "./registry.js";

/** Ascending risk — the same order `CATEGORY_ORDER` uses in authorization.ts. */
const RANK: Readonly<Record<ExecTier, number>> = Object.freeze({
  read: 0,
  write: 1,
  config: 2,
  command: 3,
  install: 4,
  destructive: 5,
});

/** What one stage was classified as, and why — the confirm dialog shows these. */
export interface StageClass {
  program: string;
  tier: ExecTier;
  reason: string;
}

export type ClassifyResult =
  | { ok: true; tier: ExecTier; stages: StageClass[]; unknownPrograms: string[] }
  | { ok: false; error: string; program?: string };

/**
 * The first `max` POSITIONAL arguments — skipping options and their values.
 *
 * `--opt=value` is self-contained; `--opt value` and `-C value` consume the next token, which
 * is why the value-option table exists per program. Collecting up to two positionals (rather
 * than stopping at the first) is what lets a two-level CLI like `gh pr merge` be told apart
 * from `gh pr create` — `git`'s subcommands are flat (`git push`), but `gh`'s are noun+verb,
 * and the noun alone ("pr") does not say how dangerous the verb is.
 */
function findPositionals(
  rest: readonly string[],
  valueOptions: readonly string[],
  max: number,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length && out.length < max; i++) {
    const a = rest[i] as string;
    if (!a.startsWith("-")) {
      out.push(a);
      continue;
    }
    if (a.includes("=")) continue; // `--git-dir=/x` carries its own value
    if (valueOptions.includes(a)) i += 1; // skip the value it consumes
  }
  return out;
}

/** Classify ONE stage. */
function classifyStage(stage: Stage): StageClass | { error: string; program: string } {
  const program = basename(stage.argv[0] ?? "");
  if (!program) return { error: "empty stage", program: "" };

  const forbidden = forbiddenReason(program);
  if (forbidden) return { error: `\`${program}\` is not permitted: ${forbidden}`, program };

  const spec = programSpec(program);
  if (!spec) {
    return {
      program,
      tier: "destructive",
      reason: `\`${program}\` is not a known program — classified at the highest tier so a human decides`,
    };
  }

  const rest = stage.argv.slice(1);
  for (const flag of spec.denyFlags ?? []) {
    // Test the flag against every argument, and against the joined tail as well: an escape
    // like `awk 'BEGIN{system("x")}'` lives INSIDE one argument, not as a separate token.
    if (rest.some((a) => flag.re.test(a)) || flag.re.test(rest.join(" "))) {
      return { error: `refused: ${flag.why}`, program };
    }
  }

  // A subcommand tier when there is one; otherwise the program's own tier.
  //
  // Walked POSITIONALLY, skipping value-taking global options and their values. "The first
  // token that is not a flag" found the VALUE of a separated option instead — `git -C . reset
  // --hard` read as subcommand `.`, and `git -C status reset --hard` read as `status`, which
  // is `read` and auto-approves at A1.
  //
  // A COMPOUND key (`"pr merge"`) is tried before the single token (`"pr"`) — `gh`'s CLI is
  // noun+verb, so `gh pr merge` and `gh pr create` share a noun but must not share a tier.
  // Flat registries (`git`, `npm`, …) only ever populate single-token keys, so the compound
  // lookup simply misses for them and behavior is unchanged.
  const [sub, sub2] = findPositionals(rest, spec.valueOptions ?? [], 2);
  const compound = sub2 ? `${sub} ${sub2}` : undefined;
  const compoundTier = compound ? spec.subcommands?.[compound] : undefined;
  const singleTier = sub ? spec.subcommands?.[sub] : undefined;
  const matchedKey = compoundTier !== undefined ? compound : sub;
  const subTier = compoundTier ?? singleTier;
  if (spec.needsSubcommand && !sub) {
    return { program, tier: spec.tier, reason: `\`${program}\` with no subcommand` };
  }
  const tier = subTier ?? spec.tier;
  const reason =
    subTier !== undefined
      ? `\`${program} ${matchedKey}\` is ${subTier}`
      : `\`${program}\` is ${tier}`;
  return { program, tier, reason };
}

/**
 * Classify a whole parsed command.
 *
 * Also reports every unknown program by name, so the confirm dialog can say *which* part of
 * the pipeline is the reason it is asking — "unknown program" without a name is a prompt the
 * human cannot reason about.
 */
export function classifyCommand(cmd: ParsedCommand): ClassifyResult {
  const stages = allStages(cmd);
  if (stages.length === 0) return { ok: false, error: "empty command" };

  const classes: StageClass[] = [];
  const unknown: string[] = [];
  for (const st of stages) {
    const c = classifyStage(st);
    if ("error" in c) return { ok: false, error: c.error, program: c.program };
    classes.push(c);
    if (!programSpec(c.program)) unknown.push(c.program);
  }

  // Writing to a file is a mutation whatever the program is: `echo x > ~/.zshrc` must not
  // classify as `read` merely because `echo` does. That includes STDERR: since exec-runner
  // really opens a `2> file` target (with "w", so it truncates), `ls 2> src/main.ts` is a
  // write. Counting only stdout left it `read`, auto-approved at the default level 1.
  // `kind === "file"` keeps `2>&1` (kind "merge") out; `< file` (stdin) only reads.
  const writesFile = stages.some((s) =>
    s.redirects.some((r) => r.kind === "file" && r.stream !== "stdin"),
  );

  let tier = classes.reduce<ExecTier>(
    (worst, c) => (RANK[c.tier] > RANK[worst] ? c.tier : worst),
    "read",
  );
  if (writesFile && RANK[tier] < RANK.command) tier = "command";

  return { ok: true, tier, stages: classes, unknownPrograms: [...new Set(unknown)] };
}

/**
 * Does `level` auto-approve `tier`, or must a human answer?
 *
 * The ladder's own table decides — `authLevelMeta(level).auto` is the cumulative category set
 * — so a command is governed by exactly the rung its content earns. This is what makes the
 * per-invocation tier real: `classifyAuth` can only see the TOOL NAME (`run_command`), which
 * would put `rm -rf` and `ls` on the same rung.
 */
export function execAuthDecision(level: number, tier: ExecTier): "allow" | "ask" {
  return authLevelMeta(level).auto.includes(tier as AuthCategory) ? "allow" : "ask";
}

/** A one-line human summary for the confirm prompt and the audit log. */
export function describeCommand(cmd: ParsedCommand, result: ClassifyResult): string {
  if (!result.ok) return `refused: ${result.error}`;
  const unknown = result.unknownPrograms.length
    ? ` — unknown: ${result.unknownPrograms.join(", ")}`
    : "";
  return `${formatCommand(cmd)}  [${result.tier}${unknown}]`;
}
