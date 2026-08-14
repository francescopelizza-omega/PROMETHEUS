/**
 * host.test.ts — drive launchSession with a SCRIPTED fake readline + fake handlers.
 *
 * No real TTY, no real engine, no real model: a tiny EventEmitter-backed fake
 * readline replays input lines, and the three line-handlers are injected as
 * deterministic fakes MATCHING THEIR REAL SIBLING SIGNATURES (execSlash →
 * SlashResult union, execVerb → CommandOutcome, runMessageTurn(session,message,deps)
 * → MessageTurnResult). We assert: profile seeding, banner/footer rendering, slash
 * vs verb vs message routing, /quit exit code, crash-free behavior on a throwing
 * handler, Ctrl-C cancelling the in-flight turn (not the session), and the confirm
 * seam reading from readline.question.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** A throwaway ~/.prometheus home per test run — never touches the real $HOME. */
const TMP_HOME = mkdtempSync(join(tmpdir(), "prom-home-"));

import type { CommandOutcome } from "../context.js";
import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import type { MessageTurnResult } from "./agent-runtime.js";
import { type SessionHandlers, launchSession, makeBudgetGuard, seedTuning } from "./host.js";
import type { SlashResult } from "./slash-exec.js";

// Color OFF so assertions match plain text (no ANSI escapes in captured output).
setColorEnabled(false);

/** A minimal ParsedArgs for a bare interactive session. */
function args(over: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: [],
    positionals: [],
    json: false,
    noColor: true,
    help: false,
    version: false,
    repl: true,
    dryRun: false,
    yes: false,
    strict: false,
    force: false,
    noGate: false,
    verbose: false,
    quiet: false,
    flags: {},
    cwd: "/tmp/session",
    ...over,
  };
}

/** A canned MessageTurnResult so a fake runMessageTurn satisfies the real return type. */
function turnResult(reply: string): MessageTurnResult {
  return {
    session: {
      id: "s1",
      title: "session",
      createdAt: "t0",
      updatedAt: "t0",
      turns: [],
    },
    events: [],
    reply,
    jsonl: "",
  };
}

/**
 * A scripted fake readline: emits the given lines (in order) on the next tick after
 * the host wires its "line" listener, then emits "close".
 */
class FakeReadline extends EventEmitter {
  private lines: string[];
  public questions: string[] = [];
  private answer: string;

  constructor(lines: string[], opts: { answer?: string } = {}) {
    super();
    this.lines = lines;
    this.answer = opts.answer ?? "n";
  }

  /** The host calls .question() for the confirm seam; reply with the canned answer. */
  question(prompt: string, cb: (answer: string) => void): void {
    this.questions.push(prompt);
    cb(this.answer);
  }

  close(): void {
    this.emit("close");
  }

  /** Begin replaying the scripted lines (called once the host is listening). */
  drive(): void {
    let i = 0;
    const step = (): void => {
      if (i >= this.lines.length) {
        this.emit("close"); // Ctrl-D equivalent
        return;
      }
      const line = this.lines[i++];
      this.emit("line", line ?? "");
      setImmediate(step);
    };
    setImmediate(step);
  }
}

/** Build a launchSession run wired to a fake readline + capturing writer. */
function runSession(
  lines: string[],
  handlers: Partial<SessionHandlers> = {},
  opts: { argsOver?: Partial<ParsedArgs>; answer?: string } = {},
): Promise<{ code: number; out: string; rl: FakeReadline }> {
  const out: string[] = [];
  const rl = new FakeReadline(lines, opts.answer !== undefined ? { answer: opts.answer } : {});
  const p = launchSession(args(opts.argsOver), {
    isTty: true,
    makeReadline: () => {
      setImmediate(() => rl.drive());
      return rl as unknown as never;
    },
    write: (s) => out.push(s),
    handlers,
    // skip the startup network/engine probe — deterministic "no backend" for tests.
    backends: { liveRunners: [], paidClis: [] },
    home: TMP_HOME,
  });
  return p.then((code) => ({ code, out: out.join(""), rl }));
}

test("seedTuning: default profile + flags win (gate-mode/dry-run/yes layered on)", () => {
  const base = seedTuning(args());
  assert.equal(base.gateMode, "warn"); // default profile ships gate=warn
  const tuned = seedTuning(args({ gateMode: "enforce", dryRun: true, yes: true }));
  assert.equal(tuned.gateMode, "enforce");
  assert.equal(tuned.dryRun, true);
  assert.equal(tuned.yes, true);
  // an unknown profile falls back to default (does not throw).
  assert.equal(seedTuning(args({ profile: "nope" })).gateMode, "warn");
});

test("non-TTY without an injected readline refuses gracefully (exit 1)", async () => {
  const out: string[] = [];
  const code = await launchSession(args(), { isTty: false, write: (s) => out.push(s) });
  assert.equal(code, 1);
  assert.match(out.join(""), /needs a TTY/);
});

test("banner + footer render; a message routes to runMessageTurn (which streams its reply)", async () => {
  let seenMessage = "";
  const { code, out } = await runSession(["hello there"], {
    // the REAL runtime streams its reply text through ctx.write as it arrives — so
    // the host must NOT double-print res.reply. The fake mirrors that contract.
    runMessageTurn: async (_session, message, deps) => {
      seenMessage = message;
      deps.ctx.write("hi back\n");
      return turnResult("hi back");
    },
  });
  assert.equal(code, 0);
  assert.equal(seenMessage, "hello there");
  assert.match(out, /████ █████/); // big block PROMETHEUS wordmark (…E T…)
  assert.match(out, /gate:warn/); // footer reflects the default tuning
  assert.match(out, /hi back/); // the runtime's streamed reply reached stdout
  // the host must not DOUBLE-print the reply (runtime already streamed it).
  assert.equal(out.match(/hi back/g)?.length, 1);
  assert.match(out, /session ended/); // clean close note
});

test("registry handles /quit (exits, code 0); an UNKNOWN /slash falls back to execSlash", async () => {
  // /quit + /gate are now host-registry commands (not legacy execSlash); only a slash the
  // registry doesn't know falls through to the legacy core brain.
  const seen: Array<{ name: string; rest: string }> = [];
  const { code } = await runSession(["/totallyunknownslash foo", "/quit"], {
    execSlash: async (name, rest): Promise<SlashResult> => {
      seen.push({ name, rest });
      return { kind: "error", text: "unknown slash" };
    },
  });
  assert.equal(code, 0); // /quit (registry) exited cleanly
  assert.deepEqual(seen, [{ name: "totallyunknownslash", rest: "foo" }]); // only the unknown one
});

test("a known single-token verb routes to execVerb (not the agent)", async () => {
  let verbTokens: string[] = [];
  let messageCalled = false;
  const { out } = await runSession(["scan"], {
    execVerb: async (tokens): Promise<CommandOutcome> => {
      verbTokens = tokens;
      return { text: "scanned: 0 findings", exitCode: 0 };
    },
    runMessageTurn: async () => {
      messageCalled = true;
      return turnResult("");
    },
  });
  assert.deepEqual(verbTokens, ["scan"]);
  assert.equal(messageCalled, false);
  assert.match(out, /scanned: 0 findings/);
});

test("a noun-led natural SENTENCE is a message, not a verb (multi-token → no mis-route)", async () => {
  let routedAsVerb = false;
  let routedAsMessage = false;
  await runSession(["list all the times you helped me today"], {
    execVerb: async () => {
      routedAsVerb = true;
      return { exitCode: 0 };
    },
    runMessageTurn: async () => {
      routedAsMessage = true;
      return turnResult("ok");
    },
  });
  // "list ..." is multi-token → treated as a chat message (only the BARE single-token
  // verb form routes to execVerb), so the agent path wins.
  assert.equal(routedAsVerb, false);
  assert.equal(routedAsMessage, true);
});

test("crash-free: a throwing handler renders a friendly line and the loop continues", async () => {
  let secondCalled = false;
  const { code, out } = await runSession(["boom", "ok"], {
    runMessageTurn: async (_session, message) => {
      if (message === "boom") throw new Error("engine exploded");
      secondCalled = true;
      return turnResult("recovered");
    },
  });
  assert.equal(code, 0);
  assert.equal(secondCalled, true); // the loop survived the throw
  assert.match(out, /engine exploded/); // friendly mapped message (no stack)
  assert.doesNotMatch(out, /at Object|\.ts:\d+/); // never a raw stack trace
});

test("Ctrl-C during a turn cancels the in-flight turn; the session stays alive", async () => {
  let laterRan = false;
  const out: string[] = [];
  const rl = new FakeReadline(["long task", "after"]);
  const code = await launchSession(args(), {
    isTty: true,
    makeReadline: () => {
      setImmediate(() => rl.drive());
      return rl as unknown as never;
    },
    write: (s) => out.push(s),
    backends: { liveRunners: [], paidClis: [] },
    home: TMP_HOME,
    handlers: {
      runMessageTurn: async (_session, message) => {
        if (message === "long task") {
          // simulate Ctrl-C landing mid-turn, then yield so the host SIGINT handler runs.
          rl.emit("SIGINT");
          await new Promise((r) => setImmediate(r));
          return turnResult("");
        }
        laterRan = true;
        return turnResult("done");
      },
    },
  });
  assert.equal(code, 0);
  assert.match(out.join(""), /cancelled/); // the host announced the in-turn cancel
  assert.equal(laterRan, true); // a later line still ran → session survived Ctrl-C
});

test("the confirm seam asks via readline.question and honors a typed no", async () => {
  let confirmed: boolean | null = null;
  const rl = new FakeReadline(["risky"], { answer: "n" });
  const out: string[] = [];
  await launchSession(args(), {
    isTty: true,
    makeReadline: () => {
      setImmediate(() => rl.drive());
      return rl as unknown as never;
    },
    write: (s) => out.push(s),
    backends: { liveRunners: [], paidClis: [] },
    home: TMP_HOME,
    handlers: {
      runMessageTurn: async (_session, _message, deps) => {
        // agent-runtime's confirm takes a ToolCall; the host adapts it to a readline y/N.
        confirmed = await (deps.ctx.confirm?.({ name: "scan", args: {} }) ??
          Promise.resolve(false));
        return turnResult("");
      },
    },
  });
  assert.equal(confirmed, false); // default-deny on "n"
  assert.ok(rl.questions.length >= 1); // the readline question seam was exercised
});

/* ── host parity: the two front ends must offer the SAME agent ──────────────*/

/**
 * Capture the SessionCtx the readline host hands to a turn.
 *
 * This exists because the two hosts silently diverged: the TUI wired the task list and the
 * remembered-grant store, this one did not, so `todowrite` reported itself unavailable and
 * every approval was asked again — depending on nothing but which front end you launched.
 * A capability that only half the hosts wire is a capability that does not exist.
 */
async function captureCtx(
  over: Parameters<typeof launchSession>[1] = {},
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const rl = new FakeReadline(["hello"]);
  await launchSession(args(), {
    isTty: true,
    makeReadline: () => {
      setImmediate(() => rl.drive());
      return rl as unknown as never;
    },
    write: () => {},
    backends: { liveRunners: [], paidClis: [] },
    home: TMP_HOME,
    ...over,
    handlers: {
      runMessageTurn: async (_s, _m, deps) => {
        captured = deps.ctx as unknown as Record<string, unknown>;
        return turnResult("");
      },
    },
  });
  return captured;
}

test("the readline host wires the task list, so todowrite is not a dead tool", async () => {
  const ctx = await captureCtx();
  assert.ok(ctx.todos, "no TodoStore reached the turn — todowrite would report unavailable");
  assert.equal(typeof ctx.onTodos, "function", "a written plan would never be rendered");
});

test("the readline host wires remembered grants, so `don't ask again` can work", async () => {
  const ctx = await captureCtx();
  assert.ok(ctx.grants, "no permission store reached the turn");
  assert.equal(typeof ctx.onRemember, "function");
  assert.equal(typeof ctx.onAutoApprove, "function");
});

test("an MCP session's tools reach the catalog the model is shown", async () => {
  const fakeMcp = {
    tools: () => [
      {
        name: "mcp__x__ping",
        title: "ping",
        description: "",
        schema: {},
        annotations: {},
        toArgv: () => [],
      },
    ],
    callTool: async () => ({ ok: true, summary: "pong" }),
    banner: () => "",
    close: async () => {},
  };
  const ctx = await captureCtx({ mcp: fakeMcp });
  const tuning = ctx.tuning as { tools: { extra?: { name: string }[] } };
  assert.ok(
    tuning.tools.extra?.some((t) => t.name === "mcp__x__ping"),
    "the connector's tool never reached the catalog",
  );
  assert.equal(typeof ctx.callMcpTool, "function", "the tool was offered with no way to run it");
});

test("with no MCP session the catalog is unchanged and no dispatcher is claimed", async () => {
  // Offering a tool the host cannot dispatch is worse than not offering it: the model spends a
  // round discovering the failure.
  const ctx = await captureCtx({ mcp: undefined });
  const tuning = ctx.tuning as { tools: { extra?: { name: string }[] } };
  assert.equal(
    tuning.tools.extra?.some((t) => t.name.startsWith("mcp__")),
    false,
  );
});

/* ── the spend cap: wired, not merely declared ─────────────────────────────*/

/**
 * `checkBudgetGate` has been called since CLI-030 and could never fire: it returns "ok" unless
 * BOTH `ctx.budget` and `ctx.accounting` are set, and neither host set either. So `[budget]
 * session_usd = 5` in a profile was decoration, and `prometheus tokens report` read a store
 * nothing ever wrote. These pin the wiring rather than the gate (which has its own tests).
 */

test("the readline host wires token accounting, so the store is not always empty", async () => {
  const ctx = await captureCtx();
  const acct = ctx.accounting as { home?: string; sessionId?: string } | undefined;
  assert.ok(acct, "no accounting sink — `prometheus tokens report` reads an empty store");
  assert.equal(typeof acct?.home, "string");
  assert.equal(typeof acct?.sessionId, "string");
});

test("makeBudgetGuard maps the price fields ACROSS the two naming conventions", () => {
  // The registry says inputUsdPerMTok; the guardrail wants pricePerMTokIn. Every field on both
  // is optional, so the wrong shape is not a type error — it silently prices every turn at $0
  // and the cap never fires. This is the assertion that would have caught that.
  const guard = makeBudgetGuard(
    { sessionUsd: 5 },
    { "gpt-x": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } },
    false,
  );
  assert.ok(guard, "a declared cap produced no guard");
  const price = guard?.priceFor("gpt-x");
  assert.equal(price?.pricePerMTokIn, 3);
  assert.equal(price?.pricePerMTokOut, 15);
});

test("an unpriced model yields NO price rather than a free one", () => {
  // Reporting 0 would be a measurement ("this cost nothing"). Absent is the honest answer.
  const guard = makeBudgetGuard({ sessionUsd: 5 }, {}, false);
  assert.equal(guard?.priceFor("who-knows"), undefined);
});

test("a profile with no [budget] table produces no guard — zero regression", () => {
  assert.equal(makeBudgetGuard(undefined, {}, false), undefined);
  // …and a table with only a warn percentage is not a cap either.
  assert.equal(makeBudgetGuard({ warnAtPercent: 80 }, {}, false), undefined);
});

test("--force-budget rides the guard and is never sourced from a profile", () => {
  // A config file must not be able to pre-authorise blowing through its own cap.
  assert.equal(makeBudgetGuard({ sessionUsd: 1 }, {}, true)?.forceBudget, true);
  assert.equal(makeBudgetGuard({ sessionUsd: 1 }, {}, false)?.forceBudget, false);
});

/* ── Ctrl-C has to reach the TURN, not just the prompt ─────────────────────── */

test("the readline host hands runMessageTurn an abort signal", async () => {
  // `turnAbort` was created, aborted by the SIGINT handler, and handed to nothing. So Ctrl-C
  // printed "(cancelled …)" and returned to the prompt while the turn kept running: the model
  // kept streaming and every remaining tool in the round still executed. A user who hit
  // Ctrl-C to stop a destructive command watched it run anyway.
  //
  // Asserted as "a live, un-aborted signal arrives", which is the property the cancel path
  // needs — a test that only checked `signal !== undefined` would pass on a stale controller.
  let signal: AbortSignal | undefined;
  await runSession(["do the thing"], {
    runMessageTurn: async (_session, _message, deps) => {
      signal = (deps as { signal?: AbortSignal }).signal;
      return turnResult("done");
    },
  });
  assert.ok(signal, "no signal reached the turn — Ctrl-C cannot cancel it");
  assert.equal(signal.aborted, false, "the turn was handed an already-aborted signal");
});

test("/continue is interruptible too — a continuation is a full turn", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  await runSession(["do the thing", "/continue"], {
    runMessageTurn: async (_session, _message, deps) => {
      seen.push((deps as { signal?: AbortSignal }).signal);
      // `capped` + `thread` is what stashes a resume point; without it /continue reports
      // "nothing to continue" and never runs a second turn.
      return { ...turnResult("partial"), capped: true, thread: [] } as never;
    },
  });
  assert.equal(seen.length, 2, "the /continue turn did not run");
  assert.ok(seen[1], "the continuation turn got no abort signal");
});

/* ── the autonomy ladder actually decides something ────────────────────────── */

test("/authorisation raises the ladder and the readline host HONOURS it", async () => {
  // `hostAuthLevel` was read from disk, exposed via getAuthLevel, written by /authorisation
  // and persisted as the next session's default — and consulted by nothing. So the command
  // printed "(saved as default)" and changed nothing: a user who raised their autonomy was
  // still asked about every read, and one who LOWERED it to `paranoid` was not protected.
  //
  // Driven through the real ctx.confirm, with NO answer available on stdin — so anything that
  // reaches the prompt cannot come back `true`.
  const decisions: Array<boolean | object> = [];
  await runSession(["/authorisation 5", "go"], {
    runMessageTurn: async (_s, _m, deps) => {
      const ctx = deps.ctx as { confirm?: (c: { name: string }) => Promise<unknown> };
      if (ctx.confirm) decisions.push((await ctx.confirm({ name: "read_file" })) as boolean);
      return turnResult("done");
    },
  });
  assert.equal(decisions[0], true, "a read at level 5 must be auto-approved, not prompted");
});

test("at a LOW level a write is still put to the human", async () => {
  // The other direction: the ladder must not become a blanket auto-approve. The level is set
  // explicitly rather than relied on as a default, because `/authorisation` persists to the
  // home directory — so a test that assumed the default would depend on test ORDER, and would
  // have passed here for the wrong reason after the previous test raised it to 5.
  const decisions: Array<unknown> = [];
  await runSession(["/authorisation 1", "go"], {
    runMessageTurn: async (_s, _m, deps) => {
      const ctx = deps.ctx as { confirm?: (c: { name: string }) => Promise<unknown> };
      if (ctx.confirm) decisions.push(await ctx.confirm({ name: "write_file" }));
      return turnResult("done");
    },
  });
  // stdin is exhausted, so the prompt resolves to a denial rather than to `true`.
  assert.notEqual(decisions[0], true, "write_file was auto-approved at the readonly default");
});

/* ------------------------------------------------------------------------- *
 * /save, /recall and --continue, asserted by CONSEQUENCE
 *
 * These replace regex-over-source-text tests in save-resume.test.ts, which asserted things
 * like `/rebuildThread\(loadTurns\(home/` against the host's own bytes. That guards a SPELLING,
 * not a behaviour: splitting one call into two statements broke them while the feature worked,
 * and — far worse — any of them would keep passing if the code were reachable but wrong.
 * ------------------------------------------------------------------------- */

test("/save writes a real file to disk", async () => {
  const { existsSync, readFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const out = join(mkdtempSync(join(tmpdir(), "prom-save-")), "transcript.txt");
  await runSession(["hello", `/save ${out}`], {
    runMessageTurn: async (_s, _m, deps) => {
      deps.ctx.write("an answer\n");
      return turnResult("an answer");
    },
  });
  assert.ok(existsSync(out), "/save printed success and wrote nothing");
  assert.match(readFileSync(out, "utf8"), /hello/);
});

test("a turn's content reaches the session store, so /recall has something to restore", async () => {
  const { listSessions, loadTurns } = await import("./history-store.js");
  await runSession(["remember this"], {
    runMessageTurn: async () => turnResult("noted"),
  });
  const sessions = listSessions(TMP_HOME);
  assert.ok(sessions.length > 0, "no session was recorded");
  // The bug this guards was NOT an empty picker: it was a full picker over an empty store, so
  // asserting the session is listed proves nothing on its own.
  const withTurns = sessions.filter((s) => loadTurns(TMP_HOME, s.id).length > 0);
  assert.ok(withTurns.length > 0, "sessions are listed but no transcript was persisted");
});

test("resuming a session with NO transcript leaves the live conversation alone", async () => {
  // `history = messages` ran unconditionally, so this wiped the live thread and still printed
  // "↻ resumed session". The user lost the conversation they were in the middle of, and the
  // only symptom was the agent suddenly knowing nothing.
  const { recordSession } = await import("./history-store.js");
  recordSession(TMP_HOME, {
    id: "ghost-session",
    ts: "2026-01-01T00:00:00Z",
    descriptor: "a session with no transcript",
    cwd: process.cwd(),
  });
  const seen: number[] = [];
  const { out } = await runSession(["first message", "/resume ghost-session", "second message"], {
    runMessageTurn: async (_s, _m, deps) => {
      seen.push((deps.history ?? []).length);
      return turnResult("ok");
    },
  });
  assert.equal(
    /resumed session/.test(out),
    false,
    "it claimed to resume a transcript-less session",
  );
  assert.match(out, /nothing to resume|no transcript/);
  assert.ok(seen.length >= 2, "the second turn never ran");
  assert.ok(
    (seen[1] as number) > 0,
    "the failed restore wiped the live conversation instead of being a no-op",
  );
});

/* ── the session-scoped fields that no host used to supply ─────────────────── */

test("the exec audit's inputs REACH the turn — home and the live authorisation level", async () => {
  // `ctx.home` and `ctx.authLevel` were declared and consumed (agent-runtime writes the
  // Phase-3 exec audit line only when `home` is set, and stamps `authLevel` on it) and
  // assigned by no host. So every runner-side audit line was silently dropped: the record of
  // what the agent ran, at what autonomy, did not exist. Both fields are optional, so nothing
  // ever failed to compile.
  let ctx: { home?: string; authLevel?: number } | undefined;
  await runSession(["/authorisation 3", "go"], {
    runMessageTurn: async (_s, _m, deps) => {
      ctx = deps.ctx as { home?: string; authLevel?: number };
      return turnResult("ok");
    },
  });
  assert.equal(ctx?.home, TMP_HOME, "no PROMETHEUS_HOME reached the turn — the audit is dropped");
  assert.equal(ctx?.authLevel, 3, "the audit line would record the wrong autonomy level");
});

test("learned tool capability SURVIVES the next message", async () => {
  // A fresh LLM client is built per user message, so the capability it accumulates —
  // "this endpoint answers a tools request with prose, stop offering native tools" — was
  // discarded every turn, and the two-observation demotion threshold could never be reached.
  const seen: Array<{ textCallsWhileNative: number }> = [];
  await runSession(["first", "second"], {
    runMessageTurn: async (_s, _m, deps) => {
      const ctx = deps.ctx as {
        capability?: () => { textCallsWhileNative: number };
        onCapability?: (s: unknown) => void;
      };
      assert.ok(ctx.capability, "the host supplies no capability getter");
      seen.push(ctx.capability());
      // Report an observation, exactly as the transport does after a turn.
      ctx.onCapability?.({ nativeRejected: false, nativeCalls: 0, textCallsWhileNative: 1 });
      return turnResult("ok");
    },
  });
  assert.equal(seen[0]?.textCallsWhileNative, 0, "the first turn should start unopinionated");
  assert.equal(
    seen[1]?.textCallsWhileNative,
    1,
    "the observation was thrown away — the endpoint is re-probed natively forever",
  );
});
