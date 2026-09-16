/**
 * session/onboarding.ts — first-run backend detection + the `/setup` wizard.
 *
 * The interactive session needs a working chat backend. Two kinds exist:
 *   • LOCAL  — a running OpenAI-compatible runner (Ollama :11434 / LM Studio :1234)
 *              that serves at least one model → the session streams from it directly.
 *   • PAID   — an installed agent CLI (claude/codex/gemini/cursor/opencode) the user
 *              launches via `prometheus chat --cli <svc> --open`.
 *
 * On startup the host probes for a live local runner+model (fast, ~1s, fail-soft) and,
 * when found, wires its OpenAI-compatible endpoint into the session so chat WORKS with
 * zero config. When nothing is found, the banner points at `/setup`, which detects +
 * lets the user pick/download a free local model (Ollama) OR connect a paid CLI.
 *
 * Everything here is dependency-injectable (client / fetch / ask / write / runChild) so
 * the detection + wizard are unit-testable with no network, no spawn, no real engine.
 * Nothing decides "safe" (C5): a model download still routes through the engine's gate.
 */
import { createRequire } from "node:module";

import { DEFAULT_CONTEXT_WINDOW, LOCAL_RUNNERS, type LocalRunnerSpec } from "@prometheus/core";
import type { AiEndpoint } from "@prometheus/core";
import {
  type EngineClient,
  type LaunchGuardSample,
  acquireRunnerStartLock,
  canStart,
  execCapture,
  launchGuardVerdict,
  listenersOnPort,
  modelServerStatus,
  releaseRunnerStartLock,
  sampleLaunchGuard,
  signalPid,
  spawnWatchdogIfNeeded,
  startModelServer,
} from "@prometheus/engine-bridge";

import type { FleetPeer } from "../fleet/heartbeat.js";
import {
  CATEGORY_LABEL,
  PATH_CATEGORIES,
  type PathCategory,
  diskInfo,
  prometheusHome,
  resolveCategory,
  setCategory,
} from "../home.js";
import { box, c, humanBytes } from "../render.js";

/** A model daemon this session tried to reach but couldn't — installed (or already occupying
 *  its port) yet not actually serving, so telling the user to "download a model" would be wrong. */
export interface UnavailableRunner {
  id: string;
  name: string;
  /** the process was already listening on the port but never answered `/models`. */
  wedged: boolean;
  /** set when refused by the CPU/RAM launch guard — human-readable, e.g. "RAM at 94% ≥ 90%
   *  ceiling". `renderOnboarding` shows this verbatim instead of the generic "could not start". */
  reason?: string;
}

/** How many times, and how far apart, to re-probe a runner right after starting it. Local model
 *  daemons answer `/models` almost immediately once up — this bounds the wait to ~1.5s total,
 *  short enough that session start never visibly stalls on a runner that won't come up. */
const AUTOSTART_RETRY_ATTEMPTS = 5;
const AUTOSTART_RETRY_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Agent CLIs the session can hand a terminal chat to (`chat --cli <svc>`). */
const CHAT_CLIS = new Set(["claude", "codex", "gemini", "cursor", "opencode"]);

/**
 * Recommended free, local, coding-capable models to offer in `/setup` (Ollama tags).
 * Small→large; the first that fits the user's box is a fine default.
 */
export const RECOMMENDED_LOCAL: ReadonlyArray<{ tag: string; note: string; gb: number }> = [
  // small → large (Apache/MIT-permissive bias); the first that fits the box is a fine default.
  { tag: "qwen2.5-coder:3b", note: "light coding model — low-RAM boxes (Apache-2.0)", gb: 1.9 },
  { tag: "llama3.2:3b", note: "compact general/edge model (Meta)", gb: 2.0 },
  { tag: "phi4-mini", note: "3.8B MIT, 128K ctx — runs on modest machines", gb: 2.5 },
  { tag: "qwen3:4b", note: "small hybrid-reasoning model (Apache-2.0)", gb: 2.6 },
  { tag: "nemotron-mini:4b", note: "NVIDIA on-device SLM — RAG/function-calling", gb: 2.7 },
  { tag: "gemma3:4b", note: "Google multimodal (vision), 128K ctx", gb: 3.3 },
  { tag: "qwen2.5-coder:7b", note: "strong coding model — great default (Apache-2.0)", gb: 4.7 },
  { tag: "llama3.1:8b", note: "well-rounded general workhorse", gb: 4.9 },
  { tag: "granite3.3:8b", note: "IBM enterprise RAG/tool-use (Apache-2.0)", gb: 4.9 },
  { tag: "deepseek-r1:8b", note: "reasoning / chain-of-thought distill (MIT)", gb: 5.2 },
  { tag: "qwen3:8b", note: "well-rounded reasoning model (Apache-2.0)", gb: 5.2 },
  { tag: "devstral:24b", note: "agentic SWE coder — needs ~16GB (Apache-2.0)", gb: 14 },
  { tag: "gpt-oss:20b", note: "OpenAI open-weight reasoning — needs ~16GB (Apache-2.0)", gb: 14 },
  { tag: "gemma3:27b", note: "big multimodal — needs ~24GB (Gemma terms)", gb: 17 },
  { tag: "qwen3-coder:30b", note: "agentic coder MoE — needs ~24GB (Apache-2.0)", gb: 19 },
  { tag: "qwen2.5-coder:32b", note: "top local coder ≈GPT-4o-class — needs ~24GB", gb: 20 },
];

export interface LocalRunner {
  name: string;
  baseUrl: string;
  /** model ids the runner currently serves (from its /v1/models). */
  models: string[];
}

export interface Backends {
  /** every live runner (may serve 0 models). */
  liveRunners: LocalRunner[];
  /** the first live runner that serves ≥1 model (the one we'd use). */
  localRunner?: LocalRunner;
  /** a ready-to-use endpoint built from `localRunner` (undefined if none). */
  localEndpoint?: AiEndpoint;
  /** installed agent CLIs that can host a terminal chat. */
  paidClis: string[];
  /** runner ids THIS detection call started (empty unless an autostart actually happened) —
   *  the only runners this session is ever allowed to stop later (see `stopSelfStartedRunners`). */
  startedRunners: ReadonlySet<string>;
  /** runners that are installed/occupying their port but not currently reachable, even after an
   *  autostart attempt — "it's broken" is a different message than "you never downloaded one". */
  unavailableRunners: UnavailableRunner[];
}

/** The all-empty `Backends` every `detectBackends().catch(...)` fallback needs — one definition
 *  so the shape can gain a field without every call site's fallback literal falling out of sync. */
export function emptyBackends(): Backends {
  return { liveRunners: [], paidClis: [], startedRunners: new Set(), unavailableRunners: [] };
}

export interface DetectDeps {
  client: EngineClient;
  /** injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** per-runner probe timeout (ms). */
  timeoutMs?: number;
  /** the autostart primitives — injected for tests; default to the real `engine-bridge` ones
   *  (no network/spawn in a unit test unless the test explicitly stubs these). */
  canStartFn?: typeof canStart;
  listenersOnPortFn?: typeof listenersOnPort;
  startModelServerFn?: typeof startModelServer;
  /** skip the retry sleep in tests — a test never needs to actually wait 1.5s wall-clock. */
  retryDelayMs?: number;
  /** the idle-shutdown watchdog spawn — injected for tests (default is the real, detached
   *  spawn; a test that never wants to fork a real `node` process stubs this to a no-op). */
  spawnWatchdogFn?: typeof spawnWatchdogIfNeeded;
  /** the cross-process "only one surface may be mid-spawn for this runner" lock — see
   *  engine-bridge's start-lock.ts. Injected for tests the same way every autostart
   *  primitive here is; production leaves these at their real defaults. */
  acquireStartLockFn?: typeof acquireRunnerStartLock;
  releaseStartLockFn?: typeof releaseRunnerStartLock;
  /** the shared 90% CPU/RAM launch ceiling (also used by `model pull`/`sidecar-cmd.ts`) —
   *  refuses a COLD start on an already-saturated machine. Injected for tests. */
  launchGuardFn?: () => Promise<LaunchGuardSample>;
}

/** Build a local OpenAI-compatible endpoint from a detected runner (model = first served). */
export function buildLocalEndpoint(runner: LocalRunner): AiEndpoint {
  const model = runner.models[0] ?? "";
  return {
    id: `local:${runner.name}:${model}`,
    baseUrl: runner.baseUrl,
    locality: "local",
    // A FLOOR, not a measurement — `probeContextWindow` replaces it with the served model's
    // real length where the runner reports one (see `withProbedContextWindow`).
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    // capable local runners (ollama/lmstudio) return native OpenAI tool_calls — the agent
    // runtime now has a tool-call transport (makeLlmClient.toolTurn), so offer tools.
    supportsTools: true,
    model,
  };
}

/** Probe ONE runner's /v1/models; returns its served models or null if unreachable. */
async function probeRunner(
  runner: { name: string; baseUrl: string },
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<LocalRunner | null> {
  try {
    const res = await fetchFn(`${runner.baseUrl}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = Array.isArray(data?.data)
      ? data.data.map((m) => String(m?.id ?? "")).filter((s) => s.length > 0)
      : [];
    return { name: runner.name, baseUrl: runner.baseUrl, models };
  } catch {
    return null; // not running / unreachable / bad response → treat as absent.
  }
}

/**
 * Probe one runner spec; if it isn't reachable AND nothing else already holds its port AND
 * Prometheus can start it, start it and give it `AUTOSTART_RETRY_ATTEMPTS` short chances to come
 * up before giving up. This is the whole fix for "the model is downloaded but the daemon isn't
 * running" — the one state the old bare-fetch probe could never tell apart from "never
 * downloaded". A port that's already occupied is left alone: that is model-server.ts's "wedged"
 * case, and starting a second instance on top of it would only make things worse.
 */
interface AutostartOps {
  canStartFn: typeof canStart;
  listenersOnPortFn: typeof listenersOnPort;
  startModelServerFn: typeof startModelServer;
  retryDelayMs: number;
  spawnWatchdogFn: typeof spawnWatchdogIfNeeded;
  acquireStartLockFn: typeof acquireRunnerStartLock;
  releaseStartLockFn: typeof releaseRunnerStartLock;
  launchGuardFn: () => Promise<LaunchGuardSample>;
}

async function probeAndMaybeStart(
  spec: LocalRunnerSpec,
  fetchFn: typeof fetch,
  timeoutMs: number,
  started: Set<string>,
  unavailable: UnavailableRunner[],
  ops: AutostartOps,
): Promise<LocalRunner | null> {
  const runner = { name: spec.id, baseUrl: spec.baseUrl };
  const first = await probeRunner(runner, fetchFn, timeoutMs);
  if (first) return first;

  const listeners = await ops.listenersOnPortFn(spec.port);
  if (listeners.processes.length > 0) {
    // Something is already on the port — a runner Prometheus did not start, or one that is up
    // but not answering. Never touch it here; report it as wedged rather than pretend it's absent.
    unavailable.push({ id: spec.id, name: spec.name, wedged: true });
    return null;
  }
  if (!spec.start || !(await ops.canStartFn(spec.start))) return null; // genuinely not installed.

  // The machine-wide 90% CPU/RAM ceiling — the same one `model pull` already refuses on. A cold
  // start is exactly the kind of NEW load this exists to block; adopting an already-running
  // runner (the `first` check above) never reaches here because it spawns nothing new.
  const guardVerdict = launchGuardVerdict(await ops.launchGuardFn());
  if (!guardVerdict.ok) {
    unavailable.push({ id: spec.id, name: spec.name, wedged: false, reason: guardVerdict.reason });
    return null;
  }

  // Another surface (another CLI shell, or the desktop app) is already mid-spawn for this same
  // runner — ride along with its attempt instead of racing a second `startModelServer` on top
  // of it. This is the whole fix for the duplicate-process/RAM-exhaustion failure mode: without
  // it, every caller that reaches this point concurrently sees an empty port and starts its own.
  if (!ops.acquireStartLockFn(spec.id)) {
    for (let attempt = 0; attempt < AUTOSTART_RETRY_ATTEMPTS; attempt++) {
      await sleep(ops.retryDelayMs);
      const again = await probeRunner(runner, fetchFn, timeoutMs);
      if (again) return again; // the lock holder brought it up — adopt it, we didn't start it.
    }
    return null; // the other attempt is still working it out (or gave up) — not ours to retry.
  }

  try {
    const result = ops.startModelServerFn(spec.start);
    if (!result.ok) {
      unavailable.push({ id: spec.id, name: spec.name, wedged: false });
      return null;
    }
    started.add(spec.id);
    for (let attempt = 0; attempt < AUTOSTART_RETRY_ATTEMPTS; attempt++) {
      await sleep(ops.retryDelayMs);
      const again = await probeRunner(runner, fetchFn, timeoutMs);
      if (again) {
        // A CLI-autostarted runner must not outlive its usefulness: this is the ONE place the
        // interactive session, `--plain` host, AND `-p`/`chat` one-shot runs all pass through to
        // bring a local runner up, so this is also the one place that must arm its own teardown.
        // Fire-and-forget — a watchdog that fails to start just means "runs until stopped by
        // hand", same as before this call existed, never a session-start failure. Any runner we
        // just self-started gets one: the watchdog's poll loop is generic (its `port`/
        // `processMatch` are passed explicitly here, never left at their Ollama-shaped
        // defaults), so this is correct for LM Studio's `lms server start` too, not just Ollama.
        ops.spawnWatchdogFn({
          port: spec.port,
          processMatch: spec.processMatch,
          runnerId: spec.id,
          displayName: spec.name,
          stopCmd: spec.stop,
        });
        return again;
      }
    }
    // Started, but never answered in time — still worth flagging as "installed", not "missing".
    unavailable.push({ id: spec.id, name: spec.name, wedged: false });
    return null;
  } finally {
    ops.releaseStartLockFn(spec.id);
  }
}

/**
 * Detect available chat backends: probe local runners (parallel, fail-soft), autostarting one
 * that's installed but not running, + scan for installed paid CLIs. Never throws — a dead runner
 * or a failed scan just yields fewer backends. Returns a ready local endpoint when a runner
 * serves a model.
 */
export async function detectBackends(deps: DetectDeps): Promise<Backends> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 900;
  const ops: AutostartOps = {
    canStartFn: deps.canStartFn ?? canStart,
    listenersOnPortFn: deps.listenersOnPortFn ?? listenersOnPort,
    startModelServerFn: deps.startModelServerFn ?? startModelServer,
    retryDelayMs: deps.retryDelayMs ?? AUTOSTART_RETRY_DELAY_MS,
    spawnWatchdogFn: deps.spawnWatchdogFn ?? spawnWatchdogIfNeeded,
    acquireStartLockFn: deps.acquireStartLockFn ?? acquireRunnerStartLock,
    releaseStartLockFn: deps.releaseStartLockFn ?? releaseRunnerStartLock,
    launchGuardFn: deps.launchGuardFn ?? sampleLaunchGuard,
  };

  const started = new Set<string>();
  const unavailableRunners: UnavailableRunner[] = [];
  const probed = await Promise.all(
    LOCAL_RUNNERS.map((r) =>
      probeAndMaybeStart(r, fetchFn, timeoutMs, started, unavailableRunners, ops),
    ),
  );
  const liveRunners = probed.filter((r): r is LocalRunner => r !== null);
  const localRunner = liveRunners.find((r) => r.models.length > 0);

  let paidClis: string[] = [];
  try {
    const scan = (await deps.client.runPrometheus(["scan"])) as unknown as {
      agents?: Array<{ name?: unknown; present?: unknown }>;
    };
    const agents = Array.isArray(scan?.agents) ? scan.agents : [];
    paidClis = agents
      .filter((a) => a.present === true && CHAT_CLIS.has(String(a.name)))
      .map((a) => String(a.name));
  } catch {
    /* scan is best-effort — no engine ⇒ no paid CLIs detected. */
  }

  return {
    liveRunners,
    ...(localRunner ? { localRunner, localEndpoint: buildLocalEndpoint(localRunner) } : {}),
    paidClis,
    startedRunners: started,
    unavailableRunners,
  };
}

/**
 * Stop every runner THIS session started (see `Backends.startedRunners`) — but only the ones no
 * OTHER live peer still needs, per the fleet's own heartbeat data (`peers`, e.g. `fleet.peers()`
 * right before `fleet.stop()`). Pure aside from the two engine-bridge probes: no fs, no `readFleet`
 * of its own — the caller already has a peer snapshot from the ticker it's tearing down anyway.
 *
 * A server Prometheus did not start is never in `startedRunners` in the first place, so this can
 * never reach for a runner some other program (or a terminal from an hour ago) launched — the same
 * invariant `model-server.ts`'s own docstring states for the manual control panel.
 */
export interface StopRunnersDeps {
  /** injected for tests; default to the real `engine-bridge` probes (no network/signal in a
   *  unit test unless the test explicitly stubs these). */
  modelServerStatusFn?: typeof modelServerStatus;
  signalPidFn?: typeof signalPid;
  /** runs a runner's OWN graceful `stop` argv (e.g. `lms server stop`) — injected for tests;
   *  defaults to the real `execCapture`. See `LocalRunnerSpec.stop`'s doc for why this is
   *  ALWAYS preferred over `signalPidFn` when a spec has one. */
  execCaptureFn?: typeof execCapture;
}

export async function stopSelfStartedRunners(
  startedRunnerIds: ReadonlySet<string> | undefined,
  peers: readonly FleetPeer[],
  deps: StopRunnersDeps = {},
): Promise<void> {
  if (!startedRunnerIds || startedRunnerIds.size === 0) return;
  const statusFn = deps.modelServerStatusFn ?? modelServerStatus;
  const signal = deps.signalPidFn ?? signalPid;
  const runCmd = deps.execCaptureFn ?? execCapture;
  const others = peers.filter((p) => !p.self && p.state !== "dead" && p.model);
  await Promise.all(
    Array.from(startedRunnerIds).map(async (id) => {
      const spec = LOCAL_RUNNERS.find((r) => r.id === id);
      if (!spec) return;
      try {
        const status = await statusFn(spec, { timeoutMs: 1500 });
        if (!status.listening) return; // already gone
        if (others.some((p) => status.models.includes(p.model))) return; // still in use
        if (spec.stop && spec.stop.length > 0) {
          // ALWAYS preferred over signalling — a server that runs INSIDE its vendor's main app
          // process (verified for LM Studio: its own process reports as "Bionic" in `ps`, not
          // even "LM Studio") would have the WHOLE app quit by a raw SIGTERM, not just its
          // server component. Let the vendor's own tool decide how to shut down.
          const [bin, ...args] = spec.stop;
          if (bin) await runCmd(bin, args, { timeoutMs: 15_000 });
          return;
        }
        for (const proc of status.processes) {
          const runningOurBinary =
            proc.command === spec.processMatch || proc.command.includes(spec.processMatch);
          if (runningOurBinary) signal(proc.pid, "SIGTERM");
        }
      } catch {
        /* best-effort teardown — a runner Prometheus can't confirm is left running, not killed. */
      }
    }),
  );
}

/** One-line backend summary for the banner/footer (e.g. "local · qwen2.5-coder"). */
export function backendSummary(backends: Backends): string {
  if (backends.localEndpoint) return `local · ${backends.localEndpoint.model ?? "?"}`;
  if (backends.paidClis.length > 0) return `paid CLI · ${backends.paidClis.join("/")} (/setup)`;
  return "no model — type /setup";
}

/** A boxed onboarding panel shown on first run when no local model is ready. */
export function renderOnboarding(backends: Backends): string {
  const lines: string[] = [];
  lines.push(c.bold("No local model is running yet."));
  lines.push("");
  if (backends.liveRunners.length > 0) {
    const r = backends.liveRunners[0];
    lines.push(`${c.yellow("•")} ${r?.name} is up but serves no model — pull one below.`);
  } else if (backends.unavailableRunners.length > 0) {
    // Installed (or occupying its port) but not actually reachable — even after Prometheus
    // tried to start it. Saying "detected" here would be a lie; saying "download a model"
    // would send the user to redo something they already did.
    for (const r of backends.unavailableRunners) {
      lines.push(
        r.wedged
          ? `${c.yellow("•")} ${r.name} is running but not responding — it may need a restart.`
          : r.reason
            ? `${c.yellow("•")} ${r.name} was not started — ${r.reason}. Free up resources and retry.`
            : `${c.yellow("•")} ${r.name} is installed but Prometheus could not start it.`,
      );
    }
  } else {
    lines.push(`${c.yellow("•")} no local runner (Ollama / LM Studio) detected.`);
  }
  if (backends.paidClis.length > 0) {
    lines.push(`${c.green("•")} paid CLIs available: ${c.bold(backends.paidClis.join(", "))}`);
  }
  lines.push("");
  lines.push(`Type ${c.cyan("/setup")} to pick a free local model to download,`);
  lines.push("or connect a paid CLI (Claude / Codex / Gemini / …).");
  lines.push("");
  lines.push(
    `${c.dim("Save tokens/$ —")} ${c.cyan("prometheus tokens")} ${c.dim("proposes terse output, prompt caching, a repo map + more.")}`,
  );
  return box(lines, { border: "brand" });
}

/* ------------------------------------------------------------------------- *
 * /setup — the interactive wizard
 * ------------------------------------------------------------------------- */

export interface SetupDeps {
  client: EngineClient;
  write: (line: string) => void;
  /** ask the user a free-text line (readline question). */
  ask: (prompt: string) => Promise<string>;
  /** ask for a FOLDER with tab path-completion (default kept on blank). */
  askPath?: (prompt: string, def: string) => Promise<string>;
  fetchFn?: typeof fetch;
  /** run a child process to completion, streaming its I/O; returns the exit code. */
  runChild?: (cmd: string, args: string[]) => Promise<number>;
  /** the ~/.prometheus home root (tests point this at a temp dir). */
  home?: string;
  /** forwarded to the internal `detectBackends` call — see `DetectDeps`; a test that never
   *  wants to exercise autostart injects safe no-ops here so it never shells out for real. */
  canStartFn?: DetectDeps["canStartFn"];
  listenersOnPortFn?: DetectDeps["listenersOnPortFn"];
  startModelServerFn?: DetectDeps["startModelServerFn"];
  retryDelayMs?: number;
  spawnWatchdogFn?: DetectDeps["spawnWatchdogFn"];
  acquireStartLockFn?: DetectDeps["acquireStartLockFn"];
  releaseStartLockFn?: DetectDeps["releaseStartLockFn"];
  launchGuardFn?: DetectDeps["launchGuardFn"];
}

/** A minimal child handle — avoids importing node:child_process types (C5 boundary). */
interface ChildLike {
  on(event: string, cb: (arg?: unknown) => void): void;
}
type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { stdio: "inherit"; shell: false },
) => ChildLike;

// node:child_process is the engine-bridge's exclusive STATIC import (C5). The /setup
// wizard spawns a user binary (`ollama pull`) — a terminal action, like the pty host —
// so it loads spawn LAZILY via createRequire (a runtime call, not a restricted import),
// matching pty/backend.ts. It is also fully injectable (`runChild`) for tests.
const nodeRequire = createRequire(import.meta.url);

/** Default child runner — spawn inheriting stdio (download progress shows live). */
function defaultRunChild(cmd: string, args: string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    try {
      const cp = nodeRequire("node:child_process") as { spawn?: SpawnLike };
      if (typeof cp.spawn !== "function") {
        resolve(127);
        return;
      }
      const child = cp.spawn(cmd, args, { stdio: "inherit", shell: false });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
    } catch {
      resolve(127);
    }
  });
}

/**
 * Run the `/setup` wizard. Re-detects backends; if a local model is already ready it
 * reports it; otherwise it offers to (1) download a free local model via Ollama or
 * (2) connect a paid CLI. Returns the endpoint to adopt for the session, if any.
 * Crash-free: every branch is guarded; a declined/blank answer cancels cleanly.
 */
export async function runSetup(deps: SetupDeps): Promise<{ endpoint?: AiEndpoint }> {
  const { write, ask } = deps;
  const runChild = deps.runChild ?? defaultRunChild;
  const backends = await detectBackends({
    client: deps.client,
    fetchFn: deps.fetchFn,
    canStartFn: deps.canStartFn,
    listenersOnPortFn: deps.listenersOnPortFn,
    startModelServerFn: deps.startModelServerFn,
    retryDelayMs: deps.retryDelayMs,
    spawnWatchdogFn: deps.spawnWatchdogFn,
    acquireStartLockFn: deps.acquireStartLockFn,
    releaseStartLockFn: deps.releaseStartLockFn,
    launchGuardFn: deps.launchGuardFn,
  });

  if (backends.localEndpoint) {
    // More than one model already downloaded (one runner serving several, or several runners
    // up at once) → let the user pick instead of silently always adopting the first — the
    // previous behavior had no way to reach anything but `liveRunners[0].models[0]`, ever.
    const served = backends.liveRunners.flatMap((r) =>
      r.models.map((model) => ({ runner: r, model })),
    );
    if (served.length > 1) {
      write(`${c.green("✓")} ${served.length} local models already downloaded:`);
      served.forEach((s, i) => {
        write(`  ${c.cyan(String(i + 1))}  ${c.bold(s.model)} ${c.dim(`(${s.runner.name})`)}`);
      });
      const pick = Number((await ask(`Pick 1–${served.length} (Enter for #1)`)).trim());
      const chosen =
        Number.isInteger(pick) && pick >= 1 && pick <= served.length ? served[pick - 1] : served[0];
      const ep = buildLocalEndpoint({ ...chosen!.runner, models: [chosen!.model] });
      write(c.dim(`  using ${ep.model} via ${chosen!.runner.name} at ${ep.baseUrl}`));
      return { endpoint: ep };
    }
    write(`${c.green("✓")} local model ready: ${c.bold(backends.localEndpoint.model ?? "?")}`);
    write(c.dim(`  via ${backends.localRunner?.name} at ${backends.localEndpoint.baseUrl}`));
    return { endpoint: backends.localEndpoint };
  }

  write(renderOnboarding(backends));
  write("");
  write(`${c.bold("Setup")} — choose:`);
  write(`  ${c.cyan("1")}  Download a free local model (Ollama)`);
  write(`  ${c.cyan("2")}  Connect a paid CLI (Claude / Codex / Gemini / Cursor / opencode)`);
  write(`  ${c.cyan("0")}  Skip for now`);
  const choice = (await ask("Pick 1, 2, or 0")).trim();

  if (choice === "1") return setupLocal(deps, backends, runChild);
  if (choice === "2") return setupPaid(deps, backends);
  write(c.dim("Setup skipped. Run /setup any time."));
  return {};
}

/** Download-a-local-model branch. */
async function setupLocal(
  deps: SetupDeps,
  backends: Backends,
  runChild: (cmd: string, args: string[]) => Promise<number>,
): Promise<{ endpoint?: AiEndpoint }> {
  const { write, ask } = deps;
  const ollamaUp = backends.liveRunners.some((r) => r.name === "ollama");

  write("");
  write(c.bold("Recommended local models (Ollama):"));
  RECOMMENDED_LOCAL.forEach((m, i) => {
    write(`  ${c.cyan(String(i + 1))}  ${c.bold(m.tag)} ${c.dim(`— ${m.note}`)}`);
  });
  const pick = Number((await ask(`Pick 1–${RECOMMENDED_LOCAL.length} (0 to cancel)`)).trim());
  if (!Number.isInteger(pick) || pick < 1 || pick > RECOMMENDED_LOCAL.length) {
    write(c.dim("cancelled."));
    return {};
  }
  const model = RECOMMENDED_LOCAL[pick - 1];
  const tag = model?.tag ?? "";

  // ── install location: show the default open_models dir + disk, let the user repoint ──
  const home = deps.home ?? prometheusHome();
  let dir = resolveCategory("open_models", home);
  write("");
  write(`${c.dim("install dir")}  ${c.bold(dir)}`);
  const di = diskInfo(dir);
  if (di) {
    write(
      `${c.dim("disk")}        ${c.green(humanBytes(di.freeBytes))} free of ${humanBytes(di.totalBytes)}  ${c.dim(`· model ≈ ${model?.gb ?? "?"} GB`)}`,
    );
  } else {
    write(`${c.dim("model size")}  ≈ ${model?.gb ?? "?"} GB`);
  }
  if (deps.askPath) {
    const keep = (await ask("Keep this folder? [Y/n]")).trim().toLowerCase();
    if (keep === "n" || keep === "no") {
      const chosen = await deps.askPath("New folder for open models:", dir);
      dir = setCategory("open_models", chosen, home);
      write(c.green(`✓ open models → ${dir}`));
      // persist engine-side too (engine reads models_root from its config.json).
      try {
        await deps.client.runPrometheus(["models", "config", "--set-root", dir]);
      } catch {
        /* best-effort — the env var below is the load-bearing path for the sidecar. */
      }
    }
  }
  // point BOTH download mechanisms at the chosen dir: the engine modelhub sidecar
  // ($PROMETHEUS_MODELS_DIR) and the `ollama pull` child ($OLLAMA_MODELS).
  process.env.PROMETHEUS_MODELS_DIR = dir;
  process.env.OLLAMA_MODELS = dir;

  if (!ollamaUp) {
    write("");
    write(`${c.yellow("Ollama is not running.")} Install it first:`);
    write(`  ${c.cyan("prometheus apps install ollama --yes")}   ${c.dim("(nemesis-gated)")}`);
    write(
      `then re-run ${c.cyan("/setup")} (or: ${c.cyan(`ollama pull ${tag}`)}), and restart prometheus.`,
    );
    const go = (await ask("Install Ollama now via the gated installer? [y/N]"))
      .trim()
      .toLowerCase();
    if (go === "y" || go === "yes") {
      write(c.dim("Routing through the engine's gated installer…"));
      try {
        const env = (await deps.client.runPrometheus(["apps", "install", "ollama"])) as unknown as {
          ok?: boolean;
        };
        write(
          env?.ok === false
            ? c.red("installer reported a problem — see output above.")
            : c.green(`✓ ollama install requested. Start it, then run \`ollama pull ${tag}\`.`),
        );
      } catch (err) {
        write(c.red(`installer failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    } else {
      write(
        c.dim(
          `skipped. Install Ollama yourself, then run \`ollama pull ${tag}\` and restart prometheus.`,
        ),
      );
    }
    return {};
  }

  // Ollama is up → pull the model directly (the natural, live-progress action).
  write("");
  write(`Pulling ${c.bold(tag)} via Ollama (this can take a few minutes)…`);
  const confirm = (await ask(`Run \`ollama pull ${tag}\` now? [y/N]`)).trim().toLowerCase();
  if (confirm !== "y" && confirm !== "yes") {
    write(c.dim(`skipped. Run \`ollama pull ${tag}\` yourself, then restart prometheus.`));
    return {};
  }
  const code = await runChild("ollama", ["pull", tag]);
  if (code !== 0) {
    write(c.red(`ollama pull exited ${code}. Is the \`ollama\` binary on PATH?`));
    return {};
  }
  write(c.green(`✓ ${tag} pulled. Adopting it for this session.`));
  return {
    endpoint: buildLocalEndpoint({
      name: "ollama",
      baseUrl: "http://localhost:11434/v1",
      models: [tag],
    }),
  };
}

/** Connect-a-paid-CLI branch. */
async function setupPaid(deps: SetupDeps, backends: Backends): Promise<{ endpoint?: AiEndpoint }> {
  const { write } = deps;
  write("");
  if (backends.paidClis.length === 0) {
    write(c.yellow("No agent CLIs detected on PATH."));
    write(
      `Install one (e.g. Claude Code / Codex / Gemini), then chat via ${c.cyan(
        "prometheus chat --cli <svc> --open",
      )}.`,
    );
    return {};
  }
  write(c.bold("Installed agent CLIs you can chat with:"));
  for (const cli of backends.paidClis) {
    write(`  ${c.green("•")} ${c.bold(cli)} → ${c.cyan(`prometheus chat --cli ${cli} --open`)}`);
  }
  write("");
  write(c.dim("Run one of the commands above from a shell to launch a live terminal chat."));
  return {};
}

/* ------------------------------------------------------------------------- *
 * /paths — view + repoint the per-category heavy-download folders
 * ------------------------------------------------------------------------- */

export interface PathsDeps {
  client: EngineClient;
  write: (line: string) => void;
  ask: (prompt: string) => Promise<string>;
  /** the folder picker with tab-completion (interactive only). */
  askPath?: (prompt: string, def: string) => Promise<string>;
  home?: string;
}

/**
 * `/paths` — list each heavy-download category (open models, videos, audio, files) with
 * its current folder + free disk, and let the user repoint one (tab-completing picker).
 * Repointing `open_models` also persists the engine's models_root. Crash-free + fail-soft.
 */
export async function runPathsWizard(deps: PathsDeps): Promise<void> {
  const { write, ask } = deps;
  const home = deps.home ?? prometheusHome();

  write(`${c.bold("Download folders")} ${c.dim(`(root: ${home})`)}`);
  PATH_CATEGORIES.forEach((cat, i) => {
    const dir = resolveCategory(cat, home);
    const di = diskInfo(dir);
    const free = di ? c.dim(`  · ${humanBytes(di.freeBytes)} free`) : "";
    write(`  ${c.cyan(String(i + 1))}  ${c.bold(CATEGORY_LABEL[cat])}`);
    write(`       ${c.dim(dir)}${free}`);
  });

  if (!deps.askPath) {
    write(c.dim("(open an interactive session to change a folder)"));
    return;
  }
  const pick = Number((await ask(`Change which? 1–${PATH_CATEGORIES.length} (0 to close)`)).trim());
  if (!Number.isInteger(pick) || pick < 1 || pick > PATH_CATEGORIES.length) {
    write(c.dim("done."));
    return;
  }
  const cat = PATH_CATEGORIES[pick - 1] as PathCategory;
  const chosen = await deps.askPath(
    `New folder for ${CATEGORY_LABEL[cat]}:`,
    resolveCategory(cat, home),
  );
  const abs = setCategory(cat, chosen, home);
  write(c.green(`✓ ${CATEGORY_LABEL[cat]} → ${abs}`));
  if (cat === "open_models") {
    try {
      await deps.client.runPrometheus(["models", "config", "--set-root", abs]);
    } catch {
      /* best-effort engine persist; the env var is the load-bearing path. */
    }
  }
}
