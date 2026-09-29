/**
 * onboarding.test.ts — backend detection + the /setup wizard. Deterministic: a fake
 * fetch (local-runner probe), a fake EngineClient (scan), a scripted ask, and a fake
 * runChild — no network, no spawn, no engine.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EngineClient } from "@prometheus/engine-bridge";

import type { FleetPeer } from "../fleet/heartbeat.js";
import { ensureHomeTree, resolveCategory } from "../home.js";
import { setColorEnabled } from "../render.js";
import {
  type DetectDeps,
  type SetupDeps,
  backendSummary,
  buildLocalEndpoint,
  detectBackends,
  renderOnboarding,
  runPathsWizard,
  runSetup,
  stopSelfStartedRunners,
} from "./onboarding.js";

setColorEnabled(false);

/**
 * The autostart surface, stubbed to do NOTHING: nothing is on PATH, nothing is listening,
 * nothing spawns. Every test below that isn't specifically exercising autostart spreads this
 * in — without it, `detectBackends`'s default (the REAL `engine-bridge` primitives) would run
 * an actual `command -v ollama` / `lsof` on whatever machine runs this suite, and — worse — could
 * really `spawn` `ollama serve` if it happened to be installed but not running there.
 */
const NO_AUTOSTART: Pick<
  DetectDeps,
  | "canStartFn"
  | "listenersOnPortFn"
  | "startModelServerFn"
  | "retryDelayMs"
  | "spawnWatchdogFn"
  | "acquireStartLockFn"
  | "releaseStartLockFn"
  | "launchGuardFn"
> = {
  canStartFn: async () => false,
  listenersOnPortFn: async () => ({ processes: [] }),
  startModelServerFn: () => ({ ok: false, error: "autostart disabled in this test" }),
  retryDelayMs: 0,
  // Same reasoning as the rest of this object: the real fn forks a detached `node` process.
  // A test that DOES want to assert the watchdog got armed overrides this with a spy.
  spawnWatchdogFn: () => {},
  // Fakes, not the real engine-bridge pidfile lock: a test never wants to touch a real path on
  // disk, and always "wins" the lock unless a test specifically overrides this to exercise the
  // lose-the-race path.
  acquireStartLockFn: () => true,
  releaseStartLockFn: () => {},
  // A fake, always-clear machine sample — the real sampleLaunchGuard sleeps ~120ms and reads
  // THIS machine's live CPU/RAM, which would make every test slow and, on a loaded box, flaky.
  launchGuardFn: async () => ({ cpuPct: 10, ramPct: 10 }),
};

/** `detectBackends`, defaulted to no autostart — override any field to opt into it. */
function detect(deps: DetectDeps): ReturnType<typeof detectBackends> {
  return detectBackends({ ...NO_AUTOSTART, ...deps });
}

/** `runSetup`, defaulted to no autostart — override any field to opt into it. */
function setup(deps: SetupDeps): ReturnType<typeof runSetup> {
  return runSetup({ ...NO_AUTOSTART, ...deps });
}

/** A fake EngineClient whose scan reports the given installed agent CLIs. */
function fakeClient(present: string[] = []): EngineClient {
  return {
    runPrometheus: (async (argv: string[]) => {
      if (argv[0] === "scan") {
        return {
          agents: ["claude", "codex", "gemini", "cursor", "opencode", "windsurf"].map((name) => ({
            name,
            present: present.includes(name),
          })),
        };
      }
      return { ok: true };
    }) as EngineClient["runPrometheus"],
  } as unknown as EngineClient;
}

/** A fake fetch: maps a base URL → the served model ids (absent URL → throws/unreachable). */
function fakeFetch(serving: Record<string, string[]>): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    for (const [base, models] of Object.entries(serving)) {
      if (u.startsWith(base)) {
        return {
          ok: true,
          json: async () => ({ data: models.map((id) => ({ id })) }),
        } as Response;
      }
    }
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

test("buildLocalEndpoint: maps a runner → an OpenAI-compatible local endpoint", () => {
  const ep = buildLocalEndpoint({
    name: "ollama",
    baseUrl: "http://localhost:11434/v1",
    models: ["qwen2.5-coder:7b", "llama3.1:8b"],
  });
  assert.equal(ep.locality, "local");
  assert.equal(ep.baseUrl, "http://localhost:11434/v1");
  assert.equal(ep.model, "qwen2.5-coder:7b"); // first served model
  assert.equal(ep.supportsTools, true); // local OpenAI-compatible runners expose native tool_calls
});

test("detectBackends: a live ollama with a model → a ready local endpoint", async () => {
  const b = await detect({
    client: fakeClient(["claude"]),
    fetchFn: fakeFetch({ "http://localhost:11434/v1": ["qwen2.5-coder:7b"] }),
  });
  assert.equal(b.localRunner?.name, "ollama");
  assert.equal(b.localEndpoint?.model, "qwen2.5-coder:7b");
  assert.deepEqual(b.paidClis, ["claude"]);
  assert.match(backendSummary(b), /local · qwen2.5-coder/);
});

test("detectBackends: no runner, paid CLIs present → no endpoint, summary points at /setup", async () => {
  const b = await detect({
    client: fakeClient(["claude", "gemini"]),
    fetchFn: fakeFetch({}), // nothing serving
  });
  assert.equal(b.localEndpoint, undefined);
  assert.deepEqual(b.paidClis, ["claude", "gemini"]);
  assert.match(backendSummary(b), /paid CLI · claude\/gemini/);
});

test("detectBackends: nothing at all → 'no model — type /setup'", async () => {
  const b = await detect({ client: fakeClient([]), fetchFn: fakeFetch({}) });
  assert.equal(b.localEndpoint, undefined);
  assert.deepEqual(b.paidClis, []);
  assert.match(backendSummary(b), /no model — type \/setup/);
});

/* ── autostart: installed-but-not-running → started, re-probed, adopted ────── */

/** A fetch that's unreachable until `up()` is called — simulates the daemon coming alive
 *  partway through detection, the way it does after a real `startModelServer`. */
function fakeFetchDelayed(
  base: string,
  models: string[],
): { fetchFn: typeof fetch; up: () => void } {
  let started = false;
  const fetchFn = (async (url: string | URL) => {
    if (started && String(url).startsWith(base)) {
      return { ok: true, json: async () => ({ data: models.map((id) => ({ id })) }) } as Response;
    }
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  return {
    fetchFn,
    up: () => {
      started = true;
    },
  };
}

test("detectBackends: ollama installed but not running → autostarted and adopted", async () => {
  const { fetchFn, up } = fakeFetchDelayed("http://localhost:11434/v1", ["qwen3.6:latest"]);
  const startedArgv: (readonly string[])[] = [];
  const b = await detect({
    client: fakeClient([]),
    fetchFn,
    canStartFn: async (argv) => argv?.[0] === "ollama",
    listenersOnPortFn: async () => ({ processes: [] }),
    startModelServerFn: (argv) => {
      startedArgv.push(argv);
      up();
      return { ok: true, pid: 4242 };
    },
    retryDelayMs: 0,
  });
  assert.deepEqual(startedArgv, [["ollama", "serve"]]);
  assert.equal(b.startedRunners.has("ollama"), true);
  assert.equal(b.localEndpoint?.model, "qwen3.6:latest");
  assert.deepEqual(b.unavailableRunners, []);
});

test("detectBackends: losing the start-lock race adopts the winner's server without double-starting", async () => {
  // Another CLI shell (or the desktop app) already owns the start attempt for this runner —
  // this call must ride along and adopt it once it comes up, never spawn a second one.
  const { fetchFn, up } = fakeFetchDelayed("http://localhost:11434/v1", ["qwen3.6:latest"]);
  let startCalled = false;
  const b = await detect({
    client: fakeClient([]),
    fetchFn,
    canStartFn: async (argv) => argv?.[0] === "ollama",
    listenersOnPortFn: async () => ({ processes: [] }),
    startModelServerFn: () => {
      startCalled = true;
      return { ok: true, pid: 4242 };
    },
    // Losing the lock is itself the moment the (simulated) winner's server comes alive.
    acquireStartLockFn: () => {
      up();
      return false;
    },
    retryDelayMs: 0,
  });
  assert.equal(startCalled, false, "must never spawn a second server after losing the lock race");
  assert.equal(b.startedRunners.has("ollama"), false, "adopted it — did not start it itself");
  assert.equal(b.localEndpoint?.model, "qwen3.6:latest");
});

test("detectBackends: loses the lock race and the winner never comes up either → reported absent, never started itself", async () => {
  let startCalled = false;
  const b = await detect({
    client: fakeClient([]),
    fetchFn: fakeFetch({}), // nobody ever answers — the winner's attempt failed too
    canStartFn: async () => true,
    acquireStartLockFn: () => false,
    startModelServerFn: () => {
      startCalled = true;
      return { ok: true, pid: 4242 };
    },
    retryDelayMs: 0,
  });
  assert.equal(startCalled, false);
  assert.equal(b.liveRunners.length, 0);
  assert.equal(b.startedRunners.has("ollama"), false);
});

test("detectBackends: start-lock is acquired and released around a successful autostart, keyed by runner id", async () => {
  const { fetchFn, up } = fakeFetchDelayed("http://localhost:11434/v1", ["qwen3.6:latest"]);
  const calls: string[] = [];
  await detect({
    client: fakeClient([]),
    fetchFn,
    canStartFn: async (argv) => argv?.[0] === "ollama",
    listenersOnPortFn: async () => ({ processes: [] }),
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
    retryDelayMs: 0,
  });
  assert.deepEqual(calls, ["acquire:ollama", "release:ollama"]);
});

test("detectBackends: a wedged port never touches the start-lock (nothing to start)", async () => {
  let lockTouched = false;
  await detect({
    client: fakeClient([]),
    fetchFn: fakeFetch({}),
    listenersOnPortFn: async (port) =>
      port === 11434 ? { processes: [{ pid: 999, command: "ollama" }] } : { processes: [] },
    // scoped to ollama — this test is specifically about the WEDGED-port short-circuit, which
    // only ollama hits here (lmstudio's port reports empty, so it never reaches this check).
    canStartFn: async (argv) => argv?.[0] === "ollama",
    acquireStartLockFn: () => {
      lockTouched = true;
      return true;
    },
  });
  assert.equal(lockTouched, false);
});

test("detectBackends: a saturated machine refuses a COLD autostart, reported with the resource reason", async () => {
  let startCalled = false;
  let lockTouched = false;
  const b = await detect({
    client: fakeClient([]),
    fetchFn: fakeFetch({}),
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
  assert.equal(startCalled, false, "must never spawn under resource pressure");
  assert.equal(lockTouched, false, "refused before even reaching the lock");
  assert.equal(b.startedRunners.has("ollama"), false);
  const ollama = b.unavailableRunners.find((r) => r.id === "ollama");
  assert.ok(ollama, "ollama must be reported, not silently dropped");
  assert.equal(ollama?.wedged, false);
  assert.match(ollama?.reason ?? "", /RAM at 94%/);
});

test("detectBackends: the resource guard is NEVER consulted when adopting an already-running runner", async () => {
  let guardCalled = false;
  const b = await detect({
    client: fakeClient([]),
    fetchFn: fakeFetch({ "http://localhost:11434/v1": ["qwen3.6:latest"] }),
    launchGuardFn: async () => {
      guardCalled = true;
      return { cpuPct: 12, ramPct: 10 };
    },
  });
  assert.equal(guardCalled, false);
  assert.equal(b.localEndpoint?.model, "qwen3.6:latest");
});

test("renderOnboarding: a resource-refused runner names the reason and tells the user to free up resources", () => {
  const backends = {
    liveRunners: [],
    localRunner: undefined,
    localEndpoint: undefined,
    paidClis: [],
    startedRunners: new Set<string>(),
    unavailableRunners: [
      { id: "ollama", name: "ollama", wedged: false, reason: "RAM at 94% ≥ 90% ceiling" },
    ],
  };
  const rendered = renderOnboarding(backends);
  // Matched against the box's TEXT, with the chrome and the line breaks taken out.
  //
  // `box()` wraps its content to the terminal width now (it used to size itself from the
  // content and draw a border wider than the window, which the terminal then tore apart), so
  // a sentence can legitimately span two rows — "Free up resources and │ / │ retry." — and a
  // regex over the raw frame would fail on a message that is in fact fully present. What this
  // test is about is that the reason and the remedy are SAID; where the wrap happens is a
  // rendering detail that must be free to change with the width.
  const text = rendered
    .replace(/[│╭╮╰╯─]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  assert.match(text, /RAM at 94% ≥ 90% ceiling/);
  assert.match(text, /Free up resources and retry/);
});

test("detectBackends: a successful CLI autostart arms the idle-shutdown watchdog", async () => {
  // This is the whole fix: the CLI's own autostart path used to be the one surface that never
  // armed the watchdog, so a CLI-started Ollama ran forever with nothing to stop it — see
  // onboarding.ts's probeAndMaybeStart. Assert the watchdog spawn actually fires, with the
  // runner's own port/process-match, not just that autostart itself works (already covered
  // above).
  const { fetchFn, up } = fakeFetchDelayed("http://localhost:11434/v1", ["qwen3.6:latest"]);
  const watchdogCalls: Array<{
    port?: number;
    processMatch?: string;
    runnerId?: string;
    displayName?: string;
    stopCmd?: readonly string[];
  }> = [];
  const b = await detect({
    client: fakeClient([]),
    fetchFn,
    canStartFn: async (argv) => argv?.[0] === "ollama",
    listenersOnPortFn: async () => ({ processes: [] }),
    startModelServerFn: () => {
      up();
      return { ok: true, pid: 4242 };
    },
    retryDelayMs: 0,
    spawnWatchdogFn: (opts) => {
      watchdogCalls.push(opts);
    },
  });
  assert.equal(b.startedRunners.has("ollama"), true);
  assert.deepEqual(watchdogCalls, [
    {
      port: 11434,
      processMatch: "ollama",
      runnerId: "ollama",
      displayName: "Ollama",
      stopCmd: undefined,
    },
  ]);
});

test("detectBackends: an autostart that never comes up must NOT arm the watchdog (nothing to watch)", async () => {
  let watchdogCalled = false;
  await detect({
    client: fakeClient([]),
    fetchFn: fakeFetch({}), // never answers, even after "starting"
    canStartFn: async () => true,
    startModelServerFn: () => ({ ok: true, pid: 4242 }),
    retryDelayMs: 0,
    spawnWatchdogFn: () => {
      watchdogCalled = true;
    },
  });
  assert.equal(watchdogCalled, false);
});

test("detectBackends: neither runner installed → canStartFn is consulted for BOTH ollama and lms, nothing left unavailable", async () => {
  const canStartCalls: (readonly string[])[] = [];
  const b = await detect({
    client: fakeClient([]),
    fetchFn: fakeFetch({}),
    canStartFn: async (argv) => {
      canStartCalls.push(argv);
      return false;
    },
  });
  assert.deepEqual(
    [...canStartCalls].sort(),
    [
      ["lms", "server", "start", "--port", "1234"],
      ["ollama", "serve"],
    ].sort(),
  );
  assert.deepEqual(b.unavailableRunners, []); // never started ⇒ not "installed but unavailable" either
  assert.equal(b.liveRunners.length, 0);
});

test("detectBackends: LM Studio installed but not running → autostarted via `lms server start` and adopted", async () => {
  const { fetchFn, up } = fakeFetchDelayed("http://localhost:1234/v1", ["qwen2.5-coder-7b"]);
  const startedArgv: (readonly string[])[] = [];
  const b = await detect({
    client: fakeClient([]),
    fetchFn,
    canStartFn: async (argv) => argv?.[0] === "lms",
    listenersOnPortFn: async () => ({ processes: [] }),
    startModelServerFn: (argv) => {
      startedArgv.push(argv);
      up();
      return { ok: true, pid: 4343 };
    },
    retryDelayMs: 0,
  });
  assert.deepEqual(startedArgv, [["lms", "server", "start", "--port", "1234"]]);
  assert.equal(b.startedRunners.has("lmstudio"), true);
  assert.equal(b.localEndpoint?.model, "qwen2.5-coder-7b");
  assert.deepEqual(b.unavailableRunners, []);
});

test("detectBackends: a successful LM Studio autostart ALSO arms the idle-shutdown watchdog, with LM Studio's own port/process-match", async () => {
  const { fetchFn, up } = fakeFetchDelayed("http://localhost:1234/v1", ["qwen2.5-coder-7b"]);
  const watchdogCalls: Array<{
    port?: number;
    processMatch?: string;
    runnerId?: string;
    displayName?: string;
    stopCmd?: readonly string[];
  }> = [];
  const b = await detect({
    client: fakeClient([]),
    fetchFn,
    canStartFn: async (argv) => argv?.[0] === "lms",
    listenersOnPortFn: async () => ({ processes: [] }),
    startModelServerFn: () => {
      up();
      return { ok: true, pid: 4343 };
    },
    retryDelayMs: 0,
    spawnWatchdogFn: (opts) => {
      watchdogCalls.push(opts);
    },
  });
  assert.equal(b.startedRunners.has("lmstudio"), true);
  assert.deepEqual(watchdogCalls, [
    {
      port: 1234,
      processMatch: "LM Studio",
      runnerId: "lmstudio",
      displayName: "LM Studio",
      stopCmd: ["lms", "server", "stop"],
    },
  ]);
});

test("detectBackends: something already occupies the port but never answers → reported wedged, never double-started", async () => {
  let startCalled = false;
  const b = await detect({
    client: fakeClient([]),
    fetchFn: fakeFetch({}), // /models never answers for anyone
    listenersOnPortFn: async (port) =>
      port === 11434 ? { processes: [{ pid: 999, command: "ollama" }] } : { processes: [] },
    // scoped to ollama — if this were consulted for lmstudio too, its empty (non-wedged) port
    // would let it proceed to start, which is a different scenario than this test is about.
    canStartFn: async (argv) => argv?.[0] === "ollama",
    startModelServerFn: () => {
      startCalled = true;
      return { ok: true, pid: 1 };
    },
  });
  assert.equal(startCalled, false, "a wedged port must never be started over");
  assert.deepEqual(b.unavailableRunners, [{ id: "ollama", name: "Ollama", wedged: true }]);
  assert.equal(b.startedRunners.size, 0);
});

test("detectBackends: canStart, but startModelServer itself fails → reported unavailable, not started", async () => {
  const b = await detect({
    client: fakeClient([]),
    fetchFn: fakeFetch({}),
    // scoped to ollama only — this test is about ONE runner's start-failure path, not both.
    canStartFn: async (argv) => argv?.[0] === "ollama",
    startModelServerFn: () => ({ ok: false, error: "spawn EPERM" }),
  });
  assert.deepEqual(b.unavailableRunners, [{ id: "ollama", name: "Ollama", wedged: false }]);
  assert.equal(b.startedRunners.size, 0);
});

test("detectBackends: started, but never answers within the retry window → still tracked as started (so exit can clean it up), reported unavailable", async () => {
  const b = await detect({
    client: fakeClient([]),
    fetchFn: fakeFetch({}), // never answers, even after "starting"
    canStartFn: async (argv) => argv?.[0] === "ollama",
    startModelServerFn: () => ({ ok: true, pid: 4242 }),
    retryDelayMs: 0,
  });
  assert.equal(b.startedRunners.has("ollama"), true);
  assert.deepEqual(b.unavailableRunners, [{ id: "ollama", name: "Ollama", wedged: false }]);
  assert.equal(b.localEndpoint, undefined);
});

test("renderOnboarding: a wedged runner gets an honest 'not responding' message, not 'download a model'", () => {
  const text = renderOnboarding({
    liveRunners: [],
    paidClis: [],
    startedRunners: new Set(),
    unavailableRunners: [{ id: "ollama", name: "Ollama", wedged: true }],
  });
  assert.match(text, /running but not responding/);
});

test("renderOnboarding: an installed-but-unstartable runner says so, not 'no local runner detected'", () => {
  const text = renderOnboarding({
    liveRunners: [],
    paidClis: [],
    startedRunners: new Set(),
    unavailableRunners: [{ id: "ollama", name: "Ollama", wedged: false }],
  });
  assert.match(text, /installed but Prometheus could not start it/);
  assert.doesNotMatch(text, /no local runner \(Ollama/);
});

/* ── stopSelfStartedRunners: only what we started, only when nothing else needs it ─── */

function fakePeer(overrides: Partial<FleetPeer>): FleetPeer {
  return {
    pid: 1,
    id: "peer",
    startedAt: "",
    updatedAt: "",
    cwd: "",
    model: "",
    state: "idle",
    self: false,
    ageMs: 0,
    stale: false,
    ...overrides,
  };
}

test("stopSelfStartedRunners: no-op when nothing was self-started", async () => {
  let statusCalled = false;
  await stopSelfStartedRunners(new Set(), [], {
    modelServerStatusFn: async () => {
      statusCalled = true;
      return { runnerId: "ollama", listening: true, healthy: true, models: [], processes: [] };
    },
  });
  assert.equal(statusCalled, false);
});

test("stopSelfStartedRunners: stops a self-started runner nobody else is using", async () => {
  const signalled: Array<[number, string]> = [];
  await stopSelfStartedRunners(new Set(["ollama"]), [], {
    modelServerStatusFn: async () => ({
      runnerId: "ollama",
      listening: true,
      healthy: true,
      models: ["qwen3.6:latest"],
      processes: [{ pid: 4242, command: "ollama" }],
    }),
    signalPidFn: (pid, signal) => {
      signalled.push([pid, signal]);
      return { pid, ok: true };
    },
  });
  assert.deepEqual(signalled, [[4242, "SIGTERM"]]);
});

test("stopSelfStartedRunners: leaves it running when another live peer's model is served by it", async () => {
  const signalled: Array<[number, string]> = [];
  const others = [fakePeer({ self: false, state: "working", model: "qwen3.6:latest" })];
  await stopSelfStartedRunners(new Set(["ollama"]), others, {
    modelServerStatusFn: async () => ({
      runnerId: "ollama",
      listening: true,
      healthy: true,
      models: ["qwen3.6:latest"],
      processes: [{ pid: 4242, command: "ollama" }],
    }),
    signalPidFn: (pid, signal) => {
      signalled.push([pid, signal]);
      return { pid, ok: true };
    },
  });
  assert.deepEqual(signalled, [], "a peer still using this runner's model must block the stop");
});

test("stopSelfStartedRunners: a dead peer's old model does not block the stop", async () => {
  const signalled: Array<[number, string]> = [];
  const others = [fakePeer({ self: false, state: "dead", model: "qwen3.6:latest" })];
  await stopSelfStartedRunners(new Set(["ollama"]), others, {
    modelServerStatusFn: async () => ({
      runnerId: "ollama",
      listening: true,
      healthy: true,
      models: ["qwen3.6:latest"],
      processes: [{ pid: 4242, command: "ollama" }],
    }),
    signalPidFn: (pid, signal) => {
      signalled.push([pid, signal]);
      return { pid, ok: true };
    },
  });
  assert.deepEqual(signalled, [[4242, "SIGTERM"]]);
});

test("stopSelfStartedRunners: already gone → no signal sent", async () => {
  let signalCalled = false;
  await stopSelfStartedRunners(new Set(["ollama"]), [], {
    modelServerStatusFn: async () => ({
      runnerId: "ollama",
      listening: false,
      healthy: false,
      models: [],
      processes: [],
    }),
    signalPidFn: () => {
      signalCalled = true;
      return { pid: 0, ok: true };
    },
  });
  assert.equal(signalCalled, false);
});

test("stopSelfStartedRunners: never signals a process whose command doesn't match the runner", async () => {
  // Defense in depth: even though the port matched, only a process that looks like the runner's
  // own binary is ever signalled.
  const signalled: number[] = [];
  await stopSelfStartedRunners(new Set(["ollama"]), [], {
    modelServerStatusFn: async () => ({
      runnerId: "ollama",
      listening: true,
      healthy: true,
      models: [],
      processes: [{ pid: 777, command: "some-other-process" }],
    }),
    signalPidFn: (pid) => {
      signalled.push(pid);
      return { pid, ok: true };
    },
  });
  assert.deepEqual(signalled, []);
});

test("stopSelfStartedRunners: a runner WITH a stop command (LM Studio) uses it, and NEVER signals any process", async () => {
  // `lms server stop` — never a raw SIGTERM/SIGKILL, which would quit the whole app (LM
  // Studio's server runs INSIDE its main process, verified against a real install — see
  // LocalRunnerSpec.stop's doc). Even though a process IS listed here (as a real listenersOnPort
  // probe would find), it must never be the thing signalled.
  const execCalls: Array<{ command: string; args: string[] }> = [];
  let signalCalled = false;
  await stopSelfStartedRunners(new Set(["lmstudio"]), [], {
    modelServerStatusFn: async () => ({
      runnerId: "lmstudio",
      listening: true,
      healthy: true,
      models: ["qwen2.5-coder-7b"],
      processes: [{ pid: 25161, command: "Bionic" }],
    }),
    signalPidFn: () => {
      signalCalled = true;
      return { pid: 0, ok: true };
    },
    execCaptureFn: async (command, args = []) => {
      execCalls.push({ command, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(execCalls, [{ command: "lms", args: ["server", "stop"] }]);
  assert.equal(signalCalled, false, "a runner with its own stop command must never be signalled");
});

test("stopSelfStartedRunners: a runner with a stop command is still left alone while a peer uses it", async () => {
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const others = [fakePeer({ self: false, state: "working", model: "qwen2.5-coder-7b" })];
  await stopSelfStartedRunners(new Set(["lmstudio"]), others, {
    modelServerStatusFn: async () => ({
      runnerId: "lmstudio",
      listening: true,
      healthy: true,
      models: ["qwen2.5-coder-7b"],
      processes: [{ pid: 25161, command: "Bionic" }],
    }),
    execCaptureFn: async (command, args = []) => {
      execCalls.push({ command, args });
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(execCalls, [], "still in use ⇒ the stop command must not run either");
});

/** A scripted ask: pops the next canned answer per question. */
function scriptedAsk(answers: string[]): (q: string) => Promise<string> {
  const q = [...answers];
  return async () => q.shift() ?? "";
}

test("runSetup: local branch pulls a model via ollama and adopts the endpoint", async () => {
  const out: string[] = [];
  const pulls: Array<[string, string[]]> = [];
  const r = await setup({
    client: fakeClient([]),
    write: (s) => out.push(s),
    // runner up but serving NO model → reaches the picker (not the early "ready" return).
    fetchFn: fakeFetch({ "http://localhost:11434/v1": [] }),
    ask: scriptedAsk(["1", "1", "y"]), // choose local → pick model #1 → confirm pull
    runChild: async (cmd, args) => {
      pulls.push([cmd, args]);
      return 0;
    },
  });
  assert.deepEqual(pulls, [["ollama", ["pull", "qwen2.5-coder:3b"]]]);
  assert.equal(r.endpoint?.model, "qwen2.5-coder:3b");
  assert.match(out.join("\n"), /pulled/);
});

test("runSetup: paid branch lists installed CLIs (no endpoint adopted)", async () => {
  const out: string[] = [];
  const r = await setup({
    client: fakeClient(["claude", "codex"]),
    write: (s) => out.push(s),
    fetchFn: fakeFetch({}),
    ask: scriptedAsk(["2"]),
  });
  assert.equal(r.endpoint, undefined);
  assert.match(out.join("\n"), /prometheus chat --cli claude --open/);
});

test("runSetup: choosing 0 skips cleanly (no endpoint, no spawn)", async () => {
  let spawned = false;
  const r = await setup({
    client: fakeClient([]),
    write: () => {},
    fetchFn: fakeFetch({}),
    ask: scriptedAsk(["0"]),
    runChild: async () => {
      spawned = true;
      return 0;
    },
  });
  assert.equal(r.endpoint, undefined);
  assert.equal(spawned, false);
});

test("runSetup: an already-ready local model is adopted without prompting", async () => {
  const r = await setup({
    client: fakeClient([]),
    write: () => {},
    fetchFn: fakeFetch({ "http://localhost:11434/v1": ["llama3.1:8b"] }),
    ask: async () => {
      throw new Error("should not ask when a model is already ready");
    },
  });
  assert.equal(r.endpoint?.model, "llama3.1:8b");
});

test("runSetup: multiple already-downloaded local models → a real pick, not a silent models[0]", async () => {
  const r = await setup({
    client: fakeClient([]),
    write: () => {},
    fetchFn: fakeFetch({ "http://localhost:11434/v1": ["llama3.1:8b", "qwen2.5-coder:7b"] }),
    ask: scriptedAsk(["2"]), // pick the SECOND already-downloaded model
  });
  assert.equal(r.endpoint?.model, "qwen2.5-coder:7b");
});

test("runSetup: multiple local models, a blank answer defaults to #1 (never throws)", async () => {
  const r = await setup({
    client: fakeClient([]),
    write: () => {},
    fetchFn: fakeFetch({ "http://localhost:11434/v1": ["llama3.1:8b", "qwen2.5-coder:7b"] }),
    ask: scriptedAsk([""]),
  });
  assert.equal(r.endpoint?.model, "llama3.1:8b");
});

test("runSetup local: declining the Ollama-install prompt still writes visible feedback", async () => {
  const out: string[] = [];
  const r = await setup({
    client: fakeClient([]),
    write: (s) => out.push(s),
    fetchFn: fakeFetch({}), // nothing serving → ollamaUp === false
    ask: scriptedAsk(["1", "1", "n"]), // local → model #1 → decline the gated installer
  });
  assert.equal(r.endpoint, undefined);
  assert.match(out.join("\n"), /skipped/i);
});

test("runSetup local: askPath repoints open_models, then pulls + adopts", async () => {
  const home = mkdtempSync(join(tmpdir(), "prom-setup-"));
  const pulls: Array<[string, string[]]> = [];
  const chosen = join(home, "big-disk", "models");
  const r = await setup({
    client: fakeClient([]),
    write: () => {},
    fetchFn: fakeFetch({ "http://localhost:11434/v1": [] }), // ollama up, no model → picker
    ask: scriptedAsk(["1", "1", "n", "y"]), // local → model#1 → don't keep folder → confirm pull
    askPath: async () => chosen,
    runChild: async (cmd, args) => {
      pulls.push([cmd, args]);
      return 0;
    },
    home,
  });
  assert.deepEqual(pulls, [["ollama", ["pull", "qwen2.5-coder:3b"]]]);
  assert.equal(r.endpoint?.model, "qwen2.5-coder:3b");
  assert.equal(resolveCategory("open_models", home), chosen); // override persisted
});

test("runPathsWizard: lists categories and repoints one via askPath", async () => {
  const home = mkdtempSync(join(tmpdir(), "prom-paths-"));
  ensureHomeTree(home);
  const out: string[] = [];
  const newDir = join(home, "movies");
  await runPathsWizard({
    client: fakeClient([]),
    write: (s) => out.push(s),
    ask: scriptedAsk(["1"]), // change category #1 (open_models)
    askPath: async () => newDir,
    home,
  });
  assert.equal(resolveCategory("open_models", home), newDir);
  assert.match(out.join("\n"), /Open LLM models/);
});
