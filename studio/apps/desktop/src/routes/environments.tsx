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
import {
  type ComponentProps,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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
  Input,
  PackageTable,
  Panel,
  type TemplateData,
} from "@prometheus/ui";

import { isMacHost } from "../renderer/platform.js";
import { qk } from "../renderer/query/client.js";
import { DecisionOverlay } from "../renderer/shell/DecisionOverlay.js";
import { ForceGate, useForceGate } from "../renderer/shell/ForceGate.js";
import { useEnvironmentsStore } from "../renderer/stores/environments.js";
import type {
  CudaInfoResult,
  EnvGateSummary,
  EnvGatedResult,
  EnvListResult,
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
/** What a gate-sheet retry adds to the original request. */
type GateExtra = { confirm?: boolean; force?: boolean; confirmForce?: boolean };

/**
 * The interpreters the create wizard offers: the system `python3` plus every distinct
 * interpreter the detected environments report. It was a hardcoded single `python3` row.
 */
function interpretersFrom(data: EnvListResult | undefined): { path: string; version: string }[] {
  const out = new Map<string, string>([["python3", "system default"]]);
  for (const e of data?.envs ?? []) {
    const path = [e.python, e.interpreter, e.executable].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    const version = [e.python_version, e.pythonVersion, e.version].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (path && !out.has(path)) out.set(path, version ?? "");
  }
  return [...out].map(([path, version]) => ({ path, version }));
}

function useEnvs() {
  return useQuery({
    queryKey: qk.envsDetected(),
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
    // `window.prompt` does not exist in Electron (it returns nothing), so this asked for a name
    // and then silently stopped: Import never ran. The name comes from the file instead.
    const base = (f.path.split(/[\\/]/).pop() ?? "env").replace(/\.(txt|ya?ml|toml|lock)$/i, "");
    const name = `imported-${base.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "env"}`;
    setImportMsg(`importing as "${name}"…`);
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
   * Run ANY gated env verb and route its outcome: installed ⇒ refetch; a gate verdict ⇒ the
   * shared sheet, with a RETRY of the SAME verb; anything else ⇒ say why.
   *
   * The sheet used to re-run `pkgInstall` whatever verb raised it — Proceed on a gated clone,
   * upgrade, update or torch install ran an install of `spec` instead (for a clone: of `""`).
   * And a failure here only cleared the sheet, so a refused or crashed run looked like nothing
   * happened. JS never decides safe: every retry goes back through the engine's gate.
   */
  const retryRef = useRef<((extra: GateExtra) => void) | null>(null);
  const routeGated = useCallback(
    async (
      label: string,
      target: string,
      op: (extra: GateExtra) => Promise<EnvGatedResult>,
      extra: GateExtra = {},
    ): Promise<void> => {
      try {
        const res = await op(extra);
        if (res.installed) {
          retryRef.current = null;
          clearPendingGate();
          refetchAll();
          return;
        }
        if (res.gate) {
          retryRef.current = (more) => void routeGated(label, target, op, more);
          setPendingGate({
            gate: res.gate,
            request: { envId: selectedEnvId ?? "", spec: "" },
            target,
          });
          return;
        }
        retryRef.current = null;
        clearPendingGate();
        setImportMsg(`${label} failed: ${res.error ?? res.message ?? "nothing was installed"}`);
      } catch (e) {
        retryRef.current = null;
        clearPendingGate();
        setImportMsg(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [clearPendingGate, refetchAll, setPendingGate, selectedEnvId],
  );

  // "+ Add" on the package table — it used to open the NEW-ENVIRONMENT wizard.
  const [addOpen, setAddOpen] = useState(false);
  const [addSpec, setAddSpec] = useState("");
  const onAddPackage = useCallback((): void => {
    const spec = addSpec.trim();
    if (!selectedEnvId || !spec) return;
    setAddSpec("");
    setAddOpen(false);
    void routeGated(`Install ${spec}`, spec, (x) =>
      envApi().pkgInstall({ envId: selectedEnvId, spec, ...x }),
    );
  }, [addSpec, selectedEnvId, routeGated]);

  // package row actions → the gated/ungated env verbs.
  const onUpdate = useCallback(
    (name: string): void => {
      if (!selectedEnvId) return;
      void routeGated(`Update ${name}`, name, (x) =>
        envApi().pkgUpdate({ envId: selectedEnvId, spec: name, ...x }),
      );
    },
    [selectedEnvId, routeGated],
  );
  /**
   * Run one environment mutation and SAY what happened. These actions used to end in
   * `.then(refetchAll).catch(() => {})`, never reading the `{ok, error}` envelope — a failed
   * remove/disable/use/CUDA install left the list unchanged with no message at all.
   */
  const reportEnvAction = useCallback(
    (label: string, op: Promise<unknown>): void => {
      void op
        .then((r) => {
          const o = (r ?? {}) as { ok?: boolean; error?: string; message?: string };
          if (o.ok === false)
            setImportMsg(`${label} failed: ${o.error ?? o.message ?? "unknown error"}`);
          refetchAll();
        })
        .catch((e: unknown) => {
          setImportMsg(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
          refetchAll();
        });
    },
    [refetchAll],
  );
  const onRemove = useCallback(
    (name: string): void => {
      if (!selectedEnvId) return;
      reportEnvAction(`Remove ${name}`, envApi().pkgRemove(selectedEnvId, name, true));
    },
    [selectedEnvId, reportEnvAction],
  );
  const onDisable = useCallback(
    (name: string): void => {
      if (!selectedEnvId) return;
      reportEnvAction(`Disable ${name}`, envApi().pkgDisable(selectedEnvId, name, true));
    },
    [selectedEnvId, reportEnvAction],
  );
  const onEnable = useCallback(
    (name: string): void => {
      if (!selectedEnvId) return;
      reportEnvAction(`Enable ${name}`, envApi().pkgEnable(selectedEnvId, name, true));
    },
    [selectedEnvId, reportEnvAction],
  );

  // create-wizard commit → env.create, then refetch + close.
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const onCreate = useCallback(
    (payload: CreateEnvPayload): void => {
      // a double click (or Enter on the focused button) issued two env.create calls
      if (creatingRef.current) return;
      creatingRef.current = true;
      setCreating(true);
      void envApi()
        .create({
          name: payload.name,
          kind: payload.kind,
          python: payload.base, // the chosen interpreter — was dropped (env made from default)
          location: payload.location,
          templateId: payload.templateId,
          confirm: true,
        })
        .then((r) => {
          closeWizard();
          refetchAll();
          // a refused/failed create used to close the wizard with no word at all
          const o = (r ?? {}) as { ok?: boolean; error?: string; message?: string };
          if (o.ok === false) {
            setImportMsg(
              `Create "${payload.name}" failed: ${o.error ?? o.message ?? "unknown error"}`,
            );
          }
        })
        .catch((e: unknown) => {
          closeWizard(); // a rejected create must still close the wizard
          setImportMsg(
            `Create "${payload.name}" failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          creatingRef.current = false;
          setCreating(false);
        });
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
            Import from file…
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
                    fontSize: "0.75rem",
                    color: "var(--text-muted)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.detail}
                </span>
                <span
                  style={{
                    flex: "none",
                    fontSize: "0.75rem",
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
                reportEnvAction("Activate", envApi().use(id));
              } else {
                selectEnv(id);
              }
            },
          }}
          onUse={(id) => reportEnvAction("Activate", envApi().use(id))}
          onClone={(id) =>
            void routeGated(`Clone ${id}`, `clone of ${id}`, (x) =>
              envApi().clone({ from: id, to: `${id}-clone`, confirm: true, ...x }),
            )
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
              reportEnvAction(`Delete ${id}`, envApi().delete(id, true));
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
          {addOpen && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                onAddPackage();
              }}
              style={{ display: "flex", gap: 8, marginBottom: "var(--space-3)" }}
            >
              <Input
                value={addSpec}
                onChange={(e) => setAddSpec(e.target.value)}
                placeholder="package to install, e.g. requests or numpy==2.1"
                aria-label="package to install"
                mono
              />
              <Button size="sm" type="submit" disabled={!addSpec.trim()}>
                Install
              </Button>
            </form>
          )}
          <PackageTable
            packages={pkgRows}
            onAdd={() => setAddOpen((v) => !v)}
            onUpdateAll={() => {
              if (!selectedEnvId) return;
              void routeGated("Upgrade", "outdated packages", (x) =>
                envApi().pkgUpgrade({ envId: selectedEnvId, ...x }),
              );
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
                    void routeGated("Install torch", "torch (CUDA-matched wheel)", (x) =>
                      envApi().cudaTorch({ envId: selectedEnvId, confirm: true, ...x }),
                    )
                : undefined
            }
            onInstallToolkit={() => reportEnvAction("CUDA toolkit install", envApi().cudaInstall())}
          />
        </Panel>
      )}

      {wizardOpen && (
        <Panel title="New environment" elevation="e2">
          <CreateEnvWizard
            interpreters={interpretersFrom(envsQ.data)}
            templates={TEMPLATES}
            gpu={gpu ?? undefined}
            gatePlan={gatePlan}
            onCreate={onCreate}
            onCancel={closeWizard}
            busy={creating}
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
                const retry = retryRef.current;
                clearPendingGate();
                retry?.({ confirm: true });
              }}
              onCancel={clearPendingGate}
              onRequestForce={() => {
                // §9 (HIGH): typed confirm before the override. The previous comment here
                // claimed the sheet's "Advanced disclosure flow" collected one — it does
                // not; that disclosure only reveals a button. This is the actual confirm.
                const retry = retryRef.current;
                // Close the verdict overlay BEFORE raising the confirm. Both are Z.modal
                // with their own document-capture focus trap, so leaving this one mounted
                // stacks two traps and one Escape fires both — the other three routes
                // (catalog/models/repos) already clear first.
                clearPendingGate();
                force.ask({
                  target: pendingGate.target,
                  blockingReasons: pendingGate.gate.reasons,
                  // `confirmForce` pairs with `force`: main DROPS a bare force (§9a).
                  onConfirm: () => retry?.({ confirm: true, force: true, confirmForce: true }),
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
