/**
 * preview.test.ts — the PURE chat-preview builders, in isolation (no engine/pty).
 *
 * Deterministic string/shape work only: opts→ChatPreviewOpts lowering, the
 * read-only preview render (label + notes verbatim + argv), the never-force
 * bypass prompt, and the display-only argv quoting (which must NEVER be confused
 * for the injection-safe argv the engine returns).
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ChatTerminalEnvelope } from "@prometheus/engine-bridge";

import { setColorEnabled } from "../render.js";
import {
  BYPASS_PHRASE,
  bypassConfirmPrompt,
  previewOutcome,
  renderArgv,
  toChatPreviewOpts,
} from "./preview.js";

// Color OFF so assertions match plain text (no ANSI escapes to strip).
setColorEnabled(false);

/** A minimal terminal envelope for the preview tests. */
function envelope(over: Partial<ChatTerminalEnvelope> = {}): ChatTerminalEnvelope {
  return {
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
    ...over,
  } as ChatTerminalEnvelope;
}

test("toChatPreviewOpts forwards only the engine-preview fields", () => {
  const opts = toChatPreviewOpts({
    model: "opus",
    systemPrompt: "/sys.md",
    replaceSystem: true,
    bypass: true,
    tmux: "work",
    cwd: "/work",
    prompt: "hello",
  });
  assert.deepEqual(opts, {
    model: "opus",
    systemPrompt: "/sys.md",
    replaceSystem: true,
    bypass: true,
    tmux: "work",
    cwd: "/work",
    prompt: "hello",
  });
});

test("toChatPreviewOpts drops empty/false fields (minimal previewed argv)", () => {
  // tmux:false and omitted optionals must NOT appear (keeps the argv minimal).
  assert.deepEqual(toChatPreviewOpts({ tmux: false }), {});
  assert.deepEqual(toChatPreviewOpts({}), {});
  // tmux:true (default session) IS forwarded.
  assert.deepEqual(toChatPreviewOpts({ tmux: true }), { tmux: true });
});

test("previewOutcome renders label, cwd and a launch hint, exit 0, json=envelope", () => {
  const env = envelope({ model: "opus" });
  const out = previewOutcome(env);

  assert.equal(out.exitCode, 0);
  assert.equal(out.json, env); // machine payload IS the contract envelope
  assert.match(out.text ?? "", /Claude Code/);
  assert.match(out.text ?? "", /claude · interactive/);
  assert.match(out.text ?? "", /model: opus/);
  assert.match(out.text ?? "", /cwd: \/work/);
  assert.match(out.text ?? "", /preview only — add --open to launch/);
  // it shows the exact argv that OPEN would run.
  assert.match(out.text ?? "", /would run:/);
  assert.match(out.text ?? "", /claude --model opus/);
});

test("previewOutcome surfaces engine notes VERBATIM and the env overrides", () => {
  const env = envelope({
    notes: ["binary 'claude' not found on PATH", "model pinned to opus"],
    env: { GEMINI_SYSTEM_MD: "/sys.md" },
  });
  const out = previewOutcome(env);
  assert.match(out.text ?? "", /binary 'claude' not found on PATH/);
  assert.match(out.text ?? "", /model pinned to opus/);
  assert.match(out.text ?? "", /GEMINI_SYSTEM_MD=\/sys\.md/);
});

test("previewOutcome flags a bypass preview (so the human sees it before --open)", () => {
  const out = previewOutcome(envelope({ bypass: true }));
  assert.match(out.text ?? "", /permission-bypass/);
});

test("previewOutcome marks a one-shot (non-interactive) session", () => {
  const out = previewOutcome(envelope({ interactive: false }));
  assert.match(out.text ?? "", /one-shot/);
});

test("bypassConfirmPrompt names the CLI and requires the exact phrase", () => {
  const prompt = bypassConfirmPrompt(envelope({ label: "Codex CLI", bypass: true }));
  assert.match(prompt, /Codex CLI/);
  assert.match(prompt, /PERMISSION-BYPASS/);
  assert.match(prompt, new RegExp(`Type ${BYPASS_PHRASE} to launch`));
});

test("renderArgv quotes only unsafe tokens (display only — never injection-safe argv)", () => {
  // safe tokens pass through bare…
  assert.equal(renderArgv(["claude", "--model", "opus"]), "claude --model opus");
  // …a token with spaces / metachars is single-quoted for HUMAN reading…
  assert.equal(renderArgv(["echo", "a b"]), "echo 'a b'");
  assert.equal(renderArgv(["x", "a;rm -rf /"]), "x 'a;rm -rf /'");
  // …and an embedded single-quote is POSIX-escaped (close, escaped quote, reopen).
  assert.equal(renderArgv(["x", "it's"]), "x 'it'\\''s'");
  // an empty token is quoted (never bare).
  assert.equal(renderArgv(["x", ""]), "x ''");
});
