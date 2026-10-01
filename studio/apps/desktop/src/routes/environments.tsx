// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/environments.tsx — the Environments tab (file 04 §1,§3).
 *
 * This is the renderer-side glue that wires `window.prometheus.env.*` (the
 * contextBridge seam) → TanStack Query (the env/package/cuda READS) + a Zustand
 * slice (selection + the pending-gate sheet) → the @prometheus/ui/env components
 * (<EnvPicker/> <PackageTable/> <CreateEnvWizard/> <CudaPanel/> <GateVerdictSheet/>).
 *
 * RENDERER-SANDBOXED (C5): it imports ONLY react + @tanstack/react-query +
 * @prometheus/ui + the PLAIN-DATA contract types + the renderer store. It NEVER
 * imports node:* / electron / the engine-bridge runtime — every byte crosses the
 * contextBridge. The gate decision on any FETCHING verb is the ENGINE's: a
 * warn/block/error result is stashed and rendered in the <GateVerdictSheet/>; the
 * user confirms (or force-overrides) and the route re-runs the SAME request with
 * `confirm:true` / `force:true`. JS never decides "safe".
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ComponentProps, type ReactElement, useCallback, useEffect, useState } from "react";

import {
  Button,
  type CreateEnvPayload,
  CreateEnvWizard,
  CudaPanel,
  EnvPicker,
  type EnvRowData,
  type GatePlanItemData,
  GateVerdictSheet,
  type GpuInfoData,
  PackageTable,
  Panel,
  type TemplateData,
} from "@prometheus/ui";

import { qk } from "../renderer/query/client.js";
import { DecisionOverlay } from "../renderer/shell/DecisionOverlay.js";
import { ForceGate, useForceGate } from "../renderer/shell/ForceGate.js";
import { useEnvironmentsStore } from "../renderer/stores/environments.js";
import type {
  CudaInfoResult,
  EnvGateSummary,
  EnvGatedResult,
  EnvListResult,
  PkgInstallRequest,
  PkgListResult,
  ProgressFeedEvent,
} from "../shared/ipc-contract.js";
import { cellVar, envAction, envRow } from "./workspace-view.js";

/** The `window.prometheus.env` surface (typed via the contract). */
function envApi(): Window["prometheus"]["env"] {
  return window.prometheus.env;
}

/** The shipped templates (file 04 §7). Static + editable in the wizard; no fetch. */
const TEMPLATES: TemplateData[] = [
  {
    id: "ml-starter",
    title: "ML Starter (PyTorch + sklearn)",
    description: "torch, scikit-learn, pandas, numpy, matplotlib, jupyter",
    builtin: true,
    needs: ["nvidia"],
    packages: [
      { name: "torch" },
      { name: "scikit-learn" },
      { name: "pandas" },
      { name: "numpy" },
      { name: "matplotlib" },
      { name: "jupyter" },
    ],
  },
  {
    id: "llm-serving",
    title: "LLM-serving (vLLM + transformers + flash-attn)",
    description: "vllm, transformers, accelerate, torch; opt: flash-attn, bitsandbytes",
    builtin: true,
    needs: ["nvidia"],
    packages: [
      { name: "torch" },
      { name: "transformers", version: ">=4.40" },
      { name: "vllm" },
      { name: "accelerate" },
      { name: "flash-attn", optional: true, note: "needs NVIDIA build toolchain" },
      { name: "bitsandbytes", optional: true },
    ],
  },
  {
    id: "data-science",
    title: "Data Science",
    description: "pandas, numpy, polars, scikit-learn, jupyterlab, seaborn, statsmodels",
    builtin: true,
    packages: [
      { name: "pandas" },
      { name: "numpy" },
      { name: "polars" },
      { name: "scikit-learn" },
      { name: "jupyterlab" },
      { name: "seaborn" },
      { name: "statsmodels" },
    ],
  },
  {
    id: "notebook-min",
    title: "Minimal Notebook",
    description: "ipykernel, jupyterlab",
    builtin: true,
    packages: [{ name: "ipykernel" }, { name: "jupyterlab" }],
  },
];

/** Read the detected envs (read-only; never gates). */
function useEnvs() {
  return useQuery({
    queryKey: qk.envs(),
    queryFn: (): Promise<EnvListResult> => envApi().list(),
  });
}

/** Read one env's packages (lazy; enabled only when an env is selected). */
function usePkgs(envId: string | null) {
  return useQuery({
    queryKey: qk.pkgs(envId ?? ""),
    queryFn: (): Promise<PkgListResult> => envApi().pkgList(envId ?? ""),
    enabled: Boolean(envId),
  });
}

/** Read the host GPU/CUDA info (read-only). */
function useCuda() {
  return useQuery({
    queryKey: qk.cuda(),
    queryFn: (): Promise<CudaInfoResult> => envApi().cudaInfo(),
  });
}

/** Coerce a plain-data envs payload → the EnvRowData[] the picker renders. */
function asEnvRows(res: EnvListResult | undefined): EnvRowData[] {
  if (!res?.ok || !Array.isArray(res.envs)) return [];
  return res.envs as unknown as EnvRowData[];
}

/** The exact row shape <PackageTable/> consumes — derived from the component so the
 *  env-module PackageRowData (source/envId) and the §3.2 patterns PackageRowData
 *  never clash at this seam. */
type PkgRow = ComponentProps<typeof PackageTable>["packages"][number];

/** Coerce a plain-data packages payload → the PkgRow[] the table renders. */
function asPkgRows(res: PkgListResult | undefined): PkgRow[] {
  if (!res?.ok || !Array.isArray(res.packages)) return [];
  return res.packages as unknown as PkgRow[];
}

/** Coerce a plain-data cuda payload → the GpuInfoData the panel renders. */
function asGpuInfo(res: CudaInfoResult | undefined): GpuInfoData | null {
  if (!res?.ok || !res.gpu) return null;
  // Normalize `gpus` at the cast boundary: a macOS / no-NVIDIA / partial probe
  // returns a gpu object without a `gpus` array; CudaPanel's `gpu.gpus.map` must
  // get [] (fail-closed) rather than crash.
  const g = res.gpu as Record<string, unknown>;
  return { ...g, gpus: Array.isArray(g.gpus) ? g.gpus : [] } as unknown as GpuInfoData;
}

/** Is this a macOS host? (best-effort; the contract carries no OS field here). */
function isMacHost(): boolean {
  const ua = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  const p = `${ua?.platform ?? ""} ${ua?.userAgent ?? ""}`.toLowerCase();
  return p.includes("mac");
}

export function EnvironmentsRoute(): ReactElement {
  // §9: the shared typed-confirm gate for deep-red overrides on this route.
  const force = useForceGate();
  const qc = useQueryClient();
  const envsQ = useEnvs();
  const cudaQ = useCuda();

  const selectedEnvId = useEnvironmentsStore((s) => s.selectedEnvId);
  const wizardOpen = useEnvironmentsStore((s) => s.wizardOpen);
  const pendingGate = useEnvironmentsStore((s) => s.pendingGate);
  const selectEnv = useEnvironmentsStore((s) => s.selectEnv);
  const openWizard = useEnvironmentsStore((s) => s.openWizard);
  const closeWizard = useEnvironmentsStore((s) => s.closeWizard);
  const setPendingGate = useEnvironmentsStore((s) => s.setPendingGate);
  const clearPendingGate = useEnvironmentsStore((s) => s.clearPendingGate);
  const setProgress = useEnvironmentsStore((s) => s.setProgress);

  const envRows = asEnvRows(envsQ.data);
  const gpu = asGpuInfo(cudaQ.data);

  // default the selection to the active (or first) env once envs load.
  useEffect(() => {
    if (selectedEnvId === null && envRows.length > 0) {
      const active = envRows.find((e) => e.active) ?? envRows[0];
      if (active) selectEnv(active.id);
    }
  }, [selectedEnvId, envRows, selectEnv]);

  const pkgsQ = usePkgs(selectedEnvId);
  const pkgRows = asPkgRows(pkgsQ.data);
  const selectedEnv = envRows.find((e) => e.id === selectedEnvId) ?? null;

  // subscribe to the env progress feed (cosmetic; cleared when a sheet appears).
  useEffect(() => {
    const off = envApi().onProgress((e: ProgressFeedEvent) => setProgress(e.message));
    return off;
  }, [setProgress]);

  const refetchAll = useCallback((): void => {
    void qc.invalidateQueries({ queryKey: qk.envs() });
    if (selectedEnvId) void qc.invalidateQueries({ queryKey: qk.pkgs(selectedEnvId) });
  }, [qc, selectedEnvId]);

  // env IMPORT from a requirements.txt / environment.yml (`env.import`) — built IPC with
  // no UI. Native file picker + name prompt → gated install.
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const onImport = useCallback(async (): Promise<void> => {
    const f = await window.prometheus.fileOpen({
      title: "Select a requirements.txt / environment.yml",
    });
    if (!f.ok || !f.path) return;
    const name = window.prompt("New environment name:", "imported-env");
    if (!name) return;
    setImportMsg("importing…");
    try {
      const r = await envApi().import({ file: f.path, name, confirm: true });
      if (r.installed) {
        refetchAll();
        setImportMsg(`Imported "${name}".`);
      } else if (r.gate && r.gate.verdict !== "allow") {
        setImportMsg(`Import gated (${r.gate.verdict}) — review the source before retrying.`);
      } else {
        setImportMsg(r.error ?? r.message ?? "import did not complete");
      }
    } catch (e) {
      setImportMsg(e instanceof Error ? e.message : "import failed");
    }
  }, [refetchAll]);

  // env health-check (`env.doctor`) — built IPC with no UI. Reports broken interpreter /
  // missing packages / drift for the selected env.
  const [doctor, setDoctor] = useState<string | null>(null);
  const [doctoring, setDoctoring] = useState(false);
  const runDoctor = useCallback(async (): Promise<void> => {
    if (!selectedEnvId || doctoring) return;
    setDoctoring(true);
    setDoctor(null);
    try {
      const r = await envApi().doctor(selectedEnvId);
      setDoctor(r.ok ? (r.message ?? "Environment looks healthy.") : (r.error ?? "doctor failed"));
    } catch (e) {
      setDoctor(e instanceof Error ? e.message : "doctor failed");
    } finally {
      setDoctoring(false);
    }
  }, [selectedEnvId, doctoring]);

  /**
   * Run a gated install request and route its outcome. allow ⇒ refetch; warn/
   * block/error ⇒ stash the engine's verdict in the sheet. JS never decides safe.
   */
  const runGated = useCallback(
    async (request: PkgInstallRequest, target: string): Promise<void> => {
      try {
        const res: EnvGatedResult = await envApi().pkgInstall(request);
        if (res.installed) {
          clearPendingGate();
          refetchAll();
          return;
        }
        const gate: EnvGateSummary | undefined = res.gate;
        if (gate) setPendingGate({ gate, request, target });
      } catch {
        // IPC/engine failure — clear the pending gate so the UI doesn't hang on it.
        clearPendingGate();
      }
    },
    [clearPendingGate, refetchAll, setPendingGate],
  );

  // package row actions → the gated/ungated env verbs.
  const onUpdate = useCallback(
    (name: string): void => {
      if (!selectedEnvId) return;
      void envApi()
        .pkgUpdate({ envId: selectedEnvId, spec: name })
        .then((res) => {
          if (res.installed) refetchAll();
          else if (res.gate)
            setPendingGate({
              gate: res.gate,
              request: { envId: selectedEnvId, spec: name },
              target: name,
            });
        })
        .catch(() => clearPendingGate());
    },
    [selectedEnvId, refetchAll, setPendingGate, clearPendingGate],
  );
  const onRemove = useCallback(
    (name: string): void => {
      if (!selectedEnvId) return;
      void envApi()
        .pkgRemove(selectedEnvId, name, true)
        .then(refetchAll)
        .catch(() => {});
    },
    [selectedEnvId, refetchAll],
  );
  const onDisable = useCallback(
    (name: string): void => {
      if (!selectedEnvId) return;
      void envApi()
        .pkgDisable(selectedEnvId, name, true)
        .then(refetchAll)
        .catch(() => {});
    },
    [selectedEnvId, refetchAll],
  );
  const onEnable = useCallback(
    (name: string): void => {
      if (!selectedEnvId) return;
      void envApi()
        .pkgEnable(selectedEnvId, name, true)
        .then(refetchAll)
        .catch(() => {});
    },
    [selectedEnvId, refetchAll],
  );

  // create-wizard commit → env.create, then refetch + close.
  const onCreate = useCallback(
    (payload: CreateEnvPayload): void => {
      void envApi()
        .create({
          name: payload.name,
          kind: payload.kind,
          python: payload.base, // the chosen interpreter — was dropped (env made from default)
          location: payload.location,
          templateId: payload.templateId,
          confirm: true,
        })
        .then(() => {
          closeWizard();
          refetchAll();
        })
        .catch(() => closeWizard()); // a rejected create must still close the wizard
    },
    [closeWizard, refetchAll],
  );

  // a preview gate plan from the selected template's checked rows (no verdicts yet).
  const gatePlan: GatePlanItemData[] = [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6, 12px)" }}>
      <Panel title="Environments" elevation="e1">
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "var(--space-3)" }}
        >
          <Button size="sm" variant="secondary" onClick={() => void onImport()}>
            📥 Import from file…
          </Button>
          {importMsg && (
            <span style={{ fontSize: "var(--text-small-size)", color: "var(--text-secondary)" }}>
              {importMsg}
            </span>
          )}
        </div>
        <EnvPicker
          envs={envRows}
          selectedId={selectedEnvId}
          onSelect={selectEnv}
          /* handoff_3 §5: the detail line + the coloured status, per row. Both come from the
             node:test-pinned projection so "0 packages" can never stand in for "unmeasured". */
          renderRowExtra={(e) => {
            const row = envRow(e as unknown as Parameters<typeof envRow>[0]);
            return (
              <>
                <span
                  style={{
                    flex: "none",
                    fontSize: "0.7rem",
                    color: "var(--text-muted)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.detail}
                </span>
                <span
                  style={{
                    flex: "none",
                    fontSize: "0.7rem",
                    fontWeight: 600,
                    color: cellVar(row.status.role),
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.status.text}
                </span>
              </>
            );
          }}
          rowAction={{
            label: (e) => envAction(envRow(e as unknown as Parameters<typeof envRow>[0])),
            onAct: (id) => {
              const e = envRows.find((x) => x.id === id);
              // Activate is the only one that MUTATES; Inspect and Recreate select the row and
              // hand the user to the detail actions, which carry their own confirms.
              if (e && !e.active && e.health !== "broken") {
                void envApi()
                  .use(id)
                  .then(refetchAll)
                  .catch(() => {});
              } else {
                selectEnv(id);
              }
            },
          }}
          onUse={(id) =>
            void envApi()
              .use(id)
              .then(refetchAll)
              .catch(() => {})
          }
          onClone={(id) =>
            void envApi()
              .clone({ from: id, to: `${id}-clone`, confirm: true })
              .then((res) => {
                // a gated clone (warn/block) used to be silently swallowed → "Clone…" looked
                // dead. Route the verdict to the shared sheet like the other gated verbs.
                if (res.installed) refetchAll();
                else if (res.gate)
                  setPendingGate({
                    gate: res.gate,
                    request: { envId: id, spec: "" },
                    target: `clone of ${id}`,
                  });
              })
              .catch(() => clearPendingGate())
          }
          onExport={(id) =>
            void envApi()
              .export(id)
              .then((r) =>
                setImportMsg(
                  r.ok ? `Exported requirements for "${id}".` : (r.error ?? "export failed"),
                ),
              )
              .catch(() => setImportMsg("export failed"))
          }
          onReveal={(id) => {
            // was a dead/greyed button (prop never passed) — reveal the env folder in the OS.
            const e = envRows.find((x) => x.id === id);
            if (e) void window.prometheus.openPath(e.path).catch(() => {});
          }}
          onDelete={(id) => {
            // destructive: removes the env + all its packages/isolation — confirm first.
            if (
              window.confirm(
                `Delete environment "${id}"? All its packages and isolation are lost. This cannot be undone.`,
              )
            ) {
              void envApi()
                .delete(id, true)
                .then(refetchAll)
                .catch(() => {});
            }
          }}
          onCreate={openWizard}
        />
      </Panel>

      {selectedEnv && (
        <Panel title="Packages" elevation="e1">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: "var(--space-3)",
            }}
          >
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void runDoctor()}
              disabled={doctoring}
            >
              {doctoring ? "Checking…" : "🩺 Doctor"}
            </Button>
            {doctor && (
              <span
                style={{
                  fontSize: "var(--text-small-size)",
                  color: "var(--text-secondary)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {doctor}
              </span>
            )}
          </div>
          <PackageTable
            packages={pkgRows}
            onAdd={openWizard}
            onUpdateAll={() => {
              if (!selectedEnvId) return;
              void envApi()
                .pkgUpgrade({ envId: selectedEnvId })
                .then((res) => {
                  if (res.installed) refetchAll();
                  else if (res.gate)
                    setPendingGate({
                      gate: res.gate,
                      // spec:[] meant the re-run installed NOTHING (silent no-op); carry the
                      // actual outdated set so Proceed actually upgrades them.
                      request: {
                        envId: selectedEnvId,
                        spec: pkgRows.filter((p) => p.state === "outdated").map((p) => p.name),
                      },
                      target: "outdated packages",
                    });
                })
                .catch(() => clearPendingGate());
            }}
            onUpdate={onUpdate}
            onEnable={onEnable}
            onDisable={onDisable}
            onRemove={onRemove}
          />
        </Panel>
      )}

      {gpu && (
        <Panel title="CUDA / GPU" elevation="e1">
          <CudaPanel
            gpu={gpu}
            isMac={isMacHost()}
            targetEnvName={selectedEnv?.name}
            onInstallTorch={
              selectedEnvId
                ? () =>
                    void envApi()
                      .cudaTorch({ envId: selectedEnvId, confirm: true })
                      .then((res) => {
                        if (res.installed) refetchAll();
                        else if (res.gate)
                          setPendingGate({
                            gate: res.gate,
                            request: { envId: selectedEnvId, spec: "torch" },
                            target: "torch (CUDA-matched wheel)",
                          });
                      })
                      .catch(() => clearPendingGate())
                : undefined
            }
            onInstallToolkit={() =>
              void envApi()
                .cudaInstall()
                .then(refetchAll)
                .catch(() => {})
            }
          />
        </Panel>
      )}

      {wizardOpen && (
        <Panel title="New environment" elevation="e2">
          <CreateEnvWizard
            interpreters={[{ path: "python3", version: "3.x (detected)" }]}
            templates={TEMPLATES}
            gpu={gpu ?? undefined}
            gatePlan={gatePlan}
            onCreate={onCreate}
            onCancel={closeWizard}
          />
        </Panel>
      )}

      {/* the gate decision is the ENGINE's — rendered in the shared sheet (file 03).
          §9: as an OVERLAY, never in-flow — a verdict that scrolls below the fold is a
          decision the user never got to make. */}
      {pendingGate && (
        <DecisionOverlay label="Security gate" onDismiss={clearPendingGate}>
          <Panel title="Security gate" elevation="e2">
            <GateVerdictSheet
              gate={pendingGate.gate}
              target={pendingGate.target}
              onProceed={() => {
                const proceed = { ...pendingGate.request, confirm: true };
                void runGated(proceed, pendingGate.target);
              }}
              onCancel={clearPendingGate}
              onRequestForce={() => {
                // §9 (HIGH): typed confirm before the override. The previous comment here
                // claimed the sheet's "Advanced disclosure flow" collected one — it does
                // not; that disclosure only reveals a button. This is the actual confirm.
                const req = pendingGate.request;
                // Close the verdict overlay BEFORE raising the confirm. Both are Z.modal
                // with their own document-capture focus trap, so leaving this one mounted
                // stacks two traps and one Escape fires both — the other three routes
                // (catalog/models/repos) already clear first.
                clearPendingGate();
                force.ask({
                  target: pendingGate.target,
                  blockingReasons: pendingGate.gate.reasons,
                  // `confirmForce` pairs with `force`: main DROPS a bare force (§9a).
                  onConfirm: () =>
                    void runGated(
                      { ...req, confirm: true, force: true, confirmForce: true },
                      pendingGate.target,
                    ),
                });
              }}
            />
          </Panel>
        </DecisionOverlay>
      )}

      {/* §9: the typed confirm that gates every deep-red override on this route. */}
      <ForceGate gate={force} />
    </div>
  );
}

export default EnvironmentsRoute;
