/**
 * ai/context-window.ts — how big is this model's context, really?
 *
 * Every endpoint this repo constructs hard-codes `contextWindow: 8192`
 * (`session/onboarding.ts`, `orchestration/backends.ts`). That number is not measured and it
 * is usually wrong by an order of magnitude: on the machine this was written for, Ollama
 * reports 8192 for `gemma4:12b` and **262144** for `qwen3.6`. Assuming the floor caps the
 * agent far below the hardware, and it is the number compaction budgets against — so a long
 * agentic run compacts a 262k-window model as though it were about to overflow at 8k.
 *
 * The fix is to ASK. Ollama answers `/api/show` with the architecture's context length, and
 * OpenAI-compatible `/v1/models` sometimes carries one. Neither is guaranteed, so this is
 * fail-soft by construction: an unreachable runner, a shape we do not recognise, or a
 * nonsense value all fall back to the documented default, and the caller is told WHICH it
 * got so it can say so rather than implying a measurement it never made.
 *
 * PURE except for the injected `fetch`. No node built-ins.
 */

/** The conservative floor used when nothing reports a real number. */
export const DEFAULT_CONTEXT_WINDOW = 8192;

/** A window that is almost certainly a misparse rather than a real model. */
const MIN_PLAUSIBLE = 512;
const MAX_PLAUSIBLE = 10_000_000;

/** Where a window came from — so a caller never presents a default as a measurement. */
export type ContextWindowSource = "ollama" | "openai-models" | "default";

export interface ContextWindowResult {
  contextWindow: number;
  source: ContextWindowSource;
}

/** The subset of `fetch` this module needs. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Accept a finite, plausibly-sized integer; reject everything else. */
function plausible(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const v = Math.floor(n);
  return v >= MIN_PLAUSIBLE && v <= MAX_PLAUSIBLE ? v : null;
}

/**
 * Pull a context length out of an Ollama `/api/show` payload.
 *
 * The number lives under `model_info` on an architecture-prefixed key —
 * `qwen3moe.context_length`, `llama.context_length`, `gemma3.context_length` — so the key is
 * matched by SUFFIX rather than enumerated. Enumerating would mean this silently returns the
 * default for every architecture released after it was written.
 */
export function contextFromOllamaShow(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const info = payload.model_info;
  if (isRecord(info)) {
    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith(".context_length")) {
        const n = plausible(v);
        if (n !== null) return n;
      }
    }
  }
  // Some builds surface it on `details`, and a few flatten it to the top level.
  const details = payload.details;
  if (isRecord(details)) {
    const n = plausible(details.context_length);
    if (n !== null) return n;
  }
  return plausible(payload.context_length);
}

/** Pull a context length out of an OpenAI-compatible `/v1/models` entry. */
export function contextFromModelsEntry(entry: unknown): number | null {
  if (!isRecord(entry)) return null;
  // `context_length` is the llama.cpp/vLLM spelling; `max_context_length` and
  // `max_model_len` appear on other shims.
  for (const key of ["context_length", "max_context_length", "max_model_len"]) {
    const n = plausible(entry[key]);
    if (n !== null) return n;
  }
  const meta = entry.meta;
  if (isRecord(meta)) return plausible(meta.n_ctx);
  return null;
}

/**
 * Ask a LOCAL runner what the model's context length is.
 *
 * Local only, on purpose: `/api/show` is an Ollama endpoint, and firing an unknown POST at a
 * cloud provider to satisfy curiosity is not something a privacy-first client should do. A
 * cloud endpoint keeps whatever window its connector declared.
 */
export async function probeContextWindow(
  baseUrl: string,
  model: string,
  doFetch: FetchLike,
): Promise<ContextWindowResult> {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const res = await doFetch(`${root}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (res.ok) {
      const n = contextFromOllamaShow(await res.json());
      if (n !== null) return { contextWindow: n, source: "ollama" };
    }
  } catch {
    // unreachable runner, wrong runner, no such endpoint — all fall through to the default.
  }
  try {
    const res = await doFetch(`${root}/v1/models`);
    if (res.ok) {
      const body = await res.json();
      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      const entry = data.find((d) => isRecord(d) && d.id === model) ?? data[0];
      const n = contextFromModelsEntry(entry);
      if (n !== null) return { contextWindow: n, source: "openai-models" };
    }
  } catch {
    // same: fail soft.
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "default" };
}
