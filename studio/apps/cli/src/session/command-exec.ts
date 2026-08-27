/**
 * session/command-exec.ts — run a `prometheus` VERB from inside the interactive
 * session (P4) through the SAME dispatcher the one-shot CLI uses. This is what makes
 * "anything you can type as `prometheus <verb>` you can type at the session prompt"
 * STRUCTURAL: EVERY verb goes to `dispatch()` — rich renderers, multi-word §2 nouns,
 * and honest stubs alike — with the session's own EngineClient injected so the
 * one-gateway invariant (C5) holds without a second routing path. Spec verbs with no
 * bespoke renderer still land on `invoke()`, because `dispatch` itself falls through
 * to `routeViaRegistry` — the canonical router the GUI palette calls.
 *
 * NEVER-FORCE / GATE-FIRST: a mutating verb carrying --force is held BEFORE it
 * reaches the engine. The session must type-confirm the override via ctx.confirm;
 * a force-forbidding profile (ci) hard-blocks with no override (there is no human
 * keystroke that can satisfy a non-interactive profile). Nothing here decides
 * "safe" — that stays the engine's nemesis verdict (C5). Every turn is wrapped so
 * an engine/transport error renders a friendly line and the session continues.
 */
import { cliProfiles } from "@prometheus/core";
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
  "disinfect",
  "quarantine",
  // "harden" is deliberately NOT here: it is a read-only, THIS-machine-only posture audit
  // (roSpec, no args/flags ever forwarded — see packages/core/src/commands.ts) that never
  // touches nemesis/gate at all. Its presence used to make `/harden --force` show a needless,
  // factually-wrong typed-confirm ("overriding the engine's nemesis verdict") that could only
  // ever block the harmless report, never override anything (the flag was never forwarded).
]);

/**
 * pentest's own destructive actions, checked as a (family, action) PAIR rather than as bare
 * words in `MUTATING_VERBS` — "build"/"run"/"shell" are common enough words (e.g. `/test run`)
 * that adding them as bare entries would wrongly force-gate unrelated commands that happen to
 * share a path segment with them.
 */
const PENTEST_MUTATING_ACTIONS = new Set(["destroy", "build", "run", "shell"]);

/** Does this parsed command path mutate state (drives the §4 force guard)? */
function isMutating(path: readonly string[]): boolean {
  if (path[0] === "pentest" && path[1] !== undefined && PENTEST_MUTATING_ACTIONS.has(path[1])) {
    return true;
  }
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
  // EXACTLY "1" — see `forceOverrideAllowed`. The bare presence check this replaced let
  // PROM_ALLOW_FORCE=0 open the escape hatch it was meant to close.
  if (cliProfiles.profileForbidsForce(ctx.profile) && !cliProfiles.forceOverrideAllowed()) {
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
 * never-force gate, then routes everything through dispatch() over ctx.client — the
 * full §2 tree (rich renderers + multi-word nouns + parity registry + honest stubs).
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

    // ONE path for every verb: the one-shot dispatcher, over the SESSION's client.
    //
    // A single-token spec verb used to short-circuit into invoke() here so it could share
    // the session's EngineClient (C5 — one gateway). But `dispatch` is not a superset of
    // invoke() only for the verbs WITHOUT a hand-written renderer — for `scan`/`list`/
    // `info`/`doctor`/`apps`/… it is strictly richer, and the short-circuit meant 28 of the
    // 121 slash commands printed `<verb>: ok` in-session while the identical shell command
    // printed a full table. Injecting the client keeps the one-gateway invariant while the
    // routing itself stays single-sourced: `dispatch` falls through to `routeViaRegistry`
    // (the SAME `invoke(id, {client})` the GUI palette calls) for every spec verb that has
    // no richer renderer, so parity is preserved by construction rather than by a list that
    // can drift.
    return await dispatch(parsed, { client: ctx.client });
  } catch (err) {
    // Never leak a stack into the session; render a friendly line and continue.
    return outcomeFromError(err);
  }
}
