/**
 * one-shot.test.ts — `prometheus -p "<prompt>"`, the headless agent turn.
 *
 * Two things here are worth pinning and neither is the happy path.
 *
 * The first is the PARSER trap: `-p` is not a boolean flag, so the prompt is swallowed as its
 * value and the command comes back empty — which sets `repl: true`. Without the explicit
 * interception, `prometheus -p "do X"` launches the full-screen TUI and silently discards the
 * prompt. The parse assertions are the guard against that regressing.
 *
 * The second is the POSTURE. Omitting `confirm` looked correct and was not: auto-approval by
 * authorisation level lives in the host's confirm, not in the loop, so a one-shot with no confirm
 * could not even `read_file` — verified live, the model spent its rounds retrying a read that
 * could never be allowed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { agent } from "@prometheus/core";
import type { ParsedArgs } from "../parse.js";
import { parseArgs } from "../parse.js";
import {
  chatPrompt,
  headlessAuthLevel,
  oneShotNotes,
  oneShotPrompt,
  renderOneShot,
  runOneShot,
} from "./one-shot.js";

function args(over: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: [],
    positionals: [],
    json: false,
    noColor: true,
    help: false,
    version: false,
    repl: false,
    dryRun: false,
    yes: false,
    strict: false,
    force: false,
    noGate: false,
    verbose: false,
    quiet: false,
    flags: {},
    ...over,
  };
}

/* ── reading the prompt out of argv ─────────────────────────────────────────*/

test("-p captures the prompt the parser would otherwise swallow into a TUI launch", () => {
  const parsed = parseArgs(["-p", "fix the failing test"]);
  assert.equal(oneShotPrompt(parsed), "fix the failing test");
  // …and this is WHY the interception has to happen before the interactive check:
  assert.equal(parsed.repl, true, "an empty command still sets repl — the trap this guards");
});

test("--print and --prompt are accepted as the same thing", () => {
  assert.equal(oneShotPrompt(args({ flags: { print: "a" } })), "a");
  assert.equal(oneShotPrompt(args({ flags: { prompt: "b" } })), "b");
});

test("an absent or empty -p is NOT a one-shot", () => {
  // A bare `prometheus` must still open the interactive session.
  assert.equal(oneShotPrompt(args()), null);
  assert.equal(oneShotPrompt(args({ flags: { p: "" } })), null);
  assert.equal(oneShotPrompt(args({ flags: { p: "   " } })), null);
  assert.equal(oneShotPrompt(args({ flags: { p: true } })), null, "a boolean -p carries no prompt");
});

/* ── rendering ──────────────────────────────────────────────────────────────*/

test("the tools it ran are NAMED — the difference between answering and doing", () => {
  const out = renderOneShot({
    ok: true,
    reply: "It adds two numbers.",
    toolCalls: ["glob", "read_file"],
    capped: false,
  });
  assert.match(out, /It adds two numbers\./);
  assert.match(out, /tools: glob, read_file/);
});

test("a clean read-only answer with no tools renders as just the answer", () => {
  const out = renderOneShot({ ok: true, reply: "42", toolCalls: [], capped: false });
  assert.equal(out, "42");
});

test("hitting the step cap is stated, not hidden", () => {
  // Silently truncating at the cap would read as a finished answer.
  const out = renderOneShot({ ok: true, reply: "partial", toolCalls: [], capped: true });
  assert.match(out, /stopped at the step cap/);
});

test("a failure renders as an error line, never as an empty success", () => {
  const out = renderOneShot({
    ok: false,
    reply: "",
    toolCalls: [],
    capped: false,
    error: "no local model is available",
  });
  assert.match(out, /^prometheus: /);
  assert.match(out, /no local model/);
});

/* ── the headless posture ladder ───────────────────────────────────────────── */

test("headless is READ-ONLY by default, and the flags are the only way up", () => {
  // The default must not move: an unattended run that can write by default is a different
  // and much more dangerous product.
  assert.equal(headlessAuthLevel(parseArgs(["-p", "x"])), 1);
  // …but a hard lock with no way out means the mode cannot do the work at all, which is why
  // no rival CLI has one.
  assert.equal(headlessAuthLevel(parseArgs(["-p", "x", "--allow-writes"])), 2);
  assert.equal(headlessAuthLevel(parseArgs(["-p", "x", "--allow-commands"])), 4);
  // Neither flag reaches `installs` (5) or `runall` (7).
  assert.ok(headlessAuthLevel(parseArgs(["-p", "x", "--allow-commands"])) < 5);
});

/* ── `prometheus chat "<message>"` ─────────────────────────────────────────── */

test("`chat <message>` is an agentic prompt, not a blurb", () => {
  // It printed a static capability listing and exited 0 with the message discarded — the most
  // obvious command in the product, silently doing nothing while reporting success.
  assert.equal(chatPrompt(parseArgs(["chat", "what is 2+2"])), "what is 2+2");
  assert.equal(chatPrompt(parseArgs(["chat", "fix", "the", "bug"])), "fix the bug");
});

test("bare `chat` and the two named surfaces are left alone", () => {
  // Bare `chat` is the interactive session; `--cli` is the terminal CLI preview and `--local`
  // the engine's own chat verb. Swallowing those would remove three working surfaces.
  assert.equal(chatPrompt(parseArgs(["chat"])), null);
  assert.equal(chatPrompt(parseArgs(["chat", "hi", "--cli", "claude"])), null);
  assert.equal(chatPrompt(parseArgs(["chat", "hi", "--local"])), null);
  assert.equal(chatPrompt(parseArgs(["scan"])), null);
});

/* ── the reply is printed ONCE ─────────────────────────────────────────────── */

test("the notes are separable from the reply, because the reply was already streamed", () => {
  // `runOneShot` streams every line through `write` as it arrives, and `bin.ts` then printed
  // `renderOneShot(res)` — which begins with the whole reply again. Every headless answer was
  // emitted twice. `oneShotNotes` is what the streaming caller prints instead.
  const r = { ok: true, reply: "the answer", toolCalls: ["read_file"], capped: true };
  const notes = oneShotNotes(r);
  assert.equal(/the answer/.test(notes), false, "the notes must not repeat the reply");
  assert.match(notes, /read_file/);
  assert.match(notes, /step cap/);
  // The full rendering still exists for a caller that did NOT stream.
  assert.match(renderOneShot(r), /the answer/);
});

test("a failed run reports its error and nothing else", () => {
  assert.match(
    renderOneShot({ ok: false, reply: "", toolCalls: [], capped: false, error: "no model" }),
    /no model/,
  );
});

/**
 * A detected LOCAL runner, so `runOneShot` gets past its "no model is available" guard and
 * reaches the part these tests are about. (That guard runs BEFORE the MCP session opens, so
 * the early return leaks nothing — which is worth knowing and is why it is fine to skip it.)
 */
const FAKE_BACKENDS = {
  liveRunners: [{ name: "ollama" }],
  paidClis: [],
  localRunner: { name: "ollama" },
  localEndpoint: {
    id: "local:ollama:test",
    baseUrl: "http://127.0.0.1:11434/v1",
    locality: "local" as const,
    model: "test",
    contextWindow: 8192,
    supportsTools: true,
  },
};

test("headless gets MCP tools too — the surface that had none", async () => {
  /**
   * Both interactive hosts open an MCP session and fold its tools into the turn. `one-shot.ts`
   * did not mention MCP at all, so a user who configured a connector got its tools in the TUI,
   * got them in the readline session, and got NONE of them from `prometheus -p "…"` — the
   * surface a script or a CI job actually uses, and the one where a missing tool is hardest to
   * notice because nobody is watching the tool list.
   */
  const MCP_TOOL: agent.ToolDef = {
    name: "mcp__files__read",
    title: "read",
    description: "read a file over MCP",
    schema: {},
    annotations: { readOnlyHint: true },
    toArgv: () => [],
  };
  let sawTools: string[] = [];
  let closed = false;
  const dispatched: string[] = [];
  const res = await runOneShot(parseArgs(["-p", "list the files"]), "list the files", {
    detect: async () => FAKE_BACKENDS as never,
    mcp: {
      tools: () => [MCP_TOOL],
      callTool: async (id, tool) => {
        dispatched.push(`${id}:${tool}`);
        return { ok: true, summary: "ok" };
      },
      close: async () => {
        closed = true;
      },
    } as never,
    runTurn: (async (_s, _m, d: { ctx: { tuning: { tools: { extra?: { name: string }[] } } } }) => {
      sawTools = (d.ctx.tuning.tools.extra ?? []).map((t) => t.name);
      return { session: {}, events: [], reply: "done", jsonl: "", capped: false, thread: [] };
    }) as never,
  });

  assert.equal(res.ok, true, res.error);
  assert.ok(
    sawTools.includes("mcp__files__read"),
    `the MCP tool never reached the turn — saw: ${sawTools.join(", ")}`,
  );
  assert.equal(closed, true, "the connectors were left running after the headless turn");
  assert.equal(dispatched.length, 0);
});

test("no connectors configured ⇒ no `mcp__` tool is advertised", async () => {
  // The host tool set is always in `extra`; what must NOT appear is an MCP tool that does not
  // exist. Advertising one the runner cannot dispatch is worse than advertising nothing.
  let sawTools: string[] = [];
  const res = await runOneShot(parseArgs(["-p", "hi"]), "hi", {
    detect: async () => FAKE_BACKENDS as never,
    mcp: {
      tools: () => [],
      callTool: async () => ({ ok: true, summary: "" }),
      close: async () => {},
    } as never,
    runTurn: (async (_s, _m, d: { ctx: { tuning: { tools: { extra?: { name: string }[] } } } }) => {
      sawTools = (d.ctx.tuning.tools.extra ?? []).map((t) => t.name);
      return { session: {}, events: [], reply: "hi", jsonl: "", capped: false, thread: [] };
    }) as never,
  });
  assert.equal(res.ok, true);
  assert.equal(
    sawTools.some((n) => n.startsWith("mcp__")),
    false,
    `an MCP tool was advertised with no connector configured: ${sawTools.join(", ")}`,
  );
});
