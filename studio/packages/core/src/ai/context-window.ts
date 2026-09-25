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

/**
 * How long a caller may block its FIRST turn on this probe before proceeding with the floor
 * anyway. The probe is fired fire-and-forget at session start for responsiveness (warmup), but
 * budgeting the first message or two against `DEFAULT_CONTEXT_WINDOW` while the real number is
 * still in flight over the loopback network is what made compaction over-trigger on a
 * 262144-window model as though it were about to overflow at 8k. A bounded await here — once,
 * before the first turn reads `endpoint.contextWindow` — closes that race without making
 * startup wait on a slow or unreachable runner indefinitely.
 */
export const CONTEXT_PROBE_AWAIT_MS = 4000;

/** A window that is almost certainly a misparse rather than a real model. */
const MIN_PLAUSIBLE = 512;
const MAX_PLAUSIBLE = 10_000_000;

/** Where a window came from — so a caller never presents a default as a measurement. */
export type ContextWindowSource = "ollama" | "ollama-loaded" | "openai-models" | "default";

export interface ContextWindowResult {
  contextWindow: number;
  source: ContextWindowSource;
  /**
   * Ollama's `/api/show` also reports a top-level `capabilities` array (e.g.
   * `["completion","tools","thinking"]`) — the SAME probe this module already makes, so the
   * capability that decides whether `/think` (effort tuning) does anything for a model is free
   * to read alongside the context length rather than needing its own round trip. `undefined`
   * means the probe didn't reach an Ollama `/api/show` (openai-models source, or failure).
   */
  capabilities?: readonly string[];
  /**
   * An opaque token identifying WHICH BUILD of the model answered — the thing that has to
   * change for a cached probe result to be stale.
   *
   * `ollama pull` on an already-present tag rewrites the blob in place: the endpoint id, the
   * baseUrl and the model name are all unchanged, so nothing a cache would naturally key on
   * moves. `modified_at` does, which is why it is the fallback here. A `digest` is preferred
   * where a build reports one (`/api/tags` always does; `/api/show` did not on Ollama 0.32.6),
   * because a digest changes on CONTENT and `modified_at` also changes on a no-op re-pull —
   * the latter costs one redundant probe, never a stale answer, which is the right way round.
   *
   * `undefined` ⇒ no identity was reported; a cache must then treat the entry as
   * unverifiable and fall back to a time bound rather than pretending it is fresh.
   */
  revision?: string;
}

/** The subset of `fetch` this module needs. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Hard ceiling on ONE probe request.
 *
 * A runner that refuses the connection fails fast on its own; the case this bounds is the
 * nastier one — a process that ACCEPTS the socket and then never answers. Without a bound that
 * hangs forever, and `/model` awaits this probe before reporting the switch, so the command
 * itself would hang with no output and no way back short of Ctrl-C.
 *
 * 2.5s, matching the desktop's `probeServedModels`, which bounds the same class of call against
 * the same runners. This is a loopback request that normally answers in single-digit
 * milliseconds; anything near the ceiling is already a broken runner.
 */
export const PROBE_TIMEOUT_MS = 2_500;

/** One bounded request. Resolves to null on timeout, refusal, or any transport error. */
async function bounded(
  doFetch: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<{ ok: boolean; json(): Promise<unknown> } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
/**
 * The context the loaded model is ACTUALLY being served with, from `/api/ps`.
 *
 * `/api/show` reports what the weights could do (`qwen3moe.context_length: 262144`); the daemon
 * may serve far less, because `OLLAMA_CONTEXT_LENGTH` caps it — this repo's own
 * `handoffs/ollama-safe-limits.sh` and `PROMETHEUS_OLLAMA_CAPS` both set 8192. Budgeting
 * against the declared number is how a 7,254-token prompt was built for an 8,192-token slot:
 * the preamble and instruction budgets scale with the window, so believing 262144 INFLATED the
 * prompt that then did not fit. `ollama ps` shows this number in its CONTEXT column.
 */
export function contextFromOllamaPs(payload: unknown, model: string): number | null {
  if (!isRecord(payload)) return null;
  const models = Array.isArray(payload.models) ? payload.models : [];
  const rows = models.filter(isRecord);
  const row = rows.find((m) => m.name === model || m.model === model) ?? rows[0];
  if (!row) return null;
  const n = plausible(row.context_length);
  if (n !== null) return n;
  const details = row.details;
  return isRecord(details) ? plausible(details.context_length) : null;
}

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

/**
 * Pull the `capabilities` array out of an Ollama `/api/show` payload.
 *
 * Reported at the top level (`{ capabilities: [...], model_info: {...}, ... }`), a plain array
 * of strings such as `"completion"`, `"tools"`, `"thinking"`, `"vision"`, `"embedding"`. Only
 * `"thinking"` is consumed today (by `ai/effort/rules.ts`'s probe-driven rules), but the raw
 * list is returned rather than a single boolean so a future capability doesn't need its own
 * probe wired in from scratch.
 */
export function capabilitiesFromOllamaShow(payload: unknown): readonly string[] | null {
  if (!isRecord(payload)) return null;
  const caps = payload.capabilities;
  if (!Array.isArray(caps)) return null;
  const strs = caps.filter((c): c is string => typeof c === "string");
  return strs.length > 0 ? strs : null;
}

/**
 * Pull a cache-invalidation token out of an Ollama `/api/show` payload.
 *
 * Prefers a content digest wherever a build reports one — `digest` at the top level, or
 * `details.digest` — and falls back to `modified_at`, which every build has reported since
 * `/api/show` existed. See `ContextWindowResult.revision` for why the fallback is the safe
 * direction to err in.
 */
export function revisionFromOllamaShow(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = payload.digest;
  if (typeof direct === "string" && direct !== "") return direct;
  const details = payload.details;
  if (isRecord(details) && typeof details.digest === "string" && details.digest !== "") {
    return details.digest;
  }
  const modified = payload.modified_at;
  return typeof modified === "string" && modified !== "" ? modified : undefined;
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

/** `/api/ps` → the loaded model's served context, or null when it is not loaded (or too old). */
async function servedContextWindow(
  root: string,
  model: string,
  doFetch: FetchLike,
  timeoutMs: number,
): Promise<number | null> {
  const res = await bounded(doFetch, `${root}/api/ps`, {}, timeoutMs);
  if (!res?.ok) return null;
  try {
    return contextFromOllamaPs(await res.json(), model);
  } catch {
    return null; // not JSON / an older daemon — the declared window stays the answer
  }
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
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ContextWindowResult> {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  {
    const res = await bounded(
      doFetch,
      `${root}/api/show`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      },
      timeoutMs,
    );
    if (res?.ok) {
      try {
        const payload = await res.json();
        const n = contextFromOllamaShow(payload);
        if (n !== null) {
          const capabilities = capabilitiesFromOllamaShow(payload);
          const revision = revisionFromOllamaShow(payload);
          // What the daemon SERVES wins over what the weights allow: it is the number the
          // request is actually measured against. Only when it is smaller — a loaded model is
          // never served more context than the architecture declares, and if /api/ps says
          // otherwise the declared number stays the safer budget.
          const served = await servedContextWindow(root, model, doFetch, timeoutMs);
          const effective = served !== null ? Math.min(n, served) : n;
          return {
            contextWindow: effective,
            source: served !== null && served < n ? "ollama-loaded" : "ollama",
            ...(capabilities ? { capabilities } : {}),
            ...(revision ? { revision } : {}),
          };
        }
      } catch {
        // a 200 whose body is not JSON (a proxy error page, a wrong runner) — fall through to
        // the /v1/models attempt, then to the floor. This function's whole contract is that it
        // never throws at its caller.
      }
    }
  }
  {
    const res = await bounded(doFetch, `${root}/v1/models`, {}, timeoutMs);
    if (res?.ok) {
      try {
        const body = await res.json();
        const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
        const entry = data.find((d) => isRecord(d) && d.id === model) ?? data[0];
        const n = contextFromModelsEntry(entry);
        if (n !== null) return { contextWindow: n, source: "openai-models" };
      } catch {
        // a body that is not JSON — fail soft to the floor, same as an unreachable runner.
      }
    }
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "default" };
}
