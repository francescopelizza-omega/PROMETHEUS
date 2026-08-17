/**
 * routes/models-hub-view.ts — PURE view model for the handoff_3 §3 Model Hub.
 *
 * §3 asks for four islands: Serving now, Installed, Pull a model, Endpoints. Three of the
 * four turn on a judgement the JSX should not be making — how big is this file really, is
 * this endpoint reachable at THIS authorisation level, how far along is a pull — so those
 * live here where node:test can pin them.
 *
 * ## What this file refuses to invent
 *
 * §3 asks the Serving island for `tok/s`, `memory` and `load time` chips. None of the three
 * exists: `ModelServeRow` carries a status, an endpoint and the runner argv, and the sidecar's
 * `model.list` measures files, not inference. There is a tokens/sec figure inside the AI chat
 * path, but it describes whatever endpoint the CHAT is pointed at, which is not necessarily
 * the profile this island is showing — reusing it would put a real-looking number next to the
 * wrong model. So `metricChips` emits a chip only for a metric it actually has, and the
 * absent ones are absent rather than zeroed. A dash is honest; `0 tok/s` is not.
 */

/* ── sizes ───────────────────────────────────────────────────────────────────*/

/**
 * Bytes → the short human form §3 shows in a row (`4.1 GB`).
 *
 * Binary units, because that is what the sidecar computes (`size / 1024**3`) and what Ollama
 * reports; mixing decimal GB here would make the Installed island disagree with the pull
 * progress line about the same file.
 */
export function formatBytes(bytes: number | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

/** Sum the sizes we know. Rows with no size contribute nothing — see `installedTotal`. */
export function installedTotal(rows: readonly { sizeBytes?: number }[]): {
  bytes: number;
  /** how many rows had NO size, so the header can say "≥" instead of implying a total. */
  unknown: number;
} {
  let bytes = 0;
  let unknown = 0;
  for (const r of rows) {
    if (typeof r.sizeBytes === "number" && r.sizeBytes > 0) bytes += r.sizeBytes;
    else unknown += 1;
  }
  return { bytes, unknown };
}

/* ── the Serving island's metric chips ───────────────────────────────────────*/

/** One metric pill. `value` is already formatted; a metric with no source never gets one. */
export interface MetricChip {
  label: string;
  value: string;
}

/** The facts a serve row can actually supply. Everything is optional on purpose. */
export interface ServingFacts {
  /** the runner's configured context length (`args.ctxLen`). */
  ctxLen?: number;
  /** measured tokens/sec, if a caller ever has one FOR THIS PROFILE. */
  tokensPerSecond?: number;
  /** resident bytes for the runner process, if a caller ever has one. */
  memoryBytes?: number;
  /** milliseconds from spawn to ready, if a caller ever has one. */
  loadMs?: number;
}

/**
 * Build the metric pills for the Serving island.
 *
 * The ORDER is §3's (tok/s, ctx, memory, load time); the CONTENT is whatever is real. Today
 * that is context length alone, and the island says so rather than showing three zeros.
 */
export function metricChips(f: ServingFacts): MetricChip[] {
  const out: MetricChip[] = [];
  if (typeof f.tokensPerSecond === "number" && f.tokensPerSecond > 0) {
    out.push({ label: "tok/s", value: f.tokensPerSecond.toFixed(1) });
  }
  if (typeof f.ctxLen === "number" && f.ctxLen > 0) {
    out.push({
      label: "ctx",
      value: f.ctxLen >= 1024 ? `${Math.round(f.ctxLen / 1024)}k` : String(f.ctxLen),
    });
  }
  const mem = formatBytes(f.memoryBytes);
  if (mem) out.push({ label: "memory", value: mem });
  if (typeof f.loadMs === "number" && f.loadMs > 0) {
    out.push({
      label: "load",
      value: f.loadMs >= 1000 ? `${(f.loadMs / 1000).toFixed(1)}s` : `${Math.round(f.loadMs)}ms`,
    });
  }
  return out;
}

/* ── the Pull island's progress line ─────────────────────────────────────────*/

/** A parsed pull progress line: `62% · 4.1 of 6.6 GB`. */
export interface PullProgress {
  /** 0..100, or null when the line carried no percentage. */
  pct: number | null;
  /** the "4.1 of 6.6 GB" half, or null when the line carried no byte figures. */
  bytes: string | null;
}

const PCT = /(\d{1,3})\s*%/;
// ollama prints e.g. "pulling 8934d96d3f08: 62% ▕███ ▏ 4.1 GB/6.6 GB  12 MB/s"
const BYTES = /([\d.]+)\s*([KMGT]i?B)\s*\/\s*([\d.]+)\s*([KMGT]i?B)/i;

/**
 * Parse a pull progress event into the §3 line.
 *
 * `ModelProgressEvent.pct` is authoritative when main set it; the byte figures only exist in
 * the runner's `raw` line, so both are read and either half may be missing. A line that
 * parses to nothing returns nulls rather than a fabricated 0% — a progress bar that sits at
 * zero while a 6 GB download runs is worse than no bar.
 */
export function parsePullProgress(
  event: { pct?: number; raw?: string; message?: string } | null | undefined,
): PullProgress {
  if (!event) return { pct: null, bytes: null };
  const text = `${event.raw ?? ""} ${event.message ?? ""}`;
  let pct: number | null =
    typeof event.pct === "number" && Number.isFinite(event.pct) ? event.pct : null;
  if (pct === null) {
    const m = PCT.exec(text);
    if (m?.[1]) pct = Number(m[1]);
  }
  if (pct !== null) pct = Math.max(0, Math.min(100, pct));

  const b = BYTES.exec(text);
  const bytes = b ? `${b[1]} of ${b[3]} ${b[4]}` : null;
  return { pct, bytes };
}

/** The §3 note under the pull bar. Kept here so the copy has one home. */
export const PULL_SCAN_NOTE = "manifest scanned by nemesis · will not auto-serve";

/* ── the Endpoints island ────────────────────────────────────────────────────*/

/**
 * The authorisation level at which an agent may reach the NETWORK.
 *
 * Not a number invented for this island: `AUTH_LEVELS[5]` is the rung whose `auto` set first
 * includes `install`/network work, which is what a cloud endpoint is. Cloud rows below it are
 * shown but greyed, because hiding them would make "why can't I use my key" unanswerable.
 */
export const CLOUD_MIN_AUTH = 5;

/** One row of the Endpoints island. */
export interface EndpointRow {
  name: string;
  baseUrl: string;
  locality: "local" | "cloud";
  /** may the CURRENT authorisation level use it? */
  usable: boolean;
  /** why not, when `usable` is false — shown verbatim beside the row. */
  note?: string;
}

/**
 * Classify one endpoint against the current level.
 *
 * `localityOf` is NOT re-implemented here — `ide/ai/endpoints.ts` owns that classification
 * and the privacy guard (`neverSendToCloud`) reads the same function, so a second copy that
 * drifted would let a "local" label disagree with what actually gets sent.
 */
export function endpointRow(
  ep: { name: string; baseUrl: string },
  locality: "local" | "cloud",
  authLevel: number,
): EndpointRow {
  if (locality === "local") {
    return { name: ep.name, baseUrl: ep.baseUrl, locality, usable: true };
  }
  const usable = authLevel >= CLOUD_MIN_AUTH;
  return {
    name: ep.name,
    baseUrl: ep.baseUrl,
    locality,
    usable,
    ...(usable ? {} : { note: `key in keychain · A${CLOUD_MIN_AUTH}+ only` }),
  };
}

/* ── the Installed island ────────────────────────────────────────────────────*/

/** One row of the Installed island — exactly the cells §3 names, each nullable. */
export interface InstalledRow {
  id: string;
  /** `4.1 GB`, or null when nothing measured it. */
  size: string | null;
  /** the raw byte count behind `size`, so the island header can total what it knows. */
  sizeBytes?: number;
  /** `32k`, or null — `model.list` does not report a context length. */
  ctx: string | null;
  /** `Q4_K_M`, or null. */
  quant: string | null;
  /** is a runner already serving it? */
  served: boolean;
}

/** The shape the Installed island reads. Structural, so the contract type satisfies it. */
export interface InstalledSource {
  id: string;
  sizeBytes?: number;
  contextLen?: number;
  quant?: string;
  params?: string;
  served?: boolean;
}

/**
 * Project the library payload into rows.
 *
 * `quant` falls back to `params` because the sidecar puts Ollama's `parameter_size` there
 * ("8B") when it could not read a quantization level — a size class is a worse answer than a
 * quantization but a much better one than a blank cell, and both are facts about the file.
 */
export function installedRows(models: readonly InstalledSource[]): InstalledRow[] {
  return models.map((m) => ({
    id: m.id,
    size: formatBytes(m.sizeBytes),
    ...(typeof m.sizeBytes === "number" && m.sizeBytes > 0 ? { sizeBytes: m.sizeBytes } : {}),
    ctx:
      typeof m.contextLen === "number" && m.contextLen > 0
        ? m.contextLen >= 1024
          ? `${Math.round(m.contextLen / 1024)}k`
          : String(m.contextLen)
        : null,
    quant: m.quant ?? m.params ?? null,
    served: m.served === true,
  }));
}
