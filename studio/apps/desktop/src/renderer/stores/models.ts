/**
 * renderer/stores/models.ts — the Model-Hub-tab Zustand slice (file 05 §1,§5,§7).
 *
 * Zustand owns UI/SESSION state; TanStack Query owns fetching/caching (hardware /
 * search / fit / serving reads). This slice holds:
 *   - the Discover controls (tab · modality · query · source · free-only · the
 *     selected model id),
 *   - the §5 DOWNLOAD QUEUE rows — advanced via the CORE store's pure
 *     `downloadTransition` reducer (the verdict the REAL nemesis produced; C5),
 *   - the pending gate sheet (the warn/block verdict the user must confirm/inspect),
 *   - the SERVE-PROFILE rows — status advanced via the core `serveTransition`.
 *
 * It reaches the engine through NOTHING — every fetch/mutation goes through
 * `window.prometheus.models.*` from the route, not from here (C5). Nothing here
 * decides "safe": a download row only reaches `admitted` through the scan event
 * the engine's verdict produced, and the serve status mirrors what the MAIN-process
 * C8 supervisor reported.
 *
 * Imports: zustand + @prometheus/ui (TYPE-only display shapes) + PLAIN-DATA
 * contract types only. NO node:*, NO electron, NO engine-bridge, and NO
 * @prometheus/core RUNTIME (its barrel re-exports the C8 ServerSupervisor, which
 * pulls node:child_process — unbundlable in the sandboxed renderer). The §5
 * download + §2.4 serve state machines are re-stated here as the SAME pure tables
 * the core `modelhub/store.ts` owns (the canonical source the `prometheus` CLI binds),
 * so both surfaces transition identically without dragging node built-ins into
 * the browser bundle — exactly the discipline the env store uses.
 */

import type {
  DownloadRowData,
  DownloadRowState,
  ModelGateBadge,
  ServeProfileData,
} from "@prometheus/ui";
import { create } from "zustand";

import type {
  ModelDownloadRequest,
  ModelGateSummary,
  ModelServeRow,
} from "../../shared/ipc-contract.js";

/* ── the §5 / §2.4 transition tables (mirror of core modelhub/store.ts) ─────── */

type DownloadState = DownloadRowState;
type DownloadEvent =
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

const DL_TRANSITIONS: Readonly<
  Record<DownloadState, Partial<Record<DownloadEvent, DownloadState>>>
> = Object.freeze({
  queued: { start: "staging" },
  staging: { staged: "scanning", checksumMismatch: "blocked" },
  scanning: {
    scanAllow: "admitted",
    scanWarn: "confirm",
    scanBlock: "blocked",
    scanError: "blocked",
    checksumMismatch: "blocked",
  },
  confirm: { confirmAdmit: "admitted", confirmReject: "blocked" },
  admitted: { retry: "queued" },
  blocked: { quarantine: "quarantined", force: "admitted", rescan: "scanning", retry: "queued" },
  quarantined: { retry: "queued" },
});

/** Pure §5 download transition (NO-OP on an illegal/unknown event — never throws). */
function downloadTransition(state: DownloadState, event: DownloadEvent): DownloadState {
  return DL_TRANSITIONS[state]?.[event] ?? state;
}

/** Map a REAL nemesis verdict tier → the scan event the queue applies (C5). */
function scanEventForVerdict(
  verdict: ModelGateBadge["verdict"],
): "scanAllow" | "scanWarn" | "scanBlock" | "scanError" {
  switch (verdict) {
    case "allow":
      return "scanAllow";
    case "warn":
      return "scanWarn";
    case "block":
      return "scanBlock";
    default:
      // "error" + anything unexpected fail closed → blocked (C5).
      return "scanError";
  }
}

type ServeStatus = ServeProfileData["status"];
type ServeEvent = "start" | "ready" | "fail" | "stop" | "crash" | "retry";

const SERVE_TRANSITIONS: Readonly<Record<ServeStatus, Partial<Record<ServeEvent, ServeStatus>>>> =
  Object.freeze({
    stopped: { start: "starting" },
    starting: { ready: "ready", fail: "error", stop: "stopped" },
    ready: { stop: "stopped", crash: "error" },
    error: { retry: "starting", stop: "stopped" },
  });

/** Pure §2.4 serve transition (NO-OP on an illegal/unknown event — never throws). */
function serveTransition(state: ServeStatus, event: ServeEvent): ServeStatus {
  return SERVE_TRANSITIONS[state]?.[event] ?? state;
}

// Mirrors @prometheus/ui ModelHub HubTab exactly (incl. the §5.4 "compare" tab) so
// the store's setTab is assignable to <ModelHub onTabChange>. Structural-equal → no drift.
export type HubTab = "discover" | "library" | "serving" | "compare";

/** A pending gated download awaiting the user's confirm/inspect (the sheet's subject). */
export interface PendingModelGate {
  /** the gate verdict the engine's nemesis produced for this staged download. */
  gate: ModelGateSummary;
  /** the download request to re-run with `force:true` on a deep-red override. */
  request: ModelDownloadRequest;
  /** a human label of the target (id:quant) shown in the sheet. */
  target: string;
}

export interface ModelsStore {
  // ── Discover controls ───────────────────────────────────────────────────
  tab: HubTab;
  modality: string;
  query: string;
  source: "hf" | "ollama";
  freeOnly: boolean;
  selectedId: string | null;

  // ── §5 download queue (rows keyed by id; advanced via the core reducer) ──
  downloads: Record<string, DownloadRowData>;
  // ── serve-profile rows (mirror of the MAIN supervisor status) ────────────
  serveRows: Record<string, ServeProfileData>;
  // ── the gate sheet ───────────────────────────────────────────────────────
  pendingGate: PendingModelGate | null;
  // ── a transient progress line (cosmetic) ─────────────────────────────────
  lastProgress: string | null;

  setTab(tab: HubTab): void;
  setModality(m: string): void;
  setQuery(q: string): void;
  setSource(s: "hf" | "ollama"): void;
  setFreeOnly(v: boolean): void;
  selectModel(id: string | null): void;

  /** enqueue a download row in `queued` (idempotent on id). */
  enqueueDownload(spec: { id: string; modelId: string; quant: string; modality?: string }): void;
  /** advance a download row by a CORE transition event (records the side-channel patch). */
  advanceDownload(id: string, event: DownloadEvent, patch?: Partial<DownloadRowData>): void;
  /** apply a REAL nemesis verdict to a SCANNING row (maps tier → the scan event; C5). */
  applyDownloadVerdict(id: string, gate: ModelGateBadge, quarantineDir?: string): void;
  /** drop a download row (cancel / dismiss). */
  removeDownload(id: string): void;

  /** replace the serve rows from a `serving()` snapshot (the supervisor's truth). */
  setServeRows(rows: ModelServeRow[]): void;
  /** advance ONE serve row's status by a CORE transition event (live feed). */
  advanceServe(id: string, event: ServeEvent, patch?: Partial<ServeProfileData>): void;

  setPendingGate(p: PendingModelGate | null): void;
  setProgress(line: string | null): void;
}

/** Map a contract ModelServeRow → the UI ServeProfileData shape (structural). */
function toServeProfileData(r: ModelServeRow): ServeProfileData {
  return {
    id: r.id,
    modelId: r.modelId,
    quant: r.quant,
    runner: r.runner,
    endpoint: r.endpoint,
    apiKey: r.apiKey,
    args: r.args,
    status: r.status,
    ...(r.external !== undefined ? { external: r.external } : {}),
    ...(r.pid !== undefined ? { pid: r.pid } : {}),
    ...(r.lastError !== undefined ? { lastError: r.lastError } : {}),
  };
}

export const useModelsStore = create<ModelsStore>((set) => ({
  tab: "discover",
  modality: "text",
  query: "",
  source: "hf",
  freeOnly: true,
  selectedId: null,
  downloads: {},
  serveRows: {},
  pendingGate: null,
  lastProgress: null,

  setTab: (tab) => set({ tab }),
  setModality: (modality) => set({ modality }),
  setQuery: (query) => set({ query }),
  setSource: (source) => set({ source }),
  setFreeOnly: (freeOnly) => set({ freeOnly }),
  selectModel: (selectedId) => set({ selectedId }),

  enqueueDownload: (spec) =>
    set((s) => {
      if (s.downloads[spec.id]) return s;
      const row: DownloadRowData = {
        id: spec.id,
        modelId: spec.modelId,
        quant: spec.quant,
        state: "queued",
        ...(spec.modality !== undefined ? { modality: spec.modality } : {}),
      };
      return { downloads: { ...s.downloads, [spec.id]: row } };
    }),

  advanceDownload: (id, event, patch = {}) =>
    set((s) => {
      const row = s.downloads[id];
      if (!row) return s;
      const nextState = downloadTransition(row.state, event);
      return { downloads: { ...s.downloads, [id]: { ...row, ...patch, state: nextState } } };
    }),

  applyDownloadVerdict: (id, gate, quarantineDir) =>
    set((s) => {
      const row = s.downloads[id];
      if (!row) return s;
      // map the REAL verdict tier → the scan event (C5: never upgraded toward allow).
      const event = scanEventForVerdict(gate.verdict);
      const nextState = downloadTransition(row.state, event);
      const patch: Partial<DownloadRowData> = { gate };
      if (quarantineDir !== undefined) patch.quarantineDir = quarantineDir;
      return { downloads: { ...s.downloads, [id]: { ...row, ...patch, state: nextState } } };
    }),

  removeDownload: (id) =>
    set((s) => {
      if (!s.downloads[id]) return s;
      const downloads = { ...s.downloads };
      delete downloads[id];
      return { downloads };
    }),

  setServeRows: (rows) =>
    set(() => {
      const serveRows: Record<string, ServeProfileData> = {};
      // guard: `rows` is forwarded straight from the IPC serving() payload, which can be
      // undefined on an ok-but-empty / partial response → iterating it crashed the store.
      for (const r of Array.isArray(rows) ? rows : []) serveRows[r.id] = toServeProfileData(r);
      return { serveRows };
    }),

  advanceServe: (id, event, patch = {}) =>
    set((s) => {
      const row = s.serveRows[id];
      if (!row) return s;
      const status = serveTransition(row.status, event);
      return { serveRows: { ...s.serveRows, [id]: { ...row, ...patch, status } } };
    }),

  setPendingGate: (pendingGate) => set({ pendingGate }),
  setProgress: (lastProgress) => set({ lastProgress }),
}));

/**
 * PURE selector: does a gated download result need the user's confirm before it
 * can proceed (warn), or is it a deep-red block the user may force-override? The
 * decision is the ENGINE's — this only reads the tier it already set (C5).
 */
export function downloadNeedsAttention(gate: ModelGateSummary | undefined): boolean {
  if (!gate) return false;
  return gate.verdict === "warn" || gate.verdict === "block" || gate.verdict === "error";
}
