// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * orchestration/backends.ts — the BackendInvoker: agent backend kind → text.
 *
 * The coordinator (pure core) hands us an agent + a prompt; we run it on whatever the
 * agent is bound to and return the reply text. Routing:
 *   cli         → the verified headless recipe (recipes.ts) → hardened spawn-capture,
 *                 bin resolved on PATH (+ fallbacks), nemesis-gated, never --force;
 *   local       → the OpenAI-compatible streaming client (createAiClient);
 *   engine-chat → the engine's `chat --local <model>` (the offline path);
 *   in-process  → same as engine-chat for v1 (the full tool-agent loop is a follow-up);
 *   fake        → a canned reply (dry-run + tests).
 * A bad outcome (timeout / rate-limit / auth / crash) THROWS — the coordinator records it
 * on the bus and the swarm survives. All IO seams are injectable.
 */
import { constants, accessSync } from "node:fs";
import { join } from "node:path";

import {
  type AiEndpoint,
  DEFAULT_CONTEXT_WINDOW,
  type Msg,
  type SseTokenUsage,
  ai,
  createAiClient,
  orchestration,
  secrets,
} from "@prometheus/core";
import { type EngineClient, type LaunchGuardSample, vendorBin } from "@prometheus/engine-bridge";
import { launchGuardVerdict, sampleLaunchGuard } from "@prometheus/engine-bridge";

import { KeyedSemaphore, defaultProviderLimit } from "./concurrency.js";
import { CLI_RECIPES, type CliRecipe, launchFor, localCapableServices } from "./recipes.js";
import { type SpawnCapture, makeSpawnCapture, redactSecrets } from "./spawn-capture.js";

type InvokeRequest = orchestration.InvokeRequest;
type InvokeResult = orchestration.InvokeResult;
type BackendInvoker = orchestration.BackendInvoker;
type AgentSpec = orchestration.AgentSpec;

/** Nemesis-gate seam for a CLI launch (vet bin+args before the first spawn). */
export type GateFn = (bin: string, args: string[]) => Promise<{ ok: boolean; reason?: string }>;

export interface InvokerDeps {
  client: EngineClient;
  /** the session's detected local endpoint (for kind:"local" without an explicit one). */
  endpoint?: AiEndpoint;
  /** the hardened spawn (default: real). */
  spawn?: SpawnCapture;
  /** is a binary on PATH? (injectable; default: a real PATH scan). */
  which?: (bin: string) => boolean;
  /** the nemesis gate for CLI launches (default: allow — the engine still gates fetch/install). */
  gate?: GateFn;
  /** working directory for spawned CLIs. */
  cwd?: string;
  /** override/extend the shipped recipes (custom CLIs + tests). Merged over CLI_RECIPES. */
  recipes?: Record<string, CliRecipe>;
  /** max concurrent CLI calls PER service (default: per-provider caps). */
  providerLimit?: (service: string) => number;
  /** retries on a retryable (rate-limit/crash) outcome (default 2). */
  maxRetries?: number;
  /** backoff sleep (injected for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** jitter source (injected for tests). */
  random?: () => number;
  /** the OpenAI-compatible client factory for kind:"local"/"api" (default: createAiClient). */
  aiClientFactory?: typeof createAiClient;
  /**
   * keychain-first API-key lookup (CLI-028). Called ONLY when no env var resolves the key,
   * so an explicit env var still wins. Default undefined = no keychain read (tests/legacy);
   * the real CLI wires `createCliSecretsStore().get`.
   */
  secretsGet?: (service: string, account: string) => Promise<string | undefined>;
  /**
   * The shared 90% CPU/RAM launch ceiling (engine-bridge's launch-guard.ts — the same one
   * `ensureOllamaRunning`/`model pull` already refuse a cold start on) — consulted right
   * before every NEW agent-CLI subprocess spawn (`opencode`, `hermes`, and every other CLI_
   * RECIPES service alike; the risk of piling more load onto an already-saturated machine
   * isn't specific to any one vendor). Injected for tests; defaults to the real
   * `sampleLaunchGuard`.
   */
  launchGuardFn?: () => Promise<LaunchGuardSample>;
  /**
   * How many times to re-sample the launch ceiling before giving up, with full-jitter backoff
   * between samples (default 3).
   *
   * The ceiling used to be read ONCE and turned into a hard failure. A swarm saturates the
   * machine by design, so that made the guard refuse the swarm's own remaining agents on a single
   * 120 ms reading. Waiting converts one noisy sample into a sustained one. Injected for tests;
   * `0` restores the single-sample behaviour.
   */
  launchGuardWaits?: number;
  /** concurrent requests per LOCAL model server (default 1 — see `makeInvoker`). */
  serverLimit?: number;
}

/** Is `bin` an executable on $PATH, or in a vendor's own bin dir (`~/.opencode/bin`)? */
function defaultWhich(bin: string): boolean {
  return onPath(bin) || vendorBin(bin) !== undefined;
}

/** On $PATH (or an executable path). */
function onPath(bin: string): boolean {
  if (bin.includes("/")) {
    try {
      accessSync(bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const d of dirs) {
    try {
      accessSync(join(d, bin), constants.X_OK);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim()) ?? "").slice(0, 120);

/** Cap on accumulated stream text so a runaway/looping endpoint can't OOM the host
 *  (mirrors the spawn-capture ring cap on the CLI path). */
const MAX_STREAM_CHARS = 8 * 1024 * 1024;

/**
 * Accumulate a chat stream into the sub-agent's ANSWER, with an R1-style model's inline
 * `<think>…</think>` stripped out of it.
 *
 * These two invoke paths matter more than the transcript ones, and were missed when the
 * splitter was wired into the four HOST transports. What they return is not shown to a human
 * and then forgotten — it is a sub-agent's RESULT, folded into a parent agent's thread and fed
 * to another model, and it is what `priceCall` measures. A leaked deliberation there becomes
 * another model's input.
 *
 * The thinking is DROPPED rather than routed: an invoke has no thinking channel to route to,
 * and dropping is strictly better than returning it as the answer. A no-op pass-through when
 * the model's capability names no tag.
 */
async function collectAnswer(
  stream: AsyncIterable<{ delta?: string; usage?: SseTokenUsage; done?: boolean }>,
  endpoint: AiEndpoint,
  onUsage?: (u: SseTokenUsage) => void,
): Promise<string> {
  const { cap } = ai.resolveCapability({
    modelId: endpoint.model ?? endpoint.id,
    runtime: ai.runtimeFromBaseUrl(endpoint.baseUrl, endpoint.locality),
    locality: endpoint.locality,
    ...(endpoint.probedCapabilities ? { probedCapabilities: endpoint.probedCapabilities } : {}),
  });
  const splitter = ai.createReasoningTagSplitter(cap.reasoningTag);
  let text = "";
  for await (const chunk of stream) {
    if (chunk.delta) text += splitter.push(chunk.delta).text;
    if (chunk.usage) onUsage?.(chunk.usage);
    if (chunk.done || text.length > MAX_STREAM_CHARS) break;
  }
  // Flush even on the `break` paths: a stream cut at the byte cap, or ended by `done`, can
  // leave a held-back partial tag that is ordinary text after all.
  return text + splitter.end().text;
}

/** A canned reply for the `fake` backend (dry-run + offline demos). */
function fakeReply(req: InvokeRequest): string {
  return `[${req.agent.name}/${req.agent.role}] (fake) turn ${req.turn}: acknowledged "${firstLine(req.prompt)}"`;
}

/** Run a prompt on a local OpenAI-compatible endpoint and concatenate the stream. */
async function localInvoke(req: InvokeRequest, deps: InvokerDeps): Promise<string> {
  const b = req.agent.backend;
  // override the session endpoint's model/baseUrl for this agent; with no detected
  // endpoint at all, fall back to the engine's local-chat path (no synthetic endpoint).
  if (!deps.endpoint) return engineChat(req, deps);
  const endpoint: AiEndpoint = {
    ...deps.endpoint,
    ...(b.model ? { model: b.model } : {}),
    ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}),
  };
  const makeClient = deps.aiClientFactory ?? createAiClient;
  const client = makeClient(endpoint, { neverSendToCloud: false });
  const messages: Msg[] = [{ role: "user", content: req.prompt }];
  return (await collectAnswer(client.chat(messages), endpoint)).trim();
}

/** The pricing table, loaded once per process (it is a shipped JSON file, not user state). */
let pricingCache: ai.Pricing | undefined;
function pricingTable(): ai.Pricing {
  pricingCache ??= ai.loadPricing();
  return pricingCache;
}

/**
 * Run a prompt on a paid OpenAI-compatible API provider with the USER'S OWN key (kind:"api").
 * The key is read from the agent env (or process env) for the provider's key var — NEVER
 * stored; resolveKey hands it to the client only at request time. This is the ToS-clean
 * automation lane: a commercial API you pay for, driven over HTTP, no CLI/subscription driving.
 */
async function apiInvoke(req: InvokeRequest, deps: InvokerDeps): Promise<InvokeResult> {
  const b = req.agent.backend;
  if (!b.baseUrl) throw new Error(`agent "${req.agent.name}" is an api backend with no baseUrl`);
  const env: Record<string, string | undefined> = { ...process.env, ...(b.env ?? {}) };
  // resolve the key: the backend's named var first, then the provider's full env list.
  let keyName = b.apiKeyEnv;
  let key = keyName ? env[keyName] : undefined;
  if ((!key || key === "") && b.service) {
    const resolved = orchestration.resolveApiKey(b.service, env);
    if (resolved) {
      keyName = resolved.env;
      key = resolved.key;
    }
  }
  // keychain fallback (CLI-028): only when NO env var resolved (env wins as explicit override).
  if ((!key || key === "") && b.service && deps.secretsGet) {
    const fromKeychain = await deps.secretsGet(secrets.SECRETS_SERVICE, `provider:${b.service}`);
    if (fromKeychain && fromKeychain !== "") {
      key = fromKeychain;
      keyName = keyName ?? `keychain:provider:${b.service}`;
    }
  }
  if (!key || key === "") {
    const hint = keyName ?? `${(b.service ?? "provider").toUpperCase()}_API_KEY`;
    throw new Error(
      `${b.service ?? "api"}: no API key — set ${hint} (own-key commercial API, automation allowed within terms)`,
    );
  }
  const contextWindow =
    ai.contextLenForModel(pricingTable(), b.model ?? b.service ?? "") ?? DEFAULT_CONTEXT_WINDOW;
  const endpoint: AiEndpoint = {
    id: `cloud:${b.service ?? "api"}:${b.model ?? "default"}`,
    baseUrl: b.baseUrl,
    locality: "cloud",
    apiKeyRef: `env:${keyName}`,
    contextWindow,
    supportsTools: false,
    ...(b.model ? { model: b.model } : {}),
  };
  const fixedKey = key;
  const makeClient = deps.aiClientFactory ?? createAiClient;
  const client = makeClient(
    endpoint,
    { neverSendToCloud: false },
    { resolveKey: async () => fixedKey },
  );
  const messages: Msg[] = [{ role: "user", content: req.prompt }];
  let usage: SseTokenUsage | undefined;
  const text = await collectAnswer(client.chat(messages), endpoint, (u) => {
    usage = ai.mergeWireUsage(usage, u);
  });
  return { text: text.trim() || "(no output)", ...priceCall(endpoint.model ?? "", usage, text) };
}

/**
 * Price one API call so the run budget can actually count it.
 *
 * This is the missing half of `RunLimits.maxCostUsd`. `Coordinator` has always called
 * `budget.addCost(out.costUsd)` — but every invoker returned a bare `{ text }`, so `costUsd` was
 * never a number, the counter never moved, and `overBudget()` compared a permanent 0 against the
 * cap. The ceiling read as enforced and enforced nothing. Both halves or neither.
 *
 * Prefers the provider's own usage frame; falls back to the same chars/4 estimate the session
 * accounting uses. An unpriced model yields NO cost rather than 0 — see below.
 */
function priceCall(
  model: string,
  usage: SseTokenUsage | undefined,
  text: string,
): { costUsd?: number } {
  const p = ai.priceForModel(pricingTable(), model);
  // An unknown model has no price. Reporting 0 would be a measurement ("this cost nothing");
  // reporting nothing lets the counter stay honest about what it does not know.
  if (!p) return {};
  const inTok = usage?.inputTokens ?? 0;
  const outTok = usage?.outputTokens ?? Math.ceil(text.length / 4);
  return {
    costUsd: (inTok / 1_000_000) * p.inputUsdPerMTok + (outTok / 1_000_000) * p.outputUsdPerMTok,
  };
}

/** Run a prompt through the engine's local chat (`chat --local <model> <prompt>`). */
async function engineChat(req: InvokeRequest, deps: InvokerDeps): Promise<string> {
  const model = req.agent.backend.model ?? "default";
  // the runner that serves this model (by the session endpoint's port), so an LM Studio model
  // is not sent to the engine's default (Ollama); `--` keeps a prompt starting with "-" a prompt
  const runner = deps.endpoint ? ai.runnerIdForUrl(deps.endpoint.baseUrl) : undefined;
  const env = (await deps.client.runPrometheus([
    "chat",
    "--local",
    model,
    ...(runner ? ["--runner", runner] : []),
    "--",
    req.prompt,
  ])) as unknown as {
    ok?: boolean;
    response?: string;
    error?: string;
  };
  if (env.ok === false) throw new Error(env.error ?? `local chat (${model}) failed`);
  return (env.response ?? "").trim() || "(no output)";
}

/** Run a vendor CLI headlessly as an agent. */
async function cliInvoke(
  req: InvokeRequest,
  deps: InvokerDeps,
  spawn: SpawnCapture,
  which: (bin: string) => boolean,
): Promise<InvokeResult> {
  const service = req.agent.backend.service;
  if (!service) throw new Error(`agent "${req.agent.name}" is a cli backend with no service`);
  const local = localTargetOf(req.agent, deps);
  if (req.agent.backend.local && !local) {
    throw new Error(
      `${service}: a LOCAL agent needs a local model server — none was detected (start Ollama or LM Studio, or give the agent a baseUrl)`,
    );
  }
  const launch = launchFor(
    service,
    redactSecrets(req.prompt),
    local?.model ?? req.agent.backend.model,
    mergedRecipes(deps.recipes),
    local ? { baseUrl: local.baseUrl } : undefined,
  );
  if (!launch) {
    throw new Error(
      local
        ? `${service} has no local-model mode Prometheus can drive (local-capable: ${localCapableServices(mergedRecipes(deps.recipes)).join(", ")})`
        : `no headless recipe for service "${service}"`,
    );
  }

  // refuse agent-supplied force flags (human-typed only).
  if (launch.args.some((a) => a === "--force" || a === "--force-unsafe"))
    throw new Error(`${service}: refusing to launch with --force (human-typed only)`);

  // resolve the binary (primary then fallbacks).
  const candidates = [launch.bin, ...launch.binFallbacks];
  const found = candidates.find((c) => which(c));
  // found only in a vendor dir (`~/.opencode/bin`, not on this process's PATH): spawn it by path
  // (only with the real lookup: an injected `which` owns the answer, as tests do)
  const bin = found && !deps.which && !onPath(found) ? (vendorBin(found) ?? found) : found;
  if (!bin)
    throw new Error(
      `${service}: none of [${candidates.join(", ")}] found on PATH — install + log it in first (try \`prometheus chat --cli ${service} --open\`)`,
    );

  // nemesis gate BEFORE the first spawn (the engine still gates any fetch/install the CLI does).
  if (deps.gate) {
    const g = await deps.gate(bin, launch.args);
    if (!g.ok) throw new Error(`nemesis blocked ${bin}: ${g.reason ?? "denied"}`);
  }

  // The machine-wide 90% CPU/RAM ceiling — the same one already refused on a cold Ollama/LM
  // Studio start. A fresh agent-CLI subprocess (claude/codex/opencode/hermes/…) is exactly the
  // kind of NEW load this exists to block when the machine is already under heavy pressure;
  // checked once per call, not per retry attempt (a retry re-uses an already-accepted decision).
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const maxRetries = deps.maxRetries ?? 2;

  /**
   * WAIT for the ceiling to clear, then refuse in RETRYABLE terms.
   *
   * A single 120 ms sample was read once and turned straight into a hard error, and that error's
   * wording ("refused — …") matches none of `isTransientBackendError`'s patterns — so the
   * coordinator broke the turn loop with `[backend error] …` and the agent was simply lost. On a
   * swarm run that is self-inflicted: `defaultProviderLimit` admits several concurrent agent CLIs
   * per service, so agents 1-3 saturating the machine made the guard refuse agent 4 — the guard
   * reading the swarm's own load and killing the rest of the swarm, while telling the user to
   * "free resources and retry" when nothing would.
   *
   * Re-sampling with backoff turns the one noisy reading into a sustained one (the same principle
   * as `nextCriticalStreak`), and "temporarily unavailable" is the token the coordinator's
   * `isTransientBackendError` recognises, so a genuinely loaded machine gets re-issued instead of
   * failing the agent outright.
   *
   * Deliberately its OWN small budget rather than sharing `maxRetries`: those attempts exist for
   * spawn outcomes, and this wait happens before anything has been spawned at all.
   */
  const launchGuardFn = deps.launchGuardFn ?? sampleLaunchGuard;
  const guardWaits = deps.launchGuardWaits ?? 3;
  let guardVerdict = launchGuardVerdict(await launchGuardFn());
  for (let i = 0; !guardVerdict.ok && i < guardWaits; i++) {
    await sleep(Math.round(random() * Math.min(8000, 500 * 2 ** i)));
    guardVerdict = launchGuardVerdict(await launchGuardFn());
  }
  if (!guardVerdict.ok) {
    throw new Error(`${service}: temporarily unavailable — ${guardVerdict.reason}`);
  }
  // rate-limits + transient crashes are RETRYABLE with full-jitter backoff; an auth error
  // or a timeout is NOT (retrying would just re-hit the lockout / re-burn the budget).
  const retryable = new Set(["rate_limited", "crashed"]);

  let lastDetail = "";
  let lastOutcome = "";
  const env = { ...(launch.env ?? {}), ...(req.agent.backend.env ?? {}) };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // a retry is a NEW launch: re-check the ceiling — the RAM guard SIGTERMs agents under
    // pressure, which reads as "crashed" (retryable), and relaunching into the same pressure
    // just gets the agent killed again while the model's weights stay resident
    if (attempt > 0) {
      const again = launchGuardVerdict(await launchGuardFn());
      if (!again.ok) throw new Error(`${service}: temporarily unavailable — ${again.reason}`);
    }
    const result = await spawn(bin, {
      args: launch.args,
      ...(launch.stdin !== undefined ? { stdin: launch.stdin } : {}),
      timeoutMs: launch.timeoutMs,
      // A local model prints NOTHING while it loads (20 GB can take minutes) or while it waits
      // behind another agent on the same server; the 90 s no-output timer killed it as a
      // non-retryable "timeout" and the agent was lost. The run's own hard timeout still holds.
      ...(local ? { idleMs: launch.timeoutMs } : {}),
      ...(deps.cwd ? { cwd: deps.cwd } : {}),
      // per-agent env ADDED to the child (a local wiring, a dedicated key) — never patches the CLI.
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
    if (result.outcome === "ok" || result.outcome === "empty") {
      return { text: result.stdout.trim() || "(no output)" };
    }
    lastOutcome = result.outcome;
    lastDetail = (result.stderr || result.stdout).split("\n").slice(0, 3).join(" ").slice(0, 300);
    if (!retryable.has(result.outcome) || attempt === maxRetries) break;
    // full-jitter exponential backoff: random * min(8s, 500ms·2^attempt).
    await sleep(Math.round(random() * Math.min(8000, 500 * 2 ** attempt)));
  }
  throw new Error(`${service} ${lastOutcome}: ${lastDetail}`);
}

/**
 * Where a CLI agent's LOCAL model lives: its own `baseUrl`, else the session's local endpoint.
 * Only for an agent marked `local` (or one given a local `baseUrl`): a bare `opencode:<model>`
 * is the CLI's own provider/model and goes through its own login.
 */
function localTargetOf(
  agent: AgentSpec,
  deps: InvokerDeps,
): { baseUrl: string; model: string } | undefined {
  const b = agent.backend;
  const ownLocal = b.baseUrl && ai.isLocalUrl(b.baseUrl) ? b.baseUrl : undefined;
  if (!b.local && !ownLocal) return undefined;
  const session = deps.endpoint?.locality === "local" ? deps.endpoint : undefined;
  const baseUrl = b.baseUrl ?? session?.baseUrl;
  const model = b.model ?? session?.model;
  return baseUrl && model ? { baseUrl, model } : undefined;
}

/** The model server an agent's inference lands on, for the one-at-a-time rule; else null. */
function serverKeyOf(agent: AgentSpec, deps: InvokerDeps): string | null {
  const b = agent.backend;
  let url: string | undefined;
  if (b.kind === "cli") url = localTargetOf(agent, deps)?.baseUrl;
  else if (b.kind === "local") url = b.baseUrl ?? deps.endpoint?.baseUrl;
  else if (b.kind === "engine-chat" || b.kind === "in-process") return "server:engine-local";
  if (!url) return b.kind === "local" ? "server:engine-local" : null;
  try {
    return `server:${new URL(url).host}`;
  } catch {
    return `server:${url}`;
  }
}

/** Merge a partial recipe override over the shipped recipes (so the base set is kept). */
function mergedRecipes(over?: Record<string, CliRecipe>): Record<string, CliRecipe> {
  return over ? { ...CLI_RECIPES, ...over } : { ...CLI_RECIPES };
}

const quoteArg = (a: string): string => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/**
 * The EXACT standalone command Prometheus will run for an agent (for `/demos probe`) —
 * so the user can confirm it's invoking claude/codex/gemini precisely as they would
 * themselves, with no modification to the CLI's own mechanics. Pure (no spawn).
 */
export function probeLaunch(
  agent: AgentSpec,
  recipes?: Record<string, CliRecipe>,
): { kind: string; service?: string; command: string } {
  const b = agent.backend;
  if (b.kind === "cli" && b.service) {
    const local = b.local ? { baseUrl: b.baseUrl ?? "<the detected local server>" } : undefined;
    const model = b.model ?? (local ? "<the session's local model>" : undefined);
    const l = launchFor(b.service, "<your prompt>", model, mergedRecipes(recipes), local);
    if (!l) {
      return {
        kind: "cli",
        service: b.service,
        command: local
          ? `(${b.service} has no local-model mode — local-capable: ${localCapableServices(mergedRecipes(recipes)).join(", ")})`
          : `(no recipe for "${b.service}")`,
      };
    }
    // the env a local wiring adds is shown by NAME (its value is a generated config, not a secret)
    const envPrefix = Object.keys(l.env ?? {})
      .map((k) => `${k}=…`)
      .join(" ");
    return {
      kind: "cli",
      service: b.service,
      command: `${envPrefix ? `${envPrefix} ` : ""}${l.bin} ${l.args.map(quoteArg).join(" ")}`,
    };
  }
  if (b.kind === "local")
    return {
      kind: "local",
      command: `local model ${b.model ?? "default"} @ ${b.baseUrl ?? "detected endpoint"}`,
    };
  if (b.kind === "api")
    return {
      kind: "api",
      ...(b.service ? { service: b.service } : {}),
      command: `POST ${b.baseUrl ?? "<baseUrl>"}/chat/completions  model=${b.model ?? "default"}  (key: $${b.apiKeyEnv ?? "API_KEY"})`,
    };
  if (b.kind === "engine-chat" || b.kind === "in-process")
    return { kind: b.kind, command: `prometheus chat --local ${b.model ?? "default"}` };
  return { kind: b.kind, command: "(no external process — dry-run backend)" };
}

/** Build the BackendInvoker the coordinator drives. */
export function makeInvoker(deps: InvokerDeps): BackendInvoker {
  const spawn = deps.spawn ?? makeSpawnCapture();
  const which = deps.which ?? defaultWhich;
  // a PER-SERVICE concurrency bulkhead so N parallel agents on one vendor can't 429 it.
  const sem = new KeyedSemaphore(deps.providerLimit ?? defaultProviderLimit);
  /**
   * ONE request at a time per LOCAL MODEL SERVER — every agent whose inference lands on it
   * (local, engine-chat, and opencode/hermes/aider driven against it) shares the slot.
   *
   * The per-service cap let 3 opencode + 3 hermes + any number of local agents hit one runner
   * at once with different models. Ollama (capped at one loaded model) then unloaded and
   * reloaded weights on every switch; LM Studio could hold several JIT models side by side.
   * Queued agents are not killed for silence (see `idleMs` in `cliInvoke`).
   */
  const servers = new KeyedSemaphore(() => deps.serverLimit ?? 1);
  const onServer = <T>(req: InvokeRequest, fn: () => Promise<T>): Promise<T> => {
    const key = serverKeyOf(req.agent, deps);
    return key ? servers.run(key, fn) : fn();
  };
  return async (req: InvokeRequest): Promise<InvokeResult> => {
    const kind = req.agent.backend.kind;
    switch (kind) {
      case "fake":
        return { text: fakeReply(req) };
      case "local":
        return { text: await onServer(req, () => localInvoke(req, deps)) };
      case "engine-chat":
      case "in-process":
        return { text: await onServer(req, () => engineChat(req, deps)) };
      case "cli":
        // serialize per provider (each vendor has its own rate limit), and per local server.
        return sem.run(req.agent.backend.service ?? "cli", () =>
          onServer(req, () => cliInvoke(req, deps, spawn, which)),
        );
      case "api":
        // own-key OpenAI-compatible API — bulkhead per provider (its own rate limit). The
        // result is returned WHOLE, `costUsd` included: dropping it here is what left the run
        // budget counting zero on the one lane that spends real money.
        return sem.run(req.agent.backend.service ?? "api", () => apiInvoke(req, deps));
      default:
        throw new Error(`unknown backend kind "${kind}"`);
    }
  };
}
