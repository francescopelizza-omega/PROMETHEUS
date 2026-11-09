// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/model-stores.ts — where each serving runtime keeps its models on this machine.
 *
 * Prometheus has NO model folder of its own. Every model it downloads, converts or installs ends
 * up in the store of the software that serves it, so nothing is kept twice:
 *
 *   ollama     `OLLAMA_MODELS`, else `~/.ollama/models` (a Linux service install keeps it under
 *              /usr/share/ollama — the sidecar finds that one)
 *   lmstudio   `<LM Studio home>/models`: the home named by `~/.lmstudio-home-pointer`, else
 *              the legacy `~/.cache/lm-studio`, else `~/.lmstudio`
 *   hf         the Hugging Face hub cache — `HF_HUB_CACHE` → `HF_HOME/hub` →
 *              `XDG_CACHE_HOME/huggingface/hub` → `~/.cache/huggingface/hub`. MLX-LM, AirLLM,
 *              vLLM, transformers and llama.cpp's own `-hf` downloads all read it.
 *   llamacpp   llama.cpp's cache for files that are not Hub repos — `LLAMA_CACHE`, else
 *              `~/Library/Caches/llama.cpp` (macOS) / `~/.cache/llama.cpp`
 *
 * Agents (OpenCode, Hermes, aider, Goose, Claude Code, Codex) keep no weights: they talk to one
 * of these servers. Pure: every input is a parameter (the caller reads the pointer file).
 */
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";

export type ModelStoreId = "ollama" | "lmstudio" | "hf" | "llamacpp";

export interface ModelStore {
  id: ModelStoreId;
  /** the runtimes that read it. */
  usedBy: string;
  dir: string;
  /** how the user moves it (Prometheus never does). */
  setBy: string;
}

export interface ModelStoreInputs {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  platform: string;
  /** the contents of `~/.lmstudio-home-pointer`, when it exists. */
  lmstudioPointer?: string;
  /** does `~/.cache/lm-studio/models` exist (LM Studio's legacy home)? */
  lmstudioLegacyExists?: boolean;
  /** the models folder chosen in LM Studio's own settings (`downloadsFolder`), when set. */
  lmstudioDownloadsFolder?: string;
}

const expand = (p: string, home: string): string =>
  p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;

export function modelStores(i: ModelStoreInputs): ModelStore[] {
  const e = i.env;
  const ollama = e.OLLAMA_MODELS?.trim()
    ? expand(e.OLLAMA_MODELS.trim(), i.home)
    : join(i.home, ".ollama", "models");
  const pointer = i.lmstudioPointer?.trim();
  const lmsHomeModels = pointer
    ? join(expand(pointer, i.home), "models")
    : i.lmstudioLegacyExists
      ? join(i.home, ".cache", "lm-studio", "models")
      : join(i.home, ".lmstudio", "models");
  // Same order as the sidecar's model_place.lmstudio_models_root (the folder files are placed
  // in): an explicit override, LM Studio's own folder setting, else <home>/models.
  const lmstudio = e.LMSTUDIO_MODELS_DIR?.trim()
    ? expand(e.LMSTUDIO_MODELS_DIR.trim(), i.home)
    : i.lmstudioDownloadsFolder?.trim()
      ? expand(i.lmstudioDownloadsFolder.trim(), i.home)
      : lmsHomeModels;
  const hf = e.HF_HUB_CACHE?.trim()
    ? expand(e.HF_HUB_CACHE.trim(), i.home)
    : e.HUGGINGFACE_HUB_CACHE?.trim()
      ? expand(e.HUGGINGFACE_HUB_CACHE.trim(), i.home)
      : e.HF_HOME?.trim()
        ? join(expand(e.HF_HOME.trim(), i.home), "hub")
        : join(
            e.XDG_CACHE_HOME?.trim()
              ? expand(e.XDG_CACHE_HOME.trim(), i.home)
              : join(i.home, ".cache"),
            "huggingface",
            "hub",
          );
  const llamacpp = e.LLAMA_CACHE?.trim()
    ? expand(e.LLAMA_CACHE.trim(), i.home)
    : i.platform === "darwin"
      ? join(i.home, "Library", "Caches", "llama.cpp")
      : join(
          e.XDG_CACHE_HOME?.trim()
            ? expand(e.XDG_CACHE_HOME.trim(), i.home)
            : join(i.home, ".cache"),
          "llama.cpp",
        );
  return [
    {
      id: "ollama",
      usedBy: "Ollama",
      dir: ollama,
      setBy: "OLLAMA_MODELS on the Ollama app or daemon",
    },
    { id: "lmstudio", usedBy: "LM Studio", dir: lmstudio, setBy: "LM Studio → My Models" },
    {
      id: "hf",
      usedBy: "llama.cpp, MLX-LM, AirLLM, colibri, vLLM",
      dir: hf,
      setBy: "HF_HOME / HF_HUB_CACHE",
    },
    { id: "llamacpp", usedBy: "llama.cpp (converted models)", dir: llamacpp, setBy: "LLAMA_CACHE" },
  ];
}

/** The LM Studio home the pointer / legacy rules name (for reading its settings file). */
function lmstudioHome(home: string, pointer: string | undefined): string {
  if (pointer?.trim()) return expand(pointer.trim(), home);
  if (existsSync(join(home, ".cache", "lm-studio", "models")))
    return join(home, ".cache", "lm-studio");
  return join(home, ".lmstudio");
}

/** `downloadsFolder` from LM Studio's settings.json, when set. */
export function lmstudioDownloadsFolder(lmsHome: string): string | undefined {
  for (const f of [
    join(lmsHome, "apps", "bionic", "settings.json"),
    join(lmsHome, "settings.json"),
  ]) {
    try {
      const v = (JSON.parse(readFileSync(f, "utf8")) as { downloadsFolder?: unknown })
        .downloadsFolder;
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch {
      /* unreadable or absent: next candidate */
    }
  }
  return undefined;
}

/** The stores on THIS machine (reads the pointer, the legacy home and LM Studio's settings). */
export function modelStoresOnThisMachine(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: string = process.platform,
): ModelStore[] {
  let pointer: string | undefined;
  try {
    pointer = readFileSync(join(home, ".lmstudio-home-pointer"), "utf8");
  } catch {
    pointer = undefined;
  }
  const folder = lmstudioDownloadsFolder(lmstudioHome(home, pointer));
  return modelStores({
    env,
    home,
    platform,
    ...(pointer ? { lmstudioPointer: pointer } : {}),
    lmstudioLegacyExists: existsSync(join(home, ".cache", "lm-studio", "models")),
    ...(folder ? { lmstudioDownloadsFolder: folder } : {}),
  });
}

/** Free bytes per store (measured on the nearest existing ancestor of each store dir). */
export function freeBytesByStore(
  stores: readonly ModelStore[],
): Partial<Record<ModelStoreId, number>> {
  const out: Partial<Record<ModelStoreId, number>> = {};
  for (const s of stores) {
    let p = s.dir;
    while (p && p !== dirname(p) && !existsSync(p)) p = dirname(p);
    try {
      const st = statfsSync(p || "/");
      out[s.id] = Number(st.bavail) * Number(st.bsize);
    } catch {
      /* unmeasurable: absent from the map, so the overall minimum is used */
    }
  }
  return out;
}

/** One row of `lms ls --json`: the key LM Studio serves a model under, and its folder path. */
export interface LmStudioListed {
  modelKey: string;
  path: string;
}

/**
 * The keys LM Studio serves the models Prometheus PLACED under these repo folders
 * (`<models>/<org>/<repo>/…`) under. LM Studio derives a sideloaded model's key from its file
 * name (and a staff pick's from its model.yaml), never from the folder — so the key is looked
 * up by path, exactly, instead of guessed. A model of the same NAME elsewhere in LM Studio's
 * folder (the user's own, unscanned) never matches.
 */
export function lmStudioKeysForRepos(
  listed: readonly LmStudioListed[],
  repos: readonly (string | undefined)[],
): string[] {
  const folders = repos
    .filter((r): r is string => !!r)
    .map((r) => r.toLowerCase().replace(/\/+$/, ""));
  return listed
    .filter((e) => {
      const p = e.path.toLowerCase();
      return folders.some((f) => p === f || p.startsWith(`${f}/`));
    })
    .map((e) => e.modelKey);
}

/** The repo folders a catalogue model can be placed under in LM Studio's folder. */
export function lmStudioReposFor(
  m: { gguf?: { repo: string }; ggufSmall?: { repo: string }; mlx?: string } | undefined,
): string[] {
  return m ? [m.gguf?.repo, m.ggufSmall?.repo, m.mlx].filter((r): r is string => !!r) : [];
}
