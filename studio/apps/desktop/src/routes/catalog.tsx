/**
 * routes/catalog.tsx — the Catalog browser tab (file 06 §4,§5,§6).
 *
 * The renderer-side glue that wires `window.prometheus.catalog.*` (the
 * contextBridge seam) → TanStack Query (the list/matrix/status READS) → a faithful
 * projection via @prometheus/core normalize (engine JSON → CatalogItem[]) → a
 * tabbed browser + the rich card + the per-agent Reach Matrix (§5) + the Skills
 * sub-surface (§6), reusing the shared file-03 <VerdictSheet/> for the install /
 * audit gate flow.
 *
 * RENDERER-SANDBOXED (C5): it imports ONLY react + @tanstack/react-query +
 * @prometheus/ui (presentational) + @prometheus/core (the PURE normalize/sort
 * projection — no node:*, no engine-bridge runtime) + the PLAIN-DATA contract
 * types. It NEVER imports node:* / electron / the engine-bridge runtime — every
 * byte crosses the contextBridge.
 *
 * THE GOLDEN RULE (C5): the gate decision on an INSTALL is the ENGINE's. The FIRST
 * install is always a dry-run preview; its verdict (from `audit`/the install
 * envelope) is rendered in the <VerdictSheet/>; the user confirms (re-run with
 * dryRun:false) or force-overrides (re-run with force:true + confirmForce:true —
 * the deep-red typed-confirm). A force-installed BLOCK surfaces a PERSISTENT
 * deep-red banner from `forcedDanger` (§4.3). JS never decides "safe".
 *
 * DOCUMENTED-ONLY (tier="documented", installable:false) renders as a read-only
 * reference card: NO Install action in the DOM (enforced upstream in core, not
 * just hidden here), an "Open docs ↗" link, + the why_excluded caution.
 */

import {
  Button,
  Panel,
  PurgeDialog,
  StatusMark,
  VerdictSheet,
  gateToVerdict,
} from "@prometheus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { qk } from "../renderer/query/client.js";
import type {
  CatalogAppLifecycleRequest,
  CatalogBrowseResult,
  CatalogEnvelopeResult,
  CatalogInstallResult,
  RepoGateSummary,
} from "../shared/ipc-contract.js";
import {
  type LifecycleMenuAction,
  appendLifecycleLog,
  lifecycleRequest,
  lifecycleRunId,
  lifecycleStreams,
  lifecycleSurfaceFor,
  parseVersions,
} from "./catalog-lifecycle-view.js";
import {
  type UninstallPending,
  uninstallFailure,
  uninstallStep,
} from "./catalog-uninstall-view.js";

/**
 * The rich catalog item the browser renders. It is the element of the PROJECTED
 * `CatalogBrowseResult.items` (the MAIN process runs the PURE @prometheus/core
 * normalize and hands back plain data — the renderer never bundles the Node-only
 * core barrel, C5). Deriving the type from the contract keeps the route sandboxed.
 */
type CatalogItem = CatalogBrowseResult["items"][number];

/** The `window.prometheus.catalog` surface (typed via the contract). */
function catalogApi(): Window["prometheus"]["catalog"] {
  return window.prometheus.catalog;
}

/* ── reads (TanStack Query) ──────────────────────────────────────────────────*/

/**
 * The PROJECTED catalog: one `browse()` call returns the rich CatalogItem[] (list
 * + matrix + status, projected + reconciled in the MAIN process). The engine stays
 * the source of truth; this is the cached read the browser renders.
 */
function useBrowse() {
  return useQuery({
    queryKey: qk.catalog(),
    queryFn: (): Promise<CatalogBrowseResult> => catalogApi().browse(),
  });
}

/* ── tabs ────────────────────────────────────────────────────────────────────*/

const TABS = [
  { id: "plugins", label: "Plugins" },
  { id: "apps", label: "Apps" },
  { id: "models", label: "Model Tools" },
  { id: "worldsim", label: "World-Sim" },
  { id: "skills", label: "Skills" },
  { id: "reach", label: "Reach Matrix" },
  { id: "documented", label: "Documented" },
] as const;
type CatalogTab = (typeof TABS)[number]["id"];

/* ── the route ───────────────────────────────────────────────────────────────*/

interface PendingGate {
  gate: RepoGateSummary;
  name: string;
  /** the dry-run install plan we are confirming. */
  target: string;
}

export function CatalogRoute(): ReactElement {
  const qc = useQueryClient();
  const [tab, setTab] = useState<CatalogTab>("plugins");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingGate, setPendingGate] = useState<PendingGate | null>(null);
  const [banner, setBanner] = useState<{ name: string; reasons: string[] } | null>(null);
  const [installError, setInstallError] = useState<{ name: string; error: string } | null>(null);
  const [tutorial, setTutorial] = useState<{ id: string; text: string } | null>(null);
  // APP-006 uninstall flow: a SUCCESSFUL dry-run arms the typed-confirm dialog.
  const [uninstallPending, setUninstallPending] = useState<UninstallPending | null>(null);
  const [uninstallError, setUninstallError] = useState<{ name: string; error: string } | null>(
    null,
  );
  // APP-007 lifecycle flow: streamed run + logs pane + versions→rollback picker.
  const [lifecycleError, setLifecycleError] = useState<{ name: string; error: string } | null>(
    null,
  );
  const [activeRun, setActiveRun] = useState<{
    runId: string;
    tool: string;
    action: string;
  } | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [rollbackPick, setRollbackPick] = useState<{
    tool: string;
    surface: CatalogAppLifecycleRequest["surface"];
    versions: string[];
  } | null>(null);
  const [rollbackConfirm, setRollbackConfirm] = useState<{
    tool: string;
    surface: CatalogAppLifecycleRequest["surface"];
    version: string;
  } | null>(null);
  const runSeq = useRef(0);
  const activeRunIdRef = useRef<string | null>(null);
  activeRunIdRef.current = activeRun?.runId ?? null;

  const browseQ = useBrowse();

  const items = useMemo(
    // coalesce: the engine can return an ok envelope with `items` undefined (empty
    // catalog / partial sidecar) → the type says CatalogItem[] but runtime is undefined,
    // which crashed the panel at the .filter below ("reading 'filter'"). Guard it.
    (): CatalogItem[] =>
      browseQ.data?.ok && Array.isArray(browseQ.data.items) ? browseQ.data.items : [],
    [browseQ.data],
  );

  // split by tier/kind for the tabbed surface (browse now folds in the app/model-tool/
  // worldsim registries alongside plugins — one grid per kind).
  const documented = items.filter((i) => i.tier === "documented");
  const plugins = items.filter((i) => i.kind === "plugin" && i.tier !== "documented");
  const base =
    tab === "documented"
      ? documented
      : tab === "apps"
        ? items.filter((i) => i.kind === "app")
        : tab === "models"
          ? items.filter((i) => i.kind === "model-tool")
          : tab === "worldsim"
            ? items.filter((i) => i.kind === "worldsim")
            : plugins;
  const filtered = base.filter(
    (i) =>
      !search ||
      i.title.toLowerCase().includes(search.toLowerCase()) ||
      i.summary.toLowerCase().includes(search.toLowerCase()),
  );
  const selected = items.find((i) => i.id === selectedId) ?? null;

  const refetchAll = useCallback((): void => {
    void qc.invalidateQueries({ queryKey: qk.catalog() });
  }, [qc]);

  /**
   * Run an install. The FIRST call is a dry-run preview (the engine still gates):
   * - a clean preview ⇒ re-run with dryRun:false to commit.
   * - a warn/block envelope ⇒ stash the verdict for the <VerdictSheet/>.
   * - a force-installed BLOCK ⇒ render the persistent deep-red banner (§4.3).
   * JS never decides "safe" (C5).
   */
  const install = useMutation({
    mutationFn: (vars: { name: string; dryRun: boolean; force: boolean }) =>
      catalogApi().install({
        name: vars.name,
        dryRun: vars.dryRun,
        yes: !vars.dryRun,
        force: vars.force,
        confirmForce: vars.force, // the deep-red typed-confirm pairs the force flag
      }),
    onSuccess: (res: CatalogInstallResult, vars) => {
      if (res.forcedDanger && res.forcedDanger.length > 0) {
        const fd = res.forcedDanger[0];
        setBanner({ name: vars.name, reasons: fd?.blockingReasons ?? [] });
        refetchAll();
        return;
      }
      // a blocked preview rides back as ok:false — surface the verdict if present.
      const raw = (res.data ?? {}) as Record<string, unknown>;
      const verdict = (raw.verdict ?? raw.worst_verdict) as string | undefined;
      if (!res.ok && verdict && verdict !== "allow") {
        setPendingGate({
          gate: gateFromEnvelope(raw),
          name: vars.name,
          target: vars.name,
        });
        return;
      }
      if (vars.dryRun && res.ok) {
        // clean preview → commit for real (the engine re-gates).
        install.mutate({ name: vars.name, dryRun: false, force: false });
        return;
      }
      // a non-allow/non-forced FAILURE. Surface the REAL reason: the engine reports a
      // nemesis BLOCK via structured install_events (no top-level error/verdict) — e.g.
      // frontend-design flagged dangerous (21 HIGH findings). Without this the banner
      // showed a meaningless "install failed" for what is actually a security block.
      if (!res.ok) {
        const events = Array.isArray(res.installEvents) ? res.installEvents : [];
        const bad = events.filter((e) => {
          const r = (e as { result?: unknown }).result;
          return r === "blocked" || r === "error" || r === "failed";
        });
        let msg = res.error ?? res.message;
        if (!msg && bad.length > 0) {
          const names = bad
            .map((e) => String((e as { plugin?: unknown }).plugin ?? vars.name))
            .join(", ");
          msg = bad.some((e) => (e as { result?: unknown }).result === "blocked")
            ? `Blocked by the security gate — nemesis flagged ${names} as dangerous; not installed. Use Force install to override at your own risk.`
            : `Install did not complete for ${names} — see the log pane below.`;
        }
        if (!msg) {
          const summary = res.summary as Record<string, unknown> | undefined;
          if (summary && Object.keys(summary).length > 0)
            msg = `Install did not complete: ${Object.entries(summary)
              .map(([k, v]) => `${String(v)} ${k}`)
              .join(", ")}.`;
        }
        setInstallError({ name: vars.name, error: msg ?? "install failed" });
      }
      refetchAll();
    },
    onError: (e, vars) => {
      setInstallError({
        name: vars.name,
        error: e instanceof Error ? e.message : "install failed",
      });
    },
  });

  /**
   * Uninstall (APP-006): dry-run FIRST (the engine returns the removal plan),
   * PurgeDialog typed-confirm, then commit with {dryRun:false, yes:true}. The
   * pure step logic is node:test-pinned in catalog-uninstall-view.ts — an
   * ok:false envelope surfaces inline and never refetches (no optimistic removal).
   */
  const uninstall = useMutation({
    mutationFn: (vars: { name: string; dryRun: boolean }) =>
      catalogApi().uninstall({ name: vars.name, dryRun: vars.dryRun, yes: !vars.dryRun }),
    onSuccess: (res: CatalogInstallResult, vars) => {
      const step = uninstallStep(vars, res);
      setUninstallPending(step.pending);
      setUninstallError(step.error);
      if (step.refetch) refetchAll();
    },
    onError: (e, vars) => {
      const step = uninstallFailure(vars.name, e);
      setUninstallPending(step.pending);
      setUninstallError(step.error);
    },
  });

  // The catalog progress stream is GLOBAL (install/uninstall/bundle/lifecycle share
  // it) — append ONLY the active run's lines (strict runId match in the pure helper).
  // The unsubscribe runs in cleanup so StrictMode's double-mount never stacks listeners.
  useEffect(() => {
    const off = catalogApi().onProgress((e) => {
      setLogLines((lines) => appendLifecycleLog(lines, e, activeRunIdRef.current));
    });
    return off;
  }, []);

  /**
   * App/worldsim/model lifecycle (APP-007): every verb rides the one validated
   * channel; the envelope renders (reader for logs/status, picker for versions,
   * inline error on ok:false) — never swallowed. Mutating verbs stream stderr
   * into the logs pane via their runId. The engine gates fetches itself (C5).
   */
  const lifecycle = useMutation({
    mutationFn: (vars: CatalogAppLifecycleRequest) => catalogApi().appLifecycle(vars),
    onSuccess: (res: CatalogEnvelopeResult, vars) => {
      const tool = vars.tool ?? "";
      if (lifecycleStreams(vars.action)) setActiveRun(null); // stream over; lines stay
      if (!res.ok) {
        setLifecycleError({ name: tool, error: res.error ?? `${vars.action} failed` });
        refetchAll(); // a failed restart/rollback may still have changed state
        return;
      }
      if (vars.action === "versions") {
        const versions = parseVersions(res.data);
        if (versions.length === 0) {
          setLifecycleError({ name: tool, error: "engine reported no versions to roll back to" });
        } else {
          setRollbackPick({ tool, surface: vars.surface, versions });
        }
        return;
      }
      if (vars.action === "logs" || vars.action === "status") {
        setTutorial({
          id: tool,
          text: `${vars.action} — ${tool}:\n\n${JSON.stringify(res.data ?? {}, null, 2)}`,
        });
        return;
      }
      // update/restart/rollback/enable/disable — re-derive the status chip (§5).
      refetchAll();
    },
    onError: (e, vars) => {
      if (lifecycleStreams(vars.action)) setActiveRun(null);
      setLifecycleError({
        name: vars.tool ?? "",
        error: e instanceof Error ? e.message : String(e),
      });
    },
  });

  const runLifecycle = useCallback(
    (
      surface: CatalogAppLifecycleRequest["surface"],
      action: string,
      tool: string,
      version?: string,
    ): void => {
      setLifecycleError(null);
      if (lifecycleStreams(action)) {
        runSeq.current += 1;
        const runId = lifecycleRunId(tool, runSeq.current);
        setLogLines([]);
        setActiveRun({ runId, tool, action });
        lifecycle.mutate(lifecycleRequest(surface, action, tool, { version, runId }));
      } else {
        lifecycle.mutate(lifecycleRequest(surface, action, tool, { version }));
      }
    },
    [lifecycle],
  );

  const onAudit = useCallback(async (name: string): Promise<void> => {
    try {
      const res = await catalogApi().audit(name);
      const raw = (res.data ?? {}) as Record<string, unknown>;
      setPendingGate({ gate: gateFromEnvelope(raw), name, target: name });
    } catch {
      /* audit IPC failed — surfaced via the global rejection handler; no stuck UI */
    }
  }, []);

  // Superscan ALL installed sources for threats (`catalog.superscan`) — built IPC with
  // no UI. Surfaces the engine report in the reader dialog.
  const [superscanning, setSuperscanning] = useState(false);
  const onSuperscan = useCallback(async (): Promise<void> => {
    if (superscanning) return;
    setSuperscanning(true);
    setTutorial({ id: "superscan", text: "Scanning all installed sources for threats…" });
    try {
      const r = await catalogApi().superscan();
      setTutorial({
        id: "superscan",
        text:
          r.ok && r.data
            ? `Superscan — all installed sources:\n\n${JSON.stringify(r.data, null, 2)}`
            : `Superscan failed.${r.error ? `\n\n${r.error}` : ""}`,
      });
    } catch (e) {
      setTutorial({
        id: "superscan",
        text: `Superscan failed: ${e instanceof Error ? e.message : "error"}`,
      });
    } finally {
      setSuperscanning(false);
    }
  }, [superscanning]);

  const loading = browseQ.isPending;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-8, 16px)" }}>
      {/* a plain install FAILURE (engine/network error, not a verdict) — surfaced so the
          button isn't silently returning to idle. */}
      {installError && (
        <div
          role="alert"
          style={{
            border: "1px solid var(--danger)",
            background: "color-mix(in srgb, var(--danger) 14%, transparent)",
            color: "var(--danger)",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: "0.85rem",
          }}
        >
          <strong>Install failed: {installError.name}</strong>
          <div style={{ marginTop: 4 }}>{installError.error}</div>
          <div style={{ marginTop: 6 }}>
            <Button variant="ghost" onClick={() => setInstallError(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {/* persistent deep-red banner for a force-installed BLOCK (§4.3 — never a toast). */}
      {banner && (
        <div
          role="alert"
          style={{
            border: "1px solid var(--danger)",
            background: "color-mix(in srgb, var(--danger) 14%, transparent)",
            color: "var(--danger)",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: "0.85rem",
          }}
        >
          <strong>Force-installed over a nemesis BLOCK: {banner.name}</strong>
          {banner.reasons.length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {banner.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 6 }}>
            <Button variant="ghost" onClick={() => setBanner(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <nav
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--space-3, 6px)",
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            style={{
              background: "transparent",
              border: "none",
              borderBottom: `2px solid ${tab === t.id ? "var(--accent, #6d5ef0)" : "transparent"}`,
              color:
                tab === t.id ? "var(--text-primary, #e7e7ea)" : "var(--text-secondary, #9a9aa3)",
              cursor: "pointer",
              fontSize: "0.9rem",
              padding: "2px 4px 6px",
              fontWeight: tab === t.id ? 700 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void onSuperscan()}
          disabled={superscanning}
          title="Scan every installed source for threats"
          style={{
            marginLeft: "auto",
            background: "var(--bg-surface-2, #16161c)",
            border: "1px solid var(--border-subtle, #2a2a33)",
            borderRadius: 6,
            color: "var(--text-primary, #e7e7ea)",
            cursor: superscanning ? "default" : "pointer",
            fontSize: "0.8rem",
            padding: "2px 8px",
          }}
        >
          {superscanning ? "Scanning…" : "🛡 Superscan"}
        </button>
        <input
          type="search"
          placeholder="search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            background: "var(--bg-surface-2, #16161c)",
            border: "1px solid var(--border-subtle, #2a2a33)",
            borderRadius: 6,
            color: "var(--text-primary, #e7e7ea)",
            padding: "4px 8px",
            fontSize: "0.85rem",
          }}
        />
      </nav>

      {tab === "reach" ? (
        <ReachMatrix items={plugins} loading={loading} />
      ) : tab === "skills" ? (
        <SkillsPanel />
      ) : (
        <div
          style={{
            display: "grid",
            // responsive: two columns when wide, STACK to one on a narrow window
            // (the old fixed 1.4fr/1fr squeezed the detail pane to a sliver).
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
            gap: "var(--space-8, 16px)",
          }}
        >
          <Panel title={tab === "documented" ? "Documented (read-only)" : "Catalog"} elevation="e1">
            {loading ? (
              <p style={{ color: "var(--text-secondary, #9a9aa3)" }}>loading catalog…</p>
            ) : filtered.length === 0 ? (
              <p style={{ color: "var(--text-secondary, #9a9aa3)" }}>no items.</p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                {filtered.map((i) => (
                  <CatalogListRow
                    key={i.id}
                    item={i}
                    selected={i.id === selectedId}
                    onSelect={() => setSelectedId(i.id)}
                  />
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Details" elevation="e1">
            {selected ? (
              <ItemCard
                item={selected}
                installing={install.isPending}
                uninstalling={uninstall.isPending}
                uninstallError={uninstallError?.name === selected.id ? uninstallError.error : null}
                lifecycleBusy={lifecycle.isPending}
                lifecycleError={lifecycleError?.name === selected.id ? lifecycleError.error : null}
                onLifecycle={(action) => {
                  const surface = lifecycleSurfaceFor(selected.kind);
                  if (surface) runLifecycle(surface, action, selected.id);
                }}
                onInstall={() => install.mutate({ name: selected.id, dryRun: true, force: false })}
                onUninstall={() => {
                  setUninstallError(null);
                  uninstall.mutate({ name: selected.id, dryRun: true });
                }}
                onAudit={() => void onAudit(selected.id)}
                onWhere={() =>
                  void catalogApi()
                    .where(selected.id)
                    .then((r) => {
                      // surface the result in the reader (was fired-and-discarded → the
                      // "Where?" button looked like it did nothing).
                      setTutorial({
                        id: selected.id,
                        text:
                          r.ok && r.data
                            ? `Install locations for "${selected.id}":\n\n${JSON.stringify(r.data, null, 2)}`
                            : `No install-location info for "${selected.id}".${r.error ? `\n\n${r.error}` : ""}`,
                      });
                    })
                    .catch(() =>
                      setTutorial({
                        id: selected.id,
                        text: "Could not load install locations (engine unavailable).",
                      }),
                    )
                }
                onLearn={() =>
                  void window.prometheus.spectacular
                    .tutorial(selected.id)
                    .then((r) => {
                      // always surface the reader — empty/error states get a clear message
                      // instead of a silently-missing dialog (no user feedback).
                      setTutorial({
                        id: selected.id,
                        text:
                          r.ok && r.text
                            ? r.text
                            : `No tutorial is available for "${selected.id}" yet.${
                                r.error ? `\n\n${r.error}` : ""
                              }`,
                      });
                    })
                    .catch(() =>
                      setTutorial({
                        id: selected.id,
                        text: "Could not load the tutorial (engine unavailable).",
                      }),
                    )
                }
              />
            ) : (
              <p style={{ color: "var(--text-secondary, #9a9aa3)" }}>select an item.</p>
            )}
            {/* APP-007: live lifecycle logs — the engine's stderr for the ACTIVE run only
                (runId-filtered; foreign install/bundle lines never interleave). */}
            {(activeRun !== null || logLines.length > 0) && (
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    color: "var(--text-secondary, #9a9aa3)",
                    fontSize: "0.75rem",
                    marginBottom: 4,
                  }}
                >
                  <span>
                    {activeRun
                      ? `${activeRun.action} ${activeRun.tool} — running…`
                      : "lifecycle log (finished)"}
                  </span>
                  {!activeRun && (
                    <Button variant="ghost" onClick={() => setLogLines([])}>
                      Clear
                    </Button>
                  )}
                </div>
                <pre
                  style={{
                    margin: 0,
                    maxHeight: 180,
                    overflow: "auto",
                    background: "var(--bg-inset, #0c0c10)",
                    border: "1px solid var(--border-subtle, #2a2a33)",
                    borderRadius: 6,
                    padding: "6px 8px",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.72rem",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {logLines.length > 0 ? logLines.join("\n") : "waiting for engine output…"}
                </pre>
              </div>
            )}
          </Panel>
        </div>
      )}

      {/* APP-006: the typed-confirm gate for removal — the SAME deep-red dialog the
          purge flow uses; the CTA arms only when the typed text === the item name.
          Cancel leaves state untouched; confirm commits with dryRun:false + yes:true. */}
      {uninstallPending && (
        <PurgeDialog
          filename={uninstallPending.name}
          title="Uninstall"
          description={
            <>
              Removes{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>{uninstallPending.name}</code> from
              every installed host.
              {uninstallPending.plan ? ` Plan: ${uninstallPending.plan}` : ""}
            </>
          }
          onConfirm={() => {
            const name = uninstallPending.name;
            setUninstallPending(null);
            uninstall.mutate({ name, dryRun: false });
          }}
          onCancel={() => setUninstallPending(null)}
        />
      )}

      {/* APP-007: versions → rollback picker (ordering is engine-defined, shown as
          returned); picking a version arms the typed-confirm below. */}
      {rollbackPick && (
        // biome-ignore lint/a11y/useSemanticElements: overlay picker follows the app's WAI-ARIA dialog pattern (no native <dialog> in use).
        <div
          role="dialog"
          aria-label={`Roll back ${rollbackPick.tool}`}
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "color-mix(in srgb, var(--bg-app) 65%, transparent)",
            zIndex: 60,
          }}
        >
          <section
            style={{
              width: "min(420px, 90%)",
              background: "var(--bg-surface-2, #16161c)",
              border: "1px solid var(--border-strong, #3a3a45)",
              borderRadius: 10,
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <strong>Roll back {rollbackPick.tool}</strong>
            <span style={{ color: "var(--text-secondary, #9a9aa3)", fontSize: "0.8rem" }}>
              Pick the version to restore (as reported by the engine):
            </span>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                maxHeight: 220,
                overflow: "auto",
              }}
            >
              {rollbackPick.versions.map((v) => (
                <Button
                  key={v}
                  variant="ghost"
                  onClick={() => {
                    setRollbackConfirm({
                      tool: rollbackPick.tool,
                      surface: rollbackPick.surface,
                      version: v,
                    });
                    setRollbackPick(null);
                  }}
                >
                  {v}
                </Button>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button variant="ghost" onClick={() => setRollbackPick(null)}>
                Cancel
              </Button>
            </div>
          </section>
        </div>
      )}

      {/* APP-007: rollback is state-destroying → the same deep-red typed-confirm gate. */}
      {rollbackConfirm && (
        <PurgeDialog
          filename={rollbackConfirm.tool}
          title="Roll back"
          description={
            <>
              Rolls <code style={{ fontFamily: "var(--font-mono)" }}>{rollbackConfirm.tool}</code>{" "}
              back to version{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>{rollbackConfirm.version}</code>. The
              current version is replaced.
            </>
          }
          onConfirm={() => {
            const { tool, surface, version } = rollbackConfirm;
            setRollbackConfirm(null);
            runLifecycle(surface, "rollback", tool, version);
          }}
          onCancel={() => setRollbackConfirm(null)}
        />
      )}

      {/* the install/audit gate decision is the ENGINE's — rendered in the shared sheet. */}
      {pendingGate && (
        // Fixed-overlay modal (mirrors the sibling dialogs). WITHOUT this the sheet was an
        // in-flow child appended below the catalog grid, inside <main overflow:auto> —
        // below the fold, so a block verdict + the force-override escape hatch were invisible
        // and Install/Audit looked like it did nothing.
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Security verdict: ${pendingGate.name}`}
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "color-mix(in srgb, var(--bg-app) 65%, transparent)",
            padding: "var(--space-8, 16px)",
            overflow: "auto",
            zIndex: 70,
          }}
        >
          <div style={{ width: "min(680px, 100%)", maxHeight: "90vh", overflow: "auto" }}>
            <VerdictSheet
              verdict={gateToVerdict(pendingGate.gate, pendingGate.target)}
              onProceed={() => {
                // proceed = commit the install (the engine still gates; warn ⇒ allowed via --yes).
                install.mutate({ name: pendingGate.name, dryRun: false, force: false });
                setPendingGate(null);
              }}
              onCancel={() => setPendingGate(null)}
              onRequestForce={() => {
                // the deep-red override re-runs the install with force + confirm (§8).
                install.mutate({ name: pendingGate.name, dryRun: false, force: true });
                setPendingGate(null);
              }}
            />
          </div>
        </div>
      )}

      {/* "Learn more" — the deep tutorial (dossier) for the selected item. */}
      {tutorial && (
        // biome-ignore lint/a11y/useSemanticElements: full-screen tutorial reader is the WAI-ARIA dialog pattern; the app does not use native <dialog>.
        <div
          role="dialog"
          aria-label={`Tutorial: ${tutorial.id}`}
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--bg-app)",
            display: "flex",
            flexDirection: "column",
            zIndex: 50,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "var(--space-3, 6px) var(--space-8, 16px)",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <strong>Learn more — {tutorial.id}</strong>
            <Button variant="ghost" onClick={() => setTutorial(null)}>
              ✕ close
            </Button>
          </div>
          <pre
            style={{
              flex: 1,
              margin: 0,
              overflow: "auto",
              padding: "var(--space-8, 16px)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-code-size, 0.875rem)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--text-primary)",
            }}
          >
            {tutorial.text}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ── a gate summary from an engine audit/install envelope (presentation only) ─*/

function gateFromEnvelope(raw: Record<string, unknown>): RepoGateSummary {
  const verdict = String(raw.verdict ?? raw.worst_verdict ?? "error");
  const tier =
    verdict === "allow" || verdict === "warn" || verdict === "block" || verdict === "error"
      ? verdict
      : "error";
  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.map(String)
    : Array.isArray(raw.blocking_reasons)
      ? raw.blocking_reasons.map(String)
      : [];
  return {
    verdict: tier,
    score: typeof raw.risk_score === "number" ? raw.risk_score : tier === "allow" ? 0 : 100,
    reasons,
    signed: Boolean(raw.signed),
    ...(typeof raw.recommendation === "string" ? { recommendation: raw.recommendation } : {}),
  };
}

/* ── list row ────────────────────────────────────────────────────────────────*/

function CatalogListRow(props: {
  item: CatalogItem;
  selected: boolean;
  onSelect: () => void;
}): ReactElement {
  const { item, selected, onSelect } = props;
  const rank = item.recommendRank;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        style={{
          width: "100%",
          textAlign: "left",
          background: selected ? "var(--bg-surface-2, #1d1d25)" : "transparent",
          border: "none",
          borderRadius: 6,
          color: "var(--text-primary, #e7e7ea)",
          cursor: "pointer",
          padding: "6px 8px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {item.tier === "official" ? "★ " : ""}
          {item.title}
        </span>
        {/* tri-state install status mark: green ✓ present · red ✗ absent · · unknown (same
            source of truth as the CLI list + the /invoke picker — never a false ✗). */}
        <StatusMark
          presence={item.state?.presence ?? (item.state?.installed ? "present" : "absent")}
          withLabel
        />
        {rank !== undefined && (
          <span style={{ fontSize: "0.72rem", color: "var(--text-secondary, #9a9aa3)" }}>
            #{rank}
          </span>
        )}
        {item.tier === "documented" && (
          <span
            style={{
              fontSize: "0.68rem",
              color: "var(--warn, #e0a458)",
              border: "1px solid var(--warn, #e0a458)",
              borderRadius: 4,
              padding: "0 4px",
            }}
          >
            doc
          </span>
        )}
      </button>
    </li>
  );
}

/* ── the rich card (§4.1) ────────────────────────────────────────────────────*/

function ItemCard(props: {
  item: CatalogItem;
  installing: boolean;
  uninstalling: boolean;
  /** the item's inline uninstall failure (envelope ok:false) — never a silent drop. */
  uninstallError: string | null;
  lifecycleBusy: boolean;
  /** the item's inline lifecycle failure (envelope ok:false) — never a silent drop. */
  lifecycleError: string | null;
  onLifecycle: (action: LifecycleMenuAction | "status") => void;
  onInstall: () => void;
  onUninstall: () => void;
  onAudit: () => void;
  onWhere: () => void;
  onLearn: () => void;
}): ReactElement {
  const { item, installing, uninstalling, uninstallError, onInstall, onUninstall } = props;
  const { lifecycleBusy, lifecycleError, onLifecycle, onAudit, onWhere, onLearn } = props;
  const reachEntries = Object.entries(item.reach ?? {});
  const installed = item.state?.installed === true || item.state?.presence === "present";
  // lifecycle menu only for the app/worldsim/model-tool surfaces AND installed entries.
  const hasLifecycle = installed && lifecycleSurfaceFor(item.kind) !== null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: "0.85rem" }}>
      <div>
        <div style={{ fontSize: "1rem", fontWeight: 700 }}>{item.title}</div>
        <div style={{ color: "var(--text-secondary, #9a9aa3)" }}>
          {item.tier}
          {item.bundle ? " · bundle" : ""}
          {item.scope ? ` · ${item.scope}` : ""}
        </div>
      </div>
      {item.repo && (
        <div style={{ color: "var(--text-secondary, #9a9aa3)" }}>
          {item.repo}
          {item.license ? ` · ${item.license}` : ""}
          {item.stars !== undefined ? ` · ★${item.stars}` : ""}
        </div>
      )}
      <p style={{ margin: 0 }}>{item.summary}</p>
      {reachEntries.length > 0 && (
        <div>
          <div style={{ color: "var(--text-secondary, #9a9aa3)", marginBottom: 4 }}>Reach</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {reachEntries.map(([agent, cell]) => (
              <span
                key={agent}
                style={{
                  fontSize: "0.72rem",
                  border: "1px solid var(--border-subtle, #2a2a33)",
                  borderRadius: 4,
                  padding: "0 5px",
                  color:
                    cell === "native"
                      ? "var(--ok, #5fd38d)"
                      : cell === "sync"
                        ? "var(--accent, #6d5ef0)"
                        : "var(--text-secondary, #9a9aa3)",
                }}
              >
                {agent} {cell === "native" ? "✓" : cell === "sync" ? "↔" : "–"}
              </span>
            ))}
          </div>
        </div>
      )}
      {item.components && item.components.length > 0 && (
        <div style={{ color: "var(--text-secondary, #9a9aa3)" }}>
          Components: {item.components.map((c) => c.id).join(", ")}
        </div>
      )}
      {item.automation && <div>Automation: {item.automation}</div>}
      {item.securityNote && (
        <div style={{ color: "var(--warn, #e0a458)" }}>Security: {item.securityNote}</div>
      )}
      {item.tier === "documented" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {item.whyExcluded && (
            <div
              style={{
                color: "var(--warn, #e0a458)",
                border: "1px solid var(--warn, #e0a458)",
                borderRadius: 6,
                padding: "6px 8px",
              }}
            >
              {item.whyExcluded}
            </div>
          )}
          {item.docUrl && (
            <a
              href={item.docUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent, #6d5ef0)" }}
            >
              Open docs ↗
            </a>
          )}
          <div>
            <Button variant="ghost" onClick={onLearn}>
              Learn more
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
          <Button variant="ghost" onClick={onLearn}>
            Learn more
          </Button>
          <Button variant="ghost" onClick={onAudit}>
            Audit
          </Button>
          <Button variant="ghost" onClick={onWhere}>
            Where?
          </Button>
          {/* installable:false is enforced upstream in core; the action is ABSENT, not disabled. */}
          {item.installable && (
            <Button variant="primary" onClick={onInstall} disabled={installing}>
              {installing ? "installing…" : "Install (dry-run first)"}
            </Button>
          )}
          {/* APP-006: removal is offered only for INSTALLED items; the click runs a
              dry-run first, then the deep-red typed-confirm gates the real commit. */}
          {installed && (
            <Button variant="danger" onClick={onUninstall} disabled={uninstalling}>
              {uninstalling ? "uninstalling…" : "Uninstall…"}
            </Button>
          )}
        </div>
      )}
      {/* APP-007: the per-entry lifecycle menu (apps/worldsim/model-tools). Every verb
          rides catalog.appLifecycle; "Versions…" opens the rollback picker. Verbs a
          given tool doesn't support come back ok:false and render inline (honest). */}
      {hasLifecycle && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {(
            [
              ["update", "Update"],
              ["restart", "Restart"],
              ["status", "Status"],
              ["logs", "Logs"],
              ["versions", "Versions…"],
              ["enable", "Enable"],
              ["disable", "Disable"],
            ] as const
          ).map(([action, label]) => (
            <Button
              key={action}
              variant="ghost"
              disabled={lifecycleBusy}
              onClick={() => onLifecycle(action)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      {lifecycleError && (
        <div role="alert" style={{ color: "var(--danger)", fontSize: "0.8rem" }}>
          Lifecycle action failed: {lifecycleError}
        </div>
      )}
      {uninstallError && (
        <div role="alert" style={{ color: "var(--danger)", fontSize: "0.8rem" }}>
          Uninstall failed: {uninstallError}
        </div>
      )}
    </div>
  );
}

/* ── the Reach Matrix screen (§5) ────────────────────────────────────────────*/

function ReachMatrix(props: { items: CatalogItem[]; loading: boolean }): ReactElement {
  const { items, loading } = props;
  const agents = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) for (const a of Object.keys(i.reach ?? {})) set.add(a);
    return [...set];
  }, [items]);
  return (
    <Panel title="Reach Matrix" elevation="e1">
      <p style={{ marginTop: 0, color: "var(--text-secondary, #9a9aa3)", fontSize: "0.82rem" }}>
        ✓ native · ↔ via sync · – unavailable. Install from the catalog list; cross-agent sync then
        propagates it to ↔ agents.
      </p>
      {loading ? (
        <p style={{ color: "var(--text-secondary, #9a9aa3)" }}>loading matrix…</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: "0.8rem", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "4px 8px" }}>plugin</th>
                {agents.map((a) => (
                  <th key={a} style={{ padding: "4px 8px" }}>
                    {a}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} style={{ borderTop: "1px solid var(--border-subtle, #2a2a33)" }}>
                  <td style={{ padding: "4px 8px" }}>
                    {i.scope === "universal" ? "[U] " : "[C] "}
                    {i.title}
                  </td>
                  {agents.map((a) => {
                    const cell = i.reach?.[a] ?? "-";
                    return (
                      <td
                        key={a}
                        style={{
                          textAlign: "center",
                          padding: "4px 8px",
                          color:
                            cell === "native"
                              ? "var(--ok, #5fd38d)"
                              : cell === "sync"
                                ? "var(--accent, #6d5ef0)"
                                : "var(--text-secondary, #9a9aa3)",
                        }}
                      >
                        {cell === "native" ? "✓" : cell === "sync" ? "↔" : "–"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ── the Skills sub-surface (§6) ─────────────────────────────────────────────*/

interface SkillRow {
  name: string;
  fires?: string;
  state?: string;
  source?: string;
}

function SkillsPanel(): ReactElement {
  const qc = useQueryClient();
  const skillsQ = useQuery({
    queryKey: ["skills"],
    queryFn: () => catalogApi().skillsList(),
  });
  const rows: SkillRow[] = useMemo(() => {
    const data = skillsQ.data?.ok ? skillsQ.data.data : undefined;
    const list = Array.isArray(data?.skills) ? (data.skills as Record<string, unknown>[]) : [];
    return list.map((s) => ({
      name: String(s.name ?? s.id ?? ""),
      fires:
        typeof s.fires === "string"
          ? s.fires
          : typeof s.trigger === "string"
            ? "on-prompt"
            : undefined,
      state: typeof s.state === "string" ? s.state : s.enabled === false ? "disabled" : "enabled",
      source: typeof s.source === "string" ? s.source : undefined,
    }));
  }, [skillsQ.data]);

  const [newName, setNewName] = useState("");
  const [scaffolding, setScaffolding] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  // APP-006: the typed-confirm target for skill removal + its inline failure.
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<{ name: string; error: string } | null>(null);
  const refetch = useCallback(() => void qc.invalidateQueries({ queryKey: ["skills"] }), [qc]);

  // Skills are prometheus.py-installed artifacts → the TOP-LEVEL uninstall verb
  // (EnvelopeResult; main executes for real — no dry-run leg on this surface, so the
  // typed-confirm is the ONLY gate). ok:false surfaces inline; the row leaves only
  // after the post-invalidation refetch (never optimistic).
  const removeSkill = useCallback(
    (name: string): void => {
      if (pending.has(name)) return;
      setPending((p) => new Set(p).add(name));
      void window.prometheus
        .uninstall(name)
        .then((res) => {
          const step = uninstallStep({ name, dryRun: false }, res);
          setRemoveError(step.error);
          if (step.refetch) {
            refetch();
            void qc.invalidateQueries({ queryKey: qk.catalog() });
          }
        })
        .catch((e) => setRemoveError(uninstallFailure(name, e).error))
        .finally(() => {
          setPending((p) => {
            const next = new Set(p);
            next.delete(name);
            return next;
          });
        });
    },
    [pending, refetch, qc],
  );

  // toggle a skill enabled/disabled with a per-row in-flight guard (no double-fire) and
  // a .catch (a rejected IPC no longer silently desyncs the row / unhandled-rejects).
  const toggleSkill = useCallback(
    (name: string, disabledNow: boolean): void => {
      if (pending.has(name)) return;
      setPending((p) => new Set(p).add(name));
      const op = disabledNow ? catalogApi().enable({ name }) : catalogApi().disable({ name });
      void op
        .catch(() => {})
        .finally(() => {
          setPending((p) => {
            const next = new Set(p);
            next.delete(name);
            return next;
          });
          refetch();
        });
    },
    [pending, refetch],
  );

  return (
    <Panel title="Skills (SKILL.md)" elevation="e1">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = newName.trim();
          if (!n || scaffolding) return;
          setScaffolding(true);
          void catalogApi()
            .scaffoldSkill({ name: n, autoFire: true })
            .then(() => {
              setNewName("");
              refetch();
            })
            .catch(() => {})
            .finally(() => setScaffolding(false));
        }}
        style={{ display: "flex", gap: 8, marginBottom: 10 }}
      >
        <input
          placeholder="new skill name (scaffold)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          style={{
            flex: 1,
            background: "var(--bg-surface-2, #16161c)",
            border: "1px solid var(--border-subtle, #2a2a33)",
            borderRadius: 6,
            color: "var(--text-primary, #e7e7ea)",
            padding: "4px 8px",
          }}
        />
        <Button variant="primary" type="submit" disabled={scaffolding || !newName.trim()}>
          {scaffolding ? "…" : "+ New skill"}
        </Button>
      </form>
      {skillsQ.isPending ? (
        <p style={{ color: "var(--text-secondary, #9a9aa3)" }}>loading skills…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "var(--text-secondary, #9a9aa3)" }}>no skills on disk.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary, #9a9aa3)" }}>
              <th style={{ padding: "4px 8px" }}>name</th>
              <th style={{ padding: "4px 8px" }}>fires</th>
              <th style={{ padding: "4px 8px" }}>state</th>
              <th style={{ padding: "4px 8px" }}>actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.name} style={{ borderTop: "1px solid var(--border-subtle, #2a2a33)" }}>
                <td style={{ padding: "4px 8px" }}>{s.name}</td>
                <td style={{ padding: "4px 8px" }}>{s.fires ?? "—"}</td>
                <td style={{ padding: "4px 8px" }}>{s.state}</td>
                <td style={{ padding: "4px 8px", display: "flex", gap: 6 }}>
                  <Button
                    variant="ghost"
                    disabled={pending.has(s.name)}
                    onClick={() => toggleSkill(s.name, s.state === "disabled")}
                  >
                    {pending.has(s.name) ? "…" : s.state === "disabled" ? "Enable" : "Disable"}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={pending.has(s.name)}
                    onClick={() => {
                      setRemoveError(null);
                      setRemoveTarget(s.name);
                    }}
                  >
                    Remove…
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {removeError && (
        <div role="alert" style={{ color: "var(--danger)", fontSize: "0.8rem", marginTop: 8 }}>
          Remove failed: {removeError.name} — {removeError.error}
        </div>
      )}
      {/* APP-006: typed-confirm gate — same deep-red dialog as purge/uninstall. */}
      {removeTarget && (
        <PurgeDialog
          filename={removeTarget}
          title="Remove skill"
          description={
            <>
              Uninstalls <code style={{ fontFamily: "var(--font-mono)" }}>{removeTarget}</code> from
              every agent it was installed into.
            </>
          }
          onConfirm={() => {
            const name = removeTarget;
            setRemoveTarget(null);
            removeSkill(name);
          }}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </Panel>
  );
}

export default CatalogRoute;
