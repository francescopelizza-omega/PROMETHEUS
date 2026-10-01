// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * commands/generic.ts — route the §2 command tree to the engine, or stub honestly.
 *
 * The rich commands (scan/list/info/gate/env/model/provider) keep their bespoke
 * renderers; THIS handles the rest of the §2 tree by mapping a command path → the
 * real prometheus.py subcommand and running it through the bridge with the §1 globals
 * BEFORE the subcommand (toEngineArgv). Verbs the engine has no verb for yet (model
 * pull/serve, env create, repo add — owned by [[04]]/[[05]]/[[06]]) return a
 * not-yet-wired stub: prometheus NEVER fakes success (§2).
 */
import {
  type EngineEnvelope,
  type RawEngineResult,
  rawEngine,
  runPrometheus,
} from "@prometheus/engine-bridge";

import { cliProfiles } from "@prometheus/core";
import type { CliContext, CommandOutcome } from "../context.js";
import { c } from "../render.js";
import { renderEnvelope } from "../render/envelope-view.js";
import { globalArgv, toEngineArgv } from "../toEngineArgv.js";
import { verdictCardFromEnvelope } from "../verdict-view.js";

/**
 * Map a recognized command path → the engine subcommand argv, or null when no engine
 * verb exists yet (→ not-yet-wired stub).
 */
export function engineSubcommand(path: string[], positionals: string[]): string[] | null {
  const a = path[0];
  const b = path[1];
  switch (a) {
    case "superscan":
      return ["superscan"];
    case "doctor":
      return ["doctor"];
    case "matrix":
      return ["matrix"];
    case "inventory":
      return ["inventory", ...positionals];
    case "schedule":
      return ["schedule", ...positionals];
    case "secure":
      if (b === "audit" || b === "verdict") return ["audit", ...positionals];
      if (b === "purge") return ["purge", ...positionals];
      // secure scan / disinfect / quarantine / db → nemesis + remediation (file 03) — not a plain subcommand.
      return null;
    /**
     * plugin <action> → engine <action>; a TRULY BARE `plugin` → list.
     *
     * "Bare" has to mean "no second word at all", not "no RECOGNIZED second word". `plugin` is
     * a TWO_WORD command (parse.ts), so an unrecognized verb leaves `command` as just
     * `["plugin"]` and parks the typo in `positionals` — and defaulting to `list` on that
     * swallowed it: `plugin uninstal skills` printed the catalog with `ok:true` and exit 0, so a
     * mistyped uninstall reported success while nothing happened. `remove` (a plausible synonym
     * for `uninstall`) did the same. Forwarding whatever WAS typed lets the engine refuse it,
     * which is exactly what the `app`/`worldsim`/`pentest`/`localai` branches below already do.
     */
    case "plugin":
      return b ? [b, ...positionals] : positionals.length > 0 ? [...positionals] : ["list"];
    case "skill":
      // Same swallow, same fix: `skill bogusverb` used to list the skills and report ok:true.
      return [
        "skills",
        ...(b ? [b, ...positionals] : positionals.length > 0 ? positionals : ["list"]),
      ];
    case "app":
      return ["apps", ...(b ? [b] : []), ...positionals];
    case "worldsim":
      return ["worldsim", ...(b ? [b] : []), ...positionals];
    case "pentest":
      return ["pentest", ...(b ? [b] : []), ...positionals];
    case "localai":
      return ["localai", ...(b ? [b] : []), ...positionals];
    case "repo":
      return b === "vault" ? ["vault", ...positionals] : null; // repo add/list/… = file 06 sidecar
    default:
      return null;
  }
}

/** An honest stub for a verb the engine has no surface for yet (§2). */
export function notYetWired(path: string[]): CommandOutcome {
  const cmd = path.join(" ");
  return {
    text: `prometheus ${cmd}: not yet wired.\nThis capability is owned by a feature file still landing (file 11 §2). It will route\nthrough the engine once the verb exists — prometheus never fakes success.`,
    json: { ok: false, command: cmd, status: "not-yet-wired" },
    // a missing capability is NOT success — exit nonzero so scripts/CI never read it as done.
    exitCode: 2,
  };
}

/**
 * The engine COMMAND flags the §2 tree forwards (globals are added by toEngineArgv).
 * This is what makes `prometheus plugin install foo --only x --host claude`,
 * `prometheus app install yt-dlp --path /opt`, `prometheus pentest build --kali`, etc. carry
 * their full GUI affordance set through to the engine instead of silently dropping.
 * `host` is handled separately (the engine's repeatable append flag).
 */
const PASSTHROUGH_FLAGS: readonly string[] = [
  "only",
  "skip",
  "arm",
  "component",
  "path",
  "version",
  "set-root",
  "show",
  "method",
  "target-python",
  "max-jobs",
  "cuda",
  "fa-version",
  "kali",
  "allow-net",
  "init",
  "name",
  "interval",
  "cron",
  "description",
  "body",
  "tools",
  "manual",
  "to",
  "revoke",
  "gate-fresh",
  "branch",
  "pin",
  "status", // CLI-078: `skills integrate --status` — the flag allowlist would otherwise drop it.
];

/** Build engine argv for any known command flags present (boolean true → bare flag). */
export function passthroughArgv(flags: Record<string, string | true>): string[] {
  const out: string[] = [];
  for (const name of PASSTHROUGH_FLAGS) {
    const v = flags[name];
    if (v === undefined) continue;
    if (v === true) out.push(`--${name}`);
    else out.push(`--${name}`, v);
  }
  // `--host a,b` → repeatable append (the engine's --host action="append").
  const host = flags.host;
  if (typeof host === "string" && host) {
    for (const h of host
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean))
      out.push("--host", h);
  }
  return out;
}

/**
 * The self-hosted-app / world-sim / model-tool / local-AI managers print a HUMAN
 * TABLE on stdout for their ENTIRE surface — reads AND lifecycle mutations alike
 * (verified live: `apps install …` emits "FAIL/OK …" text, not a JSON envelope).
 * These must go through `rawEngine` — the SAME stdout passthrough the GUI uses (file
 * 06 §4.2) — else the JSON parser fails with a spurious `bad_json` over the table.
 * The engine runs its OWN nemesis gate inside these commands (C5); prometheus just renders.
 */
// "pentest" belongs here too, for its WHOLE surface, not just the PENTEST_READS subset the
// engine's own cmd_pentest and every _pentest_*/_pentagent_*/_orchestrator_* helper (build,
// install, shell, run, destroy, …) never call emit_json for any of them (grepped: zero hits) —
// so the mutating actions were ALSO routed through the JSON bridge, which turned every one of
// them — success, a clean ROE-gate refusal, or a genuine crash — into the identical
// "prometheus.py produced no JSON on stdout (crashed before emitting)" error, indistinguishable
// from each other and contradicting the summary's promise of a working "ROE-gated ... sandbox".
const TEXT_MANAGER_FAMILIES = new Set(["apps", "worldsim", "models", "localai", "pentest"]);

/** Does this engine subcommand argv render as HUMAN TEXT (→ rawEngine, not JSON)? */
export function isManagerRead(sub: readonly string[]): boolean {
  const family = sub[0];
  if (!family) return false;
  return TEXT_MANAGER_FAMILIES.has(family); // whole family is human-text
}

/** Render a rawEngine human-table result (lines already ANSI-stripped). */
export function renderRaw(ctx: CliContext, raw: RawEngineResult): CommandOutcome {
  if (ctx.json) {
    return {
      json: {
        ok: raw.ok,
        command: raw.command,
        action: raw.action,
        lines: raw.lines,
        // carry WHY it failed: a script branching on `.ok` should not have to dig the engine's
        // own error string back out of `lines`.
        ...(raw.error ? { error: raw.error } : {}),
      },
      exitCode: raw.ok ? 0 : 2,
    };
  }
  if (!raw.ok) {
    // raw.error already names the command (e.g. "apps exit 2: FAIL unknown app …").
    return { text: c.red(raw.error ?? `${raw.command}: engine read failed`), exitCode: 2 };
  }
  /**
   * A human-table read whose engine command has since grown a JSON envelope must not dump that
   * envelope at the user.
   *
   * These reads run WITH `--json` (rawEngine adds it), and `localai models` / `localai audit`
   * answer with a v1 envelope carrying `models[]` / `tools[]` rather than the `lines[]` the
   * table reads use. `rawEngine` can only recover display rows from `lines`, so the fallback
   * split the serialized envelope into one enormous "line" and printed it verbatim — a screenful
   * of raw JSON where every sibling verb prints a table.
   *
   * Handing it to `renderEnvelope` — the SAME renderer the registry path uses — turns it into
   * the table it always should have been.
   */
  const joined = raw.lines.join("\n");
  const trimmed = joined.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const env = JSON.parse(trimmed) as EngineEnvelope;
      const rendered = renderEnvelope(raw.command, env);
      if (rendered) return { text: rendered, exitCode: 0 };
    } catch {
      /* not an envelope after all — fall through and print what the engine sent */
    }
  }
  return { text: joined, exitCode: 0 };
}

/**
 * pentest's own destructive actions, checked as a (family, action) PAIR rather than as bare
 * words below — "build"/"run"/"shell" are common enough words that adding them as bare entries
 * would wrongly force-gate unrelated commands sharing a path segment with them. Omitting these
 * entirely (the previous behavior) meant `pentest destroy --force` reached the engine with no
 * typed-confirm/CI-hard-block at all, unlike every other mutating verb.
 */
const PENTEST_MUTATING_ACTIONS = new Set(["destroy", "build", "run", "shell"]);

/** Is a mutating verb (drives the §4 force guard)? */
function isMutating(path: string[]): boolean {
  if (path[0] === "pentest" && path[1] !== undefined && PENTEST_MUTATING_ACTIONS.has(path[1])) {
    return true;
  }
  const verbs = new Set(["install", "uninstall", "enable", "disable", "purge", "bundle", "sync"]);
  return path.some((p) => verbs.has(p));
}

function summarize(cmd: string, env: EngineEnvelope): string {
  if (env.ok === false) {
    const reason = typeof env.error === "string" ? env.error : "engine returned ok:false";
    return `${cmd}: ${reason}`;
  }
  return `${cmd}: ok`;
}

/** The §4 ci force-block (shared by both engine entry points). undefined = cleared. */
function ciForceBlock(
  label: string,
  mutating: boolean,
  ctx: CliContext,
): CommandOutcome | undefined {
  // EXACTLY "1", via the shared predicate — a bare presence check fails OPEN on
  // PROM_ALLOW_FORCE=0/false, which a CI job sets believing it DISABLES the override.
  if (
    ctx.args.force &&
    mutating &&
    ctx.args.profile === "ci" &&
    !cliProfiles.forceOverrideAllowed()
  ) {
    return {
      text: `prometheus ${label}: --force is blocked under the 'ci' profile. Set PROM_ALLOW_FORCE=1 to override (there is no human to type the confirmation).`,
      json: { ok: false, error: "force-blocked", command: label },
      exitCode: 2,
    };
  }
  return undefined;
}

/**
 * Run a resolved engine subcommand argv: a HUMAN-TABLE read goes through rawEngine
 * (clean stdout, no JSON parse), everything else through the JSON bridge. Shared by
 * the §2 tree (runGeneric) and the single-token manager families (runManagerFamily).
 */
async function runEngineSub(
  label: string,
  sub: string[],
  mutating: boolean,
  ctx: CliContext,
): Promise<CommandOutcome> {
  const blocked = ciForceBlock(label, mutating, ctx);
  if (blocked) return blocked;

  if (isManagerRead(sub)) {
    // globals BEFORE the subcommand (the engine rejects them after) + per-verb flags;
    // rawEngine prepends `--json --no-color` itself and captures stdout verbatim.
    const raw = await rawEngine(
      [...globalArgv(ctx.args), ...sub, ...passthroughArgv(ctx.args.flags)],
      {
        timeoutMs: 600_000,
      },
    );
    return renderRaw(ctx, raw);
  }

  // globals BEFORE the subcommand (toEngineArgv), the engine subcommand + its
  // positionals (sub), then the per-verb command flags (the GUI affordance set).
  const argv = toEngineArgv(ctx.args, sub, passthroughArgv(ctx.args.flags));
  const env = (await runPrometheus(argv, { timeoutMs: 600_000 })) as EngineEnvelope;
  const ok = env.ok !== false;
  // Opportunistically surface a gate verdict CARD above the engine text (CLI-039) when the
  // envelope carries one (forced_danger / nested nemesis.verdict) — pretty-mode only, never by
  // re-running the gate. `--json` output stays byte-identical (only the `text` field changes).
  if (!ctx.json) {
    /**
     * Render the ENVELOPE, not just the toast.
     *
     * `summarize` produces `"<cmd>: ok"` — right as a one-line status, wrong as the only thing a
     * human sees. `commands/route.ts` fixed exactly this for the registry path and said so in a
     * comment; this second engine entry point kept the old behaviour, so every §2 verb routed
     * here threw its payload away. `prometheus plugin list` printed `plugin list: ok` and
     * `prometheus skill list` printed `skill list: ok` — no catalog, no skills, no state — while
     * the envelope beneath carried the whole table.
     *
     * `renderEnvelope` returns null when there is genuinely nothing to show, and the toast is
     * still the fallback then, so an empty `{ok:true}` says something and nothing is invented.
     */
    const card = verdictCardFromEnvelope(env);
    const body = renderEnvelope(label, env) ?? summarize(label, env);
    const text = card ? `${card}\n\n${body}` : body;
    return { text, json: env, exitCode: ok ? 0 : 2 };
  }
  return { text: summarize(label, env), json: env, exitCode: ok ? 0 : 2 };
}

/** Route a recognized §2 command through the engine (or stub). */
export async function runGeneric(path: string[], ctx: CliContext): Promise<CommandOutcome> {
  /**
   * A TYPO is not an unimplemented feature.
   *
   * `unmatchedSub` means a second word WAS typed and did not match the command's verb set
   * (parse.ts). For a family with no engine verb of its own — `provider` is the live example —
   * that fell through to `notYetWired`, so `prometheus provider bogusverb` answered "not yet
   * wired … a feature file still landing", telling the user to wait for a capability that
   * already exists and that they had simply misspelled. Reported as the unknown verb it is,
   * exit 1 (bad args, CLI-084) rather than 2.
   */
  const typo = ctx.args.unmatchedSub;
  if (typo !== undefined) {
    const head = path.join(" ");
    return {
      text: `prometheus ${head} ${typo}: unknown verb.`,
      json: { ok: false, error: "unknown-verb", command: `${head} ${typo}` },
      exitCode: 1,
    };
  }
  const sub = engineSubcommand(path, ctx.args.positionals);
  if (!sub) return notYetWired(path);
  return runEngineSub(path.join(" "), sub, isMutating(path), ctx);
}

/** Normalize a single-token manager head to its engine subcommand family. */
const FAMILY_ALIAS: Record<string, string> = { app: "apps" };

/**
 * Route a single-token manager family verb (`prometheus apps list`, `prometheus models config
 * --set-root D`, `prometheus worldsim install x`, …) to the SAME engine path the two-word
 * `app list` form uses — so human-table reads render cleanly and mutations stay gated,
 * with the per-verb flags forwarded. Mirrors managerSpec but goes through rawEngine for
 * the table reads (the registry managerSpec stays the GUI/parity surface).
 */
export async function runManagerFamily(head: string, ctx: CliContext): Promise<CommandOutcome> {
  const family = FAMILY_ALIAS[head] ?? head;
  // action may be the two-word sub (command[1]) OR the first positional (single-token).
  const action = ctx.args.command[1];
  const rest = ctx.args.positionals.filter((p) => p.length > 0);
  const sub = [family, ...(action ? [action] : []), ...rest];
  return runEngineSub(
    [family, ...(action ? [action] : []), ...rest].join(" "),
    sub,
    isMutating(sub),
    ctx,
  );
}
