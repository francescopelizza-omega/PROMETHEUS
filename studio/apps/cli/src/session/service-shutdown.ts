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
 * PURE except for the injected `fetch` seam (tests pass a stub). Never throws.
 */

/** Ollama's OpenAI-compatible runner also exposes these native control endpoints. */
const OLLAMA_PS_URL = "http://localhost:11434/api/ps";
const OLLAMA_GENERATE_URL = "http://localhost:11434/api/generate";

/** The fetch seam (default = global fetch); injected in tests. */
export type FetchFn = typeof fetch;

/** One model currently held resident by the local runner. */
export interface LoadedModel {
  name: string;
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

/** Probe the local runner for models resident in memory. [] when none / unreachable. */
export async function detectLoadedAiModels(fetchFn: FetchFn = fetch): Promise<LoadedModel[]> {
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
  for (const m of models) {
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
    `  ⎿ freed ${freed} model${freed === 1 ? "" : "s"} from memory (RAM/GPU/NPU released; ollama daemon left running)`,
  );
}
