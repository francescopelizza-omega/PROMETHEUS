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
import { type SessionHandlers, launchSession, seedTuning } from "./host.js";
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
