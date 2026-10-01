// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/runner-discovery.ts — ask THIS machine which local model servers it actually has.
 *
 * ## Why this exists
 *
 * Both surfaces shipped a hardcoded answer to a question only the machine can answer.
 *
 * The desktop's endpoint list was `LOCAL_AI_ENDPOINTS` (prometheus.py §6H) returned verbatim: a
 * five-row table of default URLs, printed identically on a machine with four runners and on a
 * machine with none. Its Chat runner dropdown was a two-item literal. The CLI was only less
 * wrong — it probed, but only the two runners `LOCAL_RUNNERS` happened to list, so llama.cpp and
 * vLLM were invisible to every surface even while serving.
 *
 * The measured consequence was not cosmetic. On the machine this was written for, 143 GB of
 * weights sat in three stores (`~/.ollama`, `~/.lmstudio`, `~/.cache/huggingface/hub`) that
 * nothing indexed, while Prometheus offered to download more into four empty directories it had
 * invented. Discovery is the other half of that fix: `model.list` now says what you HAVE, and
 * this says what can SERVE it.
 *
 * ## What it will not do
 *
 * **Metadata only.** Every request here is a read that cannot cause a model load:
 * `GET /api/tags` and `GET /v1/models` list what exists. `/v1/chat/completions`, `/api/generate`
 * and `/api/embeddings` make ollama page in the weights before it can answer even a one-token
 * ping — 23 GB resident, from what looks like a liveness check (CLAUDE.md §2.3). Those three are
 * not reachable from this file and must never become so.
 *
 * **No spawn, no signal.** Discovery reports; it does not act. Starting a runner stays with
 * `ollama-autostart.ts`, which has the start lock and the resource ceiling. A scan that could
 * start four servers would be a scan nobody could safely run on a timer.
 *
 * **Injected everything.** `fetch` and `which` are parameters, never ambient. That is this
 * repo's convention for anything that can reach the daemon (CLAUDE.md §2.3: "dependency-injected
 * or stubbed `fetch`, never an env flag") and it is what lets the tests below run with no
 * network and no `ollama` on PATH.
 */
import { type LocalRunnerSpec, localRunners } from "./local-runners.js";

/**
 * What the machine said about one runner.
 *
 * - `serving`   — it answered a metadata request. `models` is what it has loaded or can serve.
 * - `installed` — its binary is on PATH (or its app bundle exists) but nothing answered.
 * - `absent`    — no binary, no answer. Offer `install` where there is one.
 *
 * `unknown` is deliberately NOT a state. A probe that fails for an unexpected reason reports
 * `absent` with a `detail`, because a user staring at "unknown" has to go and find out anyway,
 * and a UI that renders four unknowns is the static table again with extra steps.
 */
export type RunnerState = "serving" | "installed" | "absent";

export interface DiscoveredRunner {
  id: string;
  name: string;
  /** the OpenAI-compatible root, AFTER any vendor host override (`OLLAMA_HOST`). */
  baseUrl: string;
  host: string;
  port: number;
  state: RunnerState;
  /** model ids this runner reports right now; `[]` unless `state === "serving"`. */
  models: readonly string[];
  /** Prometheus has an argv that can start it, and it is on this machine. */
  canStart: boolean;
  /** Prometheus has an argv that can install it unattended. */
  canInstall: boolean;
  /** absolute path of the binary, when `which` found one. */
  binPath?: string;
  /** why a probe did not conclude — advisory, never thrown. */
  detail?: string;
}

export interface DiscoverDeps {
  /** injected; must be a real `fetch` only in production. */
  fetchFn?: typeof fetch;
  /**
   * Resolve a bare command to an absolute path, or `undefined`.
   *
   * Injected rather than implemented here because core may not spawn (C5/SPINE: engine-bridge
   * owns every child process). Hosts pass their own — the CLI already has `canStart`, the
   * desktop has `execCapture` in main. A caller that passes nothing gets no `installed` state,
   * only `serving` and `absent`, which is still strictly better than the static table.
   */
  whichFn?: (bin: string) => Promise<string | undefined>;
  /** per-runner budget. Four probes run concurrently, so this is the wall clock, not the sum. */
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/**
 * The default per-runner probe budget, in milliseconds.
 *
 * 900 ms matches what `detectBackends` has used at CLI startup since it existed. A loopback
 * server that is up answers `/api/tags` in single-digit milliseconds; this budget is sized for
 * the case that actually costs time — a port with no listener on a host that drops rather than
 * refuses, where the alternative is the OS connect timeout (75 s on macOS).
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 900;

/** Parse an ollama `/api/tags` body into model names. Tolerant: a shape change yields `[]`. */
export function modelsFromTags(body: unknown): string[] {
  const rows = (body as { models?: unknown })?.models;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((m) =>
      String(
        (m as { name?: unknown; model?: unknown })?.name ?? (m as { model?: unknown })?.model ?? "",
      ),
    )
    .filter((s) => s.length > 0);
}

/** Parse an OpenAI `/v1/models` body into model ids. Tolerant: a shape change yields `[]`. */
export function modelsFromOpenAiList(body: unknown): string[] {
  const rows = (body as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((m) => String((m as { id?: unknown })?.id ?? "")).filter((s) => s.length > 0);
}

/**
 * The metadata URL for a runner, and the parser for its reply.
 *
 * Ollama gets its NATIVE `/api/tags` rather than the OpenAI shim: the native route returns the
 * tag the user actually typed (`qwen3.6:latest`), the shim has historically dropped the tag, and
 * a dropdown that offers a name `ollama run` rejects is worse than no dropdown.
 */
function metadataProbe(spec: LocalRunnerSpec): { url: string; parse: (b: unknown) => string[] } {
  if (spec.nativeUrl) {
    return { url: `${spec.nativeUrl.replace(/\/+$/, "")}/api/tags`, parse: modelsFromTags };
  }
  return { url: `${spec.baseUrl.replace(/\/+$/, "")}/models`, parse: modelsFromOpenAiList };
}

/**
 * Turn a thrown probe error into a sentence a user can act on.
 *
 * Node's `fetch` is undici, and undici throws `TypeError: fetch failed` for EVERY transport
 * failure — refused, unreachable host, DNS miss, TLS error. The real reason is one level down in
 * `err.cause`, and reading only `err.message` produced exactly the collapse this function exists
 * to prevent: "nothing is installed", "the daemon is wedged" and "you typed the hostname wrong"
 * all rendered as `fetch failed`, which sent people to reinstall software that was already there.
 *
 * Measured on this machine 2026-10-01: a stopped LM Studio reported `fetch failed` and nothing
 * else, while `lms` sat on PATH the whole time.
 */
export function describeProbeFailure(
  err: unknown,
  spec: { host: string; port: number },
  timeoutMs: number,
): string {
  const top = (err as Error)?.message ?? String(err);
  if (/abort|timed? ?out/i.test(top)) return `no answer within ${timeoutMs}ms`;
  const cause = (err as { cause?: unknown })?.cause;
  const code = (cause as { code?: unknown })?.code;
  const where = `${spec.host}:${spec.port}`;
  switch (code) {
    case "ECONNREFUSED":
      return `nothing listening on ${where}`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `host ${spec.host} does not resolve`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `${spec.host} is unreachable from here`;
    case "ETIMEDOUT":
      return `${where} did not answer in time`;
    default: {
      const inner = (cause as Error)?.message;
      // Only fall back to the generic wrapper when there is genuinely nothing better.
      return inner && inner !== top ? `${inner} (${where})` : `${top} (${where})`;
    }
  }
}

async function probeOne(
  spec: LocalRunnerSpec,
  doFetch: typeof fetch,
  timeoutMs: number,
): Promise<{ models: string[] } | { detail: string }> {
  const { url, parse } = metadataProbe(spec);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { method: "GET", signal: ctrl.signal });
    if (!res.ok) return { detail: `${url} answered HTTP ${res.status}` };
    return { models: parse(await res.json()) };
  } catch (err) {
    return { detail: describeProbeFailure(err, spec, timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scan this machine for local model servers.
 *
 * Concurrent, fail-soft, and total: every runner in `localRunners()` gets a row whatever
 * happens, because "vLLM: absent" is information and a missing row is not. Never throws.
 */
export async function discoverRunners(deps: DiscoverDeps = {}): Promise<DiscoveredRunner[]> {
  const doFetch = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const specs = localRunners(deps.env ?? process.env);

  return Promise.all(
    specs.map(async (spec): Promise<DiscoveredRunner> => {
      const [probe, binPath] = await Promise.all([
        probeOne(spec, doFetch, timeoutMs),
        spec.bin && deps.whichFn
          ? deps.whichFn(spec.bin).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);

      const serving = "models" in probe;
      const base: DiscoveredRunner = {
        id: spec.id,
        name: spec.name,
        baseUrl: spec.baseUrl,
        host: spec.host,
        port: spec.port,
        state: serving ? "serving" : binPath ? "installed" : "absent",
        models: serving ? probe.models : [],
        // `start` is a property of the SPEC, but "can start" is a property of the machine: an
        // argv we cannot find on PATH is not a start button, it is a failure with a delay.
        canStart: Boolean(spec.start) && Boolean(binPath),
        canInstall: Boolean(spec.install),
        ...(binPath ? { binPath } : {}),
        ...(serving ? {} : { detail: (probe as { detail: string }).detail }),
      };
      return base;
    }),
  );
}

/**
 * Flatten a scan into the `{runnerId, model}` pairs a model picker can offer.
 *
 * Only `serving` runners contribute. An installed-but-stopped runner has no model list to show
 * — claiming otherwise means offering a model that cannot answer, which is exactly the failure
 * the hardcoded two-item dropdown produced on a machine with no ollama.
 */
export function servedModelOptions(
  runners: readonly DiscoveredRunner[],
): Array<{ runnerId: string; runnerName: string; baseUrl: string; model: string }> {
  const out: Array<{ runnerId: string; runnerName: string; baseUrl: string; model: string }> = [];
  for (const r of runners) {
    if (r.state !== "serving") continue;
    for (const model of r.models) {
      out.push({ runnerId: r.id, runnerName: r.name, baseUrl: r.baseUrl, model });
    }
  }
  return out;
}

/**
 * One line a UI can show when nothing is serving, naming the cheapest next step.
 *
 * Returns `undefined` when something IS serving — the caller then has real rows to render and
 * does not need advice. The ordering is deliberate: a runner that is merely stopped is one
 * command away, so it outranks installing a new one.
 */
export function nextStepHint(runners: readonly DiscoveredRunner[]): string | undefined {
  if (runners.some((r) => r.state === "serving")) return undefined;
  const startable = runners.find((r) => r.canStart);
  if (startable) return `${startable.name} is installed but not running — start it to use it.`;
  const installable = runners.find((r) => r.canInstall);
  if (installable)
    return `No local model server found. ${installable.name} can be installed for you.`;
  return "No local model server found on this machine.";
}
