/**
 * key-resolver.test.ts — the assignment that was missing, and the guard that it stays.
 *
 * `SessionCtx.resolveKey` was declared, threaded through three call sites, consumed by the
 * transport, and covered by a test asserting a cloud key reaches the wire when a resolver is
 * supplied — and NO host ever supplied one. That is this session's recurring defect in its
 * purest form: an optional field on a context object, correct on both sides, connected by
 * nothing, and invisible to the type checker precisely because it is optional.
 *
 * So two of these tests assert the resolver's behaviour, and two assert that the hosts ACTUALLY
 * PASS IT — because the first two would have passed all along.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createKeyResolver, keychainProviders } from "./key-resolver.js";

/* ── resolving ─────────────────────────────────────────────────────────────*/

test("an env ref reads the environment at request time", async () => {
  const resolve = createKeyResolver({ env: { OPENROUTER_API_KEY: "sk-live" } });
  assert.equal(await resolve("env:OPENROUTER_API_KEY"), "sk-live");
});

test("a keychain ref reads the keychain, under the account the CLI already uses", async () => {
  const asked: string[] = [];
  const resolve = createKeyResolver({
    env: {},
    secretsGet: async (_service, account) => {
      asked.push(account);
      return "sk-from-keychain";
    },
  });
  assert.equal(await resolve("keychain:provider:groq"), "sk-from-keychain");
  // `provider:<id>` is the account `prometheus provider connect` writes and the swarm reads.
  assert.deepEqual(asked, ["provider:groq"]);
});

test("a missing key is an ACTIONABLE error, not an empty string", async () => {
  // Returning "" would send `Authorization: Bearer ` and turn "you have not configured this"
  // into an opaque 401 from the provider three seconds later.
  const resolve = createKeyResolver({ env: {}, secretsGet: async () => undefined });
  await assert.rejects(() => resolve("env:NOPE_API_KEY"), /NOPE_API_KEY is not set/);
  await assert.rejects(() => resolve("keychain:provider:groq"), /provider connect/);
});

test("an unrecognised ref is refused rather than guessed at", async () => {
  const resolve = createKeyResolver({ env: {} });
  await assert.rejects(() => resolve("sk-a-raw-key"), /unrecognised api key reference/);
});

test("a keychain with no tool for this platform is a normal state, not a crash", async () => {
  // Windows has no backend, and a user there configures providers by env var instead.
  const found = await keychainProviders(["groq", "deepseek"], async () => {
    throw new Error("no CLI keychain tool for platform 'win32'");
  });
  assert.deepEqual([...found], []);
});

test("only providers with a stored key come back from the probe", async () => {
  const found = await keychainProviders(["groq", "deepseek"], async (_s, account) =>
    account === "provider:groq" ? "sk" : undefined,
  );
  assert.deepEqual([...found], ["groq"]);
});

/* ── the wiring — what was actually broken ─────────────────────────────────*/

const hostSrc = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

test("BOTH interactive hosts assign resolveKey into the turn context", () => {
  // The whole defect. `resolveKey` is optional, so omitting it type-checks perfectly and the
  // cloud branch simply never runs. Asserted as source text because the alternative is booting
  // a full readline session with a fake TTY.
  for (const [name, src] of [
    ["readline host", hostSrc("./host.ts")],
    ["TUI host", hostSrc("../tui/session-bridge.ts")],
  ] as const) {
    assert.match(src, /\n\s+resolveKey,/, `${name} does not pass resolveKey into its TurnCtx`);
    assert.match(src, /createKeyResolver\(/, `${name} never builds a resolver`);
  }
});

test("BOTH hosts discover cloud endpoints, not just the two local runners", () => {
  // `detectBackends` probes ollama and LM Studio and nothing else, so without this a cloud
  // provider could never become the session endpoint however it was configured.
  for (const [name, src] of [
    ["readline host", hostSrc("./host.ts")],
    ["TUI host", hostSrc("../tui/session-bridge.ts")],
  ] as const) {
    assert.match(src, /discoverCloudEndpoints\(/, `${name} has no cloud endpoint discovery`);
  }
});
