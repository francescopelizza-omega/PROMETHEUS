/**
 * backends.test.ts — BackendInvoker routing (fake / cli / engine-chat) with injected
 * spawn + PATH + engine seams. No real CLI or model is touched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { orchestration } from "@prometheus/core";
import type { EngineClient } from "@prometheus/engine-bridge";

import { type InvokerDeps, makeInvoker } from "./backends.js";
import type { CaptureResult, Outcome } from "./spawn-capture.js";

type AgentSpec = orchestration.AgentSpec;
const req = (agent: AgentSpec, prompt = "do the thing", turn = 1): orchestration.InvokeRequest => ({
  agent,
  prompt,
  taskId: "T1",
  turn,
});

const fakeEngine = (resp: Record<string, unknown>): EngineClient =>
  ({ runPrometheus: async () => resp }) as unknown as EngineClient;

const capture = (outcome: Outcome, stdout = "", stderr = ""): CaptureResult => ({
  code: outcome === "ok" ? 0 : 1,
  signal: null,
  stdout,
  stderr,
  outcome,
});

/** A fake, always-clear machine sample — the real sampleLaunchGuard sleeps ~120ms and reads
 *  THIS machine's live CPU/RAM, which would make every cli-backend test slow and, on a loaded
 *  box, flaky. A test exercising the ceiling itself overrides this. */
const FAST_LAUNCH_GUARD = { launchGuardFn: async () => ({ cpuPct: 10, ramPct: 10 }) };

test("fake backend → a canned reply", async () => {
  const invoke = makeInvoker({ client: fakeEngine({}) });
  const r = await invoke(req({ name: "x", role: "tester", backend: { kind: "fake" } }));
  assert.match(r.text, /\(fake\)/);
  assert.match(r.text, /do the thing/);
});

test("cli backend → uses the verified recipe + returns captured stdout", async () => {
  let spawnedBin = "";
  let spawnedArgs: string[] = [];
  const deps: InvokerDeps = {
    client: fakeEngine({}),
    which: () => true,
    ...FAST_LAUNCH_GUARD,
    spawn: async (bin, opts) => {
      spawnedBin = bin;
      spawnedArgs = opts.args;
      return capture("ok", "endpoint implemented");
    },
  };
  const r = await makeInvoker(deps)(
    req({ name: "api", role: "backend", backend: { kind: "cli", service: "claude" } }),
  );
  assert.equal(r.text, "endpoint implemented");
  assert.equal(spawnedBin, "claude");
  assert.ok(spawnedArgs.includes("-p"));
});

test("cli backend → clear error when the binary isn't on PATH", async () => {
  const invoke = makeInvoker({
    client: fakeEngine({}),
    which: () => false,
    spawn: async () => capture("ok"),
  });
  await assert.rejects(
    invoke(req({ name: "api", role: "backend", backend: { kind: "cli", service: "codex" } })),
    /none of \[codex\] found on PATH/,
  );
});

test("cli backend → a bad outcome (rate-limit) throws (coordinator records it)", async () => {
  const invoke = makeInvoker({
    client: fakeEngine({}),
    which: () => true,
    ...FAST_LAUNCH_GUARD,
    spawn: async () => capture("rate_limited", "", "Error: 429 too many requests"),
  });
  await assert.rejects(
    invoke(req({ name: "ui", role: "frontend", backend: { kind: "cli", service: "gemini" } })),
    /gemini rate_limited/,
  );
});

test("cli backend → cursor uses its fallback bin + text format + --trust", async () => {
  let args: string[] = [];
  const invoke = makeInvoker({
    client: fakeEngine({}),
    which: (b) => b === "cursor", // primary cursor-agent missing → fallback cursor
    ...FAST_LAUNCH_GUARD,
    spawn: async (_bin, opts) => {
      args = opts.args;
      return capture("ok", "ok");
    },
  });
  await invoke(req({ name: "c", role: "x", backend: { kind: "cli", service: "cursor" } }));
  assert.ok(args.includes("--trust"));
  assert.ok(args.join(" ").includes("--output-format text"));
});

test("cli backend → a saturated machine refuses the launch, never spawns", async () => {
  let spawned = false;
  let samples = 0;
  const invoke = makeInvoker({
    client: fakeEngine({}),
    which: () => true,
    launchGuardFn: async () => {
      samples += 1;
      return { cpuPct: 12, ramPct: 96 };
    },
    sleep: async () => {},
    spawn: async () => {
      spawned = true;
      return capture("ok");
    },
  });
  await assert.rejects(
    invoke(req({ name: "a", role: "r", backend: { kind: "cli", service: "opencode" } })),
    // "temporarily unavailable" deliberately: it is the token `isTransientBackendError`
    // recognises, so the coordinator re-issues the agent instead of failing the turn outright
    // with `[backend error]`. The old "refused — …" wording matched nothing.
    /opencode: temporarily unavailable — RAM at 96%/,
  );
  assert.equal(
    spawned,
    false,
    "must never spawn a fresh agent-CLI process under critical pressure",
  );
  assert.equal(samples, 4, "the ceiling is re-sampled (1 + 3 waits) before the launch is refused");
});

test("cli backend → a ceiling that CLEARS lets the launch through instead of losing the agent", async () => {
  // The self-inflicted case: a swarm saturates the machine, so the first sample refuses agent 4.
  // One read used to be final, which meant the guard killed the rest of the swarm it was
  // reading the load of.
  let spawned = false;
  let samples = 0;
  const invoke = makeInvoker({
    client: fakeEngine({}),
    which: () => true,
    launchGuardFn: async () => {
      samples += 1;
      return samples === 1 ? { cpuPct: 94, ramPct: 40 } : { cpuPct: 30, ramPct: 40 };
    },
    sleep: async () => {},
    spawn: async () => {
      spawned = true;
      return capture("ok", "agent ran");
    },
  });
  const out = await invoke(
    req({ name: "a", role: "r", backend: { kind: "cli", service: "opencode" } }),
  );
  assert.equal(spawned, true, "the second sample was clear — the agent must run");
  assert.equal(samples, 2);
  assert.match(out.text, /agent ran/);
});

test("cli backend → launchGuardWaits: 0 restores the single-sample behaviour", async () => {
  let samples = 0;
  const invoke = makeInvoker({
    client: fakeEngine({}),
    which: () => true,
    launchGuardWaits: 0,
    launchGuardFn: async () => {
      samples += 1;
      return { cpuPct: 12, ramPct: 96 };
    },
    spawn: async () => capture("ok"),
  });
  await assert.rejects(
    invoke(req({ name: "a", role: "r", backend: { kind: "cli", service: "opencode" } })),
    /temporarily unavailable/,
  );
  assert.equal(samples, 1);
});

test("cli backend → the resource ceiling applies uniformly (hermes too, not just opencode)", async () => {
  let spawned = false;
  const invoke = makeInvoker({
    client: fakeEngine({}),
    which: () => true,
    launchGuardFn: async () => ({ cpuPct: 96, ramPct: 10 }),
    sleep: async () => {}, // the guard re-samples with backoff — never really wait in a test
    spawn: async () => {
      spawned = true;
      return capture("ok");
    },
  });
  await assert.rejects(
    invoke(req({ name: "a", role: "r", backend: { kind: "cli", service: "hermes" } })),
    /hermes: temporarily unavailable — CPU at 96%/,
  );
  assert.equal(spawned, false);
});

test("gate block aborts the cli launch before spawning", async () => {
  let spawned = false;
  const invoke = makeInvoker({
    client: fakeEngine({}),
    which: () => true,
    gate: async () => ({ ok: false, reason: "blocked binary" }),
    spawn: async () => {
      spawned = true;
      return capture("ok");
    },
  });
  await assert.rejects(
    invoke(req({ name: "a", role: "r", backend: { kind: "cli", service: "claude" } })),
    /nemesis blocked claude/,
  );
  assert.equal(spawned, false);
});

test("engine-chat backend → the engine's local chat reply", async () => {
  const invoke = makeInvoker({ client: fakeEngine({ ok: true, response: "engine says hi" }) });
  const r = await invoke(
    req({ name: "e", role: "r", backend: { kind: "engine-chat", model: "qwen" } }),
  );
  assert.equal(r.text, "engine says hi");
});

test("cli backend → retries a rate-limit with backoff, then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const invoke = makeInvoker({
    client: fakeEngine({}),
    which: () => true,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    ...FAST_LAUNCH_GUARD,
    spawn: async () => {
      calls += 1;
      return calls < 3 ? capture("rate_limited", "", "429") : capture("ok", "finally done");
    },
  });
  const r = await invoke(
    req({ name: "a", role: "r", backend: { kind: "cli", service: "gemini" } }),
  );
  assert.equal(r.text, "finally done");
  assert.equal(calls, 3); // 2 retries then success
  assert.equal(sleeps.length, 2); // backed off twice
  assert.ok((sleeps[1] ?? 0) >= (sleeps[0] ?? 0)); // exponential
});

test("cli backend → an auth error is NOT retried (no lockout hammering)", async () => {
  let calls = 0;
  const invoke = makeInvoker({
    client: fakeEngine({}),
    which: () => true,
    sleep: async () => {},
    ...FAST_LAUNCH_GUARD,
    spawn: async () => {
      calls += 1;
      return capture("auth_error", "", "not logged in");
    },
  });
  await assert.rejects(
    invoke(req({ name: "a", role: "r", backend: { kind: "cli", service: "claude" } })),
    /auth_error/,
  );
  assert.equal(calls, 1); // tried once, no retry
});
