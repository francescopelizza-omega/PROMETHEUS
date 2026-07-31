/**
 * connectors.test.ts — the 4 connector builders + the cli gate/force guards (file 12 §1.2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemorySecretsStore, SECRETS_SERVICE } from "../../secrets/keychain.js";
import { getProvider, loadProviders, newConnector } from "../providers/index.js";
import type { ConnectorConfig, Provider } from "../providers/types.js";
import {
  ConnectorError,
  buildApiKeyConnector,
  buildCliLaunchSpec,
  buildLocalServeConnector,
  buildOauthConnector,
  launchCliPassthrough,
} from "./index.js";

const PROVIDERS = loadProviders();
const provider = (id: string): Provider => getProvider(PROVIDERS, id) as Provider;

// ---- local-serve (Tier A) -------------------------------------------------- //

test("buildLocalServeConnector yields a local, key-free endpoint", () => {
  const local = provider("local");
  const c = newConnector(local, "local-serve", "qwen3:8b", ["agent-pane"]);
  const ce = buildLocalServeConnector(c, local, { baseUrl: "http://127.0.0.1:11434/v1" });
  assert.equal(ce.endpoint.locality, "local");
  assert.equal(ce.endpoint.model, "qwen3:8b");
  assert.equal(ce.endpoint.apiKeyRef, undefined);
  assert.equal(ce.resolveKey, undefined);
});

test("buildLocalServeConnector rejects a non-local connector", () => {
  const local = provider("local");
  const c = {
    ...newConnector(local, "local-serve", "qwen3:8b", ["agent-pane"]),
    kind: "api-key",
  } as ConnectorConfig;
  assert.throws(() => buildLocalServeConnector(c, local), ConnectorError);
});

// ---- api-key (Tier C) — guarded + lazy secret ------------------------------ //

function meteredConnector(): ConnectorConfig {
  const host = provider("open-weight-api-host");
  return {
    ...newConnector(host, "api-key", "deepseek-chat", ["agent-pane"]),
    baseUrl: "https://openrouter.ai/api/v1",
    keyRef: { service: SECRETS_SERVICE, account: "open-weight-api-host" },
    guardrail: {
      monthlyCapUsd: 20,
      warnAtPct: 0.8,
      spentThisMonthUsd: 0,
      onCap: "auto-disable",
      resetsOn: "2026-07-01",
    },
    confirmedCostWarningAt: "2026-06-19T00:00:00Z",
  };
}

test("buildApiKeyConnector refuses a metered connector with no guardrail/confirmation", () => {
  const host = provider("open-weight-api-host");
  const bare = {
    ...newConnector(host, "api-key", "deepseek-chat", ["agent-pane"]),
    baseUrl: "https://x/v1",
    keyRef: { service: SECRETS_SERVICE, account: "x" },
  };
  assert.throws(() => buildApiKeyConnector(bare, host, new InMemorySecretsStore()), ConnectorError);
});

test("buildApiKeyConnector builds a cloud endpoint and reads the key LAZILY from the keychain", async () => {
  const store = new InMemorySecretsStore();
  await store.set(SECRETS_SERVICE, "open-weight-api-host", "sk-secret-123");
  const ce = buildApiKeyConnector(meteredConnector(), provider("open-weight-api-host"), store);
  assert.equal(ce.endpoint.locality, "cloud");
  assert.equal(ce.endpoint.apiKeyRef, `${SECRETS_SERVICE}:open-weight-api-host`);
  // the secret is NOT embedded in the descriptor — only reachable via resolveKey().
  assert.ok(!JSON.stringify(ce.endpoint).includes("sk-secret-123"));
  assert.equal(await ce.resolveKey?.(ce.endpoint.apiKeyRef ?? ""), "sk-secret-123");
});

test("api-key resolveKey throws when the keychain has no secret", async () => {
  const ce = buildApiKeyConnector(
    meteredConnector(),
    provider("open-weight-api-host"),
    new InMemorySecretsStore(),
  );
  await assert.rejects(() => ce.resolveKey?.("x") ?? Promise.resolve(""), ConnectorError);
});

// ---- oauth-subscription-bridge (Tier B) ------------------------------------ //

test("buildOauthConnector attaches the betaHeader and resolves the token lazily", async () => {
  const claude = provider("claude");
  const store = new InMemorySecretsStore();
  await store.set(SECRETS_SERVICE, "claude-oauth", "oauth-token-xyz");
  const c: ConnectorConfig = {
    ...newConnector(claude, "oauth-subscription-bridge", "claude-sonnet-4-6", ["agent-pane"]),
    baseUrl: "https://api.anthropic.com/v1",
    oauthRef: { service: SECRETS_SERVICE, account: "claude-oauth" },
  };
  const ce = buildOauthConnector(c, claude, store);
  assert.equal(ce.endpoint.locality, "cloud");
  assert.equal(ce.extraHeaders?.["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(await ce.resolveKey?.("x"), "oauth-token-xyz");
});

test("buildOauthConnector refuses a connector with no oauthRef", () => {
  const claude = provider("claude");
  const c = newConnector(claude, "oauth-subscription-bridge", "claude-sonnet-4-6", ["agent-pane"]);
  assert.throws(() => buildOauthConnector(c, claude, new InMemorySecretsStore()), ConnectorError);
});

// ---- cli-passthrough (Tier B) — gate + never-force ------------------------- //

test("buildCliLaunchSpec uses the provider cliBin and forbids agent-supplied --force", () => {
  const cursor = provider("cursor");
  const c = newConnector(cursor, "cli-passthrough", "default", ["agent-pane"]);
  const spec = buildCliLaunchSpec(c, cursor, { args: ["chat"] });
  assert.equal(spec.bin, "cursor");
  assert.throws(() => buildCliLaunchSpec(c, cursor, { args: ["chat", "--force"] }), ConnectorError);
  assert.throws(
    () => buildCliLaunchSpec(c, cursor, { args: ["--force-unsafe=1"] }),
    ConnectorError,
  );
});

test("launchCliPassthrough spawns only after an allow/warn gate verdict", async () => {
  const cursor = provider("cursor");
  const spec = buildCliLaunchSpec(
    newConnector(cursor, "cli-passthrough", "default", ["agent-pane"]),
    cursor,
    { args: ["chat"] },
  );
  const spawned: string[] = [];
  const spawn = (bin: string) => {
    spawned.push(bin);
    return { pid: 4242 };
  };
  const ok = await launchCliPassthrough(spec, { gate: async () => ({ decision: "allow" }), spawn });
  assert.equal(ok.child?.pid, 4242);
  assert.deepEqual(spawned, ["cursor"]);
});

test("launchCliPassthrough aborts the spawn on a block verdict", async () => {
  const cursor = provider("cursor");
  const spec = buildCliLaunchSpec(
    newConnector(cursor, "cli-passthrough", "default", ["agent-pane"]),
    cursor,
    {},
  );
  let spawnedCount = 0;
  const spawn = () => {
    spawnedCount++;
    return {};
  };
  await assert.rejects(
    () =>
      launchCliPassthrough(spec, {
        gate: async () => ({ decision: "block", reason: "untrusted bin" }),
        spawn,
      }),
    ConnectorError,
  );
  assert.equal(spawnedCount, 0, "nothing must spawn after a block");
});
