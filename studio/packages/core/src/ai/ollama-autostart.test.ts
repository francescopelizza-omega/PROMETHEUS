/**
 * ollama-autostart.test.ts — `ensureOllamaRunning`, the ONE shared "make sure Ollama is up, on
 * ANY surface" function (packages/core/src/ai/ollama-autostart.ts). Every engine-bridge
 * primitive is injected — no network, no spawn, no real lock file — mirroring the CLI's own
 * onboarding.test.ts conventions for the twin `probeAndMaybeStart` code path.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { type EnsureOllamaOptions, ensureLmStudioRunning, ensureOllamaRunning } from "./ollama-autostart.js";

/** Always-safe defaults: nothing installed, nothing listening, no real spawn, no real lock —
 *  every test overrides only what it needs to exercise. */
const SAFE: EnsureOllamaOptions = {
  canStartFn: async () => false,
  listenersOnPortFn: async () => ({ processes: [] }),
  startModelServerFn: () => ({ ok: false, error: "disabled in this test" }),
  retryDelayMs: 0,
  skipWatchdog: true,
  acquireStartLockFn: () => true,
  releaseStartLockFn: () => {},
  // A fake, always-clear machine sample — the real sampleLaunchGuard sleeps ~120ms and reads
  // this actual dev machine's live CPU/RAM, either of which would make tests slow and, on a
  // loaded CI box, flaky. A test exercising the ceiling itself overrides this.
  launchGuardFn: async () => ({ cpuPct: 10, ramPct: 10 }),
};

function run(opts: EnsureOllamaOptions): ReturnType<typeof ensureOllamaRunning> {
  return ensureOllamaRunning({ ...SAFE, ...opts });
}

function runLmStudio(opts: EnsureOllamaOptions): ReturnType<typeof ensureLmStudioRunning> {
  return ensureLmStudioRunning({ ...SAFE, ...opts });
}

/** A fetch that always answers 200 with the given served model ids. */
function fetchServing(models: string[]): typeof fetch {
  return (async () =>
    ({ ok: true, json: async () => ({ data: models.map((id) => ({ id })) }) }) as Response) as unknown as typeof fetch;
}

/** A fetch that never answers (ECONNREFUSED-shaped). */
function fetchDown(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

/** A fetch that's down until `up()` flips it to serving `models`. */
function fetchDelayed(models: string[]): { fetchFn: typeof fetch; up: () => void } {
  let live = false;
  const fetchFn = (async () => {
    if (!live) throw new Error("ECONNREFUSED");
    return { ok: true, json: async () => ({ data: models.map((id) => ({ id })) }) } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, up: () => (live = true) };
}

test("already running with a model served → adopted, started:false, no lock/spawn touched", async () => {
  let lockTouched = false;
  const res = await run({
    fetchFn: fetchServing(["qwen3.6:latest"]),
    acquireStartLockFn: () => {
      lockTouched = true;
      return true;
    },
  });
  assert.equal(res.started, false);
  assert.equal(res.endpoint?.model, "qwen3.6:latest");
  assert.equal(lockTouched, false, "already up ⇒ never even reaches the lock");
});

test("already running but serving NO model → reason no-model-served", async () => {
  const res = await run({ fetchFn: fetchServing([]) });
  assert.equal(res.started, false);
  assert.equal(res.reason, "no-model-served");
  assert.equal(res.endpoint, undefined);
});

test("a caller-pinned modelId always wins, even when it isn't in the served list yet", async () => {
  const res = await run({ fetchFn: fetchServing(["llama3:latest"]), modelId: "qwen3.6:latest" });
  assert.equal(res.endpoint?.model, "qwen3.6:latest");
});

test("zero-config default picks the SMALLEST already-served model, never the biggest", async () => {
  const res = await run({ fetchFn: fetchServing(["gemma3:27b", "qwen2.5:0.5b", "smollm2:135m"]) });
  assert.equal(res.endpoint?.model, "smollm2:135m");
});

test("port occupied by something not answering → wedged, never started", async () => {
  let startCalled = false;
  const res = await run({
    fetchFn: fetchDown(),
    listenersOnPortFn: async () => ({ processes: [{ pid: 1, command: "ollama" }] }),
    canStartFn: async () => true,
    startModelServerFn: () => {
      startCalled = true;
      return { ok: true, pid: 1 };
    },
  });
  assert.equal(res.reason, "wedged");
  assert.equal(startCalled, false);
});

test("not reachable, not installed → reason not-installed", async () => {
  const res = await run({ fetchFn: fetchDown() });
  assert.equal(res.reason, "not-installed");
});

test("cold start: installed + not running → spawns, retries, and adopts", async () => {
  // spawnWatchdogIfNeeded itself is NOT injectable here (same fire-and-forget, no-DI-hook
  // design as engine-bridge's spawnWatchdogIfNeeded/startModelServer — see those modules'
  // own test files for why), so every test here keeps `skipWatchdog: true` (the SAFE default)
  // to avoid forking a real detached node process; only onboarding.test.ts's twin CLI path
  // asserts watchdog-arming, where it IS injected.
  const { fetchFn, up } = fetchDelayed(["qwen3.6:latest"]);
  const startedArgv: (readonly string[])[] = [];
  const res = await run({
    fetchFn,
    canStartFn: async () => true,
    startModelServerFn: (argv) => {
      startedArgv.push(argv);
      up();
      return { ok: true, pid: 4242 };
    },
  });
  assert.deepEqual(startedArgv, [["ollama", "serve"]]);
  assert.equal(res.started, true);
  assert.equal(res.endpoint?.model, "qwen3.6:latest");
});

test("cold start: startModelServer itself fails synchronously → reason start-failed, lock still released", async () => {
  let released = false;
  const res = await run({
    fetchFn: fetchDown(),
    canStartFn: async () => true,
    startModelServerFn: () => ({ ok: false, error: "spawn EPERM" }),
    releaseStartLockFn: () => {
      released = true;
    },
  });
  assert.equal(res.started, false);
  assert.equal(res.reason, "start-failed");
  assert.equal(released, true, "the lock must be released even when the spawn itself fails");
});

test("cold start: spawns but never answers within the retry window → started:true, start-failed, lock released", async () => {
  let released = false;
  const res = await run({
    fetchFn: fetchDown(), // never comes up, however many retries
    canStartFn: async () => true,
    startModelServerFn: () => ({ ok: true, pid: 4242 }),
    releaseStartLockFn: () => {
      released = true;
    },
  });
  assert.equal(res.started, true, "it DID start the process — just never got a healthy answer");
  assert.equal(res.reason, "start-failed");
  assert.equal(released, true);
});

test("lock lost: rides along and adopts the winner's server, never starting its own", async () => {
  const { fetchFn, up } = fetchDelayed(["qwen3.6:latest"]);
  let startCalled = false;
  const res = await run({
    fetchFn,
    canStartFn: async () => true,
    startModelServerFn: () => {
      startCalled = true;
      return { ok: true, pid: 4242 };
    },
    acquireStartLockFn: () => {
      up(); // the (simulated) winner's server comes alive right when we lose the race for it
      return false;
    },
  });
  assert.equal(startCalled, false, "must never spawn while another surface holds the start lock");
  assert.equal(res.started, false, "we did not start it — we adopted it");
  assert.equal(res.endpoint?.model, "qwen3.6:latest");
});

test("lock lost, and the winner never comes up either → reason start-failed, never started itself", async () => {
  let startCalled = false;
  const res = await run({
    fetchFn: fetchDown(),
    canStartFn: async () => true,
    acquireStartLockFn: () => false,
    startModelServerFn: () => {
      startCalled = true;
      return { ok: true, pid: 4242 };
    },
  });
  assert.equal(startCalled, false);
  assert.equal(res.started, false);
  assert.equal(res.reason, "start-failed");
});

test("resource ceiling: a saturated machine refuses a COLD start — never spawns, never touches the lock", async () => {
  let startCalled = false;
  let lockTouched = false;
  const res = await run({
    fetchFn: fetchDown(),
    canStartFn: async () => true,
    launchGuardFn: async () => ({ cpuPct: 12, ramPct: 94 }),
    startModelServerFn: () => {
      startCalled = true;
      return { ok: true, pid: 4242 };
    },
    acquireStartLockFn: () => {
      lockTouched = true;
      return true;
    },
  });
  assert.equal(res.started, false);
  assert.equal(res.reason, "resource-ceiling");
  assert.match(res.resourceReason ?? "", /RAM at 94%/);
  assert.equal(startCalled, false, "must never spawn under resource pressure");
  assert.equal(lockTouched, false, "refused before even reaching the lock");
});

test("resource ceiling: NEVER consulted when Ollama is already up (adopting spawns nothing new)", async () => {
  let guardCalled = false;
  const res = await run({
    fetchFn: fetchServing(["qwen3.6:latest"]),
    launchGuardFn: async () => {
      guardCalled = true;
      return { cpuPct: 12, ramPct: 10 };
    },
  });
  assert.equal(res.started, false);
  assert.equal(res.endpoint?.model, "qwen3.6:latest");
  assert.equal(guardCalled, false);
});

test("resource ceiling: clears when the machine is not saturated → cold start proceeds normally", async () => {
  const { fetchFn, up } = fetchDelayed(["qwen3.6:latest"]);
  const res = await run({
    fetchFn,
    canStartFn: async () => true,
    launchGuardFn: async () => ({ cpuPct: 20, ramPct: 30 }),
    startModelServerFn: () => {
      up();
      return { ok: true, pid: 4242 };
    },
  });
  assert.equal(res.started, true);
  assert.equal(res.reason, undefined);
});

test("acquire/release lock are keyed on the ollama runner id and wrap exactly one start attempt", async () => {
  const { fetchFn, up } = fetchDelayed(["qwen3.6:latest"]);
  const calls: string[] = [];
  await run({
    fetchFn,
    canStartFn: async () => true,
    startModelServerFn: () => {
      up();
      return { ok: true, pid: 4242 };
    },
    acquireStartLockFn: (id) => {
      calls.push(`acquire:${id}`);
      return true;
    },
    releaseStartLockFn: (id) => {
      calls.push(`release:${id}`);
    },
  });
  assert.deepEqual(calls, ["acquire:ollama", "release:ollama"]);
});

/* ── ensureLmStudioRunning: the exact same machinery, for `lms server start` ─────────────── */

test("ensureLmStudioRunning: already running with a model served → adopted, started:false", async () => {
  const res = await runLmStudio({ fetchFn: fetchServing(["qwen2.5-coder-7b-instruct"]) });
  assert.equal(res.started, false);
  assert.equal(res.endpoint?.model, "qwen2.5-coder-7b-instruct");
  assert.equal(res.endpoint?.id, "local:lmstudio:qwen2.5-coder-7b-instruct");
});

test("ensureLmStudioRunning: cold start spawns `lms server start`, retries, and adopts", async () => {
  const { fetchFn, up } = fetchDelayed(["qwen2.5-coder-7b-instruct"]);
  const startedArgv: (readonly string[])[] = [];
  const res = await runLmStudio({
    fetchFn,
    canStartFn: async () => true,
    startModelServerFn: (argv) => {
      startedArgv.push(argv);
      up();
      return { ok: true, pid: 5151 };
    },
  });
  assert.deepEqual(startedArgv, [["lms", "server", "start", "--port", "1234"]]);
  assert.equal(res.started, true);
  assert.equal(res.endpoint?.model, "qwen2.5-coder-7b-instruct");
});

test("ensureLmStudioRunning: port occupied by something not answering → wedged, never started", async () => {
  let startCalled = false;
  const res = await runLmStudio({
    fetchFn: fetchDown(),
    listenersOnPortFn: async () => ({ processes: [{ pid: 1, command: "LM Studio Helper" }] }),
    canStartFn: async () => true,
    startModelServerFn: () => {
      startCalled = true;
      return { ok: true, pid: 1 };
    },
  });
  assert.equal(res.reason, "wedged");
  assert.equal(startCalled, false);
});

test("ensureLmStudioRunning: resource ceiling refuses a cold start exactly like Ollama's", async () => {
  let startCalled = false;
  const res = await runLmStudio({
    fetchFn: fetchDown(),
    canStartFn: async () => true,
    launchGuardFn: async () => ({ cpuPct: 12, ramPct: 96 }),
    startModelServerFn: () => {
      startCalled = true;
      return { ok: true, pid: 5151 };
    },
  });
  assert.equal(res.started, false);
  assert.equal(res.reason, "resource-ceiling");
  assert.match(res.resourceReason ?? "", /RAM at 96%/);
  assert.equal(startCalled, false);
});

test("ensureLmStudioRunning and ensureOllamaRunning use INDEPENDENT start-locks, keyed by their own runner id", async () => {
  const { fetchFn, up } = fetchDelayed(["qwen2.5-coder-7b-instruct"]);
  const calls: string[] = [];
  await runLmStudio({
    fetchFn,
    canStartFn: async () => true,
    startModelServerFn: () => {
      up();
      return { ok: true, pid: 5151 };
    },
    acquireStartLockFn: (id) => {
      calls.push(`acquire:${id}`);
      return true;
    },
    releaseStartLockFn: (id) => {
      calls.push(`release:${id}`);
    },
  });
  assert.deepEqual(calls, ["acquire:lmstudio", "release:lmstudio"]);
});
