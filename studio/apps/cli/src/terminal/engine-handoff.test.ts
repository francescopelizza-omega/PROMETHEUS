/**
 * engine-handoff.test.ts — the one-shot `chat --cli` control flow.
 *
 * Deterministic: a FAKE EngineClient returns a scripted ChatTerminalEnvelope
 * (never spawns python), and the live-terminal + tmux seams are FAKES that just
 * record the envelope they were handed and return a scripted code (no pty, no
 * tmux). We assert the four contracts:
 *   1. no launch switch → a read-only PREVIEW CommandOutcome (nothing spawns);
 *   2. --open  → hands the previewed envelope to the live-terminal seam;
 *   3. --tmux  → hands it to the tmux seam (and tmux WINS when both are set);
 *   4. never-force: a bypass LAUNCH is held behind a typed-confirm BEFORE the
 *      seam runs (decline / no-confirmer → BLOCKED exit 2, never a silent spawn);
 *   plus crash-free: an engine error / ok:false / seam throw never crashes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type ChatTerminalEnvelope,
  type EngineClient,
  EngineError,
  type RunOptions,
} from "@prometheus/engine-bridge";

import type { CommandOutcome } from "../context.js";
import { setColorEnabled } from "../render.js";
import {
  type TerminalChatDeps,
  type TerminalChatOpts,
  runTerminalChat,
  ttyTypedConfirm,
} from "./engine-handoff.js";

setColorEnabled(false);

/* ------------------------------------------------------------------ */
/* A FAKE EngineClient: returns a scripted terminal envelope from      */
/* runPrometheus (the path Commands.chatPreview routes through). Every */
/* other method throws loud so a wrong route is never silent.          */
/* ------------------------------------------------------------------ */
function makeFakeClient(opts: {
  envelope?: Partial<ChatTerminalEnvelope>;
  throws?: "plain" | "engine";
}): { client: EngineClient; argvSeen: string[][] } {
  const argvSeen: string[][] = [];
  const unexpected = (name: string) =>
    (async () => {
      throw new Error(`fake: ${name} unexpectedly called`);
    }) as never;
  const client = {
    runPrometheus: (async (argv: string[], _o?: RunOptions) => {
      argvSeen.push(argv);
      if (opts.throws === "engine") throw EngineError.fromKind("timeout", "sidecar timed out");
      if (opts.throws === "plain") throw new Error("boom");
      const env: ChatTerminalEnvelope = {
        command: "chat",
        ok: true,
        mode: "terminal",
        cli: "claude",
        label: "Claude Code",
        argv: ["claude", "--model", "opus"],
        env: {},
        notes: [],
        bypass: false,
        tmux: null,
        interactive: true,
        model: null,
        cwd: "/work",
        ...opts.envelope,
      } as ChatTerminalEnvelope;
      return env as unknown as never;
    }) as EngineClient["runPrometheus"],
    runNemesis: unexpected("runNemesis"),
    gate: unexpected("gate"),
    scan: unexpected("scan"),
    list: unexpected("list"),
    info: unexpected("info"),
    status: unexpected("status"),
    matrix: unexpected("matrix"),
    superscan: unexpected("superscan"),
    where: unexpected("where"),
    install: unexpected("install"),
    uninstall: unexpected("uninstall"),
    enable: unexpected("enable"),
    disable: unexpected("disable"),
    vaultStatus: unexpected("vaultStatus"),
    version: unexpected("version"),
    capabilities: unexpected("capabilities"),
  } as unknown as EngineClient;
  return { client, argvSeen };
}

/** Base opts with the fake client wired in. */
function makeOpts(client: EngineClient, over: Partial<TerminalChatOpts> = {}): TerminalChatOpts {
  return { cli: "claude", client, json: false, ...over };
}

/** Fake seams that record the envelope they receive and return a scripted code. */
function makeSeams(over: Partial<TerminalChatDeps> = {}): {
  deps: TerminalChatDeps;
  live: ChatTerminalEnvelope[];
  tmux: ChatTerminalEnvelope[];
  out: string[];
  prompts: string[];
} {
  const live: ChatTerminalEnvelope[] = [];
  const tmux: ChatTerminalEnvelope[] = [];
  const out: string[] = [];
  const prompts: string[] = [];
  const deps: TerminalChatDeps = {
    runLiveTerminal: async (env) => {
      live.push(env);
      return 0;
    },
    runTmux: async (env) => {
      tmux.push(env);
      return 0;
    },
    confirm: async (prompt) => {
      prompts.push(prompt);
      return true;
    },
    write: (text) => out.push(text),
    ...over,
  };
  return { deps, live, tmux, out, prompts };
}

const isOutcome = (r: CommandOutcome | number): r is CommandOutcome => typeof r === "object";

test("default (no --open/--tmux) → PREVIEW outcome, nothing spawns", async () => {
  const { client } = makeFakeClient({});
  const { deps, live, tmux } = makeSeams();

  const res = await runTerminalChat(makeOpts(client), deps);

  assert.ok(isOutcome(res), "preview returns a CommandOutcome");
  assert.equal(res.exitCode, 0);
  assert.match(res.text ?? "", /Claude Code/);
  assert.match(res.text ?? "", /preview only/);
  // NEITHER launch seam ran.
  assert.deepEqual(live, []);
  assert.deepEqual(tmux, []);
});

test("the preview is built from Commands.chatPreview argv (chat --cli claude)", async () => {
  const { client, argvSeen } = makeFakeClient({});
  await runTerminalChat(makeOpts(client, { model: "opus", prompt: "hi" }), makeSeams().deps);
  assert.equal(argvSeen.length, 1);
  const argv = argvSeen[0] ?? [];
  // JS never hand-builds the terminal argv — but the PREVIEW request is the
  // chat-preview builder's argv (chat --cli <svc> --model … -- <prompt>). The `--`
  // end-of-options separator guards a dash-leading prompt from option-injection.
  assert.deepEqual(argv, ["chat", "--cli", "claude", "--model", "opus", "--", "hi"]);
});

test("--open → hands the previewed envelope to the live-terminal seam, returns its code", async () => {
  const { client } = makeFakeClient({ envelope: { argv: ["claude", "x"] } });
  const { deps, live, tmux } = makeSeams({ runLiveTerminal: async () => 7 });

  const res = await runTerminalChat(makeOpts(client, { open: true }), deps);

  assert.equal(res, 7); // the child's exit code, returned as a number
  assert.equal(tmux.length, 0);
  // (the recording seam was overridden, so assert via the override's return)
});

test("--open hands the EXACT engine argv through (never re-built in JS)", async () => {
  const { client } = makeFakeClient({ envelope: { argv: ["claude", "--model", "opus", "go"] } });
  const { deps, live } = makeSeams();

  await runTerminalChat(makeOpts(client, { open: true }), deps);

  assert.equal(live.length, 1);
  assert.deepEqual(live[0]?.argv, ["claude", "--model", "opus", "go"]);
});

test("--tmux → hands the envelope to the tmux seam (live seam untouched)", async () => {
  const { client } = makeFakeClient({ envelope: { tmux: "work" } });
  const { deps, live, tmux } = makeSeams();

  const res = await runTerminalChat(makeOpts(client, { tmux: "work" }), deps);

  assert.equal(res, 0);
  assert.equal(tmux.length, 1);
  assert.equal(tmux[0]?.tmux, "work");
  assert.deepEqual(live, []);
});

test("tmux WINS when both --open and --tmux are set (engine precedence mirrored)", async () => {
  const { client } = makeFakeClient({ envelope: { tmux: "work" } });
  const { deps, live, tmux } = makeSeams();

  await runTerminalChat(makeOpts(client, { open: true, tmux: "work" }), deps);

  assert.equal(tmux.length, 1);
  assert.deepEqual(live, []);
});

test("never-force: a bypass LAUNCH type-confirms BEFORE the seam runs", async () => {
  const { client } = makeFakeClient({ envelope: { bypass: true } });
  const { deps, live, prompts } = makeSeams({
    confirm: async (p) => {
      prompts.push(p);
      return true;
    },
  });

  const res = await runTerminalChat(makeOpts(client, { open: true, bypass: true }), deps);

  assert.equal(res, 0);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /Type BYPASS to launch/);
  assert.equal(live.length, 1); // confirmed → the seam ran
});

test("never-force: a DECLINED bypass blocks the launch (exit 2, nothing spawns)", async () => {
  const { client } = makeFakeClient({ envelope: { bypass: true } });
  const { deps, live, tmux } = makeSeams({ confirm: async () => false });

  const res = await runTerminalChat(makeOpts(client, { open: true, bypass: true }), deps);

  assert.equal(res, 2);
  assert.deepEqual(live, []);
  assert.deepEqual(tmux, []);
});

test("never-force: NO confirmer wired → bypass launch is DENIED (fail-closed, exit 2)", async () => {
  const { client } = makeFakeClient({ envelope: { bypass: true } });
  const { deps, live } = makeSeams({ confirm: undefined });

  const res = await runTerminalChat(makeOpts(client, { open: true }), deps);

  assert.equal(res, 2);
  assert.deepEqual(live, []);
});

test("engine notes are surfaced VERBATIM on the launch path", async () => {
  const { client } = makeFakeClient({ envelope: { notes: ["heads up: dangerous flag set"] } });
  const { deps, out } = makeSeams();

  await runTerminalChat(makeOpts(client, { open: true }), deps);

  assert.ok(out.some((l) => l.includes("heads up: dangerous flag set")));
});

test("crash-free: an engine error is rendered friendly (no throw, fail-closed exit 2)", async () => {
  const { client } = makeFakeClient({ throws: "engine" });
  const res = await runTerminalChat(makeOpts(client, { open: true }), makeSeams().deps);

  assert.ok(isOutcome(res));
  assert.notEqual(res.exitCode, 0);
  assert.match(res.text ?? "", /timed out/);
});

test("crash-free: an ok:false envelope surfaces the error, never launches", async () => {
  const { client } = makeFakeClient({ envelope: { ok: false, error: "no such cli" } });
  const { deps, live, tmux } = makeSeams();

  const res = await runTerminalChat(makeOpts(client, { open: true }), deps);

  assert.ok(isOutcome(res));
  assert.equal(res.exitCode, 2);
  assert.match(res.text ?? "", /no such cli/);
  assert.deepEqual(live, []);
  assert.deepEqual(tmux, []);
});

test("crash-free: a seam that throws becomes a friendly non-zero code (no raw stack)", async () => {
  const { client } = makeFakeClient({});
  const { deps, out } = makeSeams({
    runLiveTerminal: async () => {
      throw new Error("pty exploded");
    },
  });

  const res = await runTerminalChat(makeOpts(client, { open: true }), deps);

  assert.equal(res, 1);
  assert.ok(out.some((l) => /launch failed: pty exploded/.test(l)));
});

test("the bypass typed-confirm approves ONLY the exact phrase, and never without a TTY", async () => {
  /**
   * `defaultRunLiveTerminal` passed `runLiveTerminal` no deps, so its `confirm` fell back to the
   * module's own `async () => false`. Fail-closed is the right default for an absent seam, but
   * production never supplied one — so every `--bypass` launch answered "bypass not confirmed"
   * and no input existed that could approve it. The gate was unreachable, not strict.
   *
   * This pins the reader that now fills that seam: exact match approves, anything else denies,
   * and a non-interactive stdin denies WITHOUT reading (a pipe has nobody to type the phrase,
   * and blocking there would hang the caller rather than answer it).
   */
  const realIsTty = process.stdin.isTTY;
  const realWrite = process.stdout.write;
  const chunks: string[] = [];
  (process.stdout as { write: unknown }).write = (s: string): boolean => {
    chunks.push(String(s));
    return true;
  };

  try {
    // no TTY → denied, and nothing is even printed to a pipe
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    assert.equal(await ttyTypedConfirm("type it", "BYPASS"), false);
    assert.deepEqual(chunks, [], "a non-interactive stdin must not be prompted at all");

    // TTY → the exact phrase approves; a near-miss does not
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    for (const [typed, expected] of [
      ["BYPASS\n", true],
      ["bypass\n", false],
      ["BYPASS extra\n", false],
      ["\n", false],
    ] as const) {
      const stdin = process.stdin as unknown as {
        resume(): void;
        pause(): void;
        on(e: string, cb: (b: Buffer) => void): void;
        off(e: string, cb: unknown): void;
        once(e: string, cb: () => void): void;
      };
      const real = {
        resume: stdin.resume,
        pause: stdin.pause,
        on: stdin.on,
        off: stdin.off,
        once: stdin.once,
      };
      stdin.resume = () => {};
      stdin.pause = () => {};
      stdin.off = () => {};
      stdin.once = () => {};
      stdin.on = (e: string, cb: (b: Buffer) => void): void => {
        if (e === "data") queueMicrotask(() => cb(Buffer.from(typed)));
      };
      try {
        assert.equal(
          await ttyTypedConfirm("type it", "BYPASS"),
          expected,
          `for ${JSON.stringify(typed)}`,
        );
      } finally {
        Object.assign(stdin, real);
      }
    }
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTty, configurable: true });
    process.stdout.write = realWrite;
  }
});
