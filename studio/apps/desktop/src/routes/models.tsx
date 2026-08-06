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
  type ServeProfileData,
  ServingPanel,
  VerdictSheet,
  gateToVerdict,
} from "@prometheus/ui";

import { qk } from "../renderer/query/client.js";
import { useModelsStore } from "../renderer/stores/models.js";
import type {
  ModelDownloadResult,
  ModelFitResult,
  ModelHardwareResult,
  ModelProgressEvent,
  ModelSearchResult,
  ModelServeResult,
} from "../shared/ipc-contract.js";

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
        const res: ModelDownloadResult = await modelsApi().download({ id, quant, force });
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
  // the copy-paste fallback (only shown when the auto-install itself can't proceed).
  const [pullInstall, setPullInstall] = useState<string | null>(null);
  // true once a pull failed because the ollama runner is missing → show auto-install.
  const [needsRunner, setNeedsRunner] = useState(false);
  const [installingRunner, setInstallingRunner] = useState(false);
  const handlePull = useCallback(async (): Promise<void> => {
    if (!selectedId || pulling) return;
    setPulling(true);
    setPullMsg(`ollama pull ${selectedId} — downloading…`);
    setPullInstall(null);
    setNeedsRunner(false);
    try {
      const r = await modelsApi().pull({ id: selectedId });
      if (r.ok && r.installed) {
        setPullMsg(`✓ installed ${selectedId} — served at ${r.endpoint ?? "localhost:11434"}`);
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
    }
  }, [selectedId, pulling, refetchServing]);

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
  const serveList: ServeProfileData[] = Object.values(serveRows).sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-8, 16px)" }}>
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
            // the deep-red override re-runs the SAME download (the exact id+quant the user
            // inspected) with force:true — from the request, not a colon-split of target.
            const { id, quant } = pendingGate.request;
            if (id && quant) void runDownload(id, quant, modality, true);
            setPendingGate(null);
          }}
        />
      )}
    </div>
  );
}

export default ModelsRoute;
