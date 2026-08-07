/**
 * modelhub/store.ts — the framework-free Model Hub state layer (file 05 §1,§5,§7).
 *
 * The ISOMORPHIC core of the Model Hub screen, mirroring env-store.ts: PURE
 * reducers + selectors over three pieces of state —
 *   1. the DOWNLOAD QUEUE — a per-item state machine that models the §5 security
 *      flow (queued → staging → scanning → admitted | blocked | quarantined),
 *   2. the LIBRARY CACHE — discovered/installed Model[] indexed by id + modality,
 *   3. the SERVE-PROFILE state — stopped | starting | ready | error per profile.
 *
 * Deliberately NO react / NO zustand import — core stays isomorphic and is wrapped
 * by BOTH the desktop renderer (Zustand) and the `prometheus` CLI. This file owns only
 * the transition math + selectors so both surfaces behave identically.
 *
 * GOLDEN RULE (C5): nothing here decides "safe". The download state machine MODELS
 * the verdict the REAL nemesis produced on the staged dir (file 05 §5):
 *   - a `scanAllow` event (nemesis verdict "allow") is the only passive path to
 *     `admitted` (move stage → live library),
 *   - a `scanWarn` parks the item at `confirm` until the user explicitly admits it,
 *   - a `scanBlock` / `scanError` (nemesis "block"/"error", a sha256 mismatch, or a
 *     fail-closed missing/timeout/unparseable scan) is the ONLY path to `blocked`,
 *     and `blocked` → `quarantined` is a TERMINAL sink (the .stage dir is KEPT for
 *     inspection, never auto-deleted — matching the engine PURGE_DIR pattern).
 * JS never upgrades a verdict toward admit; it only renders the engine outcome.
 */

import type {
  ForcedDanger,
  Model,
  NemesisVerdictRef,
  Quant,
  ServeProfile,
} from "../domain/models.js";

// ====================================================================== //
//  §5 download queue — the per-item state machine.                        //
// ====================================================================== //

/**
 * A download item's lifecycle state (file 05 §5 flow):
 *
 *   queued      enqueued, waiting for a free concurrency slot
 *   staging     downloading bytes into ~/.prometheus/models/.stage/<id>/
 *   scanning    staged dir handed to the REAL nemesis gate (sidecar never decides)
 *   confirm     nemesis verdict "warn" → parked for an explicit user confirm
 *   admitted    nemesis "allow" (or user-confirmed warn) → moved stage → live lib
 *   blocked     nemesis "block"/"error" | sha256 mismatch | fail-closed scan
 *   quarantined blocked stage dir retained for inspection (TERMINAL)
 *
 * `admitted` and `quarantined` are TERMINAL. `blocked` is escaped only by an
 * explicit `quarantine`, a `rescan` (re-run the gate), a security-authorised
 * `force` override, or a `remove` (drop the item).
 */
export type DownloadState =
  | "queued"
  | "staging"
  | "scanning"
  | "confirm"
  | "admitted"
  | "blocked"
  | "quarantined";

/**
 * The transition events for the §5 flow:
 *   start       queued   → staging      (a concurrency slot opened; begin fetch)
 *   staged      staging  → scanning     (bytes on disk in .stage; hand to nemesis)
 *   scanAllow   scanning → admitted     (nemesis verdict "allow" → move to live lib)
 *   scanWarn    scanning → confirm      (nemesis "warn" → needs explicit user OK)
 *   scanBlock   scanning → blocked      (nemesis "block" — refuse)
 *   scanError   scanning → blocked      (nemesis "error" / fail-closed → refuse)
 *   checksumMismatch staging|scanning → blocked  (sha256 != HF/Ollama digest)
 *   confirmAdmit  confirm → admitted    (user explicitly admitted a warn item)
 *   confirmReject confirm → blocked     (user declined a warn item)
 *   quarantine  blocked  → quarantined  (retain the .stage dir for inspection)
 *   force       blocked  → admitted     (security-authorised --force forced_danger)
 *   rescan      blocked  → scanning     (re-run the gate from scratch on the stage)
 *   retry       blocked|quarantined → queued  (re-attempt the whole download)
 *   remove      <any>    → (item dropped from the queue)
 */
export type DownloadEvent =
  | "start"
  | "staged"
  | "scanAllow"
  | "scanWarn"
  | "scanBlock"
  | "scanError"
  | "checksumMismatch"
  | "confirmAdmit"
  | "confirmReject"
  | "quarantine"
  | "force"
  | "rescan"
  | "retry";

/** A transition outcome: the next state, or null if the event is illegal here. */
type NextDownload = DownloadState | null;

/**
 * The §5 transition table. An event NOT listed for a state is a NO-OP (returns the
 * same state) so the reducer is total and never throws — an out-of-order GUI event
 * can't crash the queue. `quarantined` is a pure sink (only `retry` leaves it);
 * `admitted` is terminal (only `retry`, e.g. re-download a corrupted file).
 */
const DL_TRANSITIONS: Readonly<
  Record<DownloadState, Partial<Record<DownloadEvent, DownloadState>>>
> = Object.freeze({
  queued: {
    start: "staging",
  },
  staging: {
    staged: "scanning",
    // a sha256 mismatch detected during fetch fails closed straight to blocked.
    checksumMismatch: "blocked",
  },
  scanning: {
    scanAllow: "admitted",
    scanWarn: "confirm",
    scanBlock: "blocked",
    scanError: "blocked",
    // a digest verified after staging can still mismatch → fail closed.
    checksumMismatch: "blocked",
  },
  confirm: {
    confirmAdmit: "admitted",
    confirmReject: "blocked",
  },
  admitted: {
    // terminal; re-downloading (e.g. corrupted live file) restarts the flow.
    retry: "queued",
  },
  blocked: {
    quarantine: "quarantined",
    force: "admitted",
    rescan: "scanning",
    retry: "queued",
  },
  quarantined: {
    // TERMINAL sink: the .stage dir is kept for inspection; only a fresh retry
    // re-enqueues the whole download (a new stage dir).
    retry: "queued",
  },
});

/**
 * The pure download-queue transition function (file 05 §5). Given a state and an
 * event, returns the next state. An illegal/irrelevant event is a NO-OP (returns
 * the input unchanged) so the table is total and never throws.
 *
 * This is the single source of download-lifecycle truth: the renderer's Zustand
 * binding and the `prometheus model download` CLI both call THIS, so an item can never
 * reach `admitted` except through the verdict the REAL nemesis produced (C5).
 */
export function downloadTransition(state: DownloadState, event: DownloadEvent): DownloadState {
  const next: NextDownload = DL_TRANSITIONS[state]?.[event] ?? null;
  return next ?? state;
}

/** Is an event legal (i.e. actually moves the item) in this download state? */
export function canDownloadTransition(state: DownloadState, event: DownloadEvent): boolean {
  const next = DL_TRANSITIONS[state]?.[event];
  return next !== undefined && next !== state;
}

/** The events legal in a download state (for enabling/disabling row actions). */
export function legalDownloadEvents(state: DownloadState): DownloadEvent[] {
  return Object.keys(DL_TRANSITIONS[state] ?? {}) as DownloadEvent[];
}

/**
 * Is this a TERMINAL download state (file 05 §5)? `quarantined` is the blocked
 * sink (stage dir retained for inspection) and `admitted` is the success sink.
 * Exposed so the GUI can paint a finished row + the CLI can stop polling it.
 */
export function isTerminalDownload(state: DownloadState): boolean {
  return state === "quarantined" || state === "admitted";
}

/**
 * Is this download in the deep-red blocked/quarantined zone (file 05 §5)? Blocked
 * halts admission until an explicit rescan / force / quarantine; quarantined keeps
 * the staged bytes for inspection. Drives the deep-red row + a non-zero CLI exit.
 */
export function isBlockedDownload(state: DownloadState): boolean {
  return state === "blocked" || state === "quarantined";
}

/** Map a REAL nemesis VerdictTier to the scan event the queue should apply (C5). */
export function scanEventForVerdict(
  verdict: NemesisVerdictRef["verdict"],
): "scanAllow" | "scanWarn" | "scanBlock" | "scanError" {
  switch (verdict) {
    case "allow":
      return "scanAllow";
    case "warn":
      return "scanWarn";
    case "block":
      return "scanBlock";
    // "error" and ANYTHING unexpected fail closed → blocked (C5).
    default:
      return "scanError";
  }
}

// ====================================================================== //
//  Download item shape + reducers.                                        //
// ====================================================================== //

/**
 * One row of the download queue. `modelId`+`quant` identify the artifact; the
 * verdict/forced fields are populated only AFTER the engine-bridge nemesis runner
 * has produced an outcome (never set by this store — it only records them).
 */
export interface DownloadItem {
  /** stable queue id (typically `${modelId}:${quant}`). */
  id: string;
  modelId: string;
  quant: Quant;
  /** the model's modality, carried for queue grouping / library indexing. */
  modality?: string;
  state: DownloadState;
  /** download progress 0..100 while `staging` (mirrors the sidecar progress lines). */
  pct?: number;
  /** the staged dir path (~/.prometheus/models/.stage/<id>/) once `staging` begins. */
  stagePath?: string;
  /** the live library path once `admitted`. */
  localPath?: string;
  /** the sha256 the gate verified (or the mismatch that blocked it). */
  sha256?: string;
  /** populated only after a real nemesis scan (the §5 verdict surfaced in the UI). */
  verdict?: NemesisVerdictRef;
  /** the forced_danger record when an item reached `admitted` via `force` (C5). */
  forced?: ForcedDanger;
  /** monotonic enqueue order, used for FIFO slot scheduling. */
  seq: number;
}

/** The default max concurrent active downloads (file 05 §8 queue concurrency). */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 2;

/** The download-queue slice of the store (a plain serialisable shape). */
export interface DownloadQueueState {
  /** items keyed by id (insertion-stable via `seq`). */
  items: Record<string, DownloadItem>;
  /** max simultaneously-active (staging|scanning) items. */
  concurrency: number;
  /** monotonic counter for enqueue ordering. */
  nextSeq: number;
}

/** The states that consume a concurrency slot (in-flight work). */
const ACTIVE_DL_STATES: ReadonlySet<DownloadState> = new Set<DownloadState>([
  "staging",
  "scanning",
]);

/** Is this download state actively occupying a concurrency slot? */
export function isActiveDownload(state: DownloadState): boolean {
  return ACTIVE_DL_STATES.has(state);
}

/** The empty initial download-queue state. */
export function initialDownloadQueueState(
  concurrency: number = DEFAULT_DOWNLOAD_CONCURRENCY,
): DownloadQueueState {
  return { items: {}, concurrency: Math.max(1, Math.trunc(concurrency)), nextSeq: 0 };
}

/**
 * Enqueue a download (file 05 §5 step 0). PURE: returns a NEW state with the item
 * appended in `queued`. Re-enqueueing an existing id is a no-op that keeps the
 * existing row (idempotent — a double-click can't duplicate a queue entry).
 */
export function enqueueDownload(
  s: DownloadQueueState,
  spec: { id: string; modelId: string; quant: Quant; modality?: string },
): DownloadQueueState {
  if (s.items[spec.id]) return s;
  const item: DownloadItem = {
    id: spec.id,
    modelId: spec.modelId,
    quant: spec.quant,
    modality: spec.modality,
    state: "queued",
    seq: s.nextSeq,
  };
  return {
    ...s,
    items: { ...s.items, [spec.id]: item },
    nextSeq: s.nextSeq + 1,
  };
}

/**
 * Advance a queue item by an event (file 05 §5). PURE: returns a NEW state with
 * the item's state transitioned (NO-OP if the event is illegal in the current
 * state, or the id is unknown). `patch` carries the side-channel facts the event
 * brings (pct, stagePath, sha256, verdict, forced) — recorded verbatim, never used
 * to DECIDE the transition (the event already encodes the engine's verdict).
 */
export function advance(
  s: DownloadQueueState,
  itemId: string,
  event: DownloadEvent,
  patch: Partial<Omit<DownloadItem, "id" | "modelId" | "quant" | "seq" | "state">> = {},
): DownloadQueueState {
  const item = s.items[itemId];
  if (!item) return s;
  const nextState = downloadTransition(item.state, event);
  const next: DownloadItem = { ...item, ...patch, state: nextState };
  return { ...s, items: { ...s.items, [itemId]: next } };
}

/** Remove a queue item (cancel / dismiss). PURE: drops the row entirely. */
export function removeDownload(s: DownloadQueueState, itemId: string): DownloadQueueState {
  if (!s.items[itemId]) return s;
  const items = { ...s.items };
  delete items[itemId];
  return { ...s, items };
}

/** All queue items in stable enqueue order (FIFO by `seq`). */
export function selectQueue(s: DownloadQueueState): DownloadItem[] {
  return Object.values(s.items).sort((a, b) => a.seq - b.seq);
}

/** Items currently occupying a concurrency slot (staging|scanning). */
export function selectActiveDownloads(s: DownloadQueueState): DownloadItem[] {
  return selectQueue(s).filter((i) => isActiveDownload(i.state));
}

/** Quarantined items (blocked stage dirs retained for inspection, §5). */
export function selectQuarantined(s: DownloadQueueState): DownloadItem[] {
  return selectQueue(s).filter((i) => i.state === "quarantined");
}

/**
 * How many more downloads may START right now (file 05 §8 concurrency limit):
 * `max(0, concurrency - activeCount)`. The scheduler uses this to decide how many
 * `queued` items to `start` without exceeding the limit.
 */
export function availableSlots(s: DownloadQueueState): number {
  const active = selectActiveDownloads(s).length;
  return Math.max(0, s.concurrency - active);
}

/**
 * The next `queued` items (FIFO) that should be `start`ed to fill free slots
 * (file 05 §8). PURE: returns at most `availableSlots(s)` ids; the caller applies
 * `advance(s, id, "start", …)` to each. Never exceeds the concurrency limit.
 */
export function selectStartable(s: DownloadQueueState): DownloadItem[] {
  const slots = availableSlots(s);
  if (slots <= 0) return [];
  return selectQueue(s)
    .filter((i) => i.state === "queued")
    .slice(0, slots);
}

// ====================================================================== //
//  Library cache — discovered/installed Model[] indexed by id + modality. //
// ====================================================================== //

/** The library-cache slice: Model[] kept indexed for fast id/modality lookup. */
export interface LibraryCacheState {
  /** every known Model keyed by id (discovered + installed). */
  byId: Record<string, Model>;
  /** id lists bucketed by modality bucket (Model.kind / subtype), for fast filter. */
  byModality: Record<string, string[]>;
  /** ids the local library actually holds on disk (installed subset). */
  installedIds: string[];
}

/** The empty initial library cache. */
export function initialLibraryCacheState(): LibraryCacheState {
  return { byId: {}, byModality: {}, installedIds: [] };
}

/**
 * The modality bucket a Model indexes under (file 05 §10 first-class facet). LLMs
 * bucket as "text"; non-LLM models bucket by their `subtype` (embedding / vision /
 * asr / reranker / diffusion / tts), defaulting to "non-llm" when unspecified.
 */
export function modalityBucket(m: Model): string {
  if (m.kind === "llm") return "text";
  return m.subtype && m.subtype.length > 0 ? m.subtype : "non-llm";
}

/** Rebuild the modality index from the id map (kept private to upsert/remove). */
function reindexModality(byId: Record<string, Model>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of Object.values(byId)) {
    const bucket = modalityBucket(m);
    const list = out[bucket];
    if (list) {
      list.push(m.id);
    } else {
      out[bucket] = [m.id];
    }
  }
  return out;
}

/**
 * Upsert a batch of discovered/owned Models into the cache (file 05 §1 library
 * cache). PURE: returns a NEW state with the id map merged + the modality index
 * + installed-id list rebuilt. Later entries with the same id win (a fresh scan
 * supersedes a stale catalog row).
 */
export function upsertModels(
  s: LibraryCacheState,
  models: Model[],
  opts: { markInstalled?: boolean } = {},
): LibraryCacheState {
  if (models.length === 0) return s;
  const byId = { ...s.byId };
  for (const m of models) byId[m.id] = m;
  const installed = new Set(s.installedIds);
  if (opts.markInstalled) for (const m of models) installed.add(m.id);
  return {
    byId,
    byModality: reindexModality(byId),
    installedIds: [...installed].filter((id) => id in byId),
  };
}

/**
 * Remove a model from the library cache (file 05 §3 `remove`). PURE: drops the id
 * from the map + the installed list + reindexes modality. A no-op for an unknown
 * id. The §3 "refuses if a ServeProfile references it" guard lives in the serve
 * slice (see `serveProfilesForModel`) — this is the pure cache mutation only.
 */
export function removeFromLibrary(s: LibraryCacheState, id: string): LibraryCacheState {
  if (!(id in s.byId)) return s;
  const byId = { ...s.byId };
  delete byId[id];
  return {
    byId,
    byModality: reindexModality(byId),
    installedIds: s.installedIds.filter((x) => x !== id && x in byId),
  };
}

/** Selector: every cached Model (no order guarantee — see the sort selectors). */
export function selectAllModels(s: LibraryCacheState): Model[] {
  return Object.values(s.byId);
}

/** Selector: the installed subset (models the local library holds on disk). */
export function selectInstalledModels(s: LibraryCacheState): Model[] {
  return s.installedIds.map((id) => s.byId[id]).filter((m): m is Model => m !== undefined);
}

/**
 * Selector: models in a modality bucket (file 05 §10). `bucket` is a value from
 * `modalityBucket` (text / embedding / vision / asr / reranker / diffusion / tts).
 * Returns them in the open-weight-first order so the UI's default sort is applied.
 */
export function selectByModality(s: LibraryCacheState, bucket: string): Model[] {
  const ids = s.byModality[bucket] ?? [];
  const models = ids.map((id) => s.byId[id]).filter((m): m is Model => m !== undefined);
  return sortOpenWeightFirst(models);
}

// ====================================================================== //
//  §6 open-weight-first sort (the Hub default).                           //
// ====================================================================== //

/**
 * The permissive / free open-source licenses the Hub treats as "free, open-weight"
 * for the §6 sort-to-top + the search `--free-only` filter. Matched case- and
 * punctuation-insensitively against `Model.license` (SPDX-ish). Anything outside
 * this set (Llama Community, CC-BY-NC, gated/commercial) sorts BELOW free.
 */
const FREE_OPEN_LICENSES: ReadonlySet<string> = new Set([
  "apache-2.0",
  "apache2.0",
  "apache20",
  "mit",
  "bsd-3-clause",
  "bsd3clause",
  "bsd-2-clause",
  "bsd2clause",
  "mpl-2.0",
  "mpl20",
  "cc-by-4.0",
  "ccby40",
  "cc0-1.0",
  "cc010",
  "cc0",
  "openrail",
  "openrail-m",
  "openrailm",
  "gemma",
  "llama3.1",
  "llama3",
  "qwen",
  "tii-falcon-license-2.0",
]);

/** Normalise a license token for the free-set lookup (lowercase, strip punctuation). */
function normalizeLicense(license: string): string {
  return license
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/**
 * Is a Model free / open-weight under a permissive license (file 05 §6)? A model
 * is "free-open" when its license is in the permissive set. This is the predicate
 * behind both the §6 sort-to-top and the search `--free-only` filter. NOTE this is
 * a LICENSE/policy classification, not a security decision (C5 untouched).
 */
export function isFreeOpenWeight(m: Model): boolean {
  const lic = normalizeLicense(m.license);
  if (FREE_OPEN_LICENSES.has(lic)) return true;
  // also accept the bare-family permissive aliases (e.g. "apache" without version).
  if (lic.startsWith("apache")) return true;
  if (lic.startsWith("bsd")) return true;
  if (lic.startsWith("mpl")) return true;
  return false;
}

/**
 * Sort free / open-weight models to the top (file 05 §6 default), then by
 * popularity-ish proxies (more tags first), then alphabetically by id for a stable
 * deterministic order. PURE: returns a NEW array, never mutates the input.
 *
 * This is the Hub's default ordering everywhere — Discover lists, modality
 * buckets, the library view — so the "open-source-free is the default" emphasis is
 * structural, not a per-screen choice.
 */
export function sortOpenWeightFirst(models: Model[]): Model[] {
  return [...models].sort((a, b) => {
    const af = isFreeOpenWeight(a) ? 0 : 1;
    const bf = isFreeOpenWeight(b) ? 0 : 1;
    if (af !== bf) return af - bf;
    // tie-break: richer (more tags) first, then deterministic by id.
    if (b.tags.length !== a.tags.length) return b.tags.length - a.tags.length;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ====================================================================== //
//  Fit-rank selector — order quants by fit verdict + quality.             //
// ====================================================================== //

/**
 * A per-quant fit row the UI ranks (the bridge maps `fit.score_quant` into this).
 * Mirrors the sidecar `score_quant` envelope fields the renderer needs to order
 * the §7 fit table. `verdict` is the §4.2 Cookbook verdict (FITS/TIGHT/PARTIAL/
 * OVERFLOW); `runnable` is the §4.3 caps gate; `qualityRank` is the §4.4 closeness
 * to F16. This store NEVER computes these — it only ORDERS what the sidecar emits.
 */
export interface QuantFitRow {
  label: Quant;
  fmt: string;
  verdict: "FITS" | "TIGHT" | "PARTIAL" | "OVERFLOW";
  qualityRank: number;
  /** est/budget ratio (lower = more headroom); null when budget is 0/unknown. */
  ratio: number | null;
  /** false when a caps gate (FP8/AWQ/accel) excludes the quant (§4.3). */
  runnable: boolean;
}

/** Rank weight of a fit verdict — better-fitting verdicts sort first (§4.2 order). */
const VERDICT_RANK: Record<QuantFitRow["verdict"], number> = {
  FITS: 0,
  TIGHT: 1,
  PARTIAL: 2,
  OVERFLOW: 3,
};

/**
 * Order quants by fit (file 05 §4.4 recommender ethos). PURE: returns a NEW array
 * sorted so the BEST recommendation surfaces first —
 *   1. runnable quants (caps-allowed, §4.3) before greyed-out ones,
 *   2. by fit verdict FITS < TIGHT < PARTIAL < OVERFLOW (§4.2),
 *   3. by quality_rank DESC within the same verdict (the §4.4 sweet-spot pick),
 *   4. tie-break toward GGUF (broadest runner support) then label for stability.
 *
 * The head of this list is exactly the quant the §4.4 recommender names — the
 * highest-quality runnable quant that FITS/TIGHT — so the renderer can mark
 * `result[0]` as "Recommended" without re-deriving the math.
 */
export function fitRankSelector(rows: QuantFitRow[]): QuantFitRow[] {
  return [...rows].sort((a, b) => {
    if (a.runnable !== b.runnable) return a.runnable ? -1 : 1;
    const va = VERDICT_RANK[a.verdict];
    const vb = VERDICT_RANK[b.verdict];
    if (va !== vb) return va - vb;
    if (b.qualityRank !== a.qualityRank) return b.qualityRank - a.qualityRank;
    const ag = a.fmt === "gguf" ? 0 : 1;
    const bg = b.fmt === "gguf" ? 0 : 1;
    if (ag !== bg) return ag - bg;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

// ====================================================================== //
//  Serve-profile state — stopped | starting | ready | error.              //
// ====================================================================== //

/**
 * The Model Hub's view of a serve profile's lifecycle (file 05 §2.4 status). This
 * mirrors what the MAIN-process C8 ServerSupervisor reports, projected into the
 * four states the Serving panel renders. (The supervisor's richer ServerState —
 * starting/running/stopping/stopped/errored — is mapped down to these by the IPC
 * layer; this store models the panel's view, never spawns anything.)
 */
export type ServeStatus = "stopped" | "starting" | "ready" | "error";

/**
 * The serve-status transition events (file 05 §8 launch flow):
 *   start    stopped → starting   (spawn the runner; poll /v1/models)
 *   ready    starting → ready      (the endpoint answered 200 → live provider, C11)
 *   fail     starting → error      (spawn failed / health never came up)
 *   stop     starting|ready|error → stopped  (SIGTERM the runner; §3 `unserve`)
 *   crash    ready    → error      (a ready runner exited unexpectedly)
 *   retry    error    → starting    (re-attempt the launch)
 */
export type ServeEvent = "start" | "ready" | "fail" | "stop" | "crash" | "retry";

type NextServe = ServeStatus | null;

/** The serve-status transition table (file 05 §2.4 / §8). Illegal events = no-op. */
const SERVE_TRANSITIONS: Readonly<Record<ServeStatus, Partial<Record<ServeEvent, ServeStatus>>>> =
  Object.freeze({
    stopped: {
      start: "starting",
    },
    starting: {
      ready: "ready",
      fail: "error",
      stop: "stopped",
    },
    ready: {
      stop: "stopped",
      crash: "error",
    },
    error: {
      retry: "starting",
      stop: "stopped",
    },
  });

/** Pure serve-status transition (file 05 §2.4). Illegal/unknown event = NO-OP. */
export function serveTransition(state: ServeStatus, event: ServeEvent): ServeStatus {
  const next: NextServe = SERVE_TRANSITIONS[state]?.[event] ?? null;
  return next ?? state;
}

/** Is a serve event legal (actually changes status) in this state? */
export function canServeTransition(state: ServeStatus, event: ServeEvent): boolean {
  const next = SERVE_TRANSITIONS[state]?.[event];
  return next !== undefined && next !== state;
}

/** The events legal in a serve status (for Start/Stop/Retry button enablement). */
export function legalServeEvents(state: ServeStatus): ServeEvent[] {
  return Object.keys(SERVE_TRANSITIONS[state] ?? {}) as ServeEvent[];
}

/**
 * A serve-profile row the Serving panel renders: the reproducible ServeProfile
 * recipe + its live status + the realised endpoint base_url once `ready` (the C11
 * seam where a served endpoint becomes a Tier-A provider).
 */
export interface ServeProfileRow {
  profile: ServeProfile;
  status: ServeStatus;
  /** the OpenAI-compatible base URL the profile serves (only meaningful when ready). */
  baseUrl?: string;
  /** the live runner pid (informational; the C8 supervisor owns the real process). */
  pid?: number;
  /** the last error string when `status === "error"`. */
  lastError?: string;
}

/** The serve-profile slice of the store, keyed by profile id. */
export interface ServeProfilesState {
  byId: Record<string, ServeProfileRow>;
}

/** The empty initial serve-profile state. */
export function initialServeProfilesState(): ServeProfilesState {
  return { byId: {} };
}

/**
 * Upsert a serve profile (file 05 §2.4 saved/editable recipe). PURE: returns a NEW
 * state. A new profile defaults to `stopped`; re-upserting an existing id keeps its
 * live `status`/`pid`/`baseUrl` (so editing the recipe doesn't reset a running
 * server's state) while replacing the recipe fields.
 */
export function upsertServeProfile(
  s: ServeProfilesState,
  profile: ServeProfile,
): ServeProfilesState {
  const existing = s.byId[profile.id];
  const row: ServeProfileRow = existing ? { ...existing, profile } : { profile, status: "stopped" };
  return { byId: { ...s.byId, [profile.id]: row } };
}

/**
 * Advance a serve profile's status by an event (file 05 §2.4 / §8). PURE: returns
 * a NEW state with the row transitioned (NO-OP for an unknown id or illegal event).
 * `patch` records the facts the event carries (baseUrl on ready, pid, lastError on
 * fail/crash). Clears `lastError` whenever the row leaves `error`.
 */
export function advanceServeProfile(
  s: ServeProfilesState,
  profileId: string,
  event: ServeEvent,
  patch: Partial<Pick<ServeProfileRow, "baseUrl" | "pid" | "lastError">> = {},
): ServeProfilesState {
  const row = s.byId[profileId];
  if (!row) return s;
  const status = serveTransition(row.status, event);
  const next: ServeProfileRow = { ...row, ...patch, status };
  // leaving the error state clears the stale error message (unless patch set one).
  if (status !== "error" && patch.lastError === undefined) next.lastError = undefined;
  return { byId: { ...s.byId, [profileId]: next } };
}

/** Remove a serve profile (file 05 §3 unserve+delete). PURE: drops the row. */
export function removeServeProfile(s: ServeProfilesState, profileId: string): ServeProfilesState {
  if (!s.byId[profileId]) return s;
  const byId = { ...s.byId };
  delete byId[profileId];
  return { byId };
}

/** All serve-profile rows in deterministic (id-sorted) order. */
export function selectServeProfiles(s: ServeProfilesState): ServeProfileRow[] {
  return Object.values(s.byId).sort((a, b) =>
    a.profile.id < b.profile.id ? -1 : a.profile.id > b.profile.id ? 1 : 0,
  );
}

/** The serve profiles currently `ready` (their endpoints are live Tier-A providers, C11). */
export function selectReadyServeProfiles(s: ServeProfilesState): ServeProfileRow[] {
  return selectServeProfiles(s).filter((r) => r.status === "ready");
}

/**
 * Serve profiles that reference a given model id (file 05 §3 remove-guard). The
 * library `remove` must REFUSE (unless forced) when a profile points at the model;
 * the caller checks `serveProfilesForModel(state, id).length > 0` before removing.
 */
export function serveProfilesForModel(s: ServeProfilesState, modelId: string): ServeProfileRow[] {
  return selectServeProfiles(s).filter((r) => {
    const p = r.profile as ServeProfile & { model_id?: string };
    // ServeProfile.id encodes the model in the sidecar build; also honour an
    // explicit model_id field when the recipe carries one.
    return p.model_id === modelId || r.profile.id.includes(modelId);
  });
}
