// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/one-shot.ts — `prometheus -p "<prompt>"`: ONE agent turn, no TTY, then exit.
 *
 * Until now there was no way to get a tool-using turn without a terminal. That reads like a
 * missing convenience and is actually a missing capability: `prometheus chat "msg"` and
 * `cat task.md | prometheus chat` both route to the PYTHON engine's chat verb, which has no
 * tools, no broker, no gate events and no session transcript. So the agent — the whole point of
 * the product — was unreachable from a script, a CI job, a git hook or a pipe.
 *
 * DEFAULT POSTURE, and the one way out of it.
 *
 *   By default this run is READ-ONLY: it reads, searches, greps and reasons freely, and every
 *   write, command and install is refused with a reason the model can act on. That default is
 *   right and it stays.
 *
 *   It used to be a HARD LOCK with no way out, on the reasoning that a one-shot which can
 *   modify a repository from a script is a more dangerous product to opt into by accident.
 *   The reasoning is sound about ACCIDENT and wrong about the conclusion: every rival agentic
 *   CLI runs unattended in CI, and a headless mode that can never write cannot do the work.
 *   So the escape hatch is deliberately hard to type by accident and impossible to arrive at
 *   by default — `--allow-writes` and `--allow-commands` raise the autonomy ladder for
 *   this run only and are named for exactly what they permit (see `headlessAuthLevel`).
 *   Neither reaches `installs` or `runall`, and nothing raises the level without one of them
 *   on the command line — so the dangerous product is never the one you get by default.
 *
 *   It supplies NO `ask` in either posture: nobody is there. The `question` tool already
 *   refuses honestly in that case and tells the model to state its assumption instead.
 */
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  agent,
  ai,
  cliProfiles,
  loadPricing,
  orchestration,
  probeContextWindow,
} from "@prometheus/core";
import {
  createHookRunner,
  isPathAllowed,
  loadMemoryIndexBlock,
  loadPermissionRules,
  resolveEffectiveHooks,
} from "@prometheus/core/agent-system-host";
import { createEngineClient } from "@prometheus/engine-bridge";

import { resolveCwd } from "../cwd-guard.js";
import { prometheusHome } from "../home.js";
import type { ParsedArgs } from "../parse.js";
import { runElevationGate } from "../tui/sudo.js";
import { type SessionCtx, runMessageTurn } from "./agent-runtime.js";
import {
  SESSION_STORE_MAX_BYTES,
  appendTurnEvents,
  descriptorOf,
  recordSession,
  rotateSessions,
} from "./history-store.js";
import { loadHooksDetailed } from "./hooks-config.js";
import { makeBudgetGuard, seedTuningWithNotes } from "./host.js";
import { createKeyResolver, keychainProviders } from "./key-resolver.js";
import { type McpSession, openMcpSession, withMcpTools } from "./mcp-session.js";
import { type Backends, detectBackends, emptyBackends } from "./onboarding.js";
import { assembleSteering, discoverSteering } from "./steering.js";
import { execVarsFromEnv } from "./system-tools.js";

/** What a one-shot run produced, for the caller to render or serialize. */
export interface OneShotResult {
  ok: boolean;
  reply: string;
  /** tools the model actually called, in order — the honest record of what it did. */
  toolCalls: string[];
  /** true when the turn hit its round cap with the model still wanting to work. */
  capped: boolean;
  /** why it failed, when it did. */
  error?: string;
}

/**
 * Read the one-shot prompt out of the parsed args, or null when this is not a one-shot run.
 *
 * `-p` is NOT in the boolean-flag set, so the parser swallows the following token as its value
 * and leaves the command empty — which sets `repl: true` and would launch the full-screen TUI,
 * silently eating the prompt. Reading it here, before the interactive check, is what makes
 * `prometheus -p "..."` mean what it looks like it means.
 */
export function oneShotPrompt(parsed: ParsedArgs): string | null {
  for (const key of ["p", "print", "prompt"]) {
    const v = parsed.flags[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * The prompt from `prometheus chat "<message>"` — or null when that is not what this is.
 *
 * `chat` with a message printed a static capability blurb and exited 0:
 *
 *     $ prometheus chat "what is 2+2"
 *     chat
 *     modes: local, terminal
 *     clis: claude, codex, gemini, cursor, opencode
 *     runners: ollama, lmstudio
 *
 * The message was read from argv and then discarded. It is the most obvious command in the
 * product and the most obvious thing to type first, and it silently did nothing while
 * reporting success — including for `cat task.md | prometheus chat`, which `bin.ts` feeds
 * here as a positional. So it routes to the same agentic turn `-p` runs.
 *
 * `--cli` and `--local` are left alone: those name genuinely different surfaces (the terminal
 * CLI preview, and the engine's own local chat verb), and both are still reachable.
 */
export function chatPrompt(parsed: ParsedArgs): string | null {
  if (parsed.command[0] !== "chat") return null;
  if (parsed.flags.cli !== undefined || parsed.flags.local !== undefined) return null;
  const text = parsed.positionals.join(" ").trim();
  return text === "" ? null : text;
}

/**
 * How much this headless run is allowed to do, from explicit flags only.
 *
 * Two flags rather than one blanket bypass, each named for its exact effect, because "can
 * edit files" and "can execute arbitrary commands" are genuinely different risks and a CI
 * file should say which one it is granting. Neither reaches `installs` or `runall`: an
 * unattended run that can install packages is a decision to make deliberately at a keyboard,
 * not a side effect of wanting the tests to run.
 *
 *   (none)             → 1 readonly  — read, search, grep, reason. The default, unchanged.
 *   --allow-writes     → 2 edits     — …and write/patch/move/delete files.
 *   --allow-commands   → 4 commands  — …and run commands. Implies --allow-writes.
 */
export function headlessAuthLevel(parsed: ParsedArgs): number {
  if (parsed.flags["allow-commands"] === true) return 4;
  if (parsed.flags["allow-writes"] === true) return 2;
  return agent.DEFAULT_AUTH_LEVEL;
}

export interface OneShotDeps {
  /** injected in tests; defaults to the real turn. */
  runTurn?: typeof runMessageTurn;
  /** injected in tests; defaults to the real backend probe. */
  detect?: typeof detectBackends;
  write?: (line: string) => void;
  /** injected in tests; defaults to opening the real connectors (the same seam both hosts have). */
  mcp?: McpSession;
}

/**
 * Run one agent turn headlessly and return what happened.
 *
 * Never throws: a missing model, an unreachable runner and a mid-turn error all come back as
 * `{ok:false, error}` so the caller can choose an exit code and a rendering.
 */
export async function runOneShot(
  parsed: ParsedArgs,
  prompt: string,
  deps: OneShotDeps = {},
): Promise<OneShotResult> {
  const write = deps.write ?? (() => {});
  const runTurn = deps.runTurn ?? runMessageTurn;
  const detect = deps.detect ?? detectBackends;
  const client = createEngineClient();

  const { tuning, budget } = seedTuningWithNotes(parsed);
  const backends: Backends = await detect({ client }).catch(() => emptyBackends());
  /**
   * Cloud endpoints, discovered exactly as the two interactive hosts discover them.
   *
   * This path took `backends.localEndpoint` and nothing else, so `-p` could reach only a
   * runner on one of two hardcoded localhost ports. A machine with `ANTHROPIC_API_KEY`
   * exported and no Ollama running was told "no local model is available — start a runner",
   * which is both unhelpful and untrue. `resolveKey` was absent for the same reason, so even
   * a hand-picked cloud endpoint could not have authenticated: the native transport refuses a
   * keyed endpoint with no resolver.
   */
  const cloudKeys = await keychainProviders(orchestration.API_PROVIDER_IDS).catch(
    () => new Set<string>(),
  );
  const cloudEndpoints = ai.discoverCloudEndpoints({
    env: process.env,
    hasKeychainKey: (id) => cloudKeys.has(id),
  });
  // Local first when it exists — free, private, already warm — then any configured provider.
  let endpoint = backends.localEndpoint ?? cloudEndpoints[0]?.endpoint;
  if (!endpoint) {
    return {
      ok: false,
      reply: "",
      toolCalls: [],
      capped: false,
      error:
        "no model is available — start a local runner (e.g. `ollama serve`), " +
        "or connect a provider with `prometheus provider connect <id>`",
    };
  }

  /**
   * MEASURE the context window, exactly as the two interactive hosts do.
   *
   * A headless run budgeted against `DEFAULT_CONTEXT_WINDOW` (8192) whatever the model really
   * served, because only the TUI and the readline host ever attached the probe. That floor is
   * also what every context-sized budget reads, so a scripted run against a 32k model refused
   * its own second round ("this request is about 8012 tokens but the model's context window is
   * 8192") while the server had room to spare — measured 2026-09-24.
   *
   * Bounded and fail-soft: an unreachable runner leaves the floor in place, as before.
   */
  try {
    const probed = await probeContextWindow(
      endpoint.baseUrl,
      endpoint.model ?? endpoint.id,
      fetch as never,
    );
    if (probed.source !== "default") {
      endpoint = {
        ...endpoint,
        contextWindow: probed.contextWindow,
        ...(probed.capabilities ? { probedCapabilities: [...probed.capabilities] } : {}),
      };
    }
  } catch {
    /* fail-soft: the documented floor stands */
  }

  const cwd = resolveCwd(parsed.cwd, write);
  /**
   * A headless run is a SESSION, recorded through the same three primitives the two
   * interactive hosts use.
   *
   * It used to persist nothing at all: no index record, no transcript, no rotation — so
   * `prometheus sessions list|search`, `/recall`, `--continue`, `sessions fork` and
   * `buildSessionExport` were blind to every CI run. The accounting was worse than absent: it
   * was written under a `oneshot-<ts>` id in a namespace nothing else knew, so
   * `tokens report` could name a session whose transcript did not exist.
   *
   * `--session-id` makes a scripted run deterministic and appendable, which is what turns a
   * sequence of `-p` calls into one auditable job.
   */
  const home = prometheusHome();
  const budgetGuard = makeBudgetGuard(budget, loadPricing(), parsed.flags["force-budget"] === true);
  const explicitId =
    typeof parsed.flags["session-id"] === "string" ? parsed.flags["session-id"] : "";
  /**
   * A millisecond timestamp is NOT unique across concurrent processes.
   *
   * `headless-${Date.now().toString(36)}` gave two runs started in the same millisecond the SAME
   * id, and their transcripts interleaved into one file. Measured: four concurrent
   * `prometheus -p` runs produced two session files, not four — and the one surface that runs
   * unattended in CI is exactly where several runs start at once. The random suffix is what makes
   * the id unique; the timestamp stays because it keeps ids sortable by start time.
   */
  const sessionId =
    explicitId.trim() || `headless-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const liveTuning = {
    ...tuning,
    model: { provider: backends.localRunner?.name ?? "ollama", modelId: endpoint.model ?? "" },
  };
  /**
   * The headless confirm: auto-approve exactly what the autonomy ladder auto-approves at its
   * DEFAULT level, and refuse everything else with a reason the model can act on.
   *
   * Omitting `confirm` entirely looked right and was not: auto-approval by authorisation level
   * lives in the HOST's confirm, not in the loop, so a one-shot with no confirm could not even
   * `read_file` — the model burned its rounds retrying a read that would never be allowed. A1
   * (`readonly`) is the documented default and is exactly the useful headless posture: read,
   * search, grep and reason freely; refuse every write, command and install.
   *
   * `headlessAuthLevel` is the only thing that can raise it, and only from an explicit flag.
   */
  /**
   * ELEVATED-PRIVILEGE CLAMP — a headless run under sudo cannot acknowledge anything.
   *
   * The TUI stops for a red acknowledgement before opening a session as root. This path had no
   * notion of elevation at all, so `sudo prometheus -p "..."` — and every scheduled task on an
   * elevated agent — ran at whatever level the flags asked for, auto-approving writes and
   * commands as the superuser with nothing printed.
   *
   * There is nobody here to answer the acknowledgement, so the gate takes its SAFE branch:
   * ask-before-everything, bypass locked. Unattended is not a reason to skip the gate; it is a
   * reason to take the conservative side of it. `write` sends the notice to stderr, so a
   * `--json` consumer's stdout stays exactly one document.
   */
  const elevation = await runElevationGate({ write });
  let level = headlessAuthLevel(parsed);
  if (elevation.bypassLocked && level > 5) level = 5;
  const allowWrites = level > agent.DEFAULT_AUTH_LEVEL;
  const confirm = (call: {
    name: string;
    args?: Record<string, unknown>;
  }): { approved: boolean; reason?: string } | true => {
    const tool = agent.exposedTools(liveTuning.tools).find((t) => t.name === call.name);
    /**
     * SCOPED, same as the TUI's confirmWrite and the desktop's permission-gate: a `write_file`
     * whose target lands outside the run's own working set (cwd — a headless run has no
     * `/add-dir`) must never be auto-approved by the coarse authorisation level alone, because
     * there is no human here to actually see the out-of-scope path and answer for it. Without
     * this, `--allow-writes`/`--allow-commands` would silently let an unattended run (a
     * scheduled task, a CI job) write anywhere the OS process can reach — `~/.ssh`, `~/.zshrc`
     * — the exact escape `scopedWriteDecision` exists to close, already wired into every
     * interactive host but missing here.
     */
    const rawPath = call.args?.path;
    const path = typeof rawPath === "string" ? rawPath : undefined;
    // No path on a write-classified call is treated as OUTSIDE (fail-closed), matching
    // scopedWriteDecision's own "an unresolvable target counts as outside" contract.
    const insideWorkingSet =
      path !== undefined && isPathAllowed(isAbsolute(path) ? path : resolve(cwd, path), [cwd]);
    /**
     * `run_command`'s risk is its COMMAND, not its name.
     *
     * `scopedWriteDecision` grades a PATH; it cannot see that `npm install x` is an install and
     * `rm -rf /` is destructive, so it answered for `run_command` on the strength of the level
     * alone. That made this the weakest of the three hosts for exec — and the one that runs
     * UNATTENDED, from a scheduled task or a CI job, with no human to catch it. The tier-aware
     * ladder is the same one the TUI and `--plain` hosts use.
     *
     * Fail-closed: an unparseable or unclassifiable command is never auto-approved.
     */
    if (call.name === "run_command") {
      const line = typeof call.args?.command === "string" ? call.args.command : "";
      const parsedCmd = line ? agent.parseCommand(line, { vars: execVarsFromEnv() }) : null;
      const cls = parsedCmd?.ok ? agent.classifyCommand(parsedCmd.command) : null;
      if (cls?.ok && agent.execAuthDecision(level, cls.tier) === "allow") return true;
      const remedy = allowWrites
        ? "This run permits some changes but not this command's risk tier."
        : "Re-run with --allow-commands to permit commands.";
      return {
        approved: false,
        reason: `run_command needs a human approval and this is a non-interactive run. Do NOT retry it. ${remedy}`,
      };
    }
    const decision = agent.scopedWriteDecision(
      level,
      call.name,
      tool?.annotations,
      insideWorkingSet,
    );
    if (decision === "allow") {
      return true;
    }
    return {
      approved: false,
      reason: [
        `${call.name} needs a human approval and this is a non-interactive run. Do NOT retry it.`,
        allowWrites
          ? "This run permits some changes but not this tool; work within what is permitted."
          : "Read-only tools are available: answer from what you can inspect, and say plainly what you would have changed. Re-run with --allow-writes (file changes) or --allow-commands (also run commands) to permit them.",
      ].join(" "),
    };
  };

  /**
   * Project steering — AGENTS.md / CLAUDE.md / PROMETHEUS.md.
   *
   * `SessionCtx.steering` is optional, both interactive hosts set it, and this path did not.
   * That is the repo's signature defect: the field type-checks either way, so a headless run
   * silently ignored every project instruction the user had written, while the same prompt
   * typed into the REPL honoured them. Read once here — a one-shot has no reload to worry
   * about — and fail-soft, because an unreadable steering file must not take the run with it.
   */
  const steeringBlock = ((): string => {
    try {
      return assembleSteering(discoverSteering(cwd));
    } catch {
      return "";
    }
  })();
  // Durable cross-session memory — same "read once here, no reload to worry about" posture as
  // steering above, and the same fail-soft framing: an unreadable/missing index must not take
  // a headless run down with it.
  const memoryBlock = ((): string | null => {
    try {
      return loadMemoryIndexBlock(home, cwd);
    } catch {
      return null;
    }
  })();

  /**
   * MCP connectors, in the UNATTENDED path too.
   *
   * Both interactive hosts open an MCP session and fold its tools into the turn; this one did
   * not mention MCP at all. So a user who configured a connector got its tools in the TUI, got
   * them in the readline session, and got none of them from `prometheus -p "…"` — the surface
   * a script or a CI job actually uses, and the one where "the tool just isn't there" is
   * hardest to notice, because there is nobody watching the tool list.
   *
   * Free when nothing is configured: `openMcpSession` starts no process in that case. Failure
   * is soft for the same reason it is in the hosts — a broken connector must not take down a
   * run that did not need it.
   */
  const mcp = deps.mcp ?? (await openMcpSession({ home, write }).catch(() => undefined));
  const mcpTools = mcp?.tools() ?? [];

  /**
   * A headless run honours the user's LIFECYCLE HOOKS too — it did not.
   *
   * Both interactive hosts resolve hooks and put them on the tuning; this path built its
   * `SessionCtx` by hand and set neither `hooks` nor `hookRunner`, so every hook seam in the
   * shared loop was inert here. A `PreToolUse` hook written specifically to DENY something
   * simply did not run on `-p` or on any scheduled task — the two surfaces that execute with
   * nobody watching, which is exactly where a deny guard earns its keep. It is the same
   * omission already fixed twice on this object, for `permissionRules` and for `budget`.
   *
   * WORKSPACE hooks are deliberately NOT trusted here. The interactive hosts can afford to ask,
   * because a human is present to read the nemesis verdict and answer; unattended, the confirm
   * seam auto-approves whatever the autonomy ladder allows, and routing a repo-supplied command
   * through that would hand any cloned repository code execution in CI. So the confirm passed to
   * the resolver always declines: the user's own GLOBAL hooks apply, a workspace list that only
   * re-selects hooks the user already has still works (the resolver returns early when nothing
   * is novel), and a genuinely new repo-supplied hook is refused and reported rather than run.
   */
  const rawHooks = loadHooksDetailed({ home, cwd });
  const { hooks: sessionHooks, refused: hookRefusals } = await resolveEffectiveHooks({
    home,
    cwd,
    globalHooks: rawHooks.globalHooks,
    workspaceHooks: rawHooks.workspaceHooks,
    confirm: async () => false,
  });
  for (const r of hookRefusals) {
    write(`hook refused (${r.event}): ${r.command} — ${r.reason}`);
  }
  const hookRunner =
    sessionHooks.length > 0 ? createHookRunner({ cwd, env: process.env }) : undefined;

  const baseTuning = mcpTools.length > 0 ? withMcpTools(liveTuning, mcpTools) : liveTuning;
  const ctx: SessionCtx = {
    client,
    tuning: {
      ...baseTuning,
      // Hooks ride the TUNING so a `spawn_agent` child inherits them through `childTuning`.
      ...(sessionHooks.length > 0 ? { hooks: sessionHooks } : {}),
      ...(hookRunner ? { hookRunner } : {}),
    },
    json: parsed.json,
    endpoint,
    confirm,
    // No `ask` — nobody is there. The `question` tool already refuses honestly in that case.
    write,
    cwd,
    home,
    workingSet: [cwd],
    todos: new agent.TodoStore(),
    accounting: { home, sessionId },
    resolveKey: createKeyResolver(),
    /**
     * A headless run honours the user's rules too — especially the DENY ones.
     *
     * The rule engine used to be gated on a grant store, which this path has no reason to
     * carry (nobody is here to remember an answer for), so a `deny` a user had written could
     * not reach the one surface that runs unattended.
     */
    permissionRules: loadPermissionRules({ cwd }).rules,
    /**
     * The run's REAL authorisation level, recorded on every exec-audit line.
     *
     * This literal never set it, so `ctx.authLevel` was undefined and the runner fell back to
     * `-1` — on the ONE surface that runs unattended, where the audit is the only record of what
     * an agent was permitted to do. `--allow-commands` runs at level 4 and every line still said
     * `authLevel:-1`, so the log could not distinguish an elevated CI run from a default one.
     * `level` is the same value the confirm seam above decides with, so the audit now agrees
     * with the policy that was actually applied.
     */
    authLevel: level,
    /**
     * The USD spend cap applies to UNATTENDED runs too — it did not.
     *
     * This path built its `SessionCtx` by hand with `accounting` but no `budget`, so a
     * `session_usd` cap the user had configured was enforced in both interactive hosts and
     * silently ignored by the one surface that runs in a loop in CI with nobody watching.
     */
    ...(budgetGuard ? { budget: budgetGuard } : {}),
    ...(steeringBlock ? { steering: () => steeringBlock } : {}),
    ...(memoryBlock ? { memory: () => memoryBlock } : {}),
    // Advertising a tool the runner cannot dispatch is worse than not advertising it.
    ...(mcp ? { callMcpTool: (id, tool, args) => mcp.callTool(id, tool, args) } : {}),
  };

  // Recorded BEFORE the turn: a run that crashes is exactly the one worth having a record of.
  recordSession(home, {
    id: sessionId,
    ts: new Date().toISOString(),
    descriptor: descriptorOf(prompt),
    cwd,
    kind: "headless",
  });
  /**
   * Shut the connectors down on EVERY exit path, including the throwing one.
   *
   * A headless run is short and the process usually ends right after — but "usually" is not a
   * lifecycle, and a `-p` call inside a longer-lived process (a test, a wrapper) would leave a
   * connector subprocess behind on each invocation. The reaper catches what this misses; this
   * is the ordered shutdown that should not need it.
   */
  const closeMcp = async (): Promise<void> => {
    await mcp?.close().catch(() => {});
  };
  try {
    const res = await runTurn(undefined, prompt, { ctx });
    appendTurnEvents(home, sessionId, [{ role: "user", text: prompt }, ...res.events]);
    rotateSessions(home, { maxBytes: SESSION_STORE_MAX_BYTES, liveId: sessionId });
    const toolCalls = res.events
      .filter((e) => e.kind === "tool_use")
      .map((e) => (e as { call: { name: string } }).call.name);
    /**
     * The exit code has to mean something, because a script is reading it.
     *
     * `ok: true` was returned for every turn that did not THROW — so a provider hard failure,
     * a refused-everything run and a model that produced nothing all exited 0. In CI that is
     * the worst possible outcome: the job goes green and the work did not happen.
     *
     * A turn failed if the runtime emitted a `blocked` event naming the model, or if it ended
     * with no reply AND no tool calls: there is no reading of "no output, no actions" that is
     * a success. Being capped is NOT a failure — the model was working and ran out of rounds,
     * which `capped` already reports for the caller to act on.
     */
    const failure = res.events.find(
      (e): e is Extract<typeof e, { kind: "blocked" }> =>
        e.kind === "blocked" && !e.tool && /model|endpoint|provider/i.test(e.reason),
    );
    const modelError = res.events.find(
      (e): e is Extract<typeof e, { kind: "text" }> =>
        e.kind === "text" && /^model error:/i.test(e.text.trim()),
    );
    const empty = res.reply.trim() === "" && toolCalls.length === 0;
    const error = failure?.reason ?? modelError?.text.trim();
    if (error || empty) {
      return {
        ok: false,
        reply: res.reply,
        toolCalls,
        capped: res.capped === true,
        error: error ?? "the model produced no reply and called no tools",
      };
    }
    return { ok: true, reply: res.reply, toolCalls, capped: res.capped === true };
  } catch (err) {
    return {
      ok: false,
      reply: "",
      toolCalls: [],
      capped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await closeMcp();
  }
}

/** The human rendering: the reply, then one honest line about what was refused or cut short. */
export function renderOneShot(r: OneShotResult): string {
  if (!r.ok) return `prometheus: ${r.error ?? "one-shot failed"}`;
  const tail = oneShotNotes(r);
  return `${r.reply.trim()}${tail ? `\n\n${tail}` : ""}`;
}

/**
 * The trailing notes ALONE — for a caller that already streamed the reply.
 *
 * `runOneShot` streams every line through `write` as it arrives, and `bin.ts` then printed
 * `renderOneShot(res)`, which begins with the whole reply again. So every headless answer was
 * emitted TWICE: once streamed, once in full. Anything parsing the output saw the response
 * duplicated, and a long answer doubled the bytes for no benefit.
 */
export function oneShotNotes(r: OneShotResult): string {
  const notes: string[] = [];
  if (r.capped) {
    notes.push("(stopped at the step cap — the model still wanted to continue)");
  }
  // Naming the tools it ran is the difference between "it answered" and "it did something".
  if (r.toolCalls.length > 0) notes.push(`(tools: ${r.toolCalls.join(", ")})`);
  return notes.join(" ");
}
