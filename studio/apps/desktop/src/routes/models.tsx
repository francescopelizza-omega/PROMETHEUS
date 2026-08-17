/**
 * routes/models.tsx — the Model Hub tab (file 05 §1,§7,§8).
 *
 * The renderer-side glue that wires `window.prometheus.models.*` (the
 * contextBridge seam) → TanStack Query (the hardware/search/fit/serving READS) +
 * a Zustand slice (selection · the §5 download queue · serve rows · the pending
 * gate sheet) → the @prometheus/ui/modelhub components (<ModelHub/> shell ·
 * <FitScorePanel/> · <DownloadQueue/> · <ServingPanel/>) and the shared file-03
 * <VerdictSheet/> for the §5 confirm/inspect flow.
 *
 * RENDERER-SANDBOXED (C5): it imports ONLY react + @tanstack/react-query +
 * @prometheus/ui + @prometheus/core (the pure store reducers) + the PLAIN-DATA
 * contract types + the renderer store. It NEVER imports node:* / electron / the
 * engine-bridge runtime — every byte crosses the contextBridge. The gate decision
 * on a DOWNLOAD is the ENGINE's: a warn/block/error result is stashed and rendered
 * in the <VerdictSheet/>; the user confirms (or force-overrides) and the route
 * re-runs the SAME download with `force:true`. JS never decides "safe".
 *
 * SERVE drives the MAIN-process C8 ServerSupervisor: `serve()` returns the live
 * rows (the started profile is `starting`); the supervisor flips it to ready/error
 * and pushes the status over the model-progress feed, which this route mirrors into
 * the store. The runner binary is absent here, so a serve resolves to `error`
 * (timeout/exit) — EXPECTED; never faked-as-ready (C5/C8).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import {
  Button,
  DownloadQueue,
  type DownloadRowData,
  type FitResultData,
  FitScorePanel,
  type HardwareProfileData,
  type ModalityFacet,
  type ModelData,
  ModelHub,
  Panel,
  Progress,
  type ServeProfileData,
  ServingPanel,
  VerdictSheet,
  gateToVerdict,
} from "@prometheus/ui";

import { localityOf } from "../renderer/ide/ai/endpoints.js";
import { qk } from "../renderer/query/client.js";
import { DecisionOverlay } from "../renderer/shell/DecisionOverlay.js";
import { ForceGate, useForceGate } from "../renderer/shell/ForceGate.js";
import { useAuthorisationStore } from "../renderer/stores/authorisation.js";
import { useModelsStore } from "../renderer/stores/models.js";
import type {
  ModelDownloadResult,
  ModelEndpointsResult,
  ModelFitResult,
  ModelHardwareResult,
  ModelProgressEvent,
  ModelSearchResult,
  ModelServeResult,
  ModelServeRow,
} from "../shared/ipc-contract.js";
import {
  type InstalledRow,
  PULL_SCAN_NOTE,
  type PullProgress,
  endpointRow,
  formatBytes,
  installedRows,
  installedTotal,
  metricChips,
  parsePullProgress,
} from "./models-hub-view.js";

/** The `window.prometheus.models` surface (typed via the contract). */
function modelsApi(): Window["prometheus"]["models"] {
  return window.prometheus.models;
}

/* ── reads (TanStack Query) ────────────────────────────────────────────────── */

function useHardware() {
  return useQuery({
    queryKey: qk.modelHardware(),
    queryFn: (): Promise<ModelHardwareResult> => modelsApi().hardware(),
  });
}

function useSearch(q: string, modality: string, source: "hf" | "ollama", freeOnly: boolean) {
  return useQuery({
    queryKey: qk.modelSearch(q, modality, source, freeOnly),
    queryFn: (): Promise<ModelSearchResult> =>
      modelsApi().search({ q, modality, source, freeOnly }),
  });
}

function useFit(id: string | null) {
  return useQuery({
    queryKey: qk.modelFit(id ?? ""),
    queryFn: (): Promise<ModelFitResult> => modelsApi().fit({ id: id ?? "" }),
    enabled: Boolean(id),
  });
}

function useServing() {
  return useQuery({
    queryKey: qk.modelServing(),
    queryFn: (): Promise<ModelServeResult> => modelsApi().serving(),
    // poll while serving so the supervisor's starting→ready/error shows up.
    refetchInterval: 2_000,
  });
}

/** §3 "Installed": the LOCAL library (files on disk + the Ollama store, indexed). */
function useLibrary() {
  return useQuery({
    queryKey: qk.modelLibrary("all"),
    queryFn: (): Promise<ModelSearchResult> => modelsApi().library(),
  });
}

/** §3 "Endpoints": the live local + open-weight endpoints. */
function useEndpoints() {
  return useQuery({
    queryKey: qk.modelEndpoints(),
    queryFn: (): Promise<ModelEndpointsResult> => modelsApi().endpoints(),
    refetchInterval: 10_000,
  });
}

/* ── plain-data → UI shape coercions (structural — no adapter needed) ───────── */

function asHardware(res: ModelHardwareResult | undefined): HardwareProfileData | null {
  if (!res?.ok || !res.hardware) return null;
  // Normalize nested arrays at the cast boundary: the engine payload is opaque, so a
  // partial probe (no GPU / no caps / no cpu) must not leave nested fields undefined
  // for downstream `.gpus.map`/`.caps.x` consumers (fail-closed, not crash).
  const hw = res.hardware as Record<string, unknown>;
  return {
    ...hw,
    gpus: Array.isArray(hw.gpus) ? hw.gpus : [],
    caps: (hw.caps ?? {}) as Record<string, unknown>,
    cpu: (hw.cpu ?? {}) as Record<string, unknown>,
  } as unknown as HardwareProfileData;
}
function asModels(res: ModelSearchResult | undefined): ModelData[] {
  if (!res?.ok || !Array.isArray(res.models)) return [];
  return res.models as unknown as ModelData[];
}
function asFit(res: ModelFitResult | undefined): FitResultData | null {
  if (!res?.ok || !res.fit) return null;
  // Normalize the two arrays the fit table iterates so a fit object that omits them
  // (sidecar partial / different shape) renders empty instead of throwing.
  const f = res.fit as Record<string, unknown>;
  return {
    ...f,
    ranked: Array.isArray(f.ranked) ? f.ranked : [],
    reasons: Array.isArray(f.reasons) ? f.reasons : [],
  } as unknown as FitResultData;
}

export function ModelsRoute(): ReactElement {
  // §9: the shared typed-confirm gate for deep-red overrides on this route.
  const force = useForceGate();
  const qc = useQueryClient();

  const tab = useModelsStore((s) => s.tab);
  const modality = useModelsStore((s) => s.modality);
  const query = useModelsStore((s) => s.query);
  const source = useModelsStore((s) => s.source);
  const freeOnly = useModelsStore((s) => s.freeOnly);
  const selectedId = useModelsStore((s) => s.selectedId);
  const downloads = useModelsStore((s) => s.downloads);
  const serveRows = useModelsStore((s) => s.serveRows);
  const pendingGate = useModelsStore((s) => s.pendingGate);

  const setTab = useModelsStore((s) => s.setTab);
  const setModality = useModelsStore((s) => s.setModality);
  const setQuery = useModelsStore((s) => s.setQuery);
  const setSource = useModelsStore((s) => s.setSource);
  const setFreeOnly = useModelsStore((s) => s.setFreeOnly);
  const selectModel = useModelsStore((s) => s.selectModel);
  const enqueueDownload = useModelsStore((s) => s.enqueueDownload);
  const advanceDownload = useModelsStore((s) => s.advanceDownload);
  const applyDownloadVerdict = useModelsStore((s) => s.applyDownloadVerdict);
  const removeDownload = useModelsStore((s) => s.removeDownload);
  const setServeRows = useModelsStore((s) => s.setServeRows);
  const setPendingGate = useModelsStore((s) => s.setPendingGate);
  const setProgress = useModelsStore((s) => s.setProgress);

  const hwQ = useHardware();
  const searchQ = useSearch(query, modality, source, freeOnly);
  // §3's four islands read three live sources: the supervisor's serve rows, the local
  // library (files + the indexed Ollama store) and the endpoint list. The A-level comes from
  // the one authorisation store every surface reads — the cloud rows gate on it (§3).
  const libraryQ = useLibrary();
  const endpointsQ = useEndpoints();
  const authLevel = useAuthorisationStore((s) => s.level);
  const [rescanning, setRescanning] = useState(false);
  const fitQ = useFit(selectedId);
  const servingQ = useServing();

  const hardware = asHardware(hwQ.data);
  const models = asModels(searchQ.data).filter(
    (m) => modality === "text" || m.modality === modality,
  );
  const fit = asFit(fitQ.data);

  // mirror the serving snapshot into the store (the supervisor is the truth).
  useEffect(() => {
    if (servingQ.data?.ok) setServeRows(servingQ.data.profiles);
  }, [servingQ.data, setServeRows]);

  // subscribe to the model-progress / serve-status feed (cosmetic + serve status).
  useEffect(() => {
    const off = modelsApi().onProgress((e: ModelProgressEvent) => {
      setProgress(e.message);
      // a serve-status event ⇒ refetch the serving snapshot (the supervisor truth).
      if (e.phase === "serve") void qc.invalidateQueries({ queryKey: qk.modelServing() });
      // §3's pull readout. Parsed rather than assumed: `pct` is only set when main computed
      // one, and the byte figures live in the runner's raw line.
      else setPullBar(parsePullProgress(e));
    });
    return off;
  }, [qc, setProgress]);

  const refetchServing = useCallback((): void => {
    void qc.invalidateQueries({ queryKey: qk.modelServing() });
  }, [qc]);

  /**
   * Run a download → route its §5 outcome. admitted ⇒ advance the row to admitted;
   * needsConfirm (warn) ⇒ stash the verdict in the sheet + park the row at confirm;
   * blocked ⇒ apply the verdict (quarantine). JS never decides "safe" (C5).
   */
  const runDownload = useCallback(
    async (id: string, quant: string, modalityHint: string, force: boolean): Promise<boolean> => {
      const rowId = `${id}:${quant}`;
      // Guard against a double-download: the warn flow surfaces BOTH the per-row queue
      // confirm AND the shared VerdictSheet, so two confirms could fire runDownload for
      // the same row. If the row is already actively in-flight, ignore the re-trigger.
      const inflight = useModelsStore.getState().downloads[rowId];
      if (inflight && (inflight.state === "staging" || inflight.state === "scanning")) return false;
      enqueueDownload({ id: rowId, modelId: id, quant, modality: modalityHint });
      advanceDownload(rowId, "start", { stagePath: `~/.prometheus/models/.stage/${id}` });
      advanceDownload(rowId, "staged");
      try {
        // `confirmForce` pairs with `force`: main DROPS a bare force (§9a). Without it the
        // typed-confirm dialog this route already shows would be pure friction — the
        // override would land whether or not the human ever typed the token.
        const res: ModelDownloadResult = await modelsApi().download({
          id,
          quant,
          force,
          confirmForce: force,
        });
        const gate = res.gate;
        if (res.admitted) {
          applyDownloadVerdict(rowId, { verdict: "allow", ...(gate ?? {}) });
          setPendingGate(null);
          return true; // admitted — the ONLY outcome a caller may serve on (§5 gate)
        }
        if (gate) {
          applyDownloadVerdict(rowId, gate, res.quarantined);
          // a warn (or a block the user may force) opens the shared verdict sheet.
          setPendingGate({ gate, request: { id, quant, force: true }, target: rowId });
        }
        return false; // warned/blocked/quarantined — NOT admitted
      } catch {
        // IPC/engine failure — unstick the row into an error state (fail-closed),
        // never leave it spinning at "staged" or raise an unhandled rejection.
        advanceDownload(rowId, "scanError");
        return false;
      }
    },
    [enqueueDownload, advanceDownload, applyDownloadVerdict, setPendingGate],
  );

  const onDownload = useCallback(
    (quant: string): void => {
      if (!selectedId) return;
      void runDownload(selectedId, quant, modality, false);
    },
    [selectedId, modality, runDownload],
  );

  const onDownloadServe = useCallback(
    (quant: string): void => {
      if (!selectedId) return;
      void runDownload(selectedId, quant, modality, false).then((admitted) => {
        // only serve a model the §5 gate ADMITTED — never spin a profile for a warned/
        // blocked/quarantined download (the sheet is still open for the user to decide).
        if (admitted) void modelsApi().serve({ id: selectedId, quant }).then(refetchServing);
      });
    },
    [selectedId, modality, runDownload, refetchServing],
  );

  // ── serve actions (drive the C8 supervisor via the MAIN process) ──────────
  const onStart = useCallback(
    (profileId: string): void => {
      const row = serveRows[profileId];
      if (!row) return;
      void modelsApi().serve({ id: row.modelId, quant: row.quant }).then(refetchServing);
    },
    [serveRows, refetchServing],
  );
  const onStop = useCallback(
    (profileId: string): void => {
      void modelsApi().unserve(profileId).then(refetchServing);
    },
    [refetchServing],
  );
  const onUseInIde = useCallback((profile: ServeProfileData): void => {
    // a serve row from the supervisor may lack an endpoint → don't deref undefined.
    const baseUrl = profile.endpoint?.baseUrl;
    if (!baseUrl) return;
    void modelsApi().repoint({ tool: "ide", baseUrl });
  }, []);

  // ── download queue actions ────────────────────────────────────────────────
  const onConfirm = useCallback(
    (rowId: string): void => {
      const row = downloads[rowId];
      if (!row) return;
      // user confirmed a warn → re-run admit (the engine still gates).
      advanceDownload(rowId, "confirmAdmit");
      // NEVER reconstruct the id from rowId.split(':') — ollama ids contain colons
      // (qwen2.5:7b), so a split would re-download the WRONG model. row.modelId is the truth.
      // FORCE=true: a warned download re-run WITHOUT force returns the same warn → the sheet
      // re-opens forever. force is the only lever the download IPC exposes to admit a warn.
      if (row.modelId) void runDownload(row.modelId, row.quant, row.modality ?? modality, true);
      setPendingGate(null);
    },
    [downloads, advanceDownload, runDownload, modality, setPendingGate],
  );
  // Inspect = show the row's gate verdict in the shared sheet (it used to be wired to
  // removeDownload, so clicking "Inspect" DELETED the row instead of showing detail).
  const onInspect = useCallback(
    (rowId: string): void => {
      const row = useModelsStore.getState().downloads[rowId];
      const g = row?.gate;
      if (g) {
        // adapt the row's ModelGateBadge (optional fields) → the ModelGateSummary the
        // verdict sheet needs (required score/reasons/signed) with fail-safe defaults.
        setPendingGate({
          gate: {
            verdict: g.verdict,
            score: g.score ?? 0,
            reasons: g.reasons ?? [],
            signed: g.signed ?? false,
            ...(g.recommendation ? { recommendation: g.recommendation } : {}),
            ...(g.scannedAt ? { scannedAt: g.scannedAt } : {}),
          },
          request: { id: row.modelId, quant: row.quant },
          target: rowId,
        });
      }
    },
    [setPendingGate],
  );
  const onRetry = useCallback(
    (rowId: string): void => {
      const row = useModelsStore.getState().downloads[rowId];
      if (!row?.modelId) return;
      // advancing to "queued" alone did NOTHING (no consumer re-runs a queued row) — the
      // button looked dead. Advance AND actually re-invoke the download.
      advanceDownload(rowId, "retry");
      void runDownload(row.modelId, row.quant, row.modality ?? modality, false);
    },
    [advanceDownload, runDownload, modality],
  );

  // ── real local install via the ollama runner (the actual weight download) ──
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState<string | null>(null);
  /** §3's Pull island owns its own input (`org/model or ollama tag`) — a pull is not
   *  restricted to whatever row happens to be selected in the search results below. */
  const [pullTarget, setPullTarget] = useState("");
  /** the live `62% · 4.1 of 6.6 GB` readout, parsed from the runner's own output. */
  const [pullBar, setPullBar] = useState<PullProgress>({ pct: null, bytes: null });
  // the copy-paste fallback (only shown when the auto-install itself can't proceed).
  const [pullInstall, setPullInstall] = useState<string | null>(null);
  // true once a pull failed because the ollama runner is missing → show auto-install.
  const [needsRunner, setNeedsRunner] = useState(false);
  const [installingRunner, setInstallingRunner] = useState(false);
  const handlePull = useCallback(async (): Promise<void> => {
    // the island's own input first, then the selected search row — so the Pull island works
    // on a fresh launch with nothing selected, which is its whole point.
    const target = (pullTarget.trim() || selectedId || "").trim();
    if (!target || pulling) return;
    setPulling(true);
    setPullBar({ pct: null, bytes: null });
    setPullMsg(`ollama pull ${target} — downloading…`);
    setPullInstall(null);
    setNeedsRunner(false);
    try {
      const r = await modelsApi().pull({ id: target });
      if (r.ok && r.installed) {
        setPullMsg(`✓ installed ${target} — served at ${r.endpoint ?? "localhost:11434"}`);
        void qc.invalidateQueries({ queryKey: qk.modelLibrary("all") });
        refetchServing();
      } else if (r.installable) {
        // don't hand the user a command — offer to install the runner on their behalf.
        setPullMsg("⚠ Ollama isn't installed yet — Prometheus can install it for you:");
        setNeedsRunner(true);
      } else if (r.blockedByResources) {
        setPullMsg(`⛔ ${r.error ?? "system under heavy load"}`);
      } else {
        setPullMsg(`✗ ${r.error ?? "pull failed"}`);
      }
    } catch (e) {
      setPullMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPulling(false);
      setPullBar({ pct: null, bytes: null });
    }
  }, [pullTarget, selectedId, pulling, refetchServing, qc]);

  // Install the ollama RUNNER on the user's behalf (OS-aware, in main) then, on
  // success, transparently retry the model pull — no copy-paste command, ever.
  const installRunner = useCallback(async (): Promise<void> => {
    if (installingRunner || typeof modelsApi().installRunner !== "function") {
      if (typeof modelsApi().installRunner !== "function")
        setPullMsg("Fully quit + relaunch Prometheus to load the auto-installer.");
      return;
    }
    setInstallingRunner(true);
    setPullInstall(null);
    setPullMsg("Installing Ollama for your OS…");
    const off = modelsApi().onProgress?.((e: ModelProgressEvent) => {
      if (e.message) setPullMsg(`Installing Ollama — ${e.message}`);
    });
    try {
      const r = await modelsApi().installRunner();
      off?.();
      if (r.ok && r.installed) {
        setNeedsRunner(false);
        setPullMsg(`✓ Ollama installed (${r.os ?? "local"}). Downloading the model…`);
        await handlePull();
      } else if (r.blockedByResources) {
        setPullMsg(`⛔ ${r.error ?? "system under heavy load"}`);
      } else if (r.manual) {
        setPullMsg(`⚠ ${r.install ?? "manual install needed"}`);
        setPullInstall(r.url ?? r.install ?? "https://ollama.com/download");
      } else {
        setPullMsg(`✗ ${r.error ?? "install failed"}`);
        if (r.install) setPullInstall(r.install);
      }
    } catch (e) {
      off?.();
      setPullMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstallingRunner(false);
    }
  }, [installingRunner, handlePull]);

  const downloadRows: DownloadRowData[] = Object.values(downloads).sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );

  /* ── §3 derived state ──────────────────────────────────────────────────────*/

  /** the local library, projected to §3's cells (every one nullable — see the view model). */
  const library: InstalledRow[] = installedRows(
    (asModels(libraryQ.data) as unknown as Parameters<typeof installedRows>[0]) ?? [],
  );
  /** every endpoint, classified local/cloud and gated on the A-level (§3). */
  const endpoints = [...(endpointsQ.data?.local ?? []), ...(endpointsQ.data?.openApi ?? [])].map(
    (e) => endpointRow(e, localityOf(e.baseUrl), authLevel),
  );
  /** the local endpoint the Serving header names (`ollama · :11434`). */
  const localEndpoint = endpoints.find((e) => e.locality === "local") ?? null;
  const serveList: ServeProfileData[] = Object.values(serveRows).sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-8, 16px)" }}>
      {/* ── §3: the four islands ──────────────────────────────────────────────
          `auto-fit` at 360px, so four islands on a wide window collapse to two and then
          one without any of them being crushed (§7). */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: "var(--space-8, 16px)",
          alignItems: "start",
        }}
      >
        <ServingIsland
          rows={serveList}
          gpu={hardware?.gpus?.[0] ?? null}
          endpoint={localEndpoint}
          onStop={onStop}
          onSwap={() => setTab("discover")}
        />
        <InstalledIsland
          rows={library}
          loading={libraryQ.isPending}
          onServe={(id) => {
            // serve the LIBRARY row directly — these bytes are already on disk and already
            // scanned, so there is no download to gate. The supervisor still owns the status.
            void modelsApi().serve({ id }).then(refetchServing);
          }}
          onStop={(id) => {
            const row = serveList.find((p) => p.modelId === id);
            if (row) onStop(row.id);
          }}
        />
        <PullIsland
          value={pullTarget}
          onChange={setPullTarget}
          onPull={() => void handlePull()}
          pulling={pulling}
          bar={pullBar}
          message={pullMsg}
          needsRunner={needsRunner}
          installingRunner={installingRunner}
          onInstallRunner={() => void installRunner()}
          manualInstall={pullInstall}
        />
        <EndpointsIsland
          endpoints={endpoints}
          authLevel={authLevel}
          loading={endpointsQ.isPending}
        />
      </div>

      <ModelHub
        hardware={hardware}
        models={models}
        tab={tab}
        onTabChange={setTab}
        modality={modality as ModalityFacet}
        onModalityChange={setModality}
        query={query}
        onQueryChange={setQuery}
        onSearch={() => void searchQ.refetch()}
        source={source}
        onSourceChange={setSource}
        freeOnly={freeOnly}
        onFreeOnlyChange={setFreeOnly}
        selectedId={selectedId}
        onSelectModel={selectModel}
        onRescan={() => {
          if (rescanning) return;
          setRescanning(true);
          void modelsApi()
            .hardware(true)
            .then(() => hwQ.refetch())
            .catch(() => {})
            .finally(() => setRescanning(false));
        }}
        loading={searchQ.isPending || rescanning}
        fitPanel={
          <FitScorePanel
            fit={fit}
            loading={fitQ.isPending}
            onDownload={onDownload}
            onDownloadServe={onDownloadServe}
          />
        }
        queuePanel={
          <DownloadQueue
            rows={downloadRows}
            onConfirm={onConfirm}
            onCancel={removeDownload}
            onInspect={onInspect}
            onRetry={onRetry}
          />
        }
        servingPanel={
          <ServingPanel
            profiles={serveList}
            onStart={onStart}
            onStop={onStop}
            onRetry={onStart}
            onUseInIde={onUseInIde}
            onEndpoint={(profile) => {
              // "Endpoint" ≠ "Use in IDE": copy the served URL instead of repointing the IDE.
              const baseUrl = profile.endpoint?.baseUrl;
              if (baseUrl) void navigator.clipboard?.writeText(baseUrl);
            }}
          />
        }
      />

      {/* REAL local install: the fastest working path is the ollama runner — one click
          pulls + serves the weights (localhost:11434). The gate-driven HF/GGUF download
          above stays for advanced users; this is the "just works" install. */}
      {selectedId && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-4, 8px)",
            flexWrap: "wrap",
            padding: "var(--space-4, 8px) var(--space-6, 12px)",
            background: "var(--bg-surface-2)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md, 6px)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <span style={{ color: "var(--text-secondary)" }}>
            Install <strong style={{ color: "var(--text-primary)" }}>{selectedId}</strong> locally:
          </span>
          <Button
            variant="primary"
            onClick={() => void handlePull()}
            disabled={pulling || installingRunner}
          >
            {pulling ? "⏳ Installing…" : "⚡ Install with Ollama"}
          </Button>
          {needsRunner && (
            <Button
              variant="secondary"
              onClick={() => void installRunner()}
              disabled={installingRunner || pulling}
            >
              {installingRunner ? "⏳ Installing Ollama…" : "⬇ Install Ollama automatically"}
            </Button>
          )}
          {pullMsg && <span style={{ color: "var(--text-primary)" }}>{pullMsg}</span>}
          {pullInstall && (
            <code
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--bg-inset)",
                padding: "2px 6px",
                borderRadius: "var(--radius-sm, 4px)",
              }}
            >
              {pullInstall}
            </code>
          )}
        </div>
      )}

      {/* the §5 gate decision is the ENGINE's — rendered in the shared file-03 sheet. */}
      {pendingGate && (
        // §9: a decision surface is NEVER in-flow. Wrapped so the verdict — and the
        // actions under it — cannot scroll below the fold.
        <DecisionOverlay label="Security verdict" onDismiss={() => setPendingGate(null)}>
          <VerdictSheet
            verdict={gateToVerdict(pendingGate.gate, pendingGate.target)}
            onProceed={() => {
              // proceed = confirm a warn (re-run admit; the engine still gates). Read the
              // id/quant from the carried request — NEVER split the colon-bearing target.
              // Advance the row off `confirm` first (else applyDownloadVerdict's transition is
              // illegal and the row parks forever), and force=true (the only lever to admit).
              advanceDownload(pendingGate.target, "confirmAdmit");
              const { id, quant } = pendingGate.request;
              if (id && quant) void runDownload(id, quant, modality, true);
              setPendingGate(null);
            }}
            onCancel={() => setPendingGate(null)}
            onRequestForce={() => {
              // §9 (HIGH): typed confirm before the override. Re-runs the SAME download
              // (the exact id+quant the user inspected), from the request — not a
              // colon-split of the target string.
              const { id, quant } = pendingGate.request;
              const reasons = pendingGate.gate.reasons;
              const target = pendingGate.target;
              if (id && quant) {
                force.ask({
                  target,
                  blockingReasons: reasons,
                  onConfirm: () => void runDownload(id, quant, modality, true),
                });
              }
              setPendingGate(null);
            }}
          />
        </DecisionOverlay>
      )}

      {/* §9: the typed confirm that gates every deep-red override on this route. */}
      <ForceGate gate={force} />
    </div>
  );
}

/* ── §3 islands ──────────────────────────────────────────────────────────────*/

/** A mono inset pill — §3's metric chip. */
function MetricPill({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 4,
        flex: "none",
        padding: "2px 7px",
        borderRadius: "var(--radius-sm, 4px)",
        background: "var(--bg-inset)",
        border: "1px solid var(--border-chip)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        whiteSpace: "nowrap", // §7
      }}
    >
      <span style={{ color: "var(--text-title)", fontWeight: 600 }}>{value}</span>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
    </span>
  );
}

/** A status dot at a semantic role. The glyph-free variant — always paired with text. */
function Dot({ color }: { color: string }): ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{ width: 7, height: 7, flex: "none", borderRadius: "50%", background: color }}
    />
  );
}

/**
 * §3 "Serving now".
 *
 * The metric chips come from `metricChips`, which emits a chip only for a metric that has a
 * real source. Today that is the runner's configured context length; tok/s, memory and load
 * time have no per-profile source anywhere in the app, so they are ABSENT rather than zeroed
 * (the view model's doc comment explains why borrowing the chat's tok/s would be wrong).
 */
function ServingIsland(props: {
  rows: readonly ServeProfileData[];
  gpu: { name: string; vramGb: number; vramFreeGb: number } | null;
  endpoint: { name: string; baseUrl: string } | null;
  onStop: (profileId: string) => void;
  onSwap: () => void;
}): ReactElement {
  const { rows, gpu, endpoint, onStop, onSwap } = props;
  const live = rows.find((r) => r.status === "ready") ?? rows[0] ?? null;
  const usedFrac =
    gpu && gpu.vramGb > 0
      ? Math.max(0, Math.min(1, (gpu.vramGb - gpu.vramFreeGb) / gpu.vramGb))
      : 0;
  return (
    <Panel
      elevation="e1"
      title="Serving now"
      actions={
        endpoint ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-secondary)",
              minWidth: 0,
            }}
          >
            <Dot color="var(--ok)" />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {endpoint.name} · {new URL(endpoint.baseUrl).port || "default"}
            </span>
          </span>
        ) : (
          <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            no endpoint
          </span>
        )
      }
    >
      {live ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4, 8px)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-4, 8px)",
              flexWrap: "wrap",
              minWidth: 0, // §7
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                color: "var(--text-title)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {live.modelId}
            </span>
            <Button variant="ghost" onClick={onSwap}>
              Swap…
            </Button>
            <button
              type="button"
              onClick={() => onStop(live.id)}
              style={{
                flex: "none",
                background: "transparent",
                border: "1px solid color-mix(in srgb, var(--danger) 45%, transparent)",
                borderRadius: "var(--radius-md, 6px)",
                color: "var(--danger)",
                cursor: "pointer",
                fontSize: "0.76rem",
                fontWeight: 600,
                padding: "3px 9px",
                whiteSpace: "nowrap", // §7
              }}
            >
              Stop
            </button>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {metricChips({ ctxLen: live.args?.ctxLen }).map((c) => (
              <MetricPill key={c.label} label={c.label} value={c.value} />
            ))}
            <MetricPill label="status" value={live.status} />
          </div>

          {gpu && gpu.vramGb > 0 && (
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  marginBottom: 3,
                  minWidth: 0,
                }}
              >
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {gpu.name}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
                  {(gpu.vramGb - gpu.vramFreeGb).toFixed(1)} / {gpu.vramGb.toFixed(1)} GB
                </span>
              </div>
              <div
                role="meter"
                aria-label="GPU memory in use"
                aria-valuenow={Math.round(usedFrac * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: "var(--bg-inset)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${usedFrac * 100}%`,
                    height: "100%",
                    background: "var(--gradient-brand)",
                  }}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
        <p style={{ color: "var(--text-secondary)", margin: 0 }}>
          Nothing is being served. Serve a model from the Installed island, or pull one.
        </p>
      )}
    </Panel>
  );
}

/** §3 "Installed": status dot · mono name · size · ctx · quant · Serve/Stop. */
function InstalledIsland(props: {
  rows: readonly InstalledRow[];
  loading: boolean;
  onServe: (id: string) => void;
  onStop: (id: string) => void;
}): ReactElement {
  const { rows, loading, onServe, onStop } = props;
  // §3's header is "count + total GB". `unknown` counts the rows whose size nothing measured,
  // so the total is prefixed with `≥` rather than silently under-reporting.
  const total = installedTotal(rows);
  const totalLabel = formatBytes(total.bytes);
  return (
    <Panel
      elevation="e1"
      title="Installed"
      actions={
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
            whiteSpace: "nowrap", // §7
          }}
        >
          {rows.length} {rows.length === 1 ? "model" : "models"}
          {totalLabel ? ` · ${total.unknown > 0 ? "≥" : ""}${totalLabel}` : ""}
        </span>
      }
    >
      {loading ? (
        <p style={{ color: "var(--text-secondary)", margin: 0 }}>reading the local library…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", margin: 0 }}>
          No local models yet — pull one from the island beside this.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li
              key={r.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                minWidth: 0, // §7
              }}
            >
              <Dot color={r.served ? "var(--ok)" : "var(--border-strong)"} />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.8rem",
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.id}
              </span>
              {/* a cell with no source is OMITTED, not rendered as "—": the row should not
                  imply that a measurement exists and came back empty. */}
              {r.size && <MetricPill label="" value={r.size} />}
              {r.ctx && <MetricPill label="ctx" value={r.ctx} />}
              {r.quant && <MetricPill label="" value={r.quant} />}
              <button
                type="button"
                onClick={() => (r.served ? onStop(r.id) : onServe(r.id))}
                style={{
                  flex: "none",
                  background: r.served ? "transparent" : "var(--bg-active)",
                  border: `1px solid ${r.served ? "color-mix(in srgb, var(--danger) 45%, transparent)" : "var(--border-strong)"}`,
                  borderRadius: "var(--radius-md, 6px)",
                  color: r.served ? "var(--danger)" : "var(--text-title)",
                  cursor: "pointer",
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  padding: "2px 8px",
                  whiteSpace: "nowrap", // §7
                }}
              >
                {r.served ? "Stop" : "Serve"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** §3 "Pull a model": input + gradient button + the live `62% · 4.1 of 6.6 GB` readout. */
function PullIsland(props: {
  value: string;
  onChange: (v: string) => void;
  onPull: () => void;
  pulling: boolean;
  bar: { pct: number | null; bytes: string | null };
  message: string | null;
  needsRunner: boolean;
  installingRunner: boolean;
  onInstallRunner: () => void;
  manualInstall: string | null;
}): ReactElement {
  const { value, onChange, onPull, pulling, bar, message } = props;
  return (
    <Panel elevation="e1" title="Pull a model">
      <div style={{ display: "flex", gap: 6, minWidth: 0 }}>
        <input
          type="text"
          aria-label="Model to pull"
          placeholder="org/model or ollama tag"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onPull();
          }}
          style={{
            flex: 1,
            minWidth: 0, // §7
            background: "var(--bg-inset)",
            border: "1px solid var(--border-chip)",
            borderRadius: "var(--radius-md, 6px)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.8rem",
            padding: "5px 9px",
          }}
        />
        <button
          type="button"
          onClick={onPull}
          disabled={pulling || props.installingRunner}
          style={{
            flex: "none",
            background: "var(--gradient-brand)",
            border: "none",
            borderRadius: "var(--radius-md, 6px)",
            color: "var(--bg-app)",
            cursor: pulling ? "default" : "pointer",
            fontSize: "0.78rem",
            fontWeight: 700,
            opacity: pulling ? 0.6 : 1,
            padding: "5px 14px",
            whiteSpace: "nowrap", // §7
          }}
        >
          {pulling ? "Pulling…" : "Pull"}
        </button>
      </div>

      {pulling && (
        <div style={{ marginTop: "var(--space-4, 8px)" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-secondary)",
              marginBottom: 3,
              minWidth: 0,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {value.trim() || "model"}
            </span>
            <span style={{ whiteSpace: "nowrap" }}>
              {/* both halves are independently nullable — the runner does not print a
                  percentage on every line, and prints none at all while verifying. */}
              {bar.pct !== null ? `${bar.pct}%` : "…"}
              {bar.bytes ? ` · ${bar.bytes}` : ""}
            </span>
          </div>
          {/* The SHARED primitive, not a fourth hand-rolled bar. Passing `undefined` for a
              line the runner has not put a percentage on yet gives an INDETERMINATE sweep
              rather than a bar pinned at 0 — which reads as "stuck" during the first minute
              of a multi-GB download. */}
          <Progress aria-label="Pull progress" {...(bar.pct !== null ? { value: bar.pct } : {})} />
          <p
            style={{
              margin: "5px 0 0",
              color: "var(--text-muted)",
              fontSize: "0.7rem",
              lineHeight: 1.4,
            }}
          >
            {PULL_SCAN_NOTE}
          </p>
        </div>
      )}

      {message && (
        <p style={{ margin: "8px 0 0", color: "var(--text-primary)", fontSize: "0.78rem" }}>
          {message}
        </p>
      )}
      {props.needsRunner && (
        <div style={{ marginTop: 6 }}>
          <Button
            variant="secondary"
            onClick={props.onInstallRunner}
            disabled={props.installingRunner || pulling}
          >
            {props.installingRunner ? "⏳ Installing Ollama…" : "⬇ Install Ollama automatically"}
          </Button>
        </div>
      )}
      {props.manualInstall && (
        <code
          style={{
            display: "block",
            marginTop: 6,
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            background: "var(--bg-inset)",
            padding: "3px 7px",
            borderRadius: "var(--radius-sm, 4px)",
            overflowWrap: "break-word",
          }}
        >
          {props.manualInstall}
        </code>
      )}
    </Panel>
  );
}

/** §3 "Endpoints": local rows live, cloud rows greyed below A5 with the reason attached. */
function EndpointsIsland(props: {
  endpoints: readonly {
    name: string;
    baseUrl: string;
    locality: "local" | "cloud";
    usable: boolean;
    note?: string;
  }[];
  authLevel: number;
  loading: boolean;
}): ReactElement {
  const { endpoints, authLevel, loading } = props;
  return (
    <Panel
      elevation="e1"
      title="Endpoints"
      actions={
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-muted)",
            whiteSpace: "nowrap", // §7
          }}
        >
          A{authLevel}
        </span>
      }
    >
      {loading ? (
        <p style={{ color: "var(--text-secondary)", margin: 0 }}>discovering endpoints…</p>
      ) : endpoints.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", margin: 0 }}>
          No endpoints are reachable. Start a local runner, or pull a model.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {endpoints.map((e) => (
            <li
              key={`${e.name}:${e.baseUrl}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
                minWidth: 0, // §7
                // a cloud row the current level cannot use is dimmed but NOT hidden —
                // hiding it makes "why can't I use my key" unanswerable.
                opacity: e.usable ? 1 : 0.5,
              }}
            >
              <Dot color={e.usable ? "var(--ok)" : "var(--text-disabled)"} />
              <span
                style={{
                  minWidth: 0,
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.78rem",
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {e.name}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: "0.7rem",
                  color: "var(--text-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {e.baseUrl}
              </span>
              <span
                style={{
                  flex: "none",
                  fontSize: "0.68rem",
                  color: e.locality === "local" ? "var(--ok)" : "var(--text-secondary)",
                  whiteSpace: "nowrap", // §7
                }}
              >
                {e.note ?? e.locality}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default ModelsRoute;
