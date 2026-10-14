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
  accessSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { delimiter, dirname, join } from "node:path";

import { type AiEndpoint, type FetchLike, ai, orchestration, secrets } from "@prometheus/core";
import { fetchOllamaTags, pullModel } from "@prometheus/core/updates-live";
import { type EngineClient, execCapture } from "@prometheus/engine-bridge";

import { diskInfo, resolveCategory } from "../home.js";
import { createCliSecretsStore } from "../secrets-backend.js";
import { pullWithProgress } from "../updates/model-actions-cmd.js";
import { type Backends, buildLocalEndpoint } from "./onboarding.js";

export type AdoptResult = { ok: true; label: string } | { ok: false; reason: string };

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
  /** pull a tag, reporting progress lines. */
  pull(tag: string, show: (line: string) => void): Promise<{ ok: boolean; reason?: string }>;
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
    const vram = await nvidiaVramBytes(env);
    const di = diskInfo(resolveCategory("open_models", deps.home));
    return ai.machineFromHost({
      totalMemBytes: os.totalmem(),
      platform: process.platform,
      arch: process.arch,
      ...(vram > 0 ? { vramBytes: vram } : {}),
      ...(di ? { freeDiskBytes: di.freeBytes } : {}),
    });
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
      const tag =
        ref.section === "served" ? ref.model : (ai.findLocalModel(ref.id)?.ollama ?? ref.id);
      const runnerName = ref.section === "served" ? ref.runner : "ollama";
      const runner = deps.backends.liveRunners.find((r) => r.name === runnerName);
      const endpoint = buildLocalEndpoint({
        name: runnerName,
        baseUrl: runner?.baseUrl ?? OLLAMA_BASE,
        models: [tag],
      });
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
      if (!deps.client) return { ok: false, reason: "no engine available to run the installer" };
      try {
        const res = (await deps.client.runPrometheus(["apps", "install", "ollama"])) as unknown as {
          ok?: boolean;
        };
        return res?.ok === false
          ? { ok: false, reason: "the installer reported a problem" }
          : { ok: true };
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

    async pull(tag, show) {
      try {
        const r = await pullTag(tag, show);
        if (!r.ok) return { ok: false, reason: r.error || "pull failed" };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
      const ollama = deps.backends.liveRunners.find((x) => x.name === "ollama");
      if (ollama && !ollama.models.includes(tag)) ollama.models.push(tag);
      else if (!ollama)
        deps.backends.liveRunners.push({ name: "ollama", baseUrl: OLLAMA_BASE, models: [tag] });
      return { ok: true };
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
        const tag = ref.section === "served" ? ref.model : ai.findLocalModel(ref.id)?.ollama;
        const runner = ref.section === "served" ? ref.runner : "ollama";
        const live = deps.backends.liveRunners.find((x) => x.name === runner);
        if (!tag || !live?.models.includes(tag)) return undefined;
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
