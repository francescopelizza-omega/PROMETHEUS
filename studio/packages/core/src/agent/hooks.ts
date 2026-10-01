// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * agent/hooks.ts — user-authored LIFECYCLE HOOKS around the shared agent turn.
 *
 * Three events, configured in settings as `hooks: [{event, matcher?, command}]`:
 *
 *   PreToolUse    runs BEFORE a tool call reaches the §4.3 broker/confirm seam. The
 *                 tool-call JSON (`{tool, args}`) goes in on stdin; a NONZERO EXIT DENIES
 *                 the call. This is the one place a hook can change what happens.
 *   PostToolUse   runs AFTER the call resolved, with the result JSON on stdin.
 *                 FIRE-AND-FORGET: it can never block, delay or fail a turn.
 *   SessionStart  runs once when a session opens; its stdout is folded into the thread as
 *                 a system block, the same channel steering/memory/repo-map already use.
 *
 * WHY IT LIVES HERE (and not in a host): the loop is the ONE chokepoint every surface
 * funnels through — CLI readline, CLI TUI, desktop pane, and `spawn_agent` sub-agents all
 * call `runAgentTurn`. Plan mode was enforced per-host once and meant three different things
 * on three surfaces as a result; hooks are not going to repeat that. A hook configured for a
 * session applies to a delegated sub-agent too, because `childTuning` carries the tuning.
 *
 * PURE. No `node:child_process` here — the host injects a `HookRunner` (see
 * `agent/system/host/hook-runner.ts` for the real spawn-based one, and every test in
 * `hooks.test.ts` / `loop.test.ts` for the fake). That keeps this module importable from the
 * C5-sandboxed renderer, which cannot spawn anything.
 *
 * FAIL-SOFT IS LOAD-BEARING. A hook is user-authored shell run on a hot path; a script that
 * throws, times out, writes garbage, or does not exist must leave the turn EXACTLY as it
 * would have been with no hook configured. The single intentional exception is a PreToolUse
 * hook that exits nonzero cleanly — that is a decision, not a failure.
 */
import { globToRegExp } from "../agents/sandbox.js";

/** The lifecycle events a hook may bind to. */
export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart";

/** The event ids, for validation + docs. */
export const HOOK_EVENTS: readonly HookEvent[] = Object.freeze([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
]);

/** One configured hook. `matcher` is a glob against the TOOL NAME (absent ⇒ every tool). */
export interface HookSpec {
  event: HookEvent;
  /** glob on the tool name (`write_file`, `mcp__*`, `*`). Ignored for SessionStart. */
  matcher?: string;
  /** the shell command line to run. stdin carries the event's JSON payload. */
  command: string;
}

/**
 * Wall-clock budget for ONE hook. Deliberately short: this runs between the model asking for
 * a tool and the tool running, on every single call, so a slow hook is felt as a slow agent.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/** One hook execution request handed to the injected runner. */
export interface HookInvocation {
  event: HookEvent;
  /** the shell command line. */
  command: string;
  /** the JSON payload to write to the child's stdin (already serialized). */
  stdin: string;
  timeoutMs: number;
}

/**
 * What a runner reports back. `timedOut` and `error` are the FAIL-SOFT channels — either one
 * means "treat as though no hook fired", never "deny". Only a clean nonzero `exitCode` denies.
 */
export interface HookOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** the hook exceeded its budget and was killed. NOT a deny. */
  timedOut?: boolean;
  /** the hook could not be run at all (spawn failure, bad shell, …). NOT a deny. */
  error?: string;
}

/** Run one hook command. INJECTED so this module stays node-free. */
export type HookRunner = (inv: HookInvocation) => Promise<HookOutcome>;

/* ── configuration parsing (drop-don't-throw, element-wise) ────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Is this a well-formed hook row? A row missing a known event or a non-empty command is not. */
export function isHookSpec(v: unknown): v is HookSpec {
  return (
    isRecord(v) &&
    typeof v.event === "string" &&
    (HOOK_EVENTS as readonly string[]).includes(v.event) &&
    typeof v.command === "string" &&
    v.command.trim().length > 0 &&
    (v.matcher === undefined || typeof v.matcher === "string")
  );
}

/**
 * Sanitize a persisted `hooks` value → `HookSpec[]`.
 *
 * ELEMENT-WISE, matching `validateSettings`' lenient contract: a non-array drops the key, and
 * one malformed row drops that row rather than every hook the user configured. A typo'd event
 * name silently never fires — which is the safe direction, since the alternative reading
 * ("run it on everything") would hand an unintended veto to a command the user bound to one
 * specific tool.
 */
export function validateHooks(v: unknown): HookSpec[] {
  if (!Array.isArray(v)) return [];
  const out: HookSpec[] = [];
  for (const row of v) {
    if (!isHookSpec(row)) continue;
    out.push({
      event: row.event,
      command: row.command,
      ...(row.matcher !== undefined ? { matcher: row.matcher } : {}),
    });
  }
  return out;
}

/* ── matching ─────────────────────────────────────────────────────────────── */

/**
 * Does a hook's matcher select this tool? An absent or empty matcher matches EVERYTHING.
 *
 * Uses the repo's own `globToRegExp` rather than a second glob dialect, and applies it to the
 * raw tool name (no path normalization — `mcp__server__tool` is a name, not a path).
 * A matcher that cannot compile matches nothing, so a broken pattern cannot accidentally
 * widen into a veto over every tool.
 */
export function hookMatchesTool(spec: HookSpec, tool: string): boolean {
  const m = spec.matcher?.trim();
  if (!m || m === "*") return true;
  try {
    return globToRegExp(m).test(tool);
  } catch {
    return false;
  }
}

/** The hooks bound to `event` that select `tool` (SessionStart ignores the tool entirely). */
export function matchingHooks(
  hooks: readonly HookSpec[] | undefined,
  event: HookEvent,
  tool?: string,
): HookSpec[] {
  if (!hooks || hooks.length === 0) return [];
  return hooks.filter(
    (h) => h.event === event && (event === "SessionStart" || hookMatchesTool(h, tool ?? "")),
  );
}

/* ── the PreToolUse refusal (same contract as the plan-mode refusal) ───────── */

/** The hint the model re-plans from after a hook veto. */
export const HOOK_REFUSAL_HINT =
  "a PreToolUse hook refused this call — do not retry it unchanged; try a different approach or ask the user";

/**
 * The JSON-serializable PreToolUse refusal fed back as a tool result.
 *
 * Intentionally the SAME shape as `planModeRefusal`: `{denied:true, tool, …, hint}`. A model
 * that learned to re-plan from one refusal contract should not have to learn a second one
 * because a different layer said no.
 */
export interface HookRefusal {
  denied: true;
  tool: string;
  event: "PreToolUse";
  /** the command that refused — named so the user can find it in their settings. */
  hook: string;
  hint: string;
}

/** Build the structured PreToolUse refusal for a hook-denied call. */
export function hookRefusal(tool: string, command: string): HookRefusal {
  return { denied: true, tool, event: "PreToolUse", hook: command, hint: HOOK_REFUSAL_HINT };
}

/* ── execution ────────────────────────────────────────────────────────────── */

/** Cap on hook stdout folded anywhere (a runaway `cat` must not enter the thread). */
export const HOOK_OUTPUT_CAP_CHARS = 8 * 1024;

function capText(s: string): string {
  return s.length <= HOOK_OUTPUT_CAP_CHARS ? s : `${s.slice(0, HOOK_OUTPUT_CAP_CHARS)}…[truncated]`;
}

/** JSON that can never throw on a circular/exotic arg — the payload is user data, not ours. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

/** A hook's veto: which command said no. */
export interface HookDenial {
  command: string;
}

/**
 * Run every PreToolUse hook matching `tool`, in configuration order, and report the FIRST
 * clean nonzero exit as a denial. Returns `undefined` when the call may proceed.
 *
 * Sequential on purpose: hooks are a policy chain, and a user who writes "deny writes outside
 * src" then "log everything" expects the deny to be attributable to the first rule that hit,
 * not to whichever of two parallel children happened to exit first.
 *
 * NEVER THROWS. A runner that rejects, a hook that times out, a hook that cannot be spawned:
 * all are logged through `onError` (when supplied) and treated as "no hook fired".
 */
export async function runPreToolUseHooks(
  hooks: readonly HookSpec[] | undefined,
  runner: HookRunner | undefined,
  call: { name: string; args: Record<string, unknown> },
  opts: { timeoutMs?: number; onError?: (message: string) => void } = {},
): Promise<HookDenial | undefined> {
  const matched = matchingHooks(hooks, "PreToolUse", call.name);
  if (matched.length === 0 || !runner) return undefined;
  const stdin = safeJson({ tool: call.name, args: call.args });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  for (const spec of matched) {
    let outcome: HookOutcome;
    try {
      outcome = await runner({ event: "PreToolUse", command: spec.command, stdin, timeoutMs });
    } catch (e) {
      opts.onError?.(`PreToolUse hook failed to run (${spec.command}): ${errText(e)}`);
      continue; // fail-soft: a broken hook is not a veto
    }
    if (outcome.error !== undefined) {
      opts.onError?.(`PreToolUse hook errored (${spec.command}): ${outcome.error}`);
      continue;
    }
    if (outcome.timedOut) {
      opts.onError?.(`PreToolUse hook timed out after ${timeoutMs}ms (${spec.command})`);
      continue;
    }
    if (typeof outcome.exitCode !== "number" || !Number.isFinite(outcome.exitCode)) {
      opts.onError?.(`PreToolUse hook returned no exit code (${spec.command})`);
      continue;
    }
    if (outcome.exitCode !== 0) return { command: spec.command };
  }
  return undefined;
}

/**
 * Fire every matching PostToolUse hook and RETURN IMMEDIATELY.
 *
 * Deliberately not awaited by the caller: a post hook is an observer, and an observer that can
 * add latency to (or fail) the turn it observes is a bug waiting to be filed as "the agent
 * hangs sometimes". Its exit code is ignored — there is nothing left to deny.
 *
 * Returns the in-flight promises so a TEST can await them; production callers ignore the
 * return value. Rejections are swallowed here, so no caller can ever see an unhandled one.
 */
export function firePostToolUseHooks(
  hooks: readonly HookSpec[] | undefined,
  runner: HookRunner | undefined,
  call: { name: string; args: Record<string, unknown> },
  result: unknown,
  opts: { timeoutMs?: number; onError?: (message: string) => void } = {},
): Promise<void>[] {
  const matched = matchingHooks(hooks, "PostToolUse", call.name);
  if (matched.length === 0 || !runner) return [];
  const stdin = safeJson({ tool: call.name, args: call.args, result });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  return matched.map(async (spec) => {
    try {
      const out = await runner({ event: "PostToolUse", command: spec.command, stdin, timeoutMs });
      if (out.error !== undefined) opts.onError?.(`PostToolUse hook errored: ${out.error}`);
      else if (out.timedOut) opts.onError?.(`PostToolUse hook timed out (${spec.command})`);
    } catch (e) {
      opts.onError?.(`PostToolUse hook failed to run (${spec.command}): ${errText(e)}`);
    }
  });
}

/** The system-block header a SessionStart hook's output arrives under. */
export const SESSION_START_BLOCK_HEADER = "<session-start-hooks>";

/**
 * Run the SessionStart hooks once and return their combined stdout as a system block, or
 * `undefined` when nothing was configured or nothing was printed.
 *
 * The block rides the SAME channel steering (`AGENTS.md`) and the memory index already use —
 * a `{role:"system"}` message assembled per turn — so a hook that prints "current sprint:
 * CLI-090" is context the model sees exactly the way a `PROMETHEUS.md` line would be. It is
 * captured ONCE at session start; the getter the host installs just replays it.
 *
 * NEVER THROWS. A hook that fails contributes nothing and the session opens normally.
 */
export async function runSessionStartHooks(
  hooks: readonly HookSpec[] | undefined,
  runner: HookRunner | undefined,
  opts: { timeoutMs?: number; onError?: (message: string) => void; cwd?: string } = {},
): Promise<string | undefined> {
  const matched = matchingHooks(hooks, "SessionStart");
  if (matched.length === 0 || !runner) return undefined;
  const stdin = safeJson({ event: "SessionStart", ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const chunks: string[] = [];
  for (const spec of matched) {
    try {
      const out = await runner({ event: "SessionStart", command: spec.command, stdin, timeoutMs });
      if (out.error !== undefined) {
        opts.onError?.(`SessionStart hook errored (${spec.command}): ${out.error}`);
        continue;
      }
      if (out.timedOut) {
        opts.onError?.(`SessionStart hook timed out after ${timeoutMs}ms (${spec.command})`);
        continue;
      }
      const text = typeof out.stdout === "string" ? out.stdout.trim() : "";
      if (text) chunks.push(text);
    } catch (e) {
      opts.onError?.(`SessionStart hook failed to run (${spec.command}): ${errText(e)}`);
    }
  }
  return sessionStartHookBlock(chunks);
}

/** Wrap SessionStart stdout chunks into the system block (or `undefined` when there is none). */
export function sessionStartHookBlock(chunks: readonly string[]): string | undefined {
  const body = chunks.filter((c) => c.trim().length > 0).join("\n\n");
  if (!body) return undefined;
  return `${SESSION_START_BLOCK_HEADER}\n${capText(body)}\n</session-start-hooks>`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
