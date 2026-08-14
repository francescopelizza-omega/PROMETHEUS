/**
 * provider.test.ts — `prometheus provider list` / `prometheus provider show <id>` over the C11
 * promotion policy (providers.config.json). Reads the REAL bundled config (a pure
 * file read, no engine spawn) — the same policy the GUI ProviderPicker renders.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { orchestration, secrets } from "@prometheus/core";

import { makeContext } from "../context.js";
import { hasMeteredConsent } from "../metered-consent.js";
import { parseArgs } from "../parse.js";
import {
  type EnableMeteredDeps,
  type FetchLike,
  type ProviderIoDeps,
  runProviderConnect,
  runProviderDisconnect,
  runProviderEnableMetered,
  runProviderList,
  runProviderShow,
  runProviderStatus,
} from "./provider.js";

const ctxFor = (argv: string[]) => makeContext(parseArgs(argv));

const KNOWN = orchestration.API_PROVIDER_IDS.find(
  (id) => orchestration.apiProviderFor(id)?.confidence === "known",
) as string;
const VERIFY = orchestration.API_PROVIDER_IDS.find(
  (id) => orchestration.apiProviderFor(id)?.confidence === "verify",
) as string;

const okFetch =
  (data: unknown): FetchLike =>
  async () => ({
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
const failFetch =
  (status: number, body: string): FetchLike =>
  async () => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  });

function io(over: Partial<ProviderIoDeps> = {}): ProviderIoDeps {
  return {
    secrets: new secrets.InMemorySecretsStore(),
    fetch: okFetch({ data: [{ id: "m1" }, { id: "m2" }] }),
    readKey: async () => "sk-test-key-123",
    confirm: async () => true,
    env: {},
    ...over,
  };
}

const SVC = secrets.SECRETS_SERVICE;

test("provider list: renders the Tier-A-first policy (exit 0)", async () => {
  const out = await runProviderList(ctxFor(["provider", "list"]));
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /Providers/);
});

test("provider show <id>: --json dumps the single Provider record", async () => {
  const out = await runProviderShow(ctxFor(["provider", "show", "local", "--json"]));
  assert.equal(out.exitCode, 0);
  const j = out.json as { ok: boolean; provider?: { id: string; tier: string } };
  assert.equal(j.ok, true);
  assert.equal(j.provider?.id, "local");
  assert.ok(["A", "B", "C"].includes(j.provider?.tier ?? ""));
});

test("provider show: missing id → usage error (exit 2)", async () => {
  const out = await runProviderShow(ctxFor(["provider", "show"]));
  assert.equal(out.exitCode, 2);
});

test("provider show: unknown id → not-found (exit 2)", async () => {
  const out = await runProviderShow(ctxFor(["provider", "show", "no-such-provider-xyz"]));
  assert.equal(out.exitCode, 2);
});

/* ── CLI-028: connect / status / disconnect (InMemory keychain + fake fetch) ──── */

test("provider connect: stores the key + verifies; key never echoed, keychain is the only sink", async () => {
  const deps = io();
  const out = await runProviderConnect(ctxFor(["provider", "connect", KNOWN]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /2 models/);
  // the key is in the (in-memory) keychain…
  assert.equal(await deps.secrets.get(SVC, `provider:${KNOWN}`), "sk-test-key-123");
  // …and NEVER in the rendered output (text or json).
  assert.ok(!(out.text ?? "").includes("sk-test-key-123"));
  assert.ok(!JSON.stringify(out.json).includes("sk-test-key-123"));
});

test("provider connect: unknown provider → exit 2, nothing stored", async () => {
  const deps = io();
  const out = await runProviderConnect(ctxFor(["provider", "connect", "no-such-xyz"]), deps);
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error: string }).error, "not-found");
});

test("provider connect: bad key → verify fails, key rolled back by default (exit 2)", async () => {
  const deps = io({ fetch: failFetch(401, '{"error":"invalid api key"}') });
  const out = await runProviderConnect(ctxFor(["provider", "connect", KNOWN]), deps);
  assert.equal(out.exitCode, 2);
  assert.match(out.text ?? "", /verify failed/);
  assert.equal(await deps.secrets.get(SVC, `provider:${KNOWN}`), undefined, "key rolled back");
});

test("provider connect --keep-unverified: bad key KEPT despite failed verify (exit 2)", async () => {
  const deps = io({ fetch: failFetch(401, "bad") });
  const out = await runProviderConnect(
    ctxFor(["provider", "connect", KNOWN, "--keep-unverified"]),
    deps,
  );
  assert.equal(out.exitCode, 2);
  assert.equal(await deps.secrets.get(SVC, `provider:${KNOWN}`), "sk-test-key-123", "key kept");
});

test("provider connect: empty key entered → exit 2, nothing stored", async () => {
  const deps = io({ readKey: async () => "   " });
  const out = await runProviderConnect(ctxFor(["provider", "connect", KNOWN]), deps);
  assert.equal(out.exitCode, 2);
  assert.equal(await deps.secrets.get(SVC, `provider:${KNOWN}`), undefined);
});

test("provider connect: verify-confidence provider prints the confirm-endpoint warning", async () => {
  const deps = io();
  const out = await runProviderConnect(ctxFor(["provider", "connect", VERIFY]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /confirm the exact/i);
});

test("provider status --json: covers all 16 registered providers with the right fields", async () => {
  const store = new secrets.InMemorySecretsStore();
  await store.set(SVC, `provider:${KNOWN}`, "sk-configured");
  const deps = io({ secrets: store, fetch: okFetch({ data: [{ id: "a" }] }) });
  const out = await runProviderStatus(ctxFor(["provider", "status", "--json"]), deps);
  assert.equal(out.exitCode, 0);
  const env = out.json as {
    ok: boolean;
    providers: {
      id: string;
      configured: boolean;
      reachable: boolean | null;
      modelCount: number | null;
    }[];
  };
  assert.equal(env.providers.length, orchestration.API_PROVIDER_IDS.length);
  const configured = env.providers.find((p) => p.id === KNOWN);
  assert.equal(configured?.configured, true);
  assert.equal(configured?.reachable, true);
  assert.equal(configured?.modelCount, 1);
  const unconfigured = env.providers.find((p) => p.id !== KNOWN && !p.configured);
  assert.equal(unconfigured?.reachable, null, "not configured → reachable is null, not false");
});

test("provider status: env var is a valid configured source (env still resolves)", async () => {
  const p = orchestration.apiProviderFor(KNOWN);
  const envVar = p?.apiKeyEnv[0] as string;
  const deps = io({ env: { [envVar]: "sk-from-env" } });
  const out = await runProviderStatus(ctxFor(["provider", "status", "--json"]), deps);
  const env = out.json as { providers: { id: string; source: string | null }[] };
  assert.match(env.providers.find((x) => x.id === KNOWN)?.source ?? "", /^env:/);
});

test("provider disconnect: --yes deletes the key (exit 0)", async () => {
  const store = new secrets.InMemorySecretsStore();
  await store.set(SVC, `provider:${KNOWN}`, "sk-x");
  const deps = io({ secrets: store });
  const out = await runProviderDisconnect(ctxFor(["provider", "disconnect", KNOWN, "--yes"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal(await store.get(SVC, `provider:${KNOWN}`), undefined);
});

test("provider disconnect: not configured → exit 0 notice, no confirm needed", async () => {
  const deps = io();
  const out = await runProviderDisconnect(ctxFor(["provider", "disconnect", KNOWN]), deps);
  assert.equal(out.exitCode, 0);
  assert.match(out.text ?? "", /not configured/);
});

test("provider disconnect: declined confirm keeps the key (exit 2)", async () => {
  const store = new secrets.InMemorySecretsStore();
  await store.set(SVC, `provider:${KNOWN}`, "sk-x");
  const deps = io({ secrets: store, confirm: async () => false });
  const out = await runProviderDisconnect(ctxFor(["provider", "disconnect", KNOWN]), deps);
  assert.equal(out.exitCode, 2);
  assert.equal(await store.get(SVC, `provider:${KNOWN}`), "sk-x", "key retained on decline");
});

/* ── CLI-031: enable-metered typed-confirm ────────────────────────────────── */

const emDeps = (over: Partial<EnableMeteredDeps>): EnableMeteredDeps => ({
  readLine: async () => "ENABLE METERED\n",
  now: () => "2026-07-17T00:00:00.000Z",
  home: "/x",
  isTty: true,
  ...over,
});

test("enable-metered: exact phrase grants consent (survives a fresh read)", async () => {
  const home = mkdtempSync(join(tmpdir(), "prom-em-"));
  try {
    const out = await runProviderEnableMetered(
      ctxFor(["provider", "enable-metered", KNOWN]),
      emDeps({ home, readLine: async () => "ENABLE METERED\n" }),
    );
    assert.equal(out.exitCode, 0);
    assert.equal(hasMeteredConsent(KNOWN, home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("enable-metered: wrong phrase 3× → exit 2, no consent", async () => {
  const home = mkdtempSync(join(tmpdir(), "prom-em-"));
  try {
    const out = await runProviderEnableMetered(
      ctxFor(["provider", "enable-metered", KNOWN]),
      emDeps({ home, readLine: async () => "enable metered\n" }), // lowercase → rejected
    );
    assert.equal(out.exitCode, 2);
    assert.equal((out.json as { reason: string }).reason, "consent-phrase-mismatch");
    assert.equal(hasMeteredConsent(KNOWN, home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("enable-metered: --json NEVER prompts — refuses fail-closed (exit 2)", async () => {
  let prompted = false;
  const out = await runProviderEnableMetered(
    ctxFor(["provider", "enable-metered", KNOWN, "--json"]),
    emDeps({
      readLine: async () => {
        prompted = true;
        return "ENABLE METERED\n";
      },
    }),
  );
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { reason: string }).reason, "interactive-consent-required");
  assert.equal(prompted, false, "--json must never read the phrase from stdin");
});

test("enable-metered: non-TTY refuses fail-closed (never blocks on a read)", async () => {
  let prompted = false;
  const out = await runProviderEnableMetered(
    ctxFor(["provider", "enable-metered", KNOWN]),
    emDeps({
      isTty: false,
      readLine: async () => {
        prompted = true;
        return "ENABLE METERED\n";
      },
    }),
  );
  assert.equal(out.exitCode, 2);
  assert.equal(prompted, false);
});

test("enable-metered: unknown provider → exit 2", async () => {
  const out = await runProviderEnableMetered(
    ctxFor(["provider", "enable-metered", "no-such-xyz"]),
    emDeps({}),
  );
  assert.equal(out.exitCode, 2);
  assert.equal((out.json as { error: string }).error, "not-found");
});

test("enable-metered: already-enabled → ok, no prompt", async () => {
  const home = mkdtempSync(join(tmpdir(), "prom-em-"));
  try {
    let prompted = false;
    await runProviderEnableMetered(ctxFor(["provider", "enable-metered", KNOWN]), emDeps({ home }));
    const out = await runProviderEnableMetered(
      ctxFor(["provider", "enable-metered", KNOWN]),
      emDeps({
        home,
        readLine: async () => {
          prompted = true;
          return "ENABLE METERED\n";
        },
      }),
    );
    assert.equal(out.exitCode, 0);
    assert.equal((out.json as { alreadyEnabled: boolean }).alreadyEnabled, true);
    assert.equal(prompted, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ── the verify ping, which was OpenAI's and only OpenAI's ─────────────────── */

/** Capture the URL and headers the verify ping actually used. */
function pingSpy(): { fetch: FetchLike; url: () => string; headers: () => Record<string, string> } {
  let url = "";
  let headers: Record<string, string> = {};
  const fetch: FetchLike = async (u, init) => {
    url = String(u);
    headers = (init?.headers ?? {}) as Record<string, string>;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "m1" }] }),
      text: async () => "{}",
    };
  };
  return { fetch, url: () => url, headers: () => headers };
}

test("connecting Anthropic pings ANTHROPIC's path with ANTHROPIC's headers", async () => {
  // Both halves of this request used to be OpenAI's: `/models` and `Authorization: Bearer`.
  // Anthropic serves `/v1/models` and takes `x-api-key` + a mandatory version header, so the
  // ping 404'd, `connect` read that as an invalid key, and a CORRECT key could not be stored.
  const spy = pingSpy();
  const deps = io({ fetch: spy.fetch });
  const out = await runProviderConnect(ctxFor(["provider", "connect", "anthropic"]), deps);
  assert.equal(out.exitCode, 0, "a valid Anthropic key must be storable");
  assert.equal(spy.url(), "https://api.anthropic.com/v1/models");
  assert.equal(spy.headers()["x-api-key"], "sk-test-key-123");
  assert.equal(spy.headers()["anthropic-version"], "2023-06-01");
  assert.equal(spy.headers().Authorization, undefined, "a bearer authenticates as nobody here");
  assert.equal(await deps.secrets.get(SVC, "provider:anthropic"), "sk-test-key-123");
});

test("connecting Gemini pings GEMINI's path with GEMINI's header", async () => {
  const spy = pingSpy();
  const deps = io({ fetch: spy.fetch });
  const out = await runProviderConnect(ctxFor(["provider", "connect", "gemini"]), deps);
  assert.equal(out.exitCode, 0);
  assert.equal(spy.url(), "https://generativelanguage.googleapis.com/v1beta/models");
  assert.equal(spy.headers()["x-goog-api-key"], "sk-test-key-123");
  assert.equal(await deps.secrets.get(SVC, "provider:gemini"), "sk-test-key-123");
});

test("an OpenAI-compatible provider is UNCHANGED — /models and a bearer", async () => {
  // The default path must not move: sixteen of the eighteen rows depend on it. Named
  // explicitly rather than via KNOWN, which now resolves to `anthropic` — the first row with
  // `confidence: "known"` — and so no longer exercises the OpenAI wire at all.
  const spy = pingSpy();
  await runProviderConnect(ctxFor(["provider", "connect", "groq"]), io({ fetch: spy.fetch }));
  assert.equal(spy.url(), "https://api.groq.com/openai/v1/models");
  assert.equal(spy.headers().authorization, "Bearer sk-test-key-123");
});
