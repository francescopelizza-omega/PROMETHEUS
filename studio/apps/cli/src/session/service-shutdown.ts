// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * session/service-shutdown.ts — free local-AI memory on exit (CLI-SVC).
 *
 * When the user quits Prometheus, a local model left resident in Ollama keeps eating
 * RAM/VRAM/NPU (the `llama-server` child holds GBs). We offer to UNLOAD it before exit.
 *
 * C5: NO `child_process` here — the CLI never spawns. We use Ollama's own HTTP control
 * plane (`/api/ps` to see what's loaded, `keep_alive:0` to evict it), which frees the
 * heavy memory immediately. The idle `ollama serve` daemon (~tens of MB) is left running;
 * fully killing that daemon is a process spawn and must route through the engine bridge.
 *
 * LM Studio too (2026-10-22). This only ever asked Ollama, so a model LM Studio held — loaded
 * by Prometheus's own warm-up — stayed resident after quit, and `lms server stop` (the only other
 * teardown) frees the port, not the weights. LM Studio's REST listing says what is loaded and
 * `POST /api/v1/models/unload` frees it; no `lms` spawn is involved.
 *
 * PURE except for the injected `fetch` seam (tests pass a stub). Never throws.
 */
import { ai } from "@prometheus/core";
import { unloadLmStudio } from "@prometheus/engine-bridge";

/** Ollama's OpenAI-compatible runner also exposes these native control endpoints. */
const OLLAMA_PS_URL = "http://localhost:11434/api/ps";
const OLLAMA_GENERATE_URL = "http://localhost:11434/api/generate";

/** The fetch seam (default = global fetch); injected in tests. */
export type FetchFn = typeof fetch;

/** One model currently held resident by the local runner. */
export interface LoadedModel {
  name: string;
  /** which runner holds it — absent means Ollama (the historical, only, answer). */
  runner?: "ollama" | "lmstudio";
  /** approximate resident bytes (RAM + VRAM), 0 when the runner didn't report it. */
  sizeBytes: number;
}

/** Format a byte count as a short human string ("2.4 GB" / "480 MB"); "" for ≤0. */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const gb = n / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(n / 1e6)} MB`;
}

/** LM Studio's base URL on this machine (honours PROMETHEUS_RUNNER_LMSTUDIO_URL). */
function lmStudioUrl(): string {
  return ai.runnerById("lmstudio")?.baseUrl ?? "http://localhost:1234/v1";
}

/** Probe the local runners for models resident in memory. [] when none / unreachable. */
export async function detectLoadedAiModels(fetchFn: FetchFn = fetch): Promise<LoadedModel[]> {
  const [ollama, lms] = await Promise.all([detectOllama(fetchFn), detectLmStudio(fetchFn)]);
  return [...ollama, ...lms];
}

async function detectLmStudio(fetchFn: FetchFn): Promise<LoadedModel[]> {
  const listed = await ai.fetchLmStudioModels(lmStudioUrl(), { fetchFn, timeoutMs: 1500 });
  return (listed ?? [])
    .filter((m) => m.loaded.length > 0)
    .map((m) => ({ name: m.id, sizeBytes: m.sizeBytes, runner: "lmstudio" as const }));
}

async function detectOllama(fetchFn: FetchFn): Promise<LoadedModel[]> {
  try {
    const res = await fetchFn(OLLAMA_PS_URL, { method: "GET" });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: Array<{ name?: unknown; model?: unknown; size?: unknown; size_vram?: unknown }>;
    };
    const rows = Array.isArray(data.models) ? data.models : [];
    return rows.map((m) => {
      const name =
        typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : "?";
      const size =
        typeof m.size === "number" ? m.size : typeof m.size_vram === "number" ? m.size_vram : 0;
      return { name, sizeBytes: size };
    });
  } catch {
    return []; // no runner / not reachable ⇒ nothing loaded, nothing to free
  }
}

/** Evict each model (`keep_alive:0`) to free its RAM/VRAM. Returns how many were unloaded. */
export async function unloadAiModels(
  models: readonly LoadedModel[],
  fetchFn: FetchFn = fetch,
): Promise<number> {
  let freed = 0;
  const lms = models.filter((m) => m.runner === "lmstudio").map((m) => m.name);
  if (lms.length > 0) {
    // REST only (`lms: null`): this module never spawns
    const r = await unloadLmStudio(lmStudioUrl(), { fetchFn, only: lms, lms: null }).catch(
      () => null,
    );
    freed += r ? new Set(r.unloaded).size : 0;
  }
  for (const m of models) {
    if (m.runner === "lmstudio") continue;
    try {
      const res = await fetchFn(OLLAMA_GENERATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m.name, keep_alive: 0 }),
      });
      if (res.ok) freed++;
    } catch {
      /* best-effort: a model that won't evict shouldn't block the others or the exit */
    }
  }
  return freed;
}

/** Deps for the exit-time prompt (injected by the session host). */
export interface ExitShutdownDeps {
  /** ask a yes/no question (the TUI's confirm modal). */
  confirm: (prompt: string) => Promise<boolean>;
  /** write a status line to the transcript. */
  write: (text: string) => void;
  /** the fetch seam (default global). */
  fetchFn?: FetchFn;
}

/**
 * On exit: if a local model is resident, ask whether to free the memory, and unload on yes.
 * Never throws — a failure here must NEVER block the user from quitting.
 */
export async function maybeStopServicesOnExit(deps: ExitShutdownDeps): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  let loaded: LoadedModel[] = [];
  try {
    loaded = await detectLoadedAiModels(fetchFn);
  } catch {
    return;
  }
  if (loaded.length === 0) return; // nothing resident ⇒ nothing to offer

  const names = loaded.map((m) => m.name).join(", ");
  const total = loaded.reduce((a, m) => a + m.sizeBytes, 0);
  const size = humanBytes(total);
  const plural = loaded.length > 1 ? "s" : "";
  const prompt = `Free memory on exit? Unload local AI model${plural} (${names})${size ? ` — ~${size}` : ""}? [y/N]`;

  let ok = false;
  try {
    ok = await deps.confirm(prompt);
  } catch {
    ok = false; // a broken prompt ⇒ leave the model loaded, just exit
  }
  if (!ok) return;

  const freed = await unloadAiModels(loaded, fetchFn);
  deps.write(
    `  ⎿ freed ${freed} model${freed === 1 ? "" : "s"} from memory (RAM/GPU/NPU released; the model servers themselves left running)`,
  );
}
