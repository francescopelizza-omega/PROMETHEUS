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

import type { CliContext, CommandOutcome } from "../context.js";
import { c } from "../render.js";
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
    case "plugin":
      // plugin <action> → engine <action>; bare `plugin` → list
      return b ? [b, ...positionals] : ["list"];
    case "skill":
      return ["skills", b ?? "list", ...positionals];
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
const TEXT_MANAGER_FAMILIES = new Set(["apps", "worldsim", "models", "localai"]);

/** pentest is split: its reads are human-text; its sandbox mutations keep the JSON path. */
const PENTEST_READS = new Set(["list", "scope", "status", "runtimes", "logs"]);

/** Does this engine subcommand argv render as HUMAN TEXT (→ rawEngine, not JSON)? */
export function isManagerRead(sub: readonly string[]): boolean {
  const family = sub[0];
  if (!family) return false;
  if (TEXT_MANAGER_FAMILIES.has(family)) return true; // whole family is human-text
  if (family === "pentest") {
    const action = sub[1];
    if (!action || action.startsWith("-")) return true; // default `pentest` = list = text
    return PENTEST_READS.has(action);
  }
  return false;
}

/** Render a rawEngine human-table result (lines already ANSI-stripped). */
function renderRaw(ctx: CliContext, raw: RawEngineResult): CommandOutcome {
  if (ctx.json) {
    return {
      json: { ok: raw.ok, command: raw.command, action: raw.action, lines: raw.lines },
      exitCode: raw.ok ? 0 : 2,
    };
  }
  if (!raw.ok) {
    // raw.error already names the command (e.g. "apps exit 2: FAIL unknown app …").
    return { text: c.red(raw.error ?? `${raw.command}: engine read failed`), exitCode: 2 };
  }
  return { text: raw.lines.join("\n"), exitCode: 0 };
}

/** Is a mutating verb (drives the §4 force guard)? */
function isMutating(path: string[]): boolean {
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
  if (ctx.args.force && mutating && ctx.args.profile === "ci" && !process.env.PROM_ALLOW_FORCE) {
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
    const card = verdictCardFromEnvelope(env);
    const text = card ? `${card}\n\n${summarize(label, env)}` : summarize(label, env);
    return { text, json: env, exitCode: ok ? 0 : 2 };
  }
  return { text: summarize(label, env), json: env, exitCode: ok ? 0 : 2 };
}

/** Route a recognized §2 command through the engine (or stub). */
export async function runGeneric(path: string[], ctx: CliContext): Promise<CommandOutcome> {
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
