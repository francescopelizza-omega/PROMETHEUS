// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/model-wizard.ts — the desktop half of `/models`, the guided model picker.
 *
 * No electron import here, so the logic is testable under plain node; the channel
 * registration lives in `model-wizard-ipc.ts`.
 *
 * The CLI and TUI build their steps from core's `ai/model-catalog/wizard.ts`; so does this. The
 * renderer is sandboxed and may not import the core barrel, so main computes each step and the
 * renderer only draws it — the same rows, the same two lines, the same fit verdicts as the
 * terminal, by construction rather than by keeping two copies in sync.
 *
 * What main keeps to itself, always:
 *  - API keys. `setKey` verifies a key against the provider's `/models` BEFORE storing it in the
 *    same OS-keychain entry `prometheus provider connect` writes (`provider:<id>`), and no
 *    channel here ever returns a key to the renderer.
 *  - The rotation's members. `rotationMembersForMain` is what `ai-ipc.ts` uses to wrap its fetch
 *    when the endpoint is the endless free rotation — computed here, never taken from the
 *    renderer, because the member list decides where prompts are sent.
 *
 * The pick is remembered in `~/.prometheus/model-choice.json` — the CLI's file — so a model
 * chosen in the terminal is the app's choice too, and vice versa.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

import { type FetchLike, ai, discoverRunners, orchestration, secrets } from "@prometheus/core";
import { createCliSecretsStore, prometheusHome } from "@prometheus/core/agent-system-host";
import { fetchOllamaTags } from "@prometheus/core/updates-live";

import type {
  ModelWizardChooseResult,
  ModelWizardEndpointsResult,
  ModelWizardLiveResult,
  ModelWizardPlanResult,
  ModelWizardSetKeyResult,
  ModelWizardStepResult,
  WizardEndpoint,
} from "../shared/ipc-contract.js";

const STEP_IDS = new Set<ai.WizardStepId>(["root", "cloud", "local", "free", "paid", "rotation"]);

export interface ModelWizardDeps {
  env?: Record<string, string | undefined>;
  home?: string;
  fetch?: FetchLike;
  secretsStore?: secrets.SecretsStore;
  /** injected for tests — never reach a real Ollama or keychain there. */
  machine?: () => ai.MachineProfile;
  ollamaTags?: () => Promise<{ name: string }[]>;
  served?: () => Promise<{ runner: string; model: string }[]>;
}

/* ------------------------------------------------------------------------- *
 * Keychain presence — cached, because asking costs one `security` spawn per provider
 * ------------------------------------------------------------------------- */

const KEYCHAIN_TTL_MS = 60_000;
let keychainCache: { at: number; ids: Set<string> } | undefined;
/**
 * Bumped by every invalidation. A lookup that STARTED before a key was stored must not finish
 * afterwards and re-cache the world without that key — it compares generations before writing.
 */
let keychainGeneration = 0;

async function keychainProviders(store: secrets.SecretsStore): Promise<Set<string>> {
  if (keychainCache && Date.now() - keychainCache.at < KEYCHAIN_TTL_MS) return keychainCache.ids;
  const gen = keychainGeneration;
  const ids = new Set<string>();
  let failed = false;
  await Promise.all(
    orchestration.API_PROVIDER_IDS.map(async (id) => {
      try {
        if (await store.get(secrets.SECRETS_SERVICE, `provider:${id}`)) ids.add(id);
      } catch {
        // No keychain tool on this platform is normal (env vars are the answer there) — but a
        // locked keychain or a timed-out lookup is not "no key", so it is never cached.
        failed = true;
      }
    }),
  );
  if (!failed && gen === keychainGeneration) keychainCache = { at: Date.now(), ids };
  return ids;
}

/** Forget the cached presence set (a key was just stored). Exported for tests. */
export function invalidateKeychainCache(): void {
  keychainCache = undefined;
  keychainGeneration += 1;
}

/** A model id as providers spell them: `org/name:tag-1.5@rev`. Bounded, no spaces or controls. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/* ------------------------------------------------------------------------- *
 * The pure-ish core of each channel, injectable for tests
 * ------------------------------------------------------------------------- */

export function createModelWizard(deps: ModelWizardDeps = {}) {
  const env = deps.env ?? process.env;
  const home = deps.home ?? prometheusHome();
  const doFetch: FetchLike = deps.fetch ?? (fetch as unknown as FetchLike);
  let store = deps.secretsStore;
  const secretsStore = (): secrets.SecretsStore => {
    store = store ?? createCliSecretsStore();
    return store;
  };

  const keyFor =
    (keychain: Set<string>) =>
    (providerId: string): ai.KeySource | undefined => {
      if (orchestration.resolveApiKey(providerId, env)) return "env";
      return keychain.has(providerId) ? "keychain" : undefined;
    };

  const machine = (): ai.MachineProfile =>
    deps.machine?.() ??
    ai.machineFromHost({
      totalMemBytes: os.totalmem(),
      platform: process.platform,
      arch: process.arch,
    });

  const served = async (): Promise<{ runner: string; model: string }[]> => {
    if (deps.served) return deps.served();
    const runners = await discoverRunners({ env }).catch(() => []);
    return runners.flatMap((r) => r.models.map((model) => ({ runner: r.id, model })));
  };

  const choicePath = (): string => join(home, "model-choice.json");

  const readChoice = (): string | undefined => {
    try {
      const j = JSON.parse(readFileSync(choicePath(), "utf8")) as { ref?: unknown };
      return typeof j.ref === "string" ? j.ref : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * The last cloud pick per provider, in memory — what `endpoints()` lists even when the
   * choice file could not be written (a read-only home) or a later pick for ANOTHER provider
   * replaced it there. Without it the renderer's `selectEndpoint(id)` named an id the list no
   * longer carried, the hook judged it stale, and the user's pick was silently reverted.
   */
  const picked = new Map<string, WizardEndpoint>();

  const saveChoice = (ref: string): void => {
    try {
      mkdirSync(dirname(choicePath()), { recursive: true });
      writeFileSync(
        choicePath(),
        `${JSON.stringify({ ref, at: new Date().toISOString() }, null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
    } catch {
      // best-effort: a read-only home must not fail a model switch
    }
  };

  async function context(): Promise<ai.PrepareContext> {
    const keychain = await keychainProviders(secretsStore());
    const [tags, live] = await Promise.all([
      (deps.ollamaTags ?? (() => fetchOllamaTags()))().catch(() => []),
      served(),
    ]);
    const ollamaServing = live.some((s) => s.runner === "ollama") || tags.length > 0;
    return {
      machine: machine(),
      installedOllama: tags.map((t) => t.name),
      served: live,
      keyFor: keyFor(keychain),
      rotation: ai.rotationMembers({ env, hasKeychainKey: (id) => keychain.has(id) }),
      ollamaServing,
      // The renderer installs Ollama through the existing `model:installRunner`, which knows
      // itself whether it is installed; "serving or has models" is the evidence available here.
      ollamaInstalled: ollamaServing,
    };
  }

  async function providerModels(providerId: string, key: string): Promise<string[] | null> {
    const p = orchestration.apiProviderFor(providerId);
    if (!p) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const wire = ai.selectWire(ai.runtimeFromBaseUrl(p.baseUrl, "cloud"));
      const res = await doFetch(`${p.baseUrl.replace(/\/+$/, "")}${ai.modelsPathFor(p)}`, {
        method: "GET",
        headers: { ...(key ? wire.headers(key) : {}), accept: "application/json" },
        body: undefined as unknown as string,
        signal: controller.signal,
      });
      if (!res.ok) return null;
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
  }

  async function keyValue(providerId: string): Promise<string> {
    const fromEnv = orchestration.resolveApiKey(providerId, env);
    if (fromEnv) return fromEnv.key;
    try {
      return (await secretsStore().get(secrets.SECRETS_SERVICE, `provider:${providerId}`)) ?? "";
    } catch {
      return "";
    }
  }

  /** Resolve a key REF (`env:X` / `keychain:provider:y`) — the rotation's per-member seam. */
  async function resolveKeyRef(ref: string): Promise<string> {
    const parsed = ai.parseKeyRef(ref);
    if (!parsed) return "";
    if (parsed.kind === "env") return env[parsed.envVar] ?? "";
    try {
      return (await secretsStore().get(secrets.SECRETS_SERVICE, parsed.account)) ?? "";
    } catch {
      return "";
    }
  }

  function wizardEndpointFor(
    ref: ai.WizardRef,
    keychain: Set<string>,
    model?: string,
  ): WizardEndpoint | { error: string } {
    if (ref.section === "rotation") {
      const ep = ai.rotationEndpoint(
        ai.rotationMembers({ env, hasKeychainKey: (id) => keychain.has(id) }),
      );
      if (!ep) return { error: "no free provider is reachable — add a free key first" };
      return {
        id: ep.id,
        baseUrl: ep.baseUrl,
        model: ep.model ?? ai.ROTATION_MODEL,
        locality: "cloud",
        contextWindow: ep.contextWindow,
      };
    }
    if (ref.section === "free" || ref.section === "paid") {
      const p = orchestration.apiProviderFor(ref.providerId);
      if (!p) return { error: `unknown provider ${ref.providerId}` };
      const keyless = ref.section === "free" && ai.freeTierFor(p.id)?.keyless === true;
      if (!keyFor(keychain)(p.id) && !keyless) return { error: `${p.label} needs a key first` };
      const chosen = model ?? ref.model;
      const entry = ai.findCloudModel(p.id, ref.model);
      const cw = entry?.contextWindow ?? p.contextWindow;
      return {
        id: `cloud:${p.id}:${chosen}`,
        baseUrl: p.baseUrl,
        model: chosen,
        locality: "cloud",
        ...(cw ? { contextWindow: cw } : {}),
      };
    }
    return { error: "local picks are adopted from the runner's own endpoint list" };
  }

  return {
    async step(arg: unknown): Promise<ModelWizardStepResult> {
      const o = (arg ?? {}) as { step?: unknown; showAll?: unknown };
      const step =
        typeof o.step === "string" && STEP_IDS.has(o.step as ai.WizardStepId)
          ? (o.step as ai.WizardStepId)
          : "root";
      try {
        const ctx = await context();
        return {
          ok: true,
          step: ai.wizardStep(step, { ...ctx, ...(o.showAll === true ? { showAll: true } : {}) }),
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async plan(arg: unknown): Promise<ModelWizardPlanResult> {
      const raw = (arg as { ref?: unknown } | undefined)?.ref;
      const ref = typeof raw === "string" ? ai.parseRef(raw) : null;
      if (!ref) return { ok: false, error: "not a model ref" };
      try {
        return { ok: true, plan: ai.preparePlan(ref, await context()) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async setKey(arg: unknown): Promise<ModelWizardSetKeyResult> {
      const o = (arg ?? {}) as { providerId?: unknown; key?: unknown };
      if (typeof o.providerId !== "string" || typeof o.key !== "string")
        return { ok: false, error: "bad request" };
      const p = orchestration.apiProviderFor(o.providerId);
      if (!p) return { ok: false, error: `unknown provider ${o.providerId}` };
      const key = o.key.trim();
      if (!key || key.length > 4096) return { ok: false, error: "no key entered — nothing stored" };
      // Verify BEFORE writing: a typo must never overwrite a working key.
      const live = await providerModels(p.id, key);
      if (live === null)
        return {
          ok: false,
          error: `${p.label} did not accept that key (or is unreachable) — nothing stored`,
        };
      try {
        await secretsStore().set(secrets.SECRETS_SERVICE, `provider:${p.id}`, key);
      } catch (e) {
        return {
          ok: false,
          error: `keychain error: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      invalidateKeychainCache();
      ai.resetRotation();
      return { ok: true, live };
    },

    async liveModels(arg: unknown): Promise<ModelWizardLiveResult> {
      const id = (arg as { providerId?: unknown } | undefined)?.providerId;
      if (typeof id !== "string") return { ok: false, error: "bad request" };
      const tier = ai.freeTierFor(id);
      const key = await keyValue(id);
      if (!key && !tier?.keyless) return { ok: true, models: [] };
      return { ok: true, models: (await providerModels(id, key)) ?? [] };
    },

    async choose(arg: unknown): Promise<ModelWizardChooseResult> {
      const o = (arg ?? {}) as { ref?: unknown; model?: unknown };
      const ref = typeof o.ref === "string" ? ai.parseRef(o.ref) : null;
      if (!ref) return { ok: false, error: "not a model ref" };
      let model = typeof o.model === "string" && o.model ? o.model : undefined;
      if (model !== undefined && !MODEL_ID.test(model))
        return { ok: false, error: "not a model id" };
      if (ref.section === "local" || ref.section === "served") {
        saveChoice(ai.formatRef(ref));
        return { ok: true, label: ref.section === "served" ? ref.model : ref.id };
      }
      const keychain = await keychainProviders(secretsStore());
      let chosenModel = model;
      // Catalogue ids rot; the provider's live list is the authority once a key exists. A
      // renamed id (a dated build, different case) is used silently; a vanished one is
      // refused WITH the live list, so the renderer can offer what is actually served. An
      // explicit `model` from the renderer must be ON that list when the list is known.
      if (ref.section === "free" || ref.section === "paid") {
        const tier = ai.freeTierFor(ref.providerId);
        const key = await keyValue(ref.providerId);
        const live =
          key || tier?.keyless ? ((await providerModels(ref.providerId, key)) ?? []) : [];
        if (chosenModel !== undefined && live.length > 0 && !live.includes(chosenModel)) {
          return {
            ok: false,
            error: `${chosenModel} is not served by this provider`,
            live: live.slice(0, 20),
          };
        }
        const m = chosenModel
          ? ({ kind: "exact", model: chosenModel } as const)
          : ai.matchLiveModel(ref.model, live);
        if (m.kind === "renamed") chosenModel = m.model;
        if (m.kind === "missing") {
          return {
            ok: false,
            error: `${ref.model} is not served by this provider any more — pick one it serves`,
            live: live.slice(0, 20),
          };
        }
      }
      model = chosenModel;
      const ep = wizardEndpointFor(ref, keychain, model);
      if ("error" in ep) return { ok: false, error: ep.error };
      saveChoice(
        model && ref.section !== "rotation" ? ai.formatRef({ ...ref, model }) : ai.formatRef(ref),
      );
      picked.set(ref.section === "rotation" ? "rotation" : ref.providerId, ep);
      return { ok: true, endpoint: ep, label: ep.model };
    },

    /**
     * The cloud endpoints the chat picker should list: every provider with a key (its default
     * model), the remembered pick, and the rotation when it has members. The engine's own
     * `model:endpoints` lists base URLs with nothing about keys, so without this a key added in
     * the wizard would not show up in the pane's model menu at all.
     */
    async endpoints(): Promise<ModelWizardEndpointsResult> {
      const keychain = await keychainProviders(secretsStore());
      const out: WizardEndpoint[] = [];
      const seen = new Set<string>();
      const push = (e: WizardEndpoint): void => {
        if (seen.has(e.id)) return;
        seen.add(e.id);
        out.push(e);
      };
      for (const ep of picked.values()) push(ep);
      const saved = readChoice();
      const savedRef = saved ? ai.parseRef(saved) : null;
      if (savedRef && savedRef.section !== "local" && savedRef.section !== "served") {
        const ep = wizardEndpointFor(savedRef, keychain);
        if (!("error" in ep)) push(ep);
      }
      for (const c of ai.discoverCloudEndpoints({
        env,
        hasKeychainKey: (id) => keychain.has(id),
      })) {
        push({
          id: c.endpoint.id,
          baseUrl: c.endpoint.baseUrl,
          model: c.endpoint.model ?? "",
          locality: "cloud",
          contextWindow: c.endpoint.contextWindow,
        });
      }
      // The spinner is listed only once it was chosen through the picker (which shows its
      // members and warns that prompts reach several providers) — never offered in the chat
      // menu to someone who has not seen that, even though its keyless tier always exists.
      const chosenSpinner = picked.has("rotation") || savedRef?.section === "rotation";
      if (chosenSpinner) {
        const rot = wizardEndpointFor({ section: "rotation" }, keychain);
        if (!("error" in rot)) push(rot);
      }
      return { ok: true, endpoints: out };
    },

    /** For `ai-ipc.ts`: the rotation's members and a key resolver, computed in main. */
    async rotationForMain(): Promise<{
      members: ai.RotationMember[];
      resolveKey: (ref: string) => Promise<string>;
    }> {
      const keychain = await keychainProviders(secretsStore());
      return {
        members: ai.rotationMembers({ env, hasKeychainKey: (id) => keychain.has(id) }),
        resolveKey: resolveKeyRef,
      };
    },
  };
}

/** The process-wide instance `ai-ipc.ts` and the handlers share. */
let shared: ReturnType<typeof createModelWizard> | undefined;
export function modelWizard(): ReturnType<typeof createModelWizard> {
  shared = shared ?? createModelWizard();
  return shared;
}

/** Tests only: swap the shared instance for one with injected seams (undefined restores). */
export function setModelWizardForTest(w: ReturnType<typeof createModelWizard> | undefined): void {
  shared = w;
}
