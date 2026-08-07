/**
 * session/command-exec.ts — run a `prometheus` VERB from inside the interactive
 * session (P4) over the SAME parity router the one-shot CLI and the GUI palette
 * use. This is what makes "anything you can type as `prometheus <verb>` you can type
 * at the session prompt" STRUCTURAL: single-token spec verbs go straight through
 * `invoke()` (the canonical router) sharing the session's EngineClient (C5 — one
 * gateway); every other verb path falls back to the one-shot `dispatch()` so the
 * full §2 tree (rich renderers + multi-word nouns + honest stubs) is reachable
 * with zero per-verb glue.
 *
 * NEVER-FORCE / GATE-FIRST: a mutating verb carrying --force is held BEFORE it
 * reaches the engine. The session must type-confirm the override via ctx.confirm;
 * a force-forbidding profile (ci) hard-blocks with no override (there is no human
 * keystroke that can satisfy a non-interactive profile). Nothing here decides
 * "safe" — that stays the engine's nemesis verdict (C5). Every turn is wrapped so
 * an engine/transport error renders a friendly line and the session continues.
 */
import { type RawArgs, cliProfiles, getCommandSpec, invoke } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import type { CommandOutcome } from "../context.js";
import { outcomeFromError } from "../context.js";
import { dispatch } from "../index.js";
import { type ParsedArgs, parseArgs } from "../parse.js";
import { c } from "../render.js";
import { isTerminalChatCli, routeTerminalChat } from "../terminal/chat-route.js";

/**
 * The minimal context the session hands its executors. Kept tiny on purpose:
 * the engine gateway, the output channel, the json flag, the active profile
 * (for force gating), and the typed-confirm prompt. Slash + agent runtimes in
 * session/ share this exact shape.
 */
export interface SessionCtx {
  /** the ONLY engine gateway (C5) — shared across the whole session. */
  client: EngineClient;
  /** machine output mode: human text → stderr, machine envelope → stdout. */
  json: boolean;
  /** active profile name (drives the force-forbidding hard block). */
  profile?: string;
  /**
   * type-confirm a dangerous override. The session prompts the user to type the
   * exact `phrase` (never-force UX); resolves true only on an exact match. A
   * non-interactive host should resolve false (deny).
   */
  confirm: (prompt: string, phrase: string) => Promise<boolean>;
  /** write a line of human output to the session transcript / stdout. */
  write: (text: string) => void;
}

/** Mutating verbs whose --force needs a typed-confirm before it reaches nemesis. */
const MUTATING_VERBS = new Set([
  "install",
  "uninstall",
  "enable",
  "disable",
  "purge",
  "bundle",
  "sync",
  "harden",
  "disinfect",
  "quarantine",
]);

/** Does this parsed command path mutate state (drives the §4 force guard)? */
function isMutating(path: readonly string[]): boolean {
  return path.some((p) => MUTATING_VERBS.has(p));
}

/** A blocked outcome the caller renders verbatim (exit 2 — never a silent 0). */
function blocked(command: string, reason: string): CommandOutcome {
  return {
    text: `prometheus ${command}: ${reason}`,
    json: { ok: false, error: reason, command },
    exitCode: 2,
  };
}

/**
 * Build the registry's RawArgs from parsed CLI args (+ lifted §1 globals), mirroring
 * commands/route.ts::toRawArgs so single-token verbs receive their declared flags
 * (install --dry-run/--force, etc.) when routed straight through invoke().
 */
function toRawArgs(parsed: ParsedArgs): RawArgs {
  const flags: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(parsed.flags)) flags[k] = v;
  // parse.ts hoists engine globals OFF `flags` into typed fields — lift them back.
  if (parsed.dryRun) flags["dry-run"] = true;
  if (parsed.yes) flags.yes = true;
  if (parsed.strict) flags.strict = true;
  if (parsed.force) flags.force = true;
  return { positionals: parsed.positionals, flags };
}

/** Render a routed RouterResult to a CommandOutcome (text summary + machine payload). */
async function routeViaInvoke(
  specId: string,
  parsed: ParsedArgs,
  ctx: SessionCtx,
): Promise<CommandOutcome> {
  // SAME router the GUI palette calls — sharing the SESSION's client (C5).
  const res = await invoke(specId, { client: ctx.client }, toRawArgs(parsed));
  const payload = {
    ...((res.verdict ?? res.envelope ?? {}) as Record<string, unknown>),
    ok: res.ok,
  };
  return { text: res.summary, json: payload, exitCode: res.ok ? 0 : 2 };
}

/**
 * Gate a forced, mutating verb behind a typed confirm (never-force, §4).
 *
 * Returns:
 *   - a blocked CommandOutcome  → caller must NOT run the verb (hard block / declined),
 *   - undefined                 → cleared to run (no force, or confirm accepted).
 */
async function forceGate(
  parsed: ParsedArgs,
  command: string,
  ctx: SessionCtx,
): Promise<CommandOutcome | undefined> {
  if (!parsed.force) return undefined; // not a force at all — nothing to gate
  if (!isMutating(parsed.command)) return undefined; // a read-only verb's --force is inert

  // A force-forbidding profile (ci) has no human at the keyboard to confirm — hard block.
  if (cliProfiles.profileForbidsForce(ctx.profile) && !process.env.PROM_ALLOW_FORCE) {
    return blocked(
      command,
      `--force is blocked under the '${ctx.profile}' profile. Set PROM_ALLOW_FORCE=1 to override (there is no human to type the confirmation).`,
    );
  }

  // Typed-confirm the override. We DON'T pre-judge danger — we only require the
  // human to acknowledge they are overriding the engine's verdict (C5).
  const phrase = "FORCE";
  const ok = await ctx.confirm(
    `'${command}' will run with --force, overriding the engine's nemesis verdict.\nType ${phrase} to proceed`,
    phrase,
  );
  if (!ok) return blocked(command, "force override declined — verb not run");
  return undefined; // confirmed — proceed
}

/**
 * Execute a session verb. `tokens` is the raw word list the user typed AFTER the
 * leading verb is included (e.g. ["install","foo","--dry-run"], ["plugin","list"],
 * ["scan"]). Parses with the SAME parser the one-shot CLI uses, applies the
 * never-force gate, then routes:
 *   - single-token spec verb  → invoke() (shares ctx.client, the GUI's exact path)
 *   - everything else         → dispatch() (full §2 tree + rich renderers + stubs)
 *
 * Crash-free: any thrown engine/transport error becomes a friendly CommandOutcome
 * (the session loop renders it and continues; it never sees a raw stack).
 */
export async function execVerb(tokens: string[], ctx: SessionCtx): Promise<CommandOutcome> {
  // An empty line / lone whitespace is a no-op the session swallows.
  const cleaned = tokens.filter((t) => t.length > 0);
  if (cleaned.length === 0) return { exitCode: 0 };

  // Inherit the session's active profile so the parse-level force semantics match
  // the session (the user typed `--profile` at launch, not per-verb). An explicit
  // per-verb `--profile` in `tokens` still wins (parseArgs lifts it).
  const argv = ctx.profile ? ["--profile", ctx.profile, ...cleaned] : cleaned;
  const parsed = parseArgs(argv);
  const command = parsed.command.length > 0 ? parsed.command.join(" ") : cleaned.join(" ");

  try {
    // `chat --cli X` from inside the session: PREVIEW only (launching a nested
    // interactive terminal would fight the host readline for stdin). Show the engine's
    // assembled argv + notes, then hint the one-shot launch from a shell.
    if (isTerminalChatCli(parsed)) {
      const preview = await routeTerminalChat(parsed, {
        client: ctx.client,
        json: ctx.json,
        write: ctx.write,
        confirm: ctx.confirm,
        previewOnly: true,
      });
      const cli = String(parsed.flags.cli);
      const hint = c.dim(
        `run \`prometheus chat --cli ${cli} --open\` from a shell to launch interactively.`,
      );
      return { ...preview, text: `${preview.text ?? ""}\n${hint}`.trim() };
    }

    // §4 never-force: hold a forced, mutating verb until the human type-confirms.
    const gate = await forceGate(parsed, command, ctx);
    if (gate) return gate;

    // STRUCTURAL PARITY: a single-token verb that maps to a CommandSpec routes
    // straight through the canonical router over the SESSION client (C5). This is
    // the byte-for-byte path the GUI palette uses, so describe/harden/chat/install/
    // apps/… reach the session with zero glue and share one engine connection.
    if (parsed.command.length === 1 && getCommandSpec(parsed.command[0] as string)) {
      return await routeViaInvoke(parsed.command[0] as string, parsed, ctx);
    }

    // Otherwise fall back to the one-shot dispatcher: rich renderers (scan/list/
    // info/gate/env/model/provider), multi-word §2 nouns (plugin install / repo add),
    // prom-native (profile/config), and honest not-yet-wired stubs — all reuse the
    // exact one-shot behavior, so the session is a true superset of the CLI.
    return await dispatch(parsed);
  } catch (err) {
    // Never leak a stack into the session; render a friendly line and continue.
    return outcomeFromError(err);
  }
}
