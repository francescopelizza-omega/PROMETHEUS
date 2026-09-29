/**
 * ai/ollama-log-parse.ts — mining ollama's own log for what models REALLY cost.
 *
 * ── WHY BOTHER ──────────────────────────────────────────────────────────────────────────────
 *
 * `/api/ps` answers "what is resident right now", which on an idle machine is nothing. But every
 * load ollama has ever performed left an exact record behind, and that record is sitting on disk:
 *
 *   llama_kv_cache: size = 2720.00 MiB (262144 cells, 10 layers, 1/1 seqs),
 *                   K (q8_0): 1360.00 MiB, V (q8_0): 1360.00 MiB
 *   load_tensors:   CPU_Mapped model buffer size = 21924.02 MiB
 *
 * That is the ground truth the estimator wants, for free, with nothing loaded and no memory
 * spent to get it. Harvesting it turns a cold machine's first admission decision from a
 * prediction into a recollection — which is the whole point of the ledger.
 *
 * ── THE ATTRIBUTION PROBLEM ─────────────────────────────────────────────────────────────────
 *
 * The allocation lines do not name the model. The load that produced them does, several lines
 * earlier, in a different format depending on the ollama version — `general.name`, a blob path,
 * or ollama's own `msg="starting llama server"` line carrying the model. So this parses
 * FORWARD, holding the most recent model identity seen, and attributes each allocation to it.
 *
 * A block whose model cannot be identified is returned with `model: undefined` rather than
 * dropped or guessed. An unattributed measurement is still useful — it proves what the machine
 * did — and guessing which model it belonged to would poison the ledger with confident nonsense.
 *
 * PURE: string in, records out. The file reading lives in engine-bridge (C5).
 */

/** One load's measured allocation, as the log recorded it. */
export interface OllamaLoadRecord {
  /** the model, when a nearby line named one. */
  model?: string;
  /** KV cache bytes. */
  kvBytes?: number;
  /** cells the cache was sized for — this is the served context. */
  contextTokens?: number;
  /** how many layers kept a cache. */
  kvLayers?: number;
  /** K/V element type, as the log spells it ("q8_0", "f16", …). */
  kvType?: string;
  /** summed tensor buffer bytes — the weights as actually mapped. */
  weightsBytes?: number;
  /** line index the KV line appeared at, so a caller can order records. */
  atLine: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** `2720.00 MiB` / `21.4 GiB` / `512.00 KiB` → bytes. */
export function parseSizeToBytes(value: string, unit: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const u = unit.toLowerCase();
  if (u.startsWith("k")) return Math.round(n * 1024);
  if (u.startsWith("m")) return Math.round(n * MIB);
  if (u.startsWith("g")) return Math.round(n * GIB);
  if (u.startsWith("t")) return Math.round(n * GIB * 1024);
  return Math.round(n);
}

/**
 * The KV cache line, in the shapes llama.cpp has used.
 *
 * Both `llama_kv_cache:` and the older `llama_kv_cache_unified:` / `llama_new_context_with_model:`
 * prefixes appear across versions, so the prefix is matched loosely and the NUMBERS carry the
 * meaning — they have not changed.
 */
const KV_LINE =
  /llama_kv_cache[a-z_]*:\s*(?:size\s*=\s*)?([\d.]+)\s*([KMGT]i?B)\s*\(\s*([\d,]+)\s*cells?\s*,\s*(\d+)\s*layers?/i;

/** `K (q8_0): 1360.00 MiB` — the element type, which tells us how the cache was quantised. */
const KV_TYPE = /\bK\s*\(([a-z0-9_]+)\)/i;

/** `load_tensors: CPU_Mapped model buffer size = 21924.02 MiB` and its Metal/CUDA siblings. */
const TENSOR_LINE =
  /(?:load_tensors|llm_load_tensors):.*?buffer size\s*=\s*([\d.]+)\s*([KMGT]i?B)/i;

/**
 * Lines that name the model being loaded.
 *
 * ── WHY THIS IS HARDER THAN IT LOOKS ────────────────────────────────────────────────────────
 *
 * The obvious approach — carry the last name seen forward — is wrong against a real ollama log.
 * A load sequence on this machine reads:
 *
 *   3872  msg="loading model via llama-server" model=/Users/…/blobs/sha256-f5ee307a…
 *   3505  print_info: general.name          = n/a
 *   3551  load_tensors: MTL0 model buffer size = 21171.18 MiB
 *   3556  llama_kv_cache: size = 2720.00 MiB (262144 cells, 10 layers …)
 *   3727  msg="template selection" model=registry.ollama.ai/library/qwen3.6:latest
 *
 * The only name a user would recognise arrives ~170 lines AFTER the allocation it describes.
 * `general.name` is literally "n/a", and the line that does precede the allocation names a
 * content-addressed blob. So attribution searches in BOTH directions for the nearest usable
 * name, rather than assuming chronological order helps.
 */
const MODEL_LINES: readonly RegExp[] = [
  // ollama's own structured lines: `model=registry.ollama.ai/library/qwen3.6:latest`
  /\bmodel=([^\s"]+)/,
  /"model"\s*:\s*"([^"]+)"/i,
  /general\.name\s*(?:=|str\s*=)\s*(.+?)\s*$/i,
  /loading model\s+'?([^\s']+)'?/i,
];

/**
 * Strip a registry prefix so the name matches what `/api/tags` returns.
 *
 * `registry.ollama.ai/library/qwen3.6:latest` and `qwen3.6:latest` are the same model, and the
 * ledger is keyed on the name the rest of the system uses. Only the well-known default registry
 * and its `library` namespace are stripped — a name from a private registry keeps its prefix,
 * because there it is part of the identity.
 */
export function normalizeModelName(raw: string): string {
  let s = raw.trim().replace(/^["']|["']$/g, "");
  s = s.replace(/^registry\.ollama\.ai\//i, "");
  s = s.replace(/^(?:docker\.io\/)?library\//i, "");
  return s;
}

/** Pull a model name out of a line, if it carries one a user would recognise. */
export function modelNameFrom(line: string): string | undefined {
  for (const re of MODEL_LINES) {
    const m = re.exec(line);
    const raw = m?.[1]?.trim();
    if (!raw) continue;
    // A blob path is content-addressed: it is an identity, but not one `/api/tags` ever returns
    // and not one a user could match to anything, so it is no use as a ledger key.
    if (/^\/|sha256[-:]/.test(raw)) continue;
    // ollama prints `general.name = n/a` for models whose GGUF omits it. Not a name.
    if (/^n\/?a$/i.test(raw)) continue;
    const cleaned = normalizeModelName(raw);
    // A model id always carries a tag or a slash; a bare word here is some other `model=` field.
    if (!/[:/]/.test(cleaned)) continue;
    if (cleaned && cleaned.length < 128) return cleaned;
  }
  return undefined;
}

/**
 * Parse a whole log into load records.
 *
 * Tensor buffer lines are SUMMED between KV lines rather than taken singly: a split load reports
 * one buffer per device (`CPU_Mapped`, `Metal`, `CUDA0`…) and the weights are their total. Taking
 * the largest would silently under-count a model spread across two devices, which is the error
 * that matters here — it would make a model look like it fits when it does not.
 */
export function parseOllamaLog(text: string): OllamaLoadRecord[] {
  const lines = text.split("\n");
  const out: OllamaLoadRecord[] = [];
  /** every line that names a model, so attribution can look forwards as well as back. */
  const names: { at: number; model: string }[] = [];
  let tensorBytes = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    const named = modelNameFrom(line);
    if (named) names.push({ at: i, model: named });

    const tensor = TENSOR_LINE.exec(line);
    if (tensor?.[1] && tensor[2]) {
      // SUMMED, not replaced: a split load reports one buffer per device (`MTL0` 21171.18 MiB
      // and `CPU` 272.81 MiB on this machine) and the weights are their total. Taking the
      // largest would under-count a model spread across two devices — the error that matters,
      // because it makes a model look like it fits when it does not.
      const b = parseSizeToBytes(tensor[1], tensor[2]);
      if (b !== null) tensorBytes += b;
      continue;
    }

    const kv = KV_LINE.exec(line);
    if (!kv) continue;
    const kvBytes = kv[1] && kv[2] ? parseSizeToBytes(kv[1], kv[2]) : null;
    const cells = kv[3] ? Number(kv[3].replace(/,/g, "")) : Number.NaN;
    const layers = kv[4] ? Number(kv[4]) : Number.NaN;
    const type = KV_TYPE.exec(line)?.[1];
    out.push({
      ...(kvBytes !== null ? { kvBytes } : {}),
      ...(Number.isFinite(cells) && cells > 0 ? { contextTokens: cells } : {}),
      ...(Number.isFinite(layers) && layers > 0 ? { kvLayers: layers } : {}),
      ...(type ? { kvType: type } : {}),
      ...(tensorBytes > 0 ? { weightsBytes: tensorBytes } : {}),
      atLine: i + 1,
    });
    tensorBytes = 0;
  }

  // Second pass: attribute each allocation to the nearest name in EITHER direction. See the
  // comment on MODEL_LINES — the recognisable name is logged after the allocation it describes.
  for (const rec of out) {
    const model = nearestModel(names, rec.atLine - 1);
    if (model) rec.model = model;
  }
  return out;
}

/**
 * The model named closest to a line, looking both ways.
 *
 * Bounded by `maxDistance` so an allocation in a log whose naming lines were rotated away is
 * left unattributed rather than captured by an unrelated load hundreds of lines off. One load's
 * span in a real log is a few hundred lines; 600 covers it without reaching the next one.
 */
export function nearestModel(
  names: readonly { at: number; model: string }[],
  at: number,
  maxDistance = 600,
): string | undefined {
  let best: { d: number; model: string } | undefined;
  for (const n of names) {
    const d = Math.abs(n.at - at);
    if (d > maxDistance) continue;
    if (!best || d < best.d) best = { d, model: n.model };
  }
  return best?.model;
}

/**
 * The freshest usable record per model.
 *
 * "Usable" means it carries both a KV size and the context it was sized for — without the
 * context the number cannot be re-scaled, and re-scaling is the entire value of the ledger.
 */
export function latestPerModel(records: readonly OllamaLoadRecord[]): OllamaLoadRecord[] {
  const byModel = new Map<string, OllamaLoadRecord>();
  for (const r of records) {
    if (!r.model || r.kvBytes === undefined || r.contextTokens === undefined) continue;
    const prev = byModel.get(r.model);
    if (!prev || r.atLine > prev.atLine) byModel.set(r.model, r);
  }
  return [...byModel.values()];
}
