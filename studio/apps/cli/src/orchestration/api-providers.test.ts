/**
 * api-providers.test.ts — the keychain-first API-key resolution for `api` backends
 * (CLI-028, deliverable 6): an env var still WINS, but a keychain key is now found where
 * only env vars worked before. Uses the injected `secretsGet` seam (no real keychain).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { orchestration, secrets } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import { type InvokerDeps, makeInvoker } from "./backends.js";

const KNOWN = orchestration.API_PROVIDER_IDS.find(
  (id) => orchestration.apiProviderFor(id)?.confidence === "known",
) as string;

// a client stub — never reached in these tests (they fail before/at key resolution or
// short-circuit on the fake AI client factory).
const client = {} as EngineClient;

function reqFor(env?: Record<string, string>) {
  const p = orchestration.apiProviderFor(KNOWN);
  return {
    agent: {
      name: "a1",
      backend: {
        kind: "api" as const,
        service: KNOWN,
        baseUrl: p?.baseUrl ?? "https://x/v1",
        apiKeyEnv: p?.apiKeyEnv[0] ?? "X_API_KEY",
        model: p?.defaultModel ?? "m",
        ...(env ? { env } : {}),
      },
    },
    prompt: "hi",
  };
}

/** A fake AI client factory that records the key it was handed, then returns a canned reply. */
function captureKeyDeps(extra: Partial<InvokerDeps> = {}): {
  deps: InvokerDeps;
  seen: () => string | undefined;
} {
  let capturedKey: string | undefined;
  const aiClientFactory = ((
    _endpoint: unknown,
    _opts: unknown,
    keyOpts?: { resolveKey?: () => Promise<string> },
  ) => ({
    chat: async function* () {
      if (keyOpts?.resolveKey) capturedKey = await keyOpts.resolveKey();
      yield { delta: "ok", done: true };
    },
  })) as unknown as InvokerDeps["aiClientFactory"];
  return {
    deps: { client, aiClientFactory, ...extra },
    seen: () => capturedKey,
  };
}

test("keychain fallback: no env var, key comes from the keychain seam", async () => {
  const store = new secrets.InMemorySecretsStore();
  await store.set(secrets.SECRETS_SERVICE, `provider:${KNOWN}`, "sk-keychain");
  const { deps } = captureKeyDeps({
    secretsGet: (svc, acct) => store.get(svc, acct),
  });
  const invoke = makeInvoker(deps);
  // it resolves the key (no "no API key" throw) — the fake client returns "ok".
  const out = await invoke(reqFor());
  assert.equal((out as { text?: string }).text, "ok");
});

test("env var WINS over the keychain (explicit override)", async () => {
  const store = new secrets.InMemorySecretsStore();
  await store.set(secrets.SECRETS_SERVICE, `provider:${KNOWN}`, "sk-keychain");
  const envVar = orchestration.apiProviderFor(KNOWN)?.apiKeyEnv[0] as string;
  const { deps, seen } = captureKeyDeps({ secretsGet: (svc, acct) => store.get(svc, acct) });
  const invoke = makeInvoker(deps);
  await invoke(reqFor({ [envVar]: "sk-env" }));
  assert.equal(seen(), "sk-env", "the env var overrides the keychain key");
});

test("no env AND no keychain seam → the helpful no-key error (legacy behavior preserved)", async () => {
  const { deps } = captureKeyDeps(); // no secretsGet
  const invoke = makeInvoker(deps);
  await assert.rejects(() => invoke(reqFor()), /no API key/);
});
