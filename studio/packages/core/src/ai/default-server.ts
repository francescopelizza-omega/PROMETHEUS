// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ai/default-server.ts — the user's DEFAULT LOCAL MODEL SERVER (`/server` in the terminal, the
 * "Default local server" picker in the app). Ollama unless the user picks another.
 *
 * One persisted key in the SHARED `~/.prometheus/config/settings.json`, so the terminal and the
 * app agree. What the choice changes, and nothing more:
 *  - which running server a session adopts when several serve models;
 *  - which installed server is started first when none is running (at most one is started);
 *  - the runtime a local catalogue pick is prepared for when the pick names none
 *    (`local:<id>` → `local:<id>@llamacpp` when llama.cpp is the default and the model has a GGUF).
 *
 * A pick that needs ANOTHER server (a model with no Ollama build, an MLX-only build) moves the
 * default to that server once it is adopted — `defaultServerAfterPick` — so the user never has
 * to know which engine a model needs.
 *
 * Pure: no IO.
 */

export const DEFAULT_SERVER_KEY = "localModels.defaultServer";

/** The servers that can be the default: the ones Prometheus can probe, start and serve on. */
export const DEFAULT_SERVER_IDS = ["ollama", "lmstudio", "llamacpp", "mlx", "vllm"] as const;
export type DefaultServerId = (typeof DEFAULT_SERVER_IDS)[number];

export const DEFAULT_SERVER: DefaultServerId = "ollama";

/** Picker rows: name on the left, two lines on the right (the TUI's two-column layout). */
export const DEFAULT_SERVER_INFO: Readonly<
  Record<DefaultServerId, { name: string; lines: readonly [string, string] }>
> = {
  ollama: {
    name: "Ollama",
    lines: [
      "The default. Pulls from its registry; every pull is scanned by nemesis.",
      "Port 11434 · serves GGUF imports too · one model resident at a time.",
    ],
  },
  lmstudio: {
    name: "LM Studio",
    lines: [
      "Desktop app + `lms` CLI; gated downloads are LINKED into it (no copy).",
      "Port 1234 · good on Apple Silicon (MLX and GGUF engines).",
    ],
  },
  llamacpp: {
    name: "llama.cpp",
    lines: [
      "llama-server on the admitted GGUF, offline — the leanest server.",
      "Port 8080 · handles split GGUFs that Ollama cannot import.",
    ],
  },
  mlx: {
    name: "MLX-LM",
    lines: [
      "Apple's MLX engine on the admitted MLX build, offline — fastest on M-series Macs.",
      "Port 8090 · Apple Silicon only · picked for models that ship only an MLX build.",
    ],
  },
  vllm: {
    name: "vLLM",
    lines: [
      "High-throughput GPU server (Linux/NVIDIA); adopted when it is running.",
      "Port 8000 · install it yourself (pip/uv) — Prometheus never runs a vendor script.",
    ],
  },
};

export function isDefaultServerId(v: unknown): v is DefaultServerId {
  return typeof v === "string" && (DEFAULT_SERVER_IDS as readonly string[]).includes(v);
}

/** The saved default from a settings object (anything invalid or absent → Ollama). */
export function defaultServerFrom(settings: Record<string, unknown> | undefined): DefaultServerId {
  const v = settings?.[DEFAULT_SERVER_KEY];
  return isDefaultServerId(v) ? v : DEFAULT_SERVER;
}

/** `items` with the preferred server first, the rest in their original (registry) order. */
export function preferFirst<T>(
  items: readonly T[],
  idOf: (t: T) => string,
  preferred: string,
): T[] {
  const hit = items.filter((t) => idOf(t) === preferred);
  return [...hit, ...items.filter((t) => idOf(t) !== preferred)];
}

/** The running server a session should adopt: the preferred one when it serves a model, else
 *  the first that does. */
export function pickServingRunner<R extends { name: string; models: readonly string[] }>(
  runners: readonly R[],
  preferred: string,
): R | undefined {
  return (
    runners.find((r) => r.name === preferred && r.models.length > 0) ??
    runners.find((r) => r.models.length > 0)
  );
}

/** The runtime a local catalogue pick is prepared for when the ref names none: llama.cpp or LM
 *  Studio when that is the default AND the model has a GGUF (Ollama otherwise). */
export function runtimeForDefault(
  defaultServer: string | undefined,
  hasGguf: boolean,
): "llamacpp" | "lmstudio" | undefined {
  if (!hasGguf) return undefined;
  return defaultServer === "llamacpp" || defaultServer === "lmstudio" ? defaultServer : undefined;
}

/**
 * The default server after a local pick was adopted on `servedBy`: that server, when it can be a
 * default and differs from the current one; otherwise unchanged. Streaming runtimes (AirLLM,
 * colibri, llama.cpp from SSD) never become the default — they exist for one model.
 */
export function defaultServerAfterPick(
  current: string | undefined,
  servedBy: string | undefined,
): { next: DefaultServerId; changed: boolean } {
  const cur = isDefaultServerId(current) ? current : DEFAULT_SERVER;
  if (!isDefaultServerId(servedBy) || servedBy === cur) return { next: cur, changed: false };
  return { next: servedBy, changed: true };
}
