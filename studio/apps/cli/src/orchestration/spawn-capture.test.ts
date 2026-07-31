/**
 * spawn-capture.test.ts — the pure classifiers + a LIVE hardened-spawn smoke (real node
 * children: capture, wall-clock kill, idle watchdog, stdin pipe).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyOutcome, makeSpawnCapture, redactSecrets, stripAnsi } from "./spawn-capture.js";

test("stripAnsi removes CSI/OSC escape noise", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m \x1b[2K\x1b[1Gdone"), "red done");
});

test("redactSecrets scrubs API keys + env-style secrets", () => {
  assert.match(redactSecrets("key sk-ant-abcdefghijklmnop1234"), /‹redacted-key›/);
  assert.equal(
    redactSecrets("ANTHROPIC_API_KEY=sk-xyz secret"),
    "ANTHROPIC_API_KEY=‹redacted› secret",
  );
});

test("classifyOutcome never trusts the exit code alone", () => {
  const base = { code: 0, signal: null as NodeJS.Signals | null, stdout: "reply", stderr: "" };
  assert.equal(classifyOutcome(base), "ok");
  assert.equal(classifyOutcome({ ...base, stdout: "  " }), "empty");
  assert.equal(classifyOutcome({ ...base, stderr: "Error: 429 rate limit" }), "rate_limited");
  assert.equal(classifyOutcome({ ...base, stderr: "not logged in" }), "auth_error");
  assert.equal(classifyOutcome({ ...base, code: 1 }), "crashed");
  assert.equal(classifyOutcome({ ...base, signal: "SIGTERM" }), "crashed");
  assert.equal(classifyOutcome({ ...base, killedByTimeout: true }), "timeout");
  assert.equal(classifyOutcome({ ...base, requireMarker: "DONE" }), "truncated");
});

test("LIVE: captures stdout of a real child + classifies ok", async () => {
  const cap = makeSpawnCapture();
  const r = await cap("node", {
    args: ["-e", "process.stdout.write('hello agent')"],
    timeoutMs: 5000,
  });
  assert.equal(r.outcome, "ok");
  assert.equal(r.stdout, "hello agent");
});

test("LIVE: wall-clock timeout kills a hung child", async () => {
  const cap = makeSpawnCapture();
  const r = await cap("node", { args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 400 });
  assert.equal(r.outcome, "timeout");
});

test("LIVE: stdin is piped to the child then EOF", async () => {
  const cap = makeSpawnCapture();
  const r = await cap("node", {
    args: [
      "-e",
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('got:'+d))",
    ],
    stdin: "prompt text",
    timeoutMs: 5000,
  });
  assert.equal(r.outcome, "ok");
  assert.equal(r.stdout, "got:prompt text");
});

test("LIVE: a missing binary surfaces as a crash, never throws", async () => {
  const cap = makeSpawnCapture();
  const r = await cap("definitely-not-a-real-bin-xyz", { args: [], timeoutMs: 2000 });
  assert.notEqual(r.outcome, "ok");
  assert.match(r.stderr, /spawn error|ENOENT/);
});
