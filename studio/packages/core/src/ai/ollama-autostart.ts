/**
 * ai/ollama-autostart.ts — the ONE shared "make sure a local runner is up, on ANY surface"
 * function — Ollama first, LM Studio (`lms server start`) the same way.
 *
 * The CLI has had its own version of this since onboarding.ts (autostart at session boot),
 * but that module is apps/cli-only and unreachable from the desktop main process or the VS
 * Code extension. `packages/core` is the natural shared home: both of those already depend on
 * it, and `@prometheus/engine-bridge` (which owns the actual spawn/signal primitives) is
 * ITSELF a dependency of core — never the other way — so this file may import engine-bridge
 * freely but engine-bridge must never import this one.
 *
 * SCOPE, DELIBERATELY NARROW: this only STARTS a runner using a model that is already pulled.
 * It never runs `ollama pull` on a bare chat prompt — a silent multi-gigabyte download with no
 * confirmation is exactly the kind of surprising, resource-heavy action a first message should
 * never trigger. Pulling a NEW model stays the job of the CLI's existing `/setup` wizard
 * (onboarding.ts's `runSetup`/`setupLocal`), which asks first. A caller that gets back
 * `endpoint: undefined` because nothing is installed yet should point the user at that wizard,
 * not try to download something itself.
 *
 * `ensureOllamaRunning`/`ensureLmStudioRunning` are both thin, name-stable wrappers around the
 * shared `ensureLocalRunnerRunning(runnerId, opts)` core below — same single-instance lock, same
 * 90% launch-ceiling gate, same idle-shutdown watchdog, same active-eviction protection, for
 * whichever runner the caller names. Kept as two named exports (rather than one generic
 * function everywhere) because existing call sites already gate "start THIS one, never a
 * different runner under someone else's endpoint" on the specific function name — see
 * `ai-ipc.ts`'s docstring on why an LM Studio endpoint must never have Ollama started underneath
 * it, and vice versa.
 */
import {
  acquireRunnerStartLock,
  canStart,
  type LaunchGuardSample,
  launchGuardVerdict,
  listenersOnPort,
  releaseRunnerStartLock,
  sampleLaunchGuard,
  spawnWatchdogIfNeeded,
  startModelServer,
} from "@prometheus/engine-bridge";

import type { AiEndpoint } from "./client.js";
import { DEFAULT_CONTEXT_WINDOW } from "./context-window.js";
import { LOCAL_RUNNERS, type LocalRunnerSpec } from "./local-runners.js";

const DEFAULT_TIMEOUT_MS = 900;
const DEFAULT_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 300;

export interface EnsureOllamaOptions {
  /**
   * A model reference the caller already has (an active profile, a prior `/model` pick).
   * When set, autostart brings Ollama up and points the endpoint at EXACTLY this model —
   * it is never swapped for Gemma, even if this tag isn't in what's currently served (the
   * server may still need a moment, or the caller may already know it's about to pull it).
   * Omit only for the true zero-config case (a fresh desktop/VS Code install, no prior pick).
   */
  modelId?: string;
  fetchFn?: typeof fetch;
  canStartFn?: typeof canStart;
  listenersOnPortFn?: typeof listenersOnPort;
  startModelServerFn?: typeof startModelServer;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  /** the idle-shutdown watchdog's threshold; only consulted when THIS call starts the server. */
  idleStopMs?: number;
  /** skip spawning the idle-shutdown watchdog (tests only — never in production). */
  skipWatchdog?: boolean;
  /**
   * The cross-process "only one surface may be mid-spawn for this runner" lock — see
   * engine-bridge's start-lock.ts. Injected for tests the same way every other autostart
   * primitive here is; production leaves these at their real defaults.
   */
  acquireStartLockFn?: typeof acquireRunnerStartLock;
  releaseStartLockFn?: typeof releaseRunnerStartLock;
  /**
   * The shared 90% CPU/RAM launch ceiling (engine-bridge's launch-guard.ts, already used by
   * `model pull`/`sidecar-cmd.ts`) — consulted here too, right before a COLD start, so a machine
   * already under heavy load never gets a fresh `ollama serve` piled on top of it. Injected for
   * tests the same way every other primitive here is; never consulted when Ollama is merely
   * being adopted (already running, or another surface's start is being ridden along) since
   * that path spawns nothing new.
   */
  launchGuardFn?: () => Promise<LaunchGuardSample>;
}

export interface EnsureOllamaResult {
  /** true when THIS call actually started the server (false ⇒ it was already up, or the
   *  attempt failed — see `reason`). */
  started: boolean;
  endpoint?: AiEndpoint;
  /** set when no endpoint could be produced — why, in the same vocabulary `renderOnboarding`
   *  already uses ("not-installed" | "wedged" | "start-failed" | "no-model-served"), plus
   *  "resource-ceiling" for a cold start refused by the CPU/RAM launch guard. */
  reason?: "not-installed" | "wedged" | "start-failed" | "no-model-served" | "resource-ceiling";
  /** set only alongside reason:"resource-ceiling" — which resource, and by how much. */
  resourceReason?: string;
}

async function probeModels(
  baseUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string[] | undefined> {
  try {
    const res = await fetchFn(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return Array.isArray(data?.data)
      ? data.data.map((m) => String(m?.id ?? "")).filter((s) => s.length > 0)
      : [];
  } catch {
    return undefined;
  }
}

/** Rough parameter count (billions) parsed from an Ollama-style tag's size suffix —
 *  "gemma3:27b" → 27, "qwen2.5:0.5b" → 0.5, "smollm2:135m" → 0.135. Undefined when no size
 *  suffix is present (e.g. most LM Studio model ids, which don't use this convention), so an
 *  unparseable tag is never mistaken for "the smallest one" — `pickModel` falls back to the
 *  first served model in that case, never a broken guess. */
function tagParamsB(tag: string): number | undefined {
  const m = /:(?:[\w.-]*?)?(\d+(?:\.\d+)?)\s*([bm])\b/i.exec(tag);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2]?.toLowerCase() === "m" ? n / 1000 : n;
}

/** Prefer an already-installed model matching `wanted`, else — the true zero-config case — the
 *  SMALLEST already-installed model with a parseable size. Zero config must never mean "whatever
 *  huge model happens to match /gemma/i": a box with only a 27B Gemma pulled (e.g. from a prior
 *  explicit /setup download) would otherwise get it loaded by default with no RAM check anywhere
 *  in this call chain. Falls back to the first served model when nothing parses. NEVER a model
 *  that isn't already pulled. */
function pickModel(served: string[], wanted: string | undefined): string | undefined {
  if (wanted && served.includes(wanted)) return wanted;
  if (wanted) return wanted; // caller's own pick still wins — see EnsureOllamaOptions.modelId doc.
  const sized = served
    .map((tag) => ({ tag, b: tagParamsB(tag) }))
    .filter((s): s is { tag: string; b: number } => s.b !== undefined)
    .sort((a, b) => a.b - b.b);
  return sized[0]?.tag ?? served[0];
}

function buildEndpoint(runner: LocalRunnerSpec, model: string): AiEndpoint {
  return {
    id: `local:${runner.id}:${model}`,
    baseUrl: runner.baseUrl,
    locality: "local",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    supportsTools: true,
    model,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make sure `runnerId`'s local server is reachable, starting it if it's merely stopped (not
 * merely unreachable for some other reason — see the `reason` field). Never overrides an
 * already-configured model (`opts.modelId`); only picks the smallest-by-default in the true
 * zero-config case. Shared core behind `ensureOllamaRunning`/`ensureLmStudioRunning` — see this
 * file's docstring for why those stay separate named exports.
 */
async function ensureLocalRunnerRunning(
  runnerId: string,
  opts: EnsureOllamaOptions,
): Promise<EnsureOllamaResult> {
  const runner = LOCAL_RUNNERS.find((r) => r.id === runnerId);
  if (!runner) return { started: false, reason: "not-installed" };
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const canStartFn = opts.canStartFn ?? canStart;
  const listenersOnPortFn = opts.listenersOnPortFn ?? listenersOnPort;
  const startModelServerFn = opts.startModelServerFn ?? startModelServer;

  const already = await probeModels(runner.baseUrl, fetchFn, timeoutMs);
  if (already !== undefined) {
    const model = pickModel(already, opts.modelId);
    return model
      ? { started: false, endpoint: buildEndpoint(runner, model) }
      : { started: false, reason: "no-model-served" };
  }

  const listeners = await listenersOnPortFn(runner.port);
  if (listeners.processes.length > 0) {
    return { started: false, reason: "wedged" }; // occupied but not answering — not ours to touch.
  }
  if (!runner.start || !(await canStartFn(runner.start))) {
    return { started: false, reason: "not-installed" };
  }

  // The machine-wide 90% CPU/RAM ceiling — the same one `model pull` already refuses on. A cold
  // start is exactly the kind of NEW load this exists to block: never adopting an already-
  // running server (nothing new spawns there), only the actual `startModelServer` below.
  const launchGuardFn = opts.launchGuardFn ?? sampleLaunchGuard;
  const guardVerdict = launchGuardVerdict(await launchGuardFn());
  if (!guardVerdict.ok) {
    return { started: false, reason: "resource-ceiling", resourceReason: guardVerdict.reason };
  }

  const attempts = opts.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const delayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const acquireStartLockFn = opts.acquireStartLockFn ?? acquireRunnerStartLock;
  const releaseStartLockFn = opts.releaseStartLockFn ?? releaseRunnerStartLock;

  // Another surface (another CLI shell, or the desktop app) is already mid-spawn for this same
  // runner — ride along with its attempt instead of racing a second `startModelServer` on top
  // of it. This is the whole fix for the duplicate-process/RAM-exhaustion failure mode: without
  // it, every caller that reaches this point concurrently sees an empty port and starts its own.
  if (!acquireStartLockFn(runner.id)) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(delayMs);
      const served = await probeModels(runner.baseUrl, fetchFn, timeoutMs);
      if (served !== undefined) {
        const model = pickModel(served, opts.modelId);
        return model
          ? { started: false, endpoint: buildEndpoint(runner, model) }
          : { started: false, reason: "no-model-served" };
      }
    }
    return { started: false, reason: "start-failed" }; // the other attempt never answered either.
  }

  try {
    const result = startModelServerFn(runner.start);
    if (!result.ok) return { started: false, reason: "start-failed" };

    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(delayMs);
      const served = await probeModels(runner.baseUrl, fetchFn, timeoutMs);
      if (served !== undefined) {
        if (!opts.skipWatchdog) {
          spawnWatchdogIfNeeded({
            idleMs: opts.idleStopMs,
            port: runner.port,
            processMatch: runner.processMatch,
            runnerId: runner.id,
            displayName: runner.name,
            stopCmd: runner.stop,
          });
        }
        const model = pickModel(served, opts.modelId);
        return model
          ? { started: true, endpoint: buildEndpoint(runner, model) }
          : { started: true, reason: "no-model-served" };
      }
    }
    return { started: true, reason: "start-failed" }; // started, but never answered in time.
  } finally {
    releaseStartLockFn(runner.id);
  }
}

/**
 * Make sure Ollama is reachable, starting it (`ollama serve`) if it's merely stopped.
 */
export async function ensureOllamaRunning(
  opts: EnsureOllamaOptions = {},
): Promise<EnsureOllamaResult> {
  return ensureLocalRunnerRunning("ollama", opts);
}

/**
 * Make sure LM Studio's server is reachable, starting it (`lms server start`) if it's merely
 * stopped — same single-instance lock, launch-ceiling gate, idle-shutdown watchdog and
 * active-eviction protection as `ensureOllamaRunning`, just for the other runner.
 */
export async function ensureLmStudioRunning(
  opts: EnsureOllamaOptions = {},
): Promise<EnsureOllamaResult> {
  return ensureLocalRunnerRunning("lmstudio", opts);
}
