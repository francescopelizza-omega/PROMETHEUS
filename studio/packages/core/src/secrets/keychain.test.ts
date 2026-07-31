/**
 * keychain.test.ts — in-memory secrets store + stderr redaction (§7.2).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySecretsStore, SECRETS_SERVICE, redactSecretEnv } from "./keychain.js";

test("InMemorySecretsStore: set/get/delete by (service, account)", async () => {
  const s = new InMemorySecretsStore();
  await s.set(SECRETS_SERVICE, "openrouter", "sk-abc");
  assert.equal(await s.get(SECRETS_SERVICE, "openrouter"), "sk-abc");
  assert.equal(await s.get(SECRETS_SERVICE, "missing"), undefined);
  // distinct accounts don't collide
  await s.set(SECRETS_SERVICE, "github", "ghp_x");
  assert.equal(await s.get(SECRETS_SERVICE, "openrouter"), "sk-abc");
  await s.delete(SECRETS_SERVICE, "openrouter");
  assert.equal(await s.get(SECRETS_SERVICE, "openrouter"), undefined);
});

test("redactSecretEnv: known + generic secret keys redacted; others kept", () => {
  const log = [
    "OPENROUTER_API_KEY=sk-live-1234567890",
    "ANTHROPIC_API_KEY: sk-ant-xyz",
    "MY_CUSTOM_TOKEN=tok_secret",
    "PROMETHEUS_PY=/abs/prometheus.py",
    "info: starting engine",
  ].join("\n");
  const out = redactSecretEnv(log);
  assert.ok(out.includes("OPENROUTER_API_KEY=***REDACTED***"));
  assert.ok(out.includes("ANTHROPIC_API_KEY: ***REDACTED***"));
  assert.ok(out.includes("MY_CUSTOM_TOKEN=***REDACTED***")); // generic …TOKEN
  assert.ok(out.includes("PROMETHEUS_PY=/abs/prometheus.py")); // a path, not secret → kept
  assert.ok(out.includes("info: starting engine"));
  assert.equal(out.includes("sk-live-1234567890"), false);
  assert.equal(out.includes("sk-ant-xyz"), false);
  // extras list + non-string
  assert.ok(redactSecretEnv("FOO=bar", ["FOO"]).includes("FOO=***REDACTED***"));
  assert.equal(redactSecretEnv(undefined), "");
});
