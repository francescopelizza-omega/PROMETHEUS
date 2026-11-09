import { randomBytes } from "node:crypto";
// SPDX-License-Identifier: MIT
// Copyright 2026 Francesco Pelizza
/**
 * session/models-host.ts — the IO behind `/models`, built ONCE for both interactive hosts.
 *
 * The readline host (`host.ts`) and the TUI bridge (`tui/session-bridge.ts`) have drifted every
 * time a feature was wired into each by hand (`adoptEndpoint`, `runHostSetup` and the model
 * picker are all copy-pasted between them, and the bridge says so in a comment). So the picker's
 * IO lives here, and each host passes in only the few closures that genuinely differ: how it
 * adopts an endpoint, and the mutable lists it already owns.
 *
 * Everything that decides WHAT to show or do is pure and lives in core
 * (`ai/model-catalog/wizard.ts`); this file only measures the machine and performs the steps.
 */
import {
  type Dirent,
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { delimiter, dirname, join } from "node:path";

import { type AiEndpoint, type FetchLike, ai, orchestration, secrets } from "@prometheus/core";
import { fetchOllamaTags, pullModel } from "@prometheus/core/updates-live";
import {
  type EngineClient,
  execCapture,
  listenersOnPort,
  localMemorySnapshot,
  runPrometheus,
  signalPid,
  startModelServer,
  vendorBin,
} from "@prometheus/engine-bridge";

import { freeDiskByStore, freeDiskForModels } from "../home.js";
import { createCliSecretsStore } from "../secrets-backend.js";
import { pullWithProgress } from "../updates/model-actions-cmd.js";
import { loadDefaultServer } from "./default-server-setting.js";
import { type Backends, buildLocalEndpoint } from "./onboarding.js";

export type AdoptResult = { ok: true; label: string } | { ok: false; reason: string };

/** A gated step that did not pass. `needsConfirm` = nemesis WARN: the user may accept it with
 *  a typed confirmation (the step is then re-run with `force`); anything else is a refusal. */
export type GatedFailure = {
  ok: false;
  reason: string;
  needsConfirm?: boolean;
  findings?: string[];
};
export type GatedResult = { ok: true } | GatedFailure;

export interface ModelsHost {
  /** everything a wizard step needs, measured now. */
  context(): Promise<ai.PrepareContext>;
  /** verify a key against the provider, then store it in the OS keychain. */
  connectKey(
    providerId: string,
    key: string,
  ): Promise<{ ok: true; live: string[] } | { ok: false; reason: string }>;
  /** the provider's live model list (empty when unknown or unreachable). */
  liveModels(providerId: string): Promise<string[]>;
  /** install Ollama through the engine's nemesis-gated installer. */
  installOllama(): Promise<{ ok: boolean; reason?: string }>;
  /** start a stopped Ollama. */
  startOllama(): Promise<{ ok: boolean; reason?: string }>;
  /** pull a tag, reporting progress lines. The pulled blobs are nemesis-scanned before ok.
   *  A nemesis WARN comes back `needsConfirm` with its findings; `force` (after the user
   *  typed a confirmation) re-runs only the gate, accepting that WARN. A BLOCK is final. */
  pull(tag: string, show: (line: string) => void, opts?: { force?: boolean }): Promise<GatedResult>;
  /** remove a pulled model the user REFUSED after a nemesis WARN, so a later "use" — which sees
   *  it as installed and would not pull (or scan) again — cannot adopt it. Optional seam. */
  discardOllama?(tag: string): Promise<{ ok: boolean; reason?: string }>;
  /** nemesis over an installed Ollama tag (`modelhub ollama-gate`; a ledger hit is cheap).
   *  Run before ANY local Ollama pick is adopted: a pull whose scan errored used to leave the
   *  model on disk, and the next pick saw it "installed" and adopted it unscanned. */
  verifyOllama?(tag: string): Promise<GatedResult>;
  /** download a GGUF from Hugging Face through the gated path (stage → sha256 → nemesis →
   *  library); resolves to the admitted file. Optional: hosts without the sidecar omit it. */
  fetchGguf?(
    id: string,
    repo: string,
    file: string,
    show: (line: string) => void,
    opts?: { force?: boolean; place?: ai.ModelPlace },
  ): Promise<{ ok: true; path: string } | GatedFailure>;
  /** which runtimes / local-model agents are installed here (modelhub `runtimes`). */
  runtimeStatus?(): Promise<
    { id: string; installed: string | null; auto: string | null; manual?: string | null }[]
  >;
  /** install one runtime / agent through its official channel (modelhub `install-runtime`). */
  installRuntime?(
    id: string,
    show: (line: string) => void,
    opts?: { acceptWarn?: boolean },
  ): Promise<
    | { ok: true }
    | { ok: false; reason: string; manual?: string; needsConfirm?: boolean; findings?: string[] }
  >;
  /**
   * start llama-server on an ADMITTED GGUF (offline, alias = id) and wait until it answers.
   * `stream`: the model is larger than RAM — weights stay memory-mapped and pageable (no GPU
   * layers for a dense model, experts on the CPU for a MoE) so the kernel pages them from disk.
   */
  serveGguf?(
    id: string,
    path: string,
    ctx: number,
    opts?: { stream?: boolean; moe?: boolean },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** download a safetensors / MLX snapshot through the gated path; resolves to the admitted dir. */
  fetchSnapshot?(
    id: string,
    repo: string,
    include: readonly string[],
    show: (line: string) => void,
    opts?: { force?: boolean; place?: ai.ModelPlace },
  ): Promise<{ ok: true; path: string } | GatedFailure>;
  /** start MLX-LM's server on an admitted MLX directory and resolve the model id it lists. */
  serveMlx?(
    id: string,
    dir: string,
  ): Promise<{ ok: true; model: string } | { ok: false; reason: string }>;
  /** start Prometheus's AirLLM server on an admitted safetensors directory. */
  serveStream?(id: string, dir: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** `coli import` the admitted GGUF (link mode), then `coli serve` it with a session key. */
  serveColibri?(
    id: string,
    gguf: string,
    ctx: number,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** link an admitted GGUF (every shard) or MLX directory into LM Studio's models folder. */
  linkLmstudio?(
    id: string,
    path: string,
    format?: "gguf" | "mlx",
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** start LM Studio's server and resolve the model key it lists for `id`. */
  startLmstudio?(id: string): Promise<{ ok: true; model: string } | { ok: false; reason: string }>;
  /** serve an admitted GGUF through Ollama under `tag`. */
  importToOllama?(
    id: string,
    path: string,
  ): Promise<{ ok: true; tag: string } | { ok: false; reason: string }>;
  /** point the session at a pick. `model` overrides the catalogued id (a live-list rename). */
  adopt(ref: ai.WizardRef, model?: string): Promise<AdoptResult>;
  /**
   * The endpoint for a REMEMBERED pick, if it is usable right now without asking anything —
   * for session start. Undefined when the pick needs a download, a key, or a stopped runner.
   */
  restore(
    ref: string | undefined,
  ):
    | { endpoint: AiEndpoint; model: { provider: string; modelId: string }; label: string }
    | undefined;
  /** A one-line nudge for a remembered pick `restore` would not bring back on its own. */
  restoreHint(ref: string | undefined): string | undefined;
  /** the rotation's members on this machine right now. */
  rotationMembers(): ai.RotationMember[];
  /** remember the pick for the next session. */
  saveChoice(ref: string): void;
}

export interface ModelsHostDeps {
  home: string;
  env?: Record<string, string | undefined>;
  client?: EngineClient;
  /** the host's own runner snapshot — updated in place after an install or pull. */
  backends: Backends;
  /** the host's own cloud endpoint list — refreshed in place after a key is stored. */
  cloudEndpoints: ai.CloudEndpointInfo[];
  /** provider ids with a keychain key — updated in place after a key is stored. */
  keychainProviders: Set<string>;
  /** adopt an endpoint the way THIS host does (tune the footer, then rebind + measure). */
  adoptEndpoint: (next: AiEndpoint, model: { provider: string; modelId: string }) => Promise<void>;
  activeId: () => string | undefined;
  fetch?: FetchLike;
  secretsStore?: secrets.SecretsStore;
  /** injected machine numbers, for tests. */
  machine?: () => ai.MachineProfile;
  /**
   * Seams over the three calls that touch a real Ollama, so a test never reaches the daemon
   * (CLAUDE.md §2.3: suites are stubbed by injection, never by an env flag).
   */
  ollamaTags?: () => Promise<{ name: string }[]>;
  ensureOllama?: () => Promise<{ started: boolean; reason?: string }>;
  pullTag?: (tag: string, show: (line: string) => void) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Run one modelhub sidecar verb (`prometheus sidecar modelhub <args>`) and return its JSON
   * envelope, streaming its progress lines to `show`. Seam for tests; the default goes through
   * the engine, which is the only thing allowed to spawn the sidecar (C5).
   */
  modelhub?: (args: string[], show: (line: string) => void) => Promise<Record<string, unknown>>;
  /**
   * Move weights an older install left inside Prometheus's library into each runtime's own
   * store when the session starts (only when there is something to move — checked here
   * without spawning anything). The real hosts set it; tests leave it off.
   */
  migrateOnStart?: boolean;
  /** `lms ls --json` rows (key + folder path); seam for tests. */
  lmsList?: () => Promise<ai.LmStudioListed[]>;
  /** the command line of whatever listens on `port` (lsof → ps); seam for tests. */
  listenerArgs?: (port: number) => Promise<string | undefined>;
  /** liveness / stop of a server this host started; seams for tests. With a faked
   *  `startServer` the pid is fictional, so the defaults never touch a real process. */
  processAlive?: (pid: number) => boolean;
  stopServer?: (pid: number) => void;
  /** seam over engine-bridge `startModelServer` (detached runtime start). */
  startServer?: (
    argv: readonly string[],
    opts?: { env?: Readonly<Record<string, string>> },
  ) => { ok: boolean; pid?: number; error?: string };
  /** seam for the readiness poll's clock (tests pass a fast one). */
  pollMs?: number;
  /** seam over the `/v1/models` readiness probe of a local runtime (metadata only). */
  listLocalModels?: (base: string, key?: string) => Promise<string[] | null>;
  /** is a binary on PATH (default: a PATH scan). */
  onPath?: (bin: string) => boolean;
  /**
   * Print one line to the user. When set, the endless free rotation's switches are announced:
   * a silent move from a 120B model to a 70B one reads as the model "getting worse" for no
   * reason the user could find.
   */
  notify?: (line: string) => void;
}

/** The one-line notice for a rotation switch. */
export function rotationNotice(e: ai.RotationEvent): string {
  return e.from
    ? `↻ free rotation: ${e.from.label} ${e.reason ? `(${e.reason}) ` : ""}→ now ${e.to.label}`
    : `↻ free rotation: answering from ${e.to.label}`;
}

const OLLAMA_BASE = "http://localhost:11434/v1";
/** where Prometheus starts / expects the non-default runtimes (it always passes the port). */
const RUNTIME_BASE: Record<ai.ServeRuntime, string> = {
  ollama: OLLAMA_BASE,
  llamacpp: "http://127.0.0.1:8080/v1",
  lmstudio: "http://localhost:1234/v1",
  mlx: "http://127.0.0.1:8090/v1",
  // llama.cpp streaming from SSD is llama-server too, on the same port
  "llamacpp-stream": "http://127.0.0.1:8080/v1",
  airllm: "http://127.0.0.1:8094/v1",
  colibri: "http://127.0.0.1:8096/v1",
};

/** The runner name a runtime is tracked under (`liveRunners`, the footer, `/ram`). */
export function runnerNameFor(rt: ai.ServeRuntime | undefined): string {
  if (!rt) return "ollama";
  return rt === "llamacpp-stream" ? "llamacpp" : rt;
}

/**
 * The env var the colibri session key lives in (an `env:` key ref the agent resolves).
 * Credential-shaped on purpose (`…_API_KEY`): `agentChildEnv` strips such names, so a command
 * the agent runs (`printenv`) never sees it.
 */
export const COLIBRI_KEY_ENV = "PROMETHEUS_COLIBRI_API_KEY";

/** Is `bin` an executable on PATH? Sync and cheap — PATH has a dozen entries. */
function onPath(bin: string, env: Record<string, string | undefined>): boolean {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, bin + ext), fsConstants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

/**
 * The largest NVIDIA GPU's memory, or 0. Bounded: a hung driver must not stall `/models`. Spawns
 * through engine-bridge's `execCapture` — the one gateway allowed to start a child (C5).
 */
async function nvidiaVramBytes(env: Record<string, string | undefined>): Promise<number> {
  if (process.platform === "darwin" || !onPath("nvidia-smi", env)) return 0;
  const r = await execCapture(
    "nvidia-smi",
    ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
    { timeoutMs: 1500 },
  ).catch(() => null);
  if (!r || r.code !== 0) return 0;
  const mib = Math.max(0, ...r.stdout.split("\n").map((l) => Number(l.trim()) || 0));
  return mib * 1024 * 1024;
}

/** Where the pick is remembered between sessions. */
export function modelChoicePath(home: string): string {
  return join(home, "model-choice.json");
}

export function readModelChoice(home: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(modelChoicePath(home), "utf8")) as { ref?: unknown };
    return typeof j.ref === "string" ? j.ref : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The key LM Studio lists for a model Prometheus linked as `prometheus/<id>/<file>.gguf`. Exact
 * forms only — a substring match let `qwen3-8b` claim `qwen3-8b-instruct`.
 */
export function lmStudioKeyFor(
  models: readonly string[],
  id: string,
  placedKeys: readonly string[] = [],
): string | undefined {
  const want = id.toLowerCase();
  const placed = new Set(placedKeys.map((k) => k.toLowerCase()));
  return models.find((m) => {
    const k = m.toLowerCase();
    // only what Prometheus placed: the keys `lms ls` reports for the files under the model's
    // own repo folder (where stage-hf --place=lmstudio puts them), or the old linked form
    // `prometheus/<id>`. A model of the same name the user loaded into LM Studio themselves
    // never passed the gate, and must not be adopted as this pick.
    return placed.has(k) || k === `prometheus/${want}` || k.startsWith(`prometheus/${want}/`);
  });
}

/** The name a local catalogue pick is served under on its runtime (see `endpointFor`). */
function localServedTag(
  ref: Extract<ai.WizardRef, { section: "local" }>,
  listed: readonly string[],
): string | undefined {
  if (ref.runtime === "llamacpp" || ref.runtime === "llamacpp-stream") return ref.id;
  if (ref.runtime === "airllm" || ref.runtime === "colibri") return ref.id;
  if (ref.runtime === "lmstudio") return lmStudioKeyFor(listed, ref.id);
  if (ref.runtime === "mlx") return listed[0];
  const known = ai.findLocalModel(ref.id);
  return known ? ai.localOllamaTag(known) : undefined;
}

/** Does the gated library still hold weights (`<root>/<source>/<model>/…/*.gguf|safetensors`)? */
export function libraryHasWeights(root: string): boolean {
  const walk = (dir: string, depth: number): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // .stage, .quarantine, ledgers
      const p = join(dir, e.name);
      if (e.isFile() && /\.(gguf|safetensors)$/i.test(e.name) && depth >= 2) return true;
      if (e.isDirectory() && depth < 5 && walk(p, depth + 1)) return true;
    }
    return false;
  };
  // download leftovers in `.stage` count too: the startup sweep removes the stale ones
  const stage = join(root, ".stage");
  let staged = false;
  try {
    staged = readdirSync(stage).length > 0;
  } catch {
    staged = false;
  }
  return staged || walk(root, 0);
}

/** Is a single real process (pid > 1, never a broadcast form) still running? */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createModelsHost(deps: ModelsHostDeps): ModelsHost {
  const env = deps.env ?? process.env;
  const doFetch: FetchLike = deps.fetch ?? (fetch as unknown as FetchLike);
  let store: secrets.SecretsStore | undefined = deps.secretsStore;
  const secretsStore = (): secrets.SecretsStore => {
    store = store ?? createCliSecretsStore();
    return store;
  };
  const resolveKey = (ref: string): Promise<string> => {
    const parsed = ai.parseKeyRef(ref);
    if (!parsed) return Promise.reject(new Error(`bad key ref ${ref}`));
    if (parsed.kind === "env") return Promise.resolve(env[parsed.envVar] ?? "");
    return secretsStore()
      .get(secrets.SECRETS_SERVICE, parsed.account)
      .then((v) => v ?? "");
  };

  const ollamaTags = deps.ollamaTags ?? (() => fetchOllamaTags());
  const ensureOllama = deps.ensureOllama ?? (() => ai.ensureOllamaRunning());
  const pullTag =
    deps.pullTag ??
    ((tag: string, show: (line: string) => void) =>
      pullWithProgress(tag, { pull: pullModel, show }));
  const hasBin = deps.onPath ?? ((bin: string) => onPath(bin, env));
  const modelhub =
    deps.modelhub ??
    ((args: string[], show: (line: string) => void) =>
      runPrometheus(["sidecar", "modelhub", ...args], {
        // a multi-GB download or a scan of a 400 GB model takes a while
        timeoutMs: 12 * 60 * 60 * 1000,
        onStderr: (line: string) => {
          try {
            const ev = JSON.parse(line) as { event?: string; status?: string; pct?: number };
            if (ev.event === "progress" && ev.status) {
              show(typeof ev.pct === "number" ? `${ev.pct}% ${ev.status}` : ev.status);
            }
          } catch {
            /* not a progress line */
          }
        },
      }) as Promise<Record<string, unknown>>);
  if (deps.migrateOnStart) {
    const libRoot =
      env.PROMETHEUS_MODELS_HOME?.trim() || join(os.homedir(), ".prometheus", "models");
    if (libraryHasWeights(libRoot)) {
      // fire-and-forget: a slow cross-volume move must never delay the prompt
      void modelhub(["migrate-library"], () => undefined).catch(() => undefined);
    }
  }
  // The sidecar says WHY in different keys: `error` (a failure), `message` (an admit decision:
  // "nemesis WARN — review…"), `hint`. Only `error` used to be read, so a WARN surfaced as the
  // fallback "the download was not admitted", with nothing to review.
  const envelopeError = (r: Record<string, unknown>, fallback: string): string => {
    const first = [r.error, r.message].find((x) => typeof x === "string" && x) as
      | string
      | undefined;
    const hint = typeof r.hint === "string" && r.hint ? ` — ${r.hint}` : "";
    return `${first ?? fallback}${hint}`;
  };
  /** the reasons nemesis gave, wherever the envelope carries them (admit vs ollama-gate). */
  const findingsOf = (r: Record<string, unknown>): string[] => {
    const out: string[] = [];
    const gate = r.gate as { reasons?: unknown } | undefined;
    if (gate && Array.isArray(gate.reasons)) out.push(...gate.reasons.map(String));
    if (Array.isArray(r.scans))
      for (const sc of r.scans as { reasons?: unknown }[])
        if (Array.isArray(sc?.reasons)) out.push(...sc.reasons.map(String));
    if (Array.isArray(r.model_findings)) out.push(...r.model_findings.map(String));
    return [...new Set(out)].slice(0, 8);
  };
  const gatedFailure = (r: Record<string, unknown>, fallback: string): GatedFailure => ({
    ok: false,
    reason: envelopeError(r, fallback),
    ...(r.needs_confirm === true ? { needsConfirm: true } : {}),
    ...(findingsOf(r).length ? { findings: findingsOf(r) } : {}),
  });
  /** the model ids an OpenAI-compatible server lists, or null when it does not answer. */
  const listModels =
    deps.listLocalModels ??
    (async (base: string, key?: string): Promise<string[] | null> => {
      try {
        const res = await fetch(`${base}/models`, {
          signal: AbortSignal.timeout(3000),
          ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { data?: { id?: unknown }[] };
        return Array.isArray(body?.data)
          ? body.data.map((d) => String(d?.id ?? "")).filter(Boolean)
          : [];
      } catch {
        return null;
      }
    });
  /** poll until the server lists what we need (a metadata route — it never loads weights). */
  const waitForModels = async (
    base: string,
    ready: (models: string[]) => boolean | Promise<boolean>,
    key?: string,
    pid?: number,
  ): Promise<boolean> => {
    const step = deps.pollMs ?? 1000;
    for (let waited = 0; waited <= 180_000; waited += step) {
      const models = await listModels(base, key);
      if (models && (await ready(models))) return true;
      // a server that already exited will never answer: stop waiting now, not in 3 minutes
      if (pid !== undefined && !alive(pid)) return false;
      await new Promise((r) => setTimeout(r, step));
    }
    return false;
  };
  const upsertRunner = (name: string, baseUrl: string, model: string): void => {
    let runner = deps.backends.liveRunners.find((x) => x.name === name);
    if (!runner) {
      runner = { name, baseUrl, models: [] };
      deps.backends.liveRunners.push(runner);
    }
    if (!runner.models.includes(model)) runner.models.push(model);
  };

  const keyFor = (providerId: string): ai.KeySource | undefined => {
    if (orchestration.resolveApiKey(providerId, env)) return "env";
    return deps.keychainProviders.has(providerId) ? "keychain" : undefined;
  };

  const rotationMembers = (): ai.RotationMember[] =>
    ai.rotationMembers({ env, hasKeychainKey: (id) => deps.keychainProviders.has(id) });

  const refreshCloud = (): void => {
    const next = ai.discoverCloudEndpoints({
      env,
      hasKeychainKey: (id) => deps.keychainProviders.has(id),
    });
    deps.cloudEndpoints.splice(0, deps.cloudEndpoints.length, ...next);
  };

  const machine = async (): Promise<ai.MachineProfile> => {
    if (deps.machine) return deps.machine();
    const [vram, mem] = await Promise.all([
      nvidiaVramBytes(env),
      localMemorySnapshot().catch(() => undefined),
    ]);
    // the free disk where a download will land: the runtimes' own stores (Prometheus has none)
    const di = freeDiskForModels(env);
    const m = ai.machineFromHost({
      totalMemBytes: os.totalmem(),
      platform: process.platform,
      arch: process.arch,
      ...(vram > 0 ? { vramBytes: vram } : {}),
      ...(di ? { freeDiskBytes: di.freeBytes } : {}),
      freeDiskBytesByStore: freeDiskByStore(env),
    });
    // shown in the picker, never used for the fit (that is decided on the machine's total RAM)
    return mem ? { ...m, freeRamGb: Math.round((mem.availableBytes / 1024 ** 3) * 10) / 10 } : m;
  };

  const fetchProviderModels = async (providerId: string, key: string): Promise<string[] | null> => {
    const p = orchestration.apiProviderFor(providerId);
    if (!p) return null;
    const tier = ai.freeTierFor(providerId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const wire = ai.selectWire(ai.runtimeFromBaseUrl(p.baseUrl, "cloud"));
      const base = p.baseUrl.replace(/\/+$/, "");
      const res = await doFetch(`${base}${ai.modelsPathFor(p)}`, {
        method: "GET",
        headers: { ...(key ? wire.headers(key) : {}), Accept: "application/json" },
        body: undefined as unknown as string,
        signal: controller.signal,
      });
      if (!res.ok) {
        // A keyless tier's /models can still be public; a 401 there is not a verdict on a key.
        return tier?.keyless && !key ? [] : null;
      }
      const body = (await res
        .text()
        .then((t) => JSON.parse(t))
        .catch(() => ({}))) as unknown;
      return ai.modelsFromOpenAiList(body);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  type Resolved = {
    endpoint: AiEndpoint;
    model: { provider: string; modelId: string };
    label: string;
  };
  /** The endpoint a pick resolves to on THIS machine right now, without any IO. */
  const endpointFor = (ref: ai.WizardRef, model?: string): Resolved | { reason: string } => {
    if (ref.section === "served" || ref.section === "local") {
      const rt = ref.section === "local" ? ref.runtime : undefined;
      const runnerName = ref.section === "served" ? ref.runner : runnerNameFor(rt);
      const listed = deps.backends.liveRunners.find((x) => x.name === runnerName)?.models ?? [];
      const tag =
        ref.section === "served" ? ref.model : (model ?? localServedTag(ref, listed) ?? ref.id);
      const runner = deps.backends.liveRunners.find((r) => r.name === runnerName);
      const built = buildLocalEndpoint({
        name: runnerName,
        baseUrl: runner?.baseUrl ?? (rt ? RUNTIME_BASE[rt] : OLLAMA_BASE),
        models: [tag],
      });
      // AirLLM's shim and colibri's gateway take no native tool calls: the agent drives tools
      // through its text protocol. colibri answers only with the session's key.
      const endpoint: AiEndpoint =
        runnerName === "airllm" || runnerName === "colibri"
          ? {
              ...built,
              supportsTools: false,
              ...(runnerName === "colibri" ? { apiKeyRef: ai.envKeyRef(COLIBRI_KEY_ENV) } : {}),
            }
          : built;
      return {
        endpoint,
        model: { provider: runnerName, modelId: tag },
        label: `${tag} (${runnerName})`,
      };
    }
    if (ref.section === "rotation") {
      const endpoint = ai.rotationEndpoint(rotationMembers());
      if (!endpoint) return { reason: "no free provider is reachable — add a free key first" };
      return {
        endpoint,
        model: { provider: "free-rotation", modelId: ai.ROTATION_MODEL },
        label: `endless free rotation (${endpoint.rotation?.length ?? 0} models)`,
      };
    }
    const p = orchestration.apiProviderFor(ref.providerId);
    if (!p) return { reason: `unknown provider ${ref.providerId}` };
    const src = keyFor(p.id);
    const keyless = ref.section === "free" && ai.freeTierFor(p.id)?.keyless === true;
    if (!src && !keyless) return { reason: `${p.label} needs a key first` };
    const keyRef =
      src === "env"
        ? ai.envKeyRef(orchestration.resolveApiKey(p.id, env)?.env ?? "")
        : src === "keychain"
          ? ai.keychainKeyRef(p.id)
          : undefined;
    const chosen = model ?? ref.model;
    const entry = ai.findCloudModel(p.id, ref.model);
    const { apiKeyRef: builtRef, ...withoutKey } = ai.endpointForProvider(p, keyRef ?? "", chosen);
    const endpoint: AiEndpoint = {
      // A keyless tier sends NO credential (an empty bearer turns "no key needed" into a 401).
      ...(keyRef ? { ...withoutKey, apiKeyRef: builtRef ?? keyRef } : withoutKey),
      ...(entry?.contextWindow
        ? { contextWindow: entry.contextWindow, contextWindowMeasured: true }
        : {}),
      ...(entry ? { supportsTools: entry.tools } : {}),
    };
    return {
      endpoint,
      model: { provider: p.id, modelId: chosen },
      label: `${entry?.label ?? chosen} (${p.label})`,
    };
  };

  if (deps.notify) {
    const notify = deps.notify;
    ai.onRotationEvent((e) => notify(rotationNotice(e)));
  }

  /** AirLLM / colibri presence, asked once per session of the sidecar (cheap after that). */
  let streamCache: Partial<Record<ai.ServeRuntime, boolean>> | undefined;
  const streamInstalled = async (): Promise<Partial<Record<ai.ServeRuntime, boolean>>> => {
    if (streamCache) return streamCache;
    try {
      const r = await modelhub(["runtimes"], () => {});
      const rows = Array.isArray(r.runtimes)
        ? (r.runtimes as { id?: string; installed?: unknown }[])
        : [];
      const has = (id: string): boolean =>
        rows.some((x) => x.id === id && typeof x.installed === "string");
      streamCache = { airllm: has("airllm"), colibri: has("colibri") };
    } catch {
      streamCache = {};
    }
    return streamCache;
  };
  /** the colibri session key: random, per process, never written anywhere. */
  const colibriKey = (): string => {
    const have = process.env[COLIBRI_KEY_ENV];
    if (have && have.length >= 32) return have;
    const key = randomBytes(24).toString("hex");
    process.env[COLIBRI_KEY_ENV] = key;
    return key;
  };
  const spawnServer = (
    argv: readonly string[],
    env?: Readonly<Record<string, string>>,
  ): { ok: boolean; pid?: number; error?: string } =>
    (deps.startServer ?? startModelServer)(argv, env ? { env } : {});
  const listenerArgs =
    deps.listenerArgs ??
    (async (port: number): Promise<string | undefined> => {
      const l = await listenersOnPort(port).catch(() => ({ processes: [] as { pid: number }[] }));
      const pid = l.processes[0]?.pid;
      if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return undefined;
      const r = await execCapture("ps", ["-o", "args=", "-p", String(pid)], { timeoutMs: 4000 });
      return r.code === 0 ? r.stdout.trim() : undefined;
    });
  /**
   * May a server that is ALREADY running be adopted for this pick? Only when the bytes it was
   * pointed at are still the admitted ones AND its own command line names them: a server of the
   * same alias the user started on some other file used to be adopted with no gate check at all.
   */
  const reusable = async (
    port: number,
    target: string,
    verifyArgs: string[],
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const v = await modelhub(["verify-admitted", ...verifyArgs], () => {}).catch(
      () => ({}) as Record<string, unknown>,
    );
    if (v.ok !== true) return { ok: false, reason: envelopeError(v, "the model is not admitted") };
    const args = await listenerArgs(port);
    if (!args?.includes(target))
      return {
        ok: false,
        reason: `a server on port ${port} answers with this name but was not started on the admitted model — stop it first`,
      };
    return { ok: true };
  };
  /** A server Prometheus just started that never came up is STOPPED — left detached it can keep
   *  tens of GB resident (CLAUDE.md Hazard B) for a pick the user was told had failed. */
  // A pid from a FAKED startServer is fictional: signalling it would hit whatever real process
  // happens to own that number (the CLAUDE.md Hazard A shape). Real signals only for real spawns.
  const realSpawns = deps.startServer === undefined;
  const alive = deps.processAlive ?? (realSpawns ? processAlive : () => true);
  const stopStarted = (pid: number | undefined): void => {
    if (pid === undefined) return;
    if (deps.stopServer) {
      deps.stopServer(pid);
      return;
    }
    if (!realSpawns) return;
    signalPid(pid, "SIGTERM");
    const t = setTimeout(() => {
      if (processAlive(pid)) signalPid(pid, "SIGKILL");
    }, 5000);
    t.unref?.();
  };

  const host: ModelsHost = {
    async context() {
      const [m, tags] = await Promise.all([machine(), ollamaTags().catch(() => [])]);
      const ollama = deps.backends.liveRunners.find((r) => r.name === "ollama");
      const served = deps.backends.liveRunners.flatMap((r) =>
        r.models.map((model) => ({ runner: r.name, model })),
      );
      const id = deps.activeId();
      return {
        machine: m,
        installedOllama: tags.map((t) => t.name),
        served,
        keyFor,
        rotation: rotationMembers(),
        ...(id ? { activeId: id } : {}),
        ollamaServing: ollama !== undefined || tags.length > 0,
        ollamaInstalled: ollama !== undefined || tags.length > 0 || hasBin("ollama"),
        runtimeInstalled: {
          ollama: ollama !== undefined || tags.length > 0 || hasBin("ollama"),
          llamacpp: hasBin("llama-server"),
          lmstudio: hasBin("lms") || vendorBin("lms") !== undefined,
          mlx: hasBin("mlx_lm.server"),
          // Prometheus-owned (gated venv / pinned build): only the sidecar can tell
          ...(await streamInstalled()),
        },
        // `/server`: a pick that names no runtime is prepared for the user's default server
        defaultServer: loadDefaultServer(deps.home),
        runtimeServing: {
          llamacpp: deps.backends.liveRunners.some((r) => r.name === "llamacpp"),
          lmstudio: deps.backends.liveRunners.some((r) => r.name === "lmstudio"),
          mlx: deps.backends.liveRunners.some((r) => r.name === "mlx"),
        },
      };
    },

    async connectKey(providerId, key) {
      const p = orchestration.apiProviderFor(providerId);
      if (!p) return { ok: false, reason: `unknown provider ${providerId}` };
      const trimmed = key.trim();
      if (!trimmed) return { ok: false, reason: "no key entered — nothing stored" };
      // Verify BEFORE writing (the same rule as `prometheus provider connect`): a typo must not
      // overwrite a working key, and a key that cannot list models cannot serve them either.
      const live = await fetchProviderModels(p.id, trimmed);
      if (live === null) {
        return {
          ok: false,
          reason: `${p.label} did not accept that key (or is unreachable) — nothing stored`,
        };
      }
      try {
        await secretsStore().set(secrets.SECRETS_SERVICE, `provider:${p.id}`, trimmed);
      } catch (e) {
        return { ok: false, reason: `keychain error: ${(e as Error).message}` };
      }
      deps.keychainProviders.add(p.id);
      refreshCloud();
      // A new key changes who is in the rotation; old cooldowns were about a world without it.
      ai.resetRotation();
      // The spinner's members were fixed when it was adopted. If it is the active model, hand
      // the session a fresh one so the provider just added joins the rotation right away.
      if (deps.activeId() === ai.ROTATION_ENDPOINT_ID) {
        const ep = ai.rotationEndpoint(rotationMembers());
        if (ep)
          await deps.adoptEndpoint(ep, { provider: "free-rotation", modelId: ai.ROTATION_MODEL });
      }
      return { ok: true, live };
    },

    async liveModels(providerId) {
      const p = orchestration.apiProviderFor(providerId);
      if (!p) return [];
      const src = keyFor(providerId);
      let key = "";
      if (src === "env") key = orchestration.resolveApiKey(providerId, env)?.key ?? "";
      else if (src === "keychain")
        key = await resolveKey(ai.keychainKeyRef(providerId)).catch(() => "");
      return (await fetchProviderModels(providerId, key)) ?? [];
    },

    async installOllama() {
      // The NATIVE runner through an official channel (Homebrew), never `apps install ollama`:
      // that is the Docker-container app — on a Mac it has no Metal, so every model ran on the
      // CPU. Where only a vendor script exists (Linux without Homebrew), the sidecar refuses to
      // run it and returns the exact command for the human instead.
      try {
        const r = await modelhub(["install-runner", "--runner", "ollama"], () => {});
        if (r.ok === true) return { ok: true };
        const manual = typeof r.install === "string" ? ` — ${r.install}` : "";
        return {
          ok: false,
          reason: `${envelopeError(r, "the installer reported a problem")}${manual}`,
        };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async startOllama() {
      const r = await ensureOllama().catch(() => ({ started: false, reason: "start-failed" }));
      const up = (await ollamaTags().catch(() => null)) !== null && r.reason !== "not-installed";
      if (!up && r.reason) return { ok: false, reason: `ollama ${r.reason}` };
      let runner = deps.backends.liveRunners.find((x) => x.name === "ollama");
      if (!runner) {
        runner = { name: "ollama", baseUrl: OLLAMA_BASE, models: [] };
        deps.backends.liveRunners.push(runner);
      }
      // Keep the snapshot's "the runner we'd use" in step, or the footer and `/model` go on
      // reporting "no local runner" for a session that was just handed one.
      if (!deps.backends.localRunner) deps.backends.localRunner = runner;
      return { ok: true };
    },

    async pull(tag, show, opts) {
      try {
        if (!opts?.force) {
          const r = await pullTag(tag, show);
          if (!r.ok) return { ok: false, reason: r.error || "pull failed" };
        }
        // Ollama's registry has no local stage: scan what it stored BEFORE the model is ever
        // loaded; the sidecar removes it on a block. Fail-closed: a scan that cannot run
        // means the pick is not adopted. `force` (the user typed a confirmation of a WARN)
        // re-runs only the gate — the model is already on disk, and a BLOCK still refuses.
        show("scanning the downloaded model with nemesis…");
        const g = await modelhub(
          ["ollama-gate", `--tag=${tag}`, ...(opts?.force ? ["--accept-warn"] : [])],
          show,
        );
        if (g.ok !== true) return gatedFailure(g, "nemesis could not verify the model");
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
      const ollama = deps.backends.liveRunners.find((x) => x.name === "ollama");
      if (ollama && !ollama.models.includes(tag)) ollama.models.push(tag);
      else if (!ollama)
        deps.backends.liveRunners.push({ name: "ollama", baseUrl: OLLAMA_BASE, models: [tag] });
      return { ok: true };
    },

    async verifyOllama(tag) {
      try {
        const g = await modelhub(["ollama-gate", `--tag=${tag}`], () => {});
        return g.ok === true ? { ok: true } : gatedFailure(g, "nemesis could not verify the model");
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async discardOllama(tag) {
      try {
        const r = await modelhub(["ollama-discard", `--tag=${tag}`], () => {});
        return r.ok === true
          ? { ok: true }
          : { ok: false, reason: envelopeError(r, "ollama rm failed") };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async runtimeStatus() {
      const r = await modelhub(["runtimes"], () => {});
      return Array.isArray(r.runtimes)
        ? (r.runtimes as {
            id: string;
            installed: string | null;
            auto: string | null;
            manual?: string | null;
          }[])
        : [];
    },

    async installRuntime(id, show, opts) {
      try {
        const r = await modelhub(
          // `--accept-warn`: the user typed acceptance of a nemesis WARN on AirLLM's wheels or
          // colibri's source — it admits a WARN only, never a block or a scanner error
          ["install-runtime", "--runtime", id, ...(opts?.acceptWarn ? ["--accept-warn"] : [])],
          show,
        );
        if (r.ok === true) {
          streamCache = undefined;
          return { ok: true };
        }
        const g = gatedFailure(r, "the installer reported a problem");
        return {
          ok: false,
          reason: g.reason,
          ...(g.needsConfirm ? { needsConfirm: true } : {}),
          ...(g.findings ? { findings: g.findings } : {}),
          ...(typeof r.install === "string" ? { manual: r.install } : {}),
        };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async serveGguf(id, path, ctx, opts) {
      const listed = await listModels(RUNTIME_BASE.llamacpp);
      if (listed?.includes(id)) {
        const ok = await reusable(8080, path, [`--path=${path}`]);
        if (!ok.ok) return ok;
        upsertRunner("llamacpp", RUNTIME_BASE.llamacpp, id);
        return { ok: true };
      }
      if (listed !== null) {
        // :8080 is held by a llama-server serving another model: a second one cannot bind, and
        // replacing the user's running server is not this step's decision
        return { ok: false, reason: "llama.cpp is already serving another model on port 8080" };
      }
      // the file must still be the one nemesis admitted: a remembered path may have been
      // replaced since (the desktop app checks the same before it serves)
      const v = await modelhub(["verify-admitted", `--path=${path}`], () => {}).catch(
        () => ({}) as Record<string, unknown>,
      );
      if (v.ok !== true) return { ok: false, reason: envelopeError(v, "the file is not admitted") };
      // The admitted file only, and `--offline`: llama-server must never fetch weights itself.
      // Streaming (larger than RAM): no flag forces mmap — llama.cpp's default load mode IS
      // mmap on Metal/CPU/CUDA (the old --mmap/--no-mmap/--mlock flags were removed in 2026-09,
      // so passing them would fail to start) — but the weights must stay pageable: a dense
      // model gets no GPU layers (Metal wires what it offloads), a MoE keeps its experts on the
      // CPU while attention stays on the GPU.
      const streamArgs = opts?.stream
        ? opts.moe
          ? ["-ngl", "999", "--cpu-moe"]
          : ["-ngl", "0"]
        : [];
      const r = spawnServer([
        "llama-server",
        "-m",
        path,
        "--host",
        "127.0.0.1",
        "--port",
        "8080",
        "-c",
        String(ctx),
        "--jinja",
        "--alias",
        id,
        ...streamArgs,
        "--offline",
      ]);
      if (!r.ok) return { ok: false, reason: r.error ?? "llama-server did not start" };
      const up = await waitForModels(
        RUNTIME_BASE.llamacpp,
        (models) => models.includes(id),
        undefined,
        r.pid,
      );
      if (!up) {
        const died = r.pid !== undefined && !alive(r.pid);
        stopStarted(r.pid);
        return {
          ok: false,
          reason: died
            ? "llama-server exited while loading the model (see ~/.prometheus/logs)"
            : "llama-server started but did not answer within 3 minutes — stopped it",
        };
      }
      upsertRunner("llamacpp", RUNTIME_BASE.llamacpp, id);
      return { ok: true };
    },

    async fetchSnapshot(id, repo, include, show, opts) {
      try {
        const r = await modelhub(
          [
            "stage-hf",
            `--id=${id}`,
            `--repo=${repo}`,
            // `--include=<glob>`: weights, config and tokenizer only — the sidecar refuses code,
            // pickles and auto_map before AND after the download
            ...include.flatMap((g) => ["--include", g]),
            // the runtime's own folder (Hugging Face cache / LM Studio), never a Prometheus one
            `--place=${opts?.place ?? "hf"}`,
            ...(opts?.force ? ["--accept-warn"] : []),
          ],
          show,
        );
        const dir = typeof r.local_path === "string" ? r.local_path : undefined;
        if (r.ok !== false && r.admitted === true && dir) return { ok: true, path: dir };
        return gatedFailure(r, "the download was not admitted");
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async serveMlx(id, dir) {
      const base = RUNTIME_BASE.mlx;
      const listed = await listModels(base);
      if (listed !== null && listed.length > 0) {
        // :8090 answers already; only reuse it when it serves THIS directory
        const hit = listed.find((m) => m === dir || m.endsWith(`/${id}`) || m.includes(dir));
        if (hit) {
          const ok = await reusable(8090, dir, [`--dir=${dir}`]);
          if (!ok.ok) return ok;
          upsertRunner("mlx", base, hit);
          return { ok: true, model: hit };
        }
        return { ok: false, reason: "MLX-LM is already serving another model on port 8090" };
      }
      const v = await modelhub(["verify-admitted", `--dir=${dir}`], () => {}).catch(
        () => ({}) as Record<string, unknown>,
      );
      if (v.ok !== true)
        return { ok: false, reason: envelopeError(v, "the directory is not admitted") };
      // offline: mlx_lm.server loads a different model when a request names one, and with the
      // hub offline that is a refusal instead of a download
      const r = spawnServer(
        ["mlx_lm.server", "--model", dir, "--host", "127.0.0.1", "--port", "8090"],
        { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
      );
      if (!r.ok) return { ok: false, reason: r.error ?? "mlx_lm.server did not start" };
      let model: string | undefined;
      const up = await waitForModels(
        base,
        (models) => {
          model = models.find((m) => m === dir || m.includes(dir)) ?? models[0];
          return model !== undefined;
        },
        undefined,
        r.pid,
      );
      if (!up || !model) {
        stopStarted(r.pid);
        return {
          ok: false,
          reason: "MLX-LM did not answer within 3 minutes (or exited) — stopped it",
        };
      }
      upsertRunner("mlx", base, model);
      return { ok: true, model };
    },

    async serveStream(id, dir) {
      const base = RUNTIME_BASE.airllm;
      const listed = await listModels(base);
      if (listed?.includes(id)) {
        const ok = await reusable(8094, dir, [`--dir=${dir}`]);
        if (!ok.ok) return ok;
        upsertRunner("airllm", base, id);
        return { ok: true };
      }
      if (listed !== null) return { ok: false, reason: "port 8094 is already in use" };
      const a = await modelhub(
        ["runtime-argv", "--runtime=airllm", `--model=${dir}`, `--id=${id}`],
        () => {},
      ).catch(
        (e: unknown): Record<string, unknown> => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      const argv = Array.isArray(a.argv) ? (a.argv as unknown[]).map(String) : undefined;
      if (a.ok !== true || !argv)
        return { ok: false, reason: envelopeError(a, "no AirLLM start command") };
      const env = (a.env ?? {}) as Record<string, string>;
      const r = spawnServer(argv, env);
      if (!r.ok) return { ok: false, reason: r.error ?? "the AirLLM server did not start" };
      // the first start splits the model into per-layer files — minutes for a 70B model
      const up = await waitForModels(base, (models) => models.includes(id));
      if (!up)
        return {
          ok: false,
          reason:
            "the AirLLM server is still preparing the model (splitting it into layers) — run /models again in a few minutes",
        };
      upsertRunner("airllm", base, id);
      // The server answers only after the split is complete and recorded: from now on the
      // model is kept ONCE, as the layer split (the sidecar verifies it, signs it into the
      // placement ledger and frees the snapshot's weight blobs). Best-effort: a refusal frees
      // nothing and loses nothing.
      void modelhub(["airllm-consolidate", `--id=${id}`, `--model=${dir}`], () => {}).catch(
        () => undefined,
      );
      return { ok: true };
    },

    async serveColibri(id, gguf, ctx) {
      const base = RUNTIME_BASE.colibri;
      const imp = await modelhub(
        ["colibri-import", `--id=${id}`, `--gguf=${gguf}`],
        () => {},
      ).catch(
        (e: unknown): Record<string, unknown> => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      const dir = typeof imp.model_dir === "string" ? imp.model_dir : undefined;
      if (imp.ok !== true || !dir)
        return { ok: false, reason: envelopeError(imp, "coli import failed") };
      const listed = await listModels(base, colibriKey());
      if (listed !== null) {
        if (listed.includes(id)) {
          upsertRunner("colibri", base, id);
          return { ok: true };
        }
        return { ok: false, reason: "port 8096 is already in use (another colibri?)" };
      }
      const a = await modelhub(
        ["runtime-argv", "--runtime=colibri", `--model=${dir}`, `--id=${id}`, `--ctx=${ctx}`],
        () => {},
      ).catch(
        (e: unknown): Record<string, unknown> => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      const argv = Array.isArray(a.argv) ? (a.argv as unknown[]).map(String) : undefined;
      if (a.ok !== true || !argv)
        return { ok: false, reason: envelopeError(a, "no colibri start command") };
      const env = { ...((a.env ?? {}) as Record<string, string>), COLI_API_KEY: colibriKey() };
      const r = spawnServer(argv, env);
      if (!r.ok) return { ok: false, reason: r.error ?? "colibri did not start" };
      const up = await waitForModels(base, (models) => models.includes(id), colibriKey(), r.pid);
      if (!up) {
        stopStarted(r.pid);
        return {
          ok: false,
          reason: "colibri did not answer within 3 minutes (or exited) — stopped it",
        };
      }
      upsertRunner("colibri", base, id);
      return { ok: true };
    },

    async linkLmstudio(id, path, format) {
      const r = await modelhub(
        [
          "install-target",
          "--target",
          "lmstudio",
          "--id",
          `prometheus/${id}`,
          ...(format === "mlx" ? [`--mlx-dir=${path}`] : ["--gguf", path]),
          "--link",
        ],
        () => {},
      );
      return r.ok === true ? { ok: true } : { ok: false, reason: envelopeError(r, "link failed") };
    },

    async startLmstudio(id) {
      const listed = await listModels(RUNTIME_BASE.lmstudio);
      if (listed === null) {
        const r = (deps.startServer ?? startModelServer)([
          "lms",
          "server",
          "start",
          "--port",
          "1234",
        ]);
        if (!r.ok) return { ok: false, reason: r.error ?? "lms server start failed" };
      }
      let key: string | undefined;
      const repos = ai.lmStudioReposFor(ai.findLocalModel(id));
      const lmsList =
        deps.lmsList ??
        (async (): Promise<ai.LmStudioListed[]> => {
          const r = await execCapture(vendorBin("lms") ?? "lms", ["ls", "--json"], {
            timeoutMs: 20_000,
          });
          try {
            const rows = JSON.parse(r.stdout) as { modelKey?: unknown; path?: unknown }[];
            return Array.isArray(rows)
              ? rows
                  .filter((x) => typeof x?.modelKey === "string" && typeof x?.path === "string")
                  .map((x) => ({ modelKey: x.modelKey as string, path: x.path as string }))
              : [];
          } catch {
            return [];
          }
        });
      const up = await waitForModels(RUNTIME_BASE.lmstudio, async (models) => {
        // the placed files' keys, by path — LM Studio names a sideloaded model by its FILE
        const placed = repos.length > 0 ? ai.lmStudioKeysForRepos(await lmsList(), repos) : [];
        key = lmStudioKeyFor(models, id, placed);
        return key !== undefined;
      });
      if (!up || !key)
        return { ok: false, reason: "LM Studio is up but does not list the model yet" };
      upsertRunner("lmstudio", RUNTIME_BASE.lmstudio, key);
      return { ok: true, model: key };
    },

    async fetchGguf(id, repo, file, show, opts) {
      try {
        const r = await modelhub(
          // `--accept-warn`, never `--force`: the user accepted a WARN they were shown, which
          // must not also admit a block, a scanner error or a sha256 mismatch on the re-run.
          [
            "stage-hf",
            `--id=${id}`,
            `--repo=${repo}`,
            `--file=${file}`,
            // where the admitted file ends up: the serving runtime's own folder (or a transit
            // copy for Ollama that import-ollama removes once Ollama holds it)
            `--place=${opts?.place ?? "hf"}`,
            ...(opts?.force ? ["--accept-warn"] : []),
          ],
          show,
        );
        const weights = Array.isArray(r.weights) ? (r.weights as unknown[]) : [];
        const first = typeof weights[0] === "string" ? (weights[0] as string) : undefined;
        if (r.ok === true && r.admitted === true && first) return { ok: true, path: first };
        return gatedFailure(r, "the download was not admitted");
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async importToOllama(id, path) {
      try {
        const r = await modelhub(["import-ollama", `--id=${id}`, `--path=${path}`], () => {});
        if (r.ok === true && typeof r.tag === "string") {
          const tag = r.tag;
          const ollama = deps.backends.liveRunners.find((x) => x.name === "ollama");
          if (ollama && !ollama.models.includes(tag)) ollama.models.push(tag);
          return { ok: true, tag };
        }
        return { ok: false, reason: envelopeError(r, "ollama create failed") };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async adopt(ref, model) {
      const r = endpointFor(ref, model);
      if ("reason" in r) return { ok: false, reason: r.reason };
      await deps.adoptEndpoint(r.endpoint, r.model);
      return { ok: true, label: r.label };
    },

    restore(raw) {
      if (!raw) return undefined;
      const ref = ai.parseRef(raw);
      if (!ref) return undefined;
      /**
       * Only picks that cost nothing come back on their own. A PAID pick restored at launch
       * spends money the moment the user types, on a key that may have been exported for some
       * other tool; the SPINNER sends prompts to several third parties, which `/models` asks
       * about explicitly. Both are offered back as a hint instead (`restoreHint`).
       */
      if (ref.section === "paid" || ref.section === "rotation") return undefined;
      // A remembered LOCAL pick only counts when its runner is serving it right now: restoring
      // it otherwise would point the session at a model that cannot answer.
      if (ref.section === "served" || ref.section === "local") {
        // the SAME tag/runner resolution `endpointFor` adopts with — an imported GGUF is served
        // as prometheus/<id>, a llama.cpp pick under its alias, an LM Studio pick under the key
        // LM Studio lists for it. Reading only `.ollama` never restored any of those.
        const runner = ref.section === "served" ? ref.runner : runnerNameFor(ref.runtime);
        const live = deps.backends.liveRunners.find((x) => x.name === runner);
        const tag = ref.section === "served" ? ref.model : localServedTag(ref, live?.models ?? []);
        if (!tag || !live?.models.includes(tag)) return undefined;
        const r = endpointFor(ref, ref.section === "local" ? tag : undefined);
        return "reason" in r ? undefined : r;
      }
      const r = endpointFor(ref);
      return "reason" in r ? undefined : r;
    },

    restoreHint(raw) {
      const ref = raw ? ai.parseRef(raw) : null;
      if (!ref || (ref.section !== "paid" && ref.section !== "rotation")) return undefined;
      return `last /models pick: ${ai.formatRef(ref)} — not restored automatically (${
        ref.section === "paid" ? "metered" : "sends prompts to several providers"
      }); \`/models use ${ai.formatRef(ref)}\` to switch back`;
    },

    rotationMembers,

    saveChoice(ref) {
      try {
        const file = modelChoicePath(deps.home);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify({ ref, at: new Date().toISOString() }, null, 2)}\n`, {
          mode: 0o600,
        });
      } catch {
        // best-effort: a read-only home must not fail a model switch that already happened
      }
    },
  };
  return host;
}
