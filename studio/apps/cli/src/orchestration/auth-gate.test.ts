/**
 * auth-gate.test.ts — ToS auth classification + the /demos gate verdict.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { orchestration as orch } from "@prometheus/core";

import { assessAgentAuth, authGateVerdict, detectAuthMode } from "./auth-gate.js";

test("detectAuthMode: API key env → api-key; else login service → subscription", () => {
  assert.equal(detectAuthMode("claude", { ANTHROPIC_API_KEY: "sk-ant-x" }), "api-key");
  assert.equal(detectAuthMode("claude", {}), "subscription"); // Keychain/OAuth login
  assert.equal(detectAuthMode("codex", { OPENAI_API_KEY: "sk-x" }), "api-key");
  assert.equal(detectAuthMode("codex", {}), "subscription");
  assert.equal(detectAuthMode("gemini", { GOOGLE_API_KEY: "x" }), "api-key");
  assert.equal(detectAuthMode("gemini", {}), "subscription");
  assert.equal(detectAuthMode("cursor", { CURSOR_API_KEY: "x" }), "api-key");
  assert.equal(detectAuthMode("madeupcli", {}), "unknown");
});

test("assessAgentAuth: local/api-key are automation-OK; claude subscription is blocked", () => {
  assert.equal(assessAgentAuth("l", { kind: "local", model: "qwen" }).automationOk, true);
  assert.equal(assessAgentAuth("f", { kind: "fake" }).severity, "ok");
  assert.equal(
    assessAgentAuth("a", { kind: "cli", service: "claude" }, { ANTHROPIC_API_KEY: "k" }).severity,
    "ok",
  );
  const sub = assessAgentAuth("a", { kind: "cli", service: "claude" }, {});
  assert.equal(sub.mode, "subscription");
  assert.equal(sub.automationOk, false);
  assert.equal(sub.severity, "block");
  assert.match(sub.note, /Anthropic Consumer Terms/);
});

test("subscription stance is PER-VENDOR: gemini block, codex warn, cursor ok", () => {
  // Google forbids third-party driving of the OAuth/Code-Assist path → block.
  const g = assessAgentAuth("u", { kind: "cli", service: "gemini" }, {});
  assert.equal(g.severity, "block");
  assert.equal(g.automationOk, false);
  assert.match(g.note, /FORBIDDEN/);
  // OpenAI permits it but recommends an API key → warn.
  const cdx = assessAgentAuth("u", { kind: "cli", service: "codex" }, {});
  assert.equal(cdx.severity, "warn");
  assert.equal(cdx.automationOk, false);
  // Cursor blesses print mode for scripts/CI → ok even on a subscription.
  const cur = assessAgentAuth("u", { kind: "cli", service: "cursor" }, {});
  assert.equal(cur.severity, "ok");
  assert.equal(cur.automationOk, true);
});

test("api backend: own-key provider with a key → ok; verify-at-setup or no key → warn", () => {
  // an "allowed" provider (groq) with its key present → ok (commercial own-key automation).
  const ok = assessAgentAuth(
    "g",
    {
      kind: "api",
      service: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
    },
    { GROQ_API_KEY: "sk" },
  );
  assert.equal(ok.severity, "ok");
  assert.equal(ok.automationOk, true);
  // a "verify-at-setup" provider (nexos) with a key → warn (confirm terms at setup).
  const verify = assessAgentAuth(
    "n",
    {
      kind: "api",
      service: "nexos",
      baseUrl: "https://api.nexos.ai/v1",
      apiKeyEnv: "NEXOS_API_KEY",
    },
    { NEXOS_API_KEY: "sk" },
  );
  assert.equal(verify.severity, "warn");
  // no key at all → warn (it just won't run).
  const noKey = assessAgentAuth(
    "g",
    {
      kind: "api",
      service: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
    },
    {},
  );
  assert.equal(noKey.severity, "warn");
  assert.match(noKey.note, /no key/i);
});

test("authGateVerdict: all api-key/local → ok, no confirm", () => {
  const t = orch.normalizeTopology({
    orchestrator: "lead",
    agents: [
      { name: "lead", backend: { kind: "cli", service: "claude" }, role: "x" },
      { name: "w", backend: { kind: "local", model: "qwen" }, role: "y" },
    ],
  });
  const v = authGateVerdict(t, { ANTHROPIC_API_KEY: "k" });
  assert.equal(v.severity, "ok");
  assert.equal(v.needsConfirm, false);
  assert.equal(v.message, "");
});

test("authGateVerdict: a subscription claude → block + confirm + cites the clause", () => {
  const t = orch.normalizeTopology({
    orchestrator: "lead",
    agents: [{ name: "lead", backend: { kind: "cli", service: "claude" }, role: "x" }],
  });
  const v = authGateVerdict(t, {}); // no API key → subscription
  assert.equal(v.severity, "block");
  assert.equal(v.needsConfirm, true);
  assert.match(v.message, /per-vendor/i);
  assert.match(v.message, /at your own risk/);
  assert.equal(v.flagged.length, 1);
});
