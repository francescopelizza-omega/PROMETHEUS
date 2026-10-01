// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
import { cliProfiles, updates } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";
import { runAgentsCommand } from "./commands/agents-cmd.js";
import { runBudgetCommandFromCtx } from "./commands/budget-cmd.js";
import { runCompletion } from "./commands/completion.js";
import { runDiagram } from "./commands/diagram-cmd.js";
/**
 * index.ts — the prometheus command dispatcher. Maps a parsed command path to a
 * command runner and returns a CommandOutcome. Pure-ish: it builds the context
 * (which constructs the EngineClient) and awaits the command. bin.ts owns
 * argv reading, printing, color setup, and process.exit — keeping this unit
 * testable.
 */
import { runEnvCommand } from "./commands/env-cmd.js";
import { runGate } from "./commands/gate.js";
import { runGeneric, runManagerFamily } from "./commands/generic.js";
import { runHealth } from "./commands/health.js";
import { PROM_VERSION, helpForTopic, runHelp, runVersion } from "./commands/help.js";
import { runInfo } from "./commands/info.js";
import { runKeymap } from "./commands/keymap.js";
import { runList } from "./commands/list.js";
import { runMan } from "./commands/man.js";
import { runMcpCommand } from "./commands/mcp-cmd.js";
import { runMeetCommandFromCtx } from "./commands/meet-cmd.js";
import { runMetadataCommand } from "./commands/metadata-cmd.js";
import { runModelCommand } from "./commands/model-cmd.js";
import { runPersonaCommandFromCtx } from "./commands/persona-cmd.js";
import { runConfig, runProfile } from "./commands/profile.js";
import {
  runProviderConnect,
  runProviderDisconnect,
  runProviderEnableMetered,
  runProviderList,
  runProviderShow,
  runProviderStatus,
} from "./commands/provider.js";
import { runRefactor } from "./commands/refactor-cmd.js";
import { runRepoCommand } from "./commands/repo-cmd.js";
import { routeViaRegistry, specIdFor } from "./commands/route.js";
import { runScan } from "./commands/scan.js";
import { runTasksCommand } from "./commands/schedule-cmd.js";
import { runSecureCommand } from "./commands/secure-cmd.js";
import { runSessions } from "./commands/sessions-cmd.js";
import { runTest } from "./commands/test-cmd.js";
import { runTokens } from "./commands/tokens.js";
import { type CliContext, type CommandOutcome, makeContext, outcomeFromError } from "./context.js";
import { runDoctor, runDoctorBridge } from "./doctor-bridge.js";

import { prometheusHome } from "./home.js";
import { type ParsedArgs, parseArgs } from "./parse.js";
import { c } from "./render.js";
import { RECOGNIZED_VERBS, ROUTED_VERBS } from "./route-table.js";
import { isTerminalChatCli, routeTerminalChat } from "./terminal/chat-route.js";
import { runUpdates } from "./updates/updates-cmd.js";

export type { CommandOutcome, CliContext } from "./context.js";
export { parseArgs } from "./parse.js";

/** Join a command path to a stable lookup key, e.g. ["model","hw"] -> "model hw". */
function key(path: string[]): string {
  return path.join(" ");
}

/**
 * Dispatch a fully-parsed invocation to its command. Top-level help/version are
 * handled here. Unknown commands produce a help outcome with a nonzero exit.
 *
 * `opts.client` injects an EXISTING engine gateway — the interactive session passes its
 * own so a session verb reaches the rich renderers here without opening a second
 * connection (C5, one gateway). Absent → the one-shot path builds its own.
 */
export async function dispatch(
  parsed: ParsedArgs,
  opts?: { client?: EngineClient },
): Promise<CommandOutcome> {
  const ctx = makeContext(parsed, opts?.client);

  // version / help short-circuits (no engine call)
  if (parsed.version) return runVersion(ctx);
  if (parsed.command.length === 0 || parsed.command[0] === "help") {
    return runHelp(ctx);
  }
  // A MISTYPED command is not a request for help on one — see parse.ts. Checked before the
  // help-topic branch below, which would otherwise look the typo up as a topic.
  if (parsed.unknownCommand) return unknownCommand(parsed.command, ctx);
  if (parsed.help && key(parsed.command) !== "help") {
    // `prometheus <cmd> --help` → that command's help from the registry (CLI-049); an unknown command
    // topic yields exit 2 + the nearest-match suggestion inside helpForTopic.
    const topic = parsed.command[0];
    if (topic) return helpForTopic(ctx, topic);
    return runHelp(ctx); // bare `--help` (no command) is handled above; safety net
  }

  try {
    return await runByKey(parsed.command, ctx);
  } catch (err) {
    const out = outcomeFromError(err);
    if (ctx.json && out.json === undefined) out.json = { ok: false };
    return out;
  }
}

/** Top-level §2 verbs prometheus recognizes DIRECTLY — the single source of truth is the leaf
 *  route-table (CLI-050), shared with the help screen so the two can never drift. */
const RECOGNIZED = new Set(RECOGNIZED_VERBS);

function isKnownCommand(path: string[]): boolean {
  // a verb is "known" if it's a recognized §2 noun OR maps to a CommandSpec
  // (the canonical parity registry) — so spec'd verbs never read as unknown.
  return (path.length > 0 && RECOGNIZED.has(path[0] as string)) || specIdFor(path) !== undefined;
}

/**
 * An unrecognised verb, reported as what it is.
 *
 * This used to hand the argv to `runHelp`, which reads the first token as a HELP TOPIC — so
 * `prometheus keys` answered "unknown help topic: keys" and `prometheus wroktree` answered
 * "unknown help topic: wroktree". Both are commands the user tried to RUN, and the reply talked
 * about a help system they never invoked, suggesting the nearest help TOPIC rather than the
 * nearest command.
 *
 * The suggestion now comes from `ROUTED_VERBS` — the same single source the help screen and the
 * router derive from — so "keys" points at `keymap`, which is the verb that actually exists.
 */
function unknownCommand(path: string[], ctx: CliContext): CommandOutcome {
  const typed = path.join(" ");
  const near = cliProfiles.nearestKey(path[0] ?? "", [...ROUTED_VERBS]);
  const lines = [c.red(`unknown command: ${typed}`)];
  if (near) lines.push(c.dim(`did you mean "${near}"?`));
  lines.push(c.dim("`prometheus help` lists every command."));
  return {
    text: lines.join("\n"),
    json: {
      ok: false,
      error: "unknown-command",
      command: typed,
      ...(near ? { didYouMean: near } : {}),
    },
    // A mistyped COMMAND is the same class as a mistyped verb or a missing argument: bad args,
    // which CLI-084 numbers 1. It exited 2 — the security-block code — so `$? -eq 2` fired on a
    // typo. See `usageError` for the full reasoning.
    exitCode: 1,
  };
}

/** The interactive REPL/TUI needs the Ink view (apps/cli/src/repl) — a TTY thing. */
function replStub(path: string[]): CommandOutcome {
  return {
    text: `prometheus ${path.join(" ")}: the interactive REPL/agent runs the full-screen Ink TUI.\nLaunch it with a bare \`prometheus\` (no args). The REPL brain (slash/tuning/agent loop) lives\nin @prometheus/core; the Ink view binds it once \`ink\` is installed.`,
    json: { ok: false, command: path.join(" "), status: "repl-tui" },
    exitCode: 0,
  };
}

async function runByKey(path: string[], ctx: CliContext): Promise<CommandOutcome> {
  const k = key(path);
  const head = path[0];
  // doctor --bridge (engine-discovery check, §8) before the generic doctor.
  if (head === "doctor" && ctx.args.flags.bridge === true) return runDoctorBridge(ctx);
  // `prometheus doctor` → the comprehensive environment health report (CLI-051).
  if (head === "doctor") return runDoctor(ctx);
  // prom-native (§6): profiles + config read the shared core, no engine call.
  if (head === "profile") return runProfile(path, ctx);
  if (head === "config") return runConfig(path, ctx);
  // `prometheus updates` — one-shot update check (vendor CLIs · local models · Prometheus self).
  if (head === "updates") {
    const lines: string[] = [];
    const report = await runUpdates(path.slice(1).join(" "), {
      home: prometheusHome(),
      promVersion: PROM_VERSION,
      client: ctx.client,
      write: (l) => lines.push(l),
      env: process.env,
      ...(process.argv[1] ? { scriptPath: process.argv[1] } : {}),
      cwd: process.cwd(),
    });
    // CLI-047: emit the real per-component array under --json (a check failure → ok:false),
    // built from the SAME report that produced the human lines; exit codes unchanged.
    if (report === null) {
      return {
        text: lines.join("\n"),
        json: { ok: false, error: "update-check-failed" },
        exitCode: 0,
      };
    }
    return { text: lines.join("\n"), json: { ...updates.toUpdatesJson(report) }, exitCode: 0 };
  }
  // `prometheus sessions` (PLURAL) is the one-shot session browser — distinct from the
  // singular `session` which enters the interactive REPL below.
  if (head === "sessions") return runSessions(ctx);
  // the full-screen interactive REPL/TUI (P4) — one-shot context can't host it.
  if (head === "repl" || head === "tui" || head === "session") return replStub(path);
  // `chat --cli X` → the rich terminal PREVIEW (the engine's injection-safe argv +
  // notes). dispatch is a pure path, so it NEVER spawns: a launch (--open/--tmux) is
  // owned by bin.ts (TTY + readline confirm); reaching here (a programmatic run() or a
  // plain preview) renders preview-only. The session previews in-line via command-exec.
  if (head === "chat" && isTerminalChatCli(ctx.args)) {
    return routeTerminalChat(ctx.args, { client: ctx.client, json: ctx.json, previewOnly: true });
  }
  // bare `prometheus chat` is the interactive chat surface (REPL pane, P4) → stub for now;
  // `chat --cli/--local/<message>` is a real one-shot → falls through to the registry.
  if (
    head === "chat" &&
    ctx.args.positionals.length === 0 &&
    !ctx.args.flags.local &&
    !ctx.args.flags.cli
  ) {
    return replStub(path);
  }
  // §2 sidecar-backed surfaces (full GUI parity): env/model/repo/metadata route to
  // their rich command dispatchers over the python sidecars (C7). `repo vault` stays
  // on the engine (the Repo Vault is a prometheus.py subcommand, not the repo sidecar).
  if (head === "keymap") return runKeymap(ctx);
  if (head === "test") return runTest(ctx);
  if (head === "diagram") return runDiagram(ctx);
  if (head === "refactor") return runRefactor(ctx);
  if (head === "tokens") return runTokens(ctx);
  if (head === "completion") return runCompletion(ctx);
  if (head === "man") return runMan(ctx);
  if (head === "env") return runEnvCommand(ctx);
  if (head === "model") return runModelCommand(ctx);
  if (head === "metadata") return runMetadataCommand(ctx);
  if (head === "secure") return runSecureCommand(ctx);
  if (head === "repo") {
    if (path[1] === "vault") return runGeneric(path, ctx);
    return runRepoCommand(ctx);
  }
  // self-hosted apps / world-sim / model-tools / local-AI / pentest managers: route
  // BOTH the single-token (`apps list`) and two-word (`app list`) forms to one place
  // so human-table READS render via rawEngine (no bad_json noise) and mutations stay
  // gated — with --path/--version/--set-root/… forwarded.
  if (
    head === "app" ||
    head === "apps" ||
    head === "worldsim" ||
    head === "models" ||
    head === "localai" ||
    head === "pentest"
  ) {
    return runManagerFamily(head as string, ctx);
  }

  switch (k) {
    case "scan":
      return runScan(ctx);
    case "health":
      return runHealth(ctx);
    case "gate":
      return runGate(ctx);
    case "list":
      return runList(ctx);
    case "info":
      return runInfo(ctx);
    case "provider list":
      return runProviderList(ctx);
    case "provider show":
      return runProviderShow(ctx);
    case "provider connect":
      return runProviderConnect(ctx);
    case "provider status":
      return runProviderStatus(ctx);
    case "provider disconnect":
      return runProviderDisconnect(ctx);
    case "provider enable-metered":
      return runProviderEnableMetered(ctx);
    case "agents":
    case "agents list":
    case "agents attach":
    case "agents kill":
      return runAgentsCommand(ctx);
    case "tasks":
      return runTasksCommand(ctx);
    case "persona":
      return runPersonaCommandFromCtx(ctx);
    case "budget":
      return runBudgetCommandFromCtx(ctx);
    case "meet":
      return Promise.resolve(runMeetCommandFromCtx(ctx));
    case "mcp":
    case "mcp list":
    case "mcp add":
    case "mcp remove":
    case "mcp test":
      return runMcpCommand(ctx);
    case "version":
      return runVersion(ctx);
    case "help":
      return runHelp(ctx);
    default: {
      // STRUCTURAL PARITY: if the verb maps to a CommandSpec, route through the
      // canonical registry (the SAME run() the GUI uses) — covers describe/
      // tutorial/methods/harden/chat/install/uninstall/apps/worldsim/localai/
      // vault/pentest/… with no per-verb glue.
      const specId = specIdFor(path);
      if (specId) return routeViaRegistry(specId, ctx);
      // recognized §2 verb with no spec → engine passthrough / honest stub.
      if (isKnownCommand(path)) return runGeneric(path, ctx);
      return unknownCommand(path, ctx);
    }
  }
}

/** Convenience for callers/tests: parse a raw argv slice then dispatch. */
export async function run(argv: string[]): Promise<CommandOutcome> {
  return dispatch(parseArgs(argv));
}
