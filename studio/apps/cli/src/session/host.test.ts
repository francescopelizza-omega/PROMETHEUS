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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

/** A throwaway ~/.prometheus home per test run — never touches the real $HOME. */
const TMP_HOME = mkdtempSync(join(tmpdir(), "prom-home-"));

import type { CommandOutcome } from "../context.js";
import type { ParsedArgs } from "../parse.js";
import { setColorEnabled } from "../render.js";
import { stringWidth } from "../tui/width.js";
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
    backends: {
      liveRunners: [],
      paidClis: [],
      startedRunners: new Set<string>(),
      unavailableRunners: [],
    },
    home: TMP_HOME,
    configHome: TMP_HOME,
  });
  return p.then((code) => ({ code, out: out.join(""), rl }));
}

test("/ls in the readline host lists the session folder", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = mkdtempSync(join(tmpdir(), "prom-host-ls-"));
  writeFileSync(join(base, "marker-file.md"), "x");
  const { out } = await runSession(["/ls", "/quit"], {}, { argsOver: { cwd: base } });
  assert.match(out, /marker-file\.md/);
  assert.match(out, /0 dirs, 1 file/);
});

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

/**
 * The two etched initials.
 *
 * P and M are filled with `▓` and milled with `▒`/`░` instead of being drawn in solid `█`.
 * The thing that can silently go wrong is NOT the texture — it is the two invariants the
 * texture has to respect, so both are asserted rather than eyeballed:
 *
 *   • CELL OCCUPANCY. De-texturing (`░▒▓` → `█`) must give back the classic letterforms
 *     exactly. If a future edit moves ink into a blank cell or drops a filled one, the
 *     silhouette drifts and nobody notices, because a shaded letter already "looks wrong".
 *   • COLUMN WIDTH. Every shade glyph must measure ONE column. The banner box pads from
 *     `visibleLen`, so a two-column glyph here tears the right border and every row below it.
 *
 * Color is OFF for this suite (`setColorEnabled(false)`), which is exactly the NO_COLOR case:
 * the etching must still be visible with every escape stripped, and these assertions are what
 * says so.
 */
test("the etched initials: P and M are shaded and milled, and neither shape nor width moved", async () => {
  const { out } = await runSession(["hello there"], {
    runMessageTurn: async () => turnResult("hi back"),
  });

  // The five assembled wordmark rows, verbatim. P and M carry the texture; every other
  // letter is untouched solid `█`, which is what pins the alignment between them.
  const ROWS = [
    "▓▒▓  ███  ▟██▙ ▓   ▓ ████ █████ █  █ ████ █  █ ▟███",
    "▒  ▒ █  █ █  █ ▒▓ ▓▒ █      █   █  █ █    █  █ █   ",
    "░▓▒  ███  █  █ ▓ ▓ ░ ███    █   ████ ███  █  █ ▜██▙",
    "▓    █ █  █  █ ░   ▓ █      █   █  █ █    █  █    █",
    "▒    █  █ ▜██▛ ▓   ▓ ████   █   █  █ ████ ▜██▛ ███▛",
  ];
  for (const row of ROWS) {
    assert.ok(out.includes(row), `wordmark row missing or altered:\n${row}`);
  }

  // Both initials carry the base shade and at least one mill line; neither is solid any more.
  assert.match(out, /▓▒▓/); // P, row 0 — base + mill
  assert.match(out, /░▓▒/); // P, row 2 — the deep gouge across the stem
  // A string, not a regex: the gap between the legs is three literal spaces, and biome's
  // noMultipleSpacesInRegularExpressionLiterals rightly objects to counting them by eye.
  assert.ok(out.includes("░   ▓"), "M, row 3 — the gouge on the left leg");

  // The M's inner V must stay UNMILLED, or the middle of the letter reads as noise and the
  // M collapses into two bars. All three V cells at the base shade, and the row-1 stems that
  // flank them one step lighter — that contrast is what separates the V from the right stem.
  const vRow = ROWS[1]?.slice(15, 20);
  const tipRow = ROWS[2]?.slice(15, 20);
  assert.equal(vRow, "▒▓ ▓▒", "M row 1: ▒ stems flanking ▓ V arms");
  assert.equal(tipRow?.[2], "▓", "M row 2: the V tip is never milled");

  // Both of the M's legs must ANCHOR on the base shade. A leg that ends on a mill line or a
  // gouge fades out at the baseline and the letter reads as if it were cropped — which is
  // what the left leg did while its last cell was `▒`.
  const lastRow = ROWS[4]?.slice(15, 20);
  assert.equal(lastRow?.[0], "▓", "M: left leg lands on the base shade");
  assert.equal(lastRow?.[4], "▓", "M: right leg lands on the base shade");

  // Invariant 1: de-texturing restores the ORIGINAL solid silhouettes, cell for cell.
  const solid = ROWS.map((r) => r.replace(/[░▒▓]/g, "█"));
  const col = (rows: string[], from: number, to: number): string[] =>
    rows.map((r) => r.slice(from, to));
  assert.deepEqual(col(solid, 0, 4), ["███ ", "█  █", "███ ", "█   ", "█   "], "P silhouette");
  assert.deepEqual(
    col(solid, 15, 20),
    ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
    "M silhouette",
  );

  // Invariant 2: one column per shade glyph, or the banner's right border tears.
  for (const g of ["░", "▒", "▓", "█"]) {
    assert.equal(stringWidth(g), 1, `${g} must measure one column`);
  }
});

test("banner shows the REAL, full home path — never a bare '~' — when cwd IS the home directory", async () => {
  // A lone `~` reads clearly to an expert and is nearly invisible to everyone else — the one
  // line in the whole banner that answers "where am I", reduced to a single low-contrast
  // glyph. The banner (shown once, at startup) spells it out in full; the persistent per-turn
  // status lines (tested below) intentionally keep the traditional `~` — that's a DIFFERENT,
  // deliberate choice, not an oversight.
  const { out } = await runSession([], {}, { argsOver: { cwd: homedir() } });
  // The banner box right-pads the value with spaces before the closing "│" — so this checks
  // for a WHITESPACE boundary right after the path, not a literal end-of-line.
  assert.match(out, new RegExp(`cwd {5}${homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s`));
  assert.doesNotMatch(out, /cwd {5}~\s/);
});

test("banner still collapses a NESTED path under home to '~/sub' — only the bare home case expands", async () => {
  const nested = join(homedir(), "projects", "demo");
  const { out } = await runSession([], {}, { argsOver: { cwd: nested } });
  assert.match(out, /cwd {5}~\/projects\/demo\s/);
});

test("the TUI-analogous persistent status line keeps the plain '~' for home (unchanged, on purpose)", async () => {
  // footer() (the readline host's own persistent per-turn status line, and the same shortCwd
  // the TUI's own right-hand status chip uses) is a SEPARATE code path from the banner and
  // must NOT pick up the banner's full-path expansion.
  const { out } = await runSession(
    ["hi"],
    { runMessageTurn: async () => turnResult("ok") },
    { argsOver: { cwd: homedir() } },
  );
  assert.match(out, /~ {2}│ {2}model/); // footer's "~  │  model ..." line, unexpanded
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
    backends: {
      liveRunners: [],
      paidClis: [],
      startedRunners: new Set<string>(),
      unavailableRunners: [],
    },
    home: TMP_HOME,
    configHome: TMP_HOME,
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
    backends: {
      liveRunners: [],
      paidClis: [],
      startedRunners: new Set<string>(),
      unavailableRunners: [],
    },
    home: TMP_HOME,
    configHome: TMP_HOME,
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
    backends: {
      liveRunners: [],
      paidClis: [],
      startedRunners: new Set<string>(),
      unavailableRunners: [],
    },
    home: TMP_HOME,
    configHome: TMP_HOME,
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

test("/authorisation persists under `configHome` (os.homedir()-rooted), NEVER under `home` (prometheusHome()'s accounting tree)", async () => {
  // A real, shipped bug (found via a stray `~/.prometheus/.config/prometheus-studio/...`
  // artifact on an actual dev machine): `saveAuthLevel`/`readSavedAuthLevel` used to be called
  // with `home` (prometheusHome()) instead of `deps.configHome` — silently writing the saved
  // level to the WRONG tree. Two DELIBERATELY DIFFERENT temp dirs here (unlike every other test
  // in this file, which reuses the same TMP_HOME for both) is what actually distinguishes them.
  const wrongHome = mkdtempSync(join(tmpdir(), "prom-wrong-home-"));
  const rightConfigHome = mkdtempSync(join(tmpdir(), "prom-right-confighome-"));
  try {
    const rl = new FakeReadline(["/authorisation 6", "go"]);
    await launchSession(args(), {
      isTty: true,
      makeReadline: () => {
        setImmediate(() => rl.drive());
        return rl as unknown as never;
      },
      write: () => {},
      backends: {
        liveRunners: [],
        paidClis: [],
        startedRunners: new Set<string>(),
        unavailableRunners: [],
      },
      home: wrongHome,
      configHome: rightConfigHome,
      handlers: { runMessageTurn: async () => turnResult("done") },
    });

    const savedAtRightPath = JSON.parse(
      readFileSync(join(rightConfigHome, ".prometheus", "config", "authorisation.json"), "utf8"),
    );
    assert.equal(savedAtRightPath.level, 6);
    assert.equal(
      existsSync(join(wrongHome, ".prometheus", "config", "authorisation.json")),
      false,
      "must NEVER be written under `home` (prometheusHome()'s accounting/state tree)",
    );
  } finally {
    rmSync(wrongHome, { recursive: true, force: true });
    rmSync(rightConfigHome, { recursive: true, force: true });
  }
});

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

/* ── /cd (project switch) — the readline host's own changeProjectDirectory, end-to-end ────────
 * Previously covered only via slash-registry.test.ts's FAKE SlashCtx (never runs this host's real
 * code) and tui/session-bridge.test.ts's structurally separate implementation — a regression here
 * would have shipped undetected. These drive the REAL launchSession, no fakes on the /cd path. */

test("/cd: a valid target rotates the session (fresh id echoed, tuning untouched)", async () => {
  const base = mkdtempSync(join(tmpdir(), "prom-cd-"));
  const target = join(base, "other-project");
  mkdirSync(target, { recursive: true });
  const { out } = await runSession([`/cd ${target}`, "/quit"], {}, { argsOver: { cwd: base } });
  assert.match(out, /moved to/);
  assert.match(out, new RegExp(target.replace(/[/\\]/g, "\\$&")));
  assert.match(out, /model\/tuning kept/);
});

test("/cd: a nonexistent target reports the error and does not disturb the session", async () => {
  const base = mkdtempSync(join(tmpdir(), "prom-cd-bad-"));
  const { out } = await runSession(
    [`/cd ${join(base, "does-not-exist")}`, "/status", "/quit"],
    {},
    { argsOver: { cwd: base } },
  );
  assert.match(out, /\/cd: no such directory/);
  assert.match(out, new RegExp(`cwd\\s+${base.replace(/[/\\]/g, "\\$&")}`)); // cwd is unchanged
});

test("/cd: accepting the pre-filled default (blank Enter) is a genuine no-op, not a rotation", async () => {
  const base = mkdtempSync(join(tmpdir(), "prom-cd-noop-"));
  // a bare "/cd" with no path asks via askPath, which returns the pre-filled default (the
  // current cwd) verbatim on a blank answer — exactly what a plain Enter keystroke produces.
  const { out, rl } = await runSession(
    ["/cd", "/quit"],
    {},
    { argsOver: { cwd: base }, answer: "" },
  );
  assert.match(out, /already in/);
  assert.doesNotMatch(out, /fresh session/);
  assert.ok(rl.questions.some((q) => /Move to project/.test(q)));
});

test("/cd: expands a leading ~ the same way /add-dir does", async () => {
  const marker = mkdtempSync(join(homedir(), "prom-cd-tilde-"));
  try {
    const base = mkdtempSync(join(tmpdir(), "prom-cd-from-"));
    const rel = `~/${relative(homedir(), marker)}`;
    const { out } = await runSession([`/cd ${rel}`, "/quit"], {}, { argsOver: { cwd: base } });
    assert.match(out, /moved to/);
    assert.match(out, new RegExp(marker.replace(/[/\\]/g, "\\$&")));
    assert.doesNotMatch(out, /no such directory/);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(marker, { recursive: true, force: true });
  }
});

test("/cd: re-discovers steering (AGENTS.md) from the NEW directory, not the old one", async () => {
  // Regression test for the ordering bug where steering.reload() ran before state.cwd was
  // updated, so it silently re-read the OLD project's AGENTS.md forever.
  const projectA = mkdtempSync(join(tmpdir(), "prom-cd-steerA-"));
  const projectB = mkdtempSync(join(tmpdir(), "prom-cd-steerB-"));
  writeFileSync(join(projectA, "AGENTS.md"), "Project A steering rules.");
  writeFileSync(join(projectB, "AGENTS.md"), "Project B steering rules — totally different.");
  const { out } = await runSession(
    [`/cd ${projectB}`, "/memory", "/quit"],
    {},
    { argsOver: { cwd: projectA } },
  );
  assert.ok(out.includes(join(projectB, "AGENTS.md")), "project B's AGENTS.md was not loaded");
  assert.ok(
    !out.includes(join(projectA, "AGENTS.md")),
    "project A's AGENTS.md is still being read after /cd",
  );
});

test("/context window: set directly, then bare /context shows the new ceiling", async () => {
  const { out } = await runSession(["/context window 500000", "/context", "/quit"]);
  assert.match(out, /500,000/);
  assert.match(out, /auto-compact ceiling: 500,000 tokens/);
});

test("/context window: the no-arg menu states a custom current value even off-preset", async () => {
  const { out } = await runSession(
    ["/context window 325000", "/context window", "/quit"],
    {},
    { answer: "" },
  );
  assert.match(out, /current: 325,000 tokens \(custom\)/);
});

test("yolo RUNS TO DONE on this host too — it used to stop at the cap and ask", async () => {
  /**
   * `yolo` is "bypass + run to done (auto-/continue, no pauses)", and `/permission-mode` prints
   * that description verbatim — "no prompts, no pauses". This host implemented only the
   * confirm-skip half: `runAgentMessage` ended at `settleCap` and `isRunToDoneMode` appeared
   * nowhere in the file, so a yolo turn hit the step cap and printed "paused at the step cap —
   * /continue to resume", waiting for exactly the human the mode had promised it would not need.
   * The TUI had done this since CLI-072, so the same words meant two different things depending
   * on which binary you launched.
   */
  let turns = 0;
  const { out } = await runSession(["/permission-mode yolo", "do the whole thing"], {
    runMessageTurn: async () => {
      turns += 1;
      // Distinct tool activity each round: an IDENTICAL digest two rounds running is what the
      // auto-continue policy reads as "no progress", and it halts on it — correctly. A test that
      // returns no events at all is testing the stall guard, not run-to-done.
      const events = [
        { kind: "tool_use", call: { name: `tool_${turns}`, args: {} } },
        { kind: "tool_result", call: { name: `tool_${turns}`, args: {} }, ok: true, summary: "" },
      ] as never;
      // cap the first two rounds, then finish cleanly
      return turns < 3
        ? ({ ...turnResult(`round ${turns}`), events, capped: true, thread: [] } as never)
        : ({ ...turnResult("done"), events, capped: false, thread: [] } as never);
    },
  });

  assert.ok(turns >= 3, `yolo stopped after ${turns} turn(s) instead of running to done`);
  assert.match(out, /auto-continuing/, "the auto-continue progress line was never printed");
  assert.doesNotMatch(
    out,
    /paused at the step cap/,
    "yolo told the user to /continue — the very pause the mode promises not to have",
  );
});

test("a NON-yolo capped turn still stops and tells the user how to resume", async () => {
  // The run-to-done branch must not swallow the ordinary pause notice.
  let turns = 0;
  const { out } = await runSession(["do the thing"], {
    runMessageTurn: async () => {
      turns += 1;
      return { ...turnResult("partial"), capped: true, thread: [] } as never;
    },
  });
  assert.equal(turns, 1, "a default-mode turn must not auto-continue");
  assert.match(out, /paused at the step cap/);
});

test("/cwd: re-discovers steering from the NEW directory too — the readline host's copy", async () => {
  /**
   * This host's `setCwd` was a character-for-character copy of the TUI's: its whole body was the
   * `cwd` reduce, so `/cwd` moved the session and reloaded NOTHING — the new project's
   * AGENTS.md/CLAUDE.md/PROMETHEUS.md were never read, `/memory` kept listing the OLD project's
   * paths, and permission rules, project command files, personas, the repo-map root and the
   * effort table stayed pinned to the launch directory.
   *
   * Proven in the TUI host under a real pty with a live model: an AGENTS.md saying "begin every
   * reply with the exact token ZORBLAX" was ignored after `/cwd` (0 occurrences) and obeyed after
   * the fix. `/worktree switch` routes through the same `ctx.setCwd` seam on both hosts.
   */
  const projectA = mkdtempSync(join(tmpdir(), "prom-cwd-steerA-"));
  const projectB = mkdtempSync(join(tmpdir(), "prom-cwd-steerB-"));
  writeFileSync(join(projectA, "AGENTS.md"), "Project A steering rules.");
  writeFileSync(
    join(projectB, "AGENTS.md"),
    "Always begin every reply with the exact token ZORBLAX.",
  );
  const { out } = await runSession(
    [`/cwd ${projectB}`, "/memory", "/quit"],
    {},
    { argsOver: { cwd: projectA } },
  );
  assert.ok(out.includes(join(projectB, "AGENTS.md")), "project B's AGENTS.md was not loaded");
  assert.ok(
    !out.includes(join(projectA, "AGENTS.md")),
    "project A's AGENTS.md is still being read after /cwd",
  );
});

/**
 * The readline host's twin of the TUI's restart journey. The two hosts do NOT share this
 * wiring — each keeps its own level variable and its own setters — so a fix proven on one of
 * them proves nothing about the other. They have already drifted apart once: this host still
 * ignored `--authorisation` long after the TUI read it.
 */
test("readline host: /authorisation survives a restart; /permission-mode never overwrites it", async () => {
  const configHome = mkdtempSync(join(tmpdir(), "prom-host-authjourney-"));
  const authFile = join(configHome, ".prometheus", "config", "authorisation.json");
  const saved = (): number | null => {
    try {
      return JSON.parse(readFileSync(authFile, "utf8")).level;
    } catch {
      return null;
    }
  };
  const run = async (lines: string[], argsOver: Partial<ParsedArgs> = {}): Promise<string> => {
    const out: string[] = [];
    const rl = new FakeReadline(lines);
    await launchSession(args(argsOver), {
      isTty: true,
      makeReadline: () => {
        setImmediate(() => rl.drive());
        return rl as unknown as never;
      },
      write: (s) => out.push(s),
      backends: {
        liveRunners: [],
        paidClis: [],
        startedRunners: new Set<string>(),
        unavailableRunners: [],
      },
      home: TMP_HOME,
      configHome,
      handlers: { runMessageTurn: async () => turnResult("done") },
    });
    return out.join("");
  };
  try {
    await run(["/authorisation 7"]);
    assert.equal(saved(), 7, "an explicit numbered choice is written");

    // "restart": a second launchSession over the same config home reports the saved level back
    const restored = await run(["/authorisation"]);
    assert.match(restored, /authorisation: 7 runall/, "the saved posture must survive a restart");

    // a session-scoped posture change must not become the next session's default
    await run(["/permission-mode default"]);
    assert.equal(saved(), 7, "/permission-mode is not a preference");
    const after = await run(["/authorisation"]);
    assert.match(after, /authorisation: 7 runall/, "the mode change leaked into the next session");
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

/**
 * `--authorisation` parsed, was accepted, and did nothing at all on this host — so
 * `prometheus --plain --authorisation 7`, every `--tmux` launch and every non-TTY fallback ran
 * at the persisted-or-default level with nothing printed to say the flag had been dropped.
 */
test("readline host: --authorisation is APPLIED for the session but never saved", async () => {
  const configHome = mkdtempSync(join(tmpdir(), "prom-host-authflag-"));
  const authFile = join(configHome, ".prometheus", "config", "authorisation.json");
  const run = async (lines: string[], argsOver: Partial<ParsedArgs> = {}): Promise<string> => {
    const out: string[] = [];
    const rl = new FakeReadline(lines);
    await launchSession(args(argsOver), {
      isTty: true,
      makeReadline: () => {
        setImmediate(() => rl.drive());
        return rl as unknown as never;
      },
      write: (s) => out.push(s),
      backends: {
        liveRunners: [],
        paidClis: [],
        startedRunners: new Set<string>(),
        unavailableRunners: [],
      },
      home: TMP_HOME,
      configHome,
      handlers: { runMessageTurn: async () => turnResult("done") },
    });
    return out.join("");
  };
  try {
    const out = await run(["/authorisation"], { flags: { authorisation: "6" } });
    assert.match(out, /authorisation: 6 trusted/, "the flag must reach this host's level");
    assert.equal(
      existsSync(authFile),
      false,
      "a launch flag is a one-off override, not a stored preference",
    );
    // the name form works too, and so does the `--auth` short spelling
    assert.match(
      await run(["/authorisation"], { flags: { auth: "runall" } }),
      /authorisation: 7 runall/,
    );
    // an unparseable value is REPORTED, not silently ignored
    assert.match(await run([], { flags: { authorisation: "nope" } }), /unknown --authorisation/);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

/**
 * `--permission-mode` reached this host but could not survive it: the launch block set the mode,
 * then the elevation clamp three lines below UNCONDITIONALLY re-derived it from the numeric level.
 * mode → level → mode is lossy (plan pins the level to 0, and level 0 maps back to "default"), so
 * `plan` — the one mode whose whole purpose is a read-only DENY, and the only thing enforcing it
 * on this host — was thrown away on every launch. With `--authorisation 7` alongside, the same
 * line produced "yolo".
 */
test("readline host: --permission-mode plan SURVIVES the elevation clamp (and never becomes yolo)", async () => {
  const run = async (argsOver: Partial<ParsedArgs>): Promise<string> => {
    const out: string[] = [];
    const rl = new FakeReadline(["/permission-mode", "/quit"]);
    await launchSession(args(argsOver), {
      isTty: true,
      makeReadline: () => {
        setImmediate(() => rl.drive());
        return rl as unknown as never;
      },
      write: (s) => out.push(s),
      backends: {
        liveRunners: [],
        paidClis: [],
        startedRunners: new Set<string>(),
        unavailableRunners: [],
      },
      home: TMP_HOME,
      configHome: TMP_HOME,
      handlers: { runMessageTurn: async () => turnResult("done") },
    });
    return out.join("");
  };

  assert.match(
    await run({ flags: { "permission-mode": "plan" } }),
    /permission mode: plan/,
    "the flag must still be in force after the clamp",
  );
  // The escalation half: an explicit read-only mode must not be rewritten by the level flag.
  const both = await run({ flags: { "permission-mode": "plan", authorisation: "7" } });
  assert.match(both, /permission mode: plan/);
  assert.doesNotMatch(both, /permission mode: yolo/, "plan must never come out as run-all");
  // the modes that DO round-trip keep working, so the guard did not break the normal path
  assert.match(
    await run({ flags: { "permission-mode": "acceptEdits" } }),
    /permission mode: acceptEdits/,
  );
});

/**
 * The `[keymap]` table the CLI's own `config set` writes must actually be READ.
 *
 * `loadKeymap` was handed `home` — `prometheusHome()`, the `~/.prometheus` STATE tree — while
 * the config it parses lives in the CONFIG tree, so it resolved a path nothing ever creates and
 * fell into its own fail-soft branch on every launch. A rebind saved, printed success, and did
 * nothing. Identical config-tree-vs-state-tree confusion to the one that lost the saved
 * authorisation level, in a second place.
 */
test("readline host: a [keymap] rebind in config.toml reaches /keys", async () => {
  const configHome = mkdtempSync(join(tmpdir(), "prom-host-keymap-"));
  const stateHome = mkdtempSync(join(tmpdir(), "prom-host-keymap-state-"));
  try {
    const cfgDir = join(configHome, ".prometheus", "config");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.toml"), '[keymap]\nnewline = "alt+enter"\n');

    const out: string[] = [];
    const rl = new FakeReadline(["/keys"]);
    await launchSession(args(), {
      isTty: true,
      makeReadline: () => {
        setImmediate(() => rl.drive());
        return rl as unknown as never;
      },
      write: (s) => out.push(s),
      backends: {
        liveRunners: [],
        paidClis: [],
        startedRunners: new Set<string>(),
        unavailableRunners: [],
      },
      // deliberately DIFFERENT trees, which is the whole point: passing the state tree here is
      // what made the read miss, and a test that reused one dir for both could not see it.
      home: stateHome,
      configHome,
      handlers: { runMessageTurn: async () => turnResult("done") },
    });
    assert.match(
      out.join(""),
      /alt\+enter/,
      "the [keymap] table was not read — the rebind is cosmetic again",
    );
  } finally {
    rmSync(configHome, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
  }
});

/**
 * The readline host's twin of the effort restart journey. The two hosts do not share this
 * wiring — each seeds its own tuning and owns its own setter — so a fix proven on one proves
 * nothing about the other. They have drifted before.
 */
test("readline host: /think survives a restart; a flag overrides it without rewriting it", async () => {
  const configHome = mkdtempSync(join(tmpdir(), "prom-host-effort-"));
  const tierFile = join(configHome, ".prometheus", "config", "effort.json");
  const saved = (): string | null => {
    try {
      return JSON.parse(readFileSync(tierFile, "utf8")).tier;
    } catch {
      return null;
    }
  };
  const run = async (lines: string[], argsOver: Partial<ParsedArgs> = {}): Promise<string> => {
    const out: string[] = [];
    const rl = new FakeReadline(lines);
    await launchSession(args(argsOver), {
      isTty: true,
      makeReadline: () => {
        setImmediate(() => rl.drive());
        return rl as unknown as never;
      },
      write: (s) => out.push(s),
      backends: {
        liveRunners: [],
        paidClis: [],
        startedRunners: new Set<string>(),
        unavailableRunners: [],
      },
      home: TMP_HOME,
      configHome,
      handlers: { runMessageTurn: async () => turnResult("done") },
    });
    return out.join("");
  };
  try {
    await run([]);
    assert.equal(saved(), null, "opening a session must not create the store");

    await run(["/think xhigh"]);
    assert.equal(saved(), "xhigh", "an explicit /think is written");

    // "restart": /think with no argument reports the tier the new session started at
    assert.match(await run(["/think"]), /think: xhigh/, "the saved tier must survive a restart");

    // a launch flag wins for THIS session and leaves the preference alone
    assert.match(await run(["/think"], { effort: "low" }), /think: low/);
    assert.equal(saved(), "xhigh", "a flag is a one-off override, not a stored preference");
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
