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
import type { EngineClient } from "@prometheus/engine-bridge";

import { KeyedSemaphore, defaultProviderLimit } from "./concurrency.js";
import { CLI_RECIPES, type CliRecipe, launchFor } from "./recipes.js";
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
}

/** Default PATH lookup: is `bin` an executable on $PATH? */
function defaultWhich(bin: string): boolean {
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
  let text = "";
  for await (const chunk of client.chat(messages)) {
    if (chunk.delta) text += chunk.delta;
    if (chunk.done || text.length > MAX_STREAM_CHARS) break;
  }
  return text.trim();
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
  let text = "";
  let usage: SseTokenUsage | undefined;
  for await (const chunk of client.chat(messages)) {
    if (chunk.delta) text += chunk.delta;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.done || text.length > MAX_STREAM_CHARS) break;
  }
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
  const env = (await deps.client.runPrometheus([
    "chat",
    "--local",
    model,
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
  const launch = launchFor(
    service,
    redactSecrets(req.prompt),
    req.agent.backend.model,
    mergedRecipes(deps.recipes),
  );
  if (!launch) throw new Error(`no headless recipe for service "${service}"`);

  // refuse agent-supplied force flags (human-typed only).
  if (launch.args.some((a) => a === "--force" || a === "--force-unsafe"))
    throw new Error(`${service}: refusing to launch with --force (human-typed only)`);

  // resolve the binary (primary then fallbacks).
  const candidates = [launch.bin, ...launch.binFallbacks];
  const bin = candidates.find((c) => which(c));
  if (!bin)
    throw new Error(
      `${service}: none of [${candidates.join(", ")}] found on PATH — install + log it in first (try \`prometheus chat --cli ${service} --open\`)`,
    );

  // nemesis gate BEFORE the first spawn (the engine still gates any fetch/install the CLI does).
  if (deps.gate) {
    const g = await deps.gate(bin, launch.args);
    if (!g.ok) throw new Error(`nemesis blocked ${bin}: ${g.reason ?? "denied"}`);
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const maxRetries = deps.maxRetries ?? 2;
  // rate-limits + transient crashes are RETRYABLE with full-jitter backoff; an auth error
  // or a timeout is NOT (retrying would just re-hit the lockout / re-burn the budget).
  const retryable = new Set(["rate_limited", "crashed"]);

  let lastDetail = "";
  let lastOutcome = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await spawn(bin, {
      args: launch.args,
      ...(launch.stdin !== undefined ? { stdin: launch.stdin } : {}),
      timeoutMs: launch.timeoutMs,
      ...(deps.cwd ? { cwd: deps.cwd } : {}),
      // per-agent env ADDED to the child (e.g. a dedicated key) — never patches the CLI.
      ...(req.agent.backend.env ? { env: req.agent.backend.env } : {}),
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
    const l = launchFor(b.service, "<your prompt>", b.model, mergedRecipes(recipes));
    if (!l) return { kind: "cli", service: b.service, command: `(no recipe for "${b.service}")` };
    return {
      kind: "cli",
      service: b.service,
      command: `${l.bin} ${l.args.map(quoteArg).join(" ")}`,
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
  return async (req: InvokeRequest): Promise<InvokeResult> => {
    const kind = req.agent.backend.kind;
    switch (kind) {
      case "fake":
        return { text: fakeReply(req) };
      case "local":
        return { text: await localInvoke(req, deps) };
      case "engine-chat":
      case "in-process":
        return { text: await engineChat(req, deps) };
      case "cli":
        // serialize per provider (each vendor has its own rate limit).
        return sem.run(req.agent.backend.service ?? "cli", () =>
          cliInvoke(req, deps, spawn, which),
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
