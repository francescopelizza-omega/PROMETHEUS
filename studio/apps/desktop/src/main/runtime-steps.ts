// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * main/runtime-steps.ts — the llama.cpp and LM Studio steps of a guided model pick, in MAIN.
 *
 * The terminal could already prepare a local model for llama.cpp or LM Studio (`/models use
 * local:<id>@llamacpp`); the app said "not available in the app yet — use the terminal". These
 * are the same four steps the CLI host runs, with the same invariants:
 *
 *  - the weights are ALWAYS the file the gated download admitted (stage → Hugging Face sha256 →
 *    nemesis → library). The renderer names a catalogue id; main looks the admitted path up in
 *    the map its own fetch filled. A path never crosses the IPC seam, so a compromised renderer
 *    cannot point llama-server or LM Studio at an arbitrary file;
 *  - llama-server is started `--offline` on that file: it never fetches weights itself (`-hf`);
 *  - LM Studio gets a SYMLINK to that file (no `lms import`, no second copy), and its server is
 *    started only when it is not already answering;
 *  - runtimes are installed through their official package channel (modelhub install-runtime);
 *    a vendor `curl | sh` comes back as the exact command for the human, never run.
 *
 * Pure apart from the injected seams, so node:test drives it without a real server.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ai } from "@prometheus/core";

export type ServeRuntimeId = "llamacpp" | "lmstudio";

/** The OpenAI-compatible base each runtime answers on (the same ports the CLI host uses). */
export const RUNTIME_BASE: Record<ServeRuntimeId, string> = {
  llamacpp: "http://127.0.0.1:8080/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
};

export interface RuntimeStepDeps {
  /** spawn a detached model server (engine-bridge `startModelServer`). */
  startServer: (argv: readonly string[]) => { ok: boolean; error?: string };
  /** the model ids an OpenAI-compatible server lists, or null when it does not answer. */
  listModels: (base: string) => Promise<string[] | null>;
  /** `install-target --target lmstudio --link` through the modelhub client. */
  linkLmstudio: (id: string, path: string) => Promise<{ ok: boolean; error?: string }>;
  /** is `bin` runnable here (PATH, or a vendor dir such as ~/.lmstudio/bin)? */
  hasBin: (bin: string) => boolean;
  /** does something accept TCP connections on 127.0.0.1:`port`? (a server still loading
   *  answers /v1/models with an error, which `listModels` reports as null) */
  portOpen?: (port: number) => Promise<boolean>;
  /** re-check, right before serving, that the admission record still vouches for the file. */
  verifyAdmitted?: (path: string) => Promise<{ ok: boolean; error?: string }>;
  /** `lms ls --json` (key + folder path of every model LM Studio indexed); [] when unknown. */
  lmsList?: () => Promise<ai.LmStudioListed[]>;
  pollMs?: number;
  /** how long a freshly started server may take to list the model (default 3 minutes). */
  readyTimeoutMs?: number;
}

/** PATH lookup plus the vendor dir a runtime installs itself into. */
export function hasBinOn(
  bin: string,
  path: string | undefined,
  vendor: (b: string) => string | undefined,
): boolean {
  if ((path ?? "").split(":").some((d) => d && existsSync(join(d, bin)))) return true;
  return vendor(bin) !== undefined;
}

/** Which serving runtimes are installed — what the planner needs to add (or skip) an install. */
export function runtimeInstalled(
  hasBin: (bin: string) => boolean,
): Record<ServeRuntimeId, boolean> {
  return { llamacpp: hasBin("llama-server"), lmstudio: hasBin("lms") };
}

/** The key LM Studio lists for a file Prometheus linked as `prometheus/<id>`. Exact matches only. */
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

async function waitFor(
  deps: RuntimeStepDeps,
  base: string,
  ready: (models: string[]) => boolean | Promise<boolean>,
): Promise<boolean> {
  const step = deps.pollMs ?? 1000;
  const limit = deps.readyTimeoutMs ?? 180_000;
  for (let waited = 0; waited <= limit; waited += step) {
    const models = await deps.listModels(base);
    if (models && (await ready(models))) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/** A catalogue id is also the llama-server alias and part of the LM Studio key. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/** Start llama-server on the ADMITTED file, offline, and wait until it lists the alias. */
export async function serveAdmittedGguf(
  deps: RuntimeStepDeps,
  id: string,
  path: string,
  ctx: number,
): Promise<{ ok: true; baseUrl: string; model: string } | { ok: false; error: string }> {
  if (!SAFE_ID.test(id)) return { ok: false, error: "not a catalogue id" };
  const window = Number.isFinite(ctx) ? Math.max(512, Math.min(Math.floor(ctx), 1_048_576)) : 8192;
  const listed = await deps.listModels(RUNTIME_BASE.llamacpp);
  if (listed?.includes(id)) return { ok: true, baseUrl: RUNTIME_BASE.llamacpp, model: id };
  if (listed !== null) {
    // something already holds :8080 and serves another model — starting a second llama-server
    // would fail to bind, and "replacing" it is not this step's call to make
    return { ok: false, error: "llama.cpp is already serving another model on port 8080" };
  }
  if (await deps.portOpen?.(8080)) {
    // listening but not answering /v1/models: a llama-server still LOADING (e.g. the one a
    // timed-out earlier attempt started). A second spawn would load a second copy of the weights.
    return {
      ok: false,
      error: "port 8080 is busy (a llama-server still loading?) — wait for it, or stop it first",
    };
  }
  // the remembered path is re-verified against its signed admission record: the file may have
  // been removed, replaced or rewritten in place since it was admitted
  const ok = deps.verifyAdmitted ? await deps.verifyAdmitted(path) : { ok: true };
  if (!ok.ok) return { ok: false, error: `not served: ${ok.error ?? "no longer admitted"}` };
  const r = deps.startServer([
    "llama-server",
    "-m",
    path,
    "--host",
    "127.0.0.1",
    "--port",
    "8080",
    "-c",
    String(window),
    "--jinja",
    "--alias",
    id,
    "--offline",
  ]);
  if (!r.ok) return { ok: false, error: r.error ?? "llama-server did not start" };
  const up = await waitFor(deps, RUNTIME_BASE.llamacpp, (models) => models.includes(id));
  return up
    ? { ok: true, baseUrl: RUNTIME_BASE.llamacpp, model: id }
    : { ok: false, error: "llama-server started but did not list the model within 3 minutes" };
}

/** Link the ADMITTED file into LM Studio. */
export async function linkIntoLmstudio(
  deps: RuntimeStepDeps,
  id: string,
  path: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!SAFE_ID.test(id)) return { ok: false, error: "not a catalogue id" };
  return deps.linkLmstudio(id, path);
}

/** Start LM Studio's server when it is not answering, and resolve the key it lists for `id`. */
export async function startLmstudioFor(
  deps: RuntimeStepDeps,
  id: string,
): Promise<{ ok: true; baseUrl: string; model: string } | { ok: false; error: string }> {
  if (!SAFE_ID.test(id)) return { ok: false, error: "not a catalogue id" };
  const listed = await deps.listModels(RUNTIME_BASE.lmstudio);
  if (listed === null) {
    const r = deps.startServer(["lms", "server", "start", "--port", "1234"]);
    if (!r.ok) return { ok: false, error: r.error ?? "lms server start failed" };
  }
  let key: string | undefined;
  const repos = ai.lmStudioReposFor(ai.findLocalModel(id));
  let placedKeys: string[] = [];
  const up = await waitFor(deps, RUNTIME_BASE.lmstudio, async (models) => {
    // LM Studio indexes a newly placed file a moment after it lands: re-read each poll
    if (deps.lmsList && repos.length > 0)
      placedKeys = ai.lmStudioKeysForRepos(await deps.lmsList().catch(() => []), repos);
    key = lmStudioKeyFor(models, id, placedKeys);
    return key !== undefined;
  });
  if (!up || !key) return { ok: false, error: "LM Studio is up but does not list the model yet" };
  return { ok: true, baseUrl: RUNTIME_BASE.lmstudio, model: key };
}
