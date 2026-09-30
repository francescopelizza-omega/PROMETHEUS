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
  type RoleToken,
  StatusMark,
  StreamLog,
  VerdictCard,
  VerdictSheet,
  Z,
  gateToVerdict,
  useFocusTrap,
} from "@prometheus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { qk } from "../renderer/query/client.js";
import { DecisionOverlay } from "../renderer/shell/DecisionOverlay.js";
import { EngineGate } from "../renderer/shell/EngineGate.js";
import { ForceGate, useForceGate } from "../renderer/shell/ForceGate.js";
import { Segmented } from "../renderer/shell/Segmented.js";
import type {
  CatalogAppLifecycleRequest,
  CatalogBrowseResult,
  CatalogEnvelopeResult,
  CatalogInstallResult,
  RepoGateSummary,
} from "../shared/ipc-contract.js";
import {
  CATALOG_FOOTER_NOTE,
  CATALOG_KINDS,
  CATALOG_VERDICT_CHIP,
  type CatalogKindFilter,
  type CatalogVerdict,
  INSTALL_STEPS,
  type InstallPhase,
  catalogVerdictOf,
  filterByKind,
  filterBySearch,
  installPhase,
  kindGlyph,
  stepStates,
} from "./catalog-browse-view.js";
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
import ExtensionsRoute from "./extensions.js";
import { type CatalogTab, onRouteTab, takeRouteTab } from "./route-tabs.js";
import { classifyStreamLine } from "./stream-line-level.js";

/** Resolve a semantic role → its CSS var. Local, as elsewhere in the app: `roleVar` is not
 *  exported from the @prometheus/ui barrel, and raw hex is a build failure (08 §6). */
function roleVar(role: RoleToken): string {
  return role === "text-secondary" ? "var(--text-secondary)" : `var(--${role})`;
}

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

/* ── segments (handoff_3 §1/§2) ──────────────────────────────────────────────*/

/**
 * The three segments §2 names. The route used to paint SEVEN hand-rolled underline tabs
 * (plugins/apps/models/worldsim/skills/reach/documented) and never read the `catalog` tab
 * latch, so `resolveActivity("extensions")` redirected here and then landed on Plugins — the
 * segment it asked for was silently dropped, and `routes/extensions.tsx` (the MCP connector
 * manager) had no import site at all. Four of the old seven are now a KIND FILTER inside
 * Plugins; the Reach Matrix is a toggle on that island's header.
 */
const SEGMENTS: readonly { id: CatalogTab; label: string }[] = [
  { id: "plugins", label: "Plugins" },
  { id: "extensions", label: "Extensions" },
  { id: "skills", label: "Skills" },
];

/* ── the route ───────────────────────────────────────────────────────────────*/

interface PendingGate {
  gate: RepoGateSummary;
  name: string;
  /** the dry-run install plan we are confirming. */
  target: string;
}

export function CatalogRoute(): ReactElement {
  const qc = useQueryClient();
  // §9: the shared typed-confirm gate for deep-red overrides on this route.
  const force = useForceGate();
  // The segment is LATCHED, not local state, so a persisted `"extensions"` activity from
  // before the §1 merge lands on Catalog/Extensions instead of Catalog's default. Read once
  // in the initial state (the latch is a one-shot handoff) and subscribed to thereafter.
  const [tab, setTab] = useState<CatalogTab>(
    () => (takeRouteTab("catalog") as CatalogTab) ?? "plugins",
  );
  useEffect(() => onRouteTab("catalog", (t) => setTab(t as CatalogTab)), []);
  const [kind, setKind] = useState<CatalogKindFilter>("all");
  const [reachOpen, setReachOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * Per-item gate verdicts, keyed by item id.
   *
   * `CatalogItem` carries no verdict — there is no engine read that returns one for an item
   * nobody has touched — so this map starts EMPTY and every row renders `◌ QUEUED` until an
   * `audit` or an install dry-run actually produces a tier. Defaulting to ALLOW would paint
   * the whole catalog green while contradicting the footer strip directly below it.
   */
  const [verdicts, setVerdicts] = useState<Record<string, CatalogVerdict>>({});
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
  // Both full-screen dialogs below declare aria-modal, so both must MEAN it: Tab stays inside
  // and Escape dismisses. (aria-modal without a trap tells assistive tech the catalog behind
  // is inert while Tab still walks into its Install/Audit buttons.) aria-modal is also what
  // makes the shell refuse ⌘K underneath them (App.tsx anotherModalOpen).
  const tutorialRef = useRef<HTMLDivElement>(null);
  useFocusTrap(tutorialRef, tutorial !== null, () => setTutorial(null));
  const rollbackRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rollbackRef, rollbackPick !== null, () => setRollbackPick(null));
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

  // The kind filter + search are PURE (catalog-browse-view.ts), so "documented never leaks
  // into an installable bucket" and "every registry stays reachable after the merge" are
  // pinned by node:test rather than by reading this expression.
  const plugins = items.filter((i) => i.kind === "plugin" && i.tier !== "documented");
  const filtered = filterBySearch(filterByKind(items, kind), search);
  const selected = items.find((i) => i.id === selectedId) ?? null;

  /** Record the tier an audit / install envelope produced for an item (§2 row chip). */
  const noteVerdict = useCallback((name: string, raw: string | null | undefined): void => {
    setVerdicts((v) => ({ ...v, [name]: catalogVerdictOf(raw) }));
  }, []);

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
  /**
   * §9: ARM a streaming run — mint the correlation id, clear the pane, and set
   * `activeRun` (which arms `activeRunIdRef`, the filter key the progress subscription
   * closure reads). This must happen BEFORE `mutate()` so the very first stderr line
   * already matches; arming after would drop the head of every stream.
   */
  const beginRun = useCallback((kind: string, tool: string, action: string): string => {
    runSeq.current += 1;
    const runId = lifecycleRunId(tool, runSeq.current, kind);
    setLogLines([]);
    setActiveRun({ runId, tool, action });
    return runId;
  }, []);
  /** §9: CLOSE a run — the pane stops reading "running…" and the Clear button returns. */
  const endRun = useCallback((): void => setActiveRun(null), []);
  /**
   * §2 stepper state. The five steps are derived from these two facts plus `activeRun` and
   * `pendingGate` — see `installPhase`, which is node:test-pinned. Nothing here is a timer:
   * `Fetch → Dry-run` turns over on the engine's FIRST streamed line, because a stepper that
   * advances on a clock says "Dry-run" while a slow clone is still fetching.
   */
  const [installLeg, setInstallLeg] = useState<"dry" | "commit" | null>(null);
  const [installDone, setInstallDone] = useState<string | null>(null);

  /** Arm an INSTALL leg and return the mutate vars carrying its runId. */
  const beginInstallRun = useCallback(
    (name: string, leg: "dry" | "commit"): { name: string; runId: string } => {
      setInstallLeg(leg);
      setInstallDone(null);
      return { name, runId: beginRun("install", name, "install") };
    },
    [beginRun],
  );

  const install = useMutation({
    mutationFn: (vars: { name: string; dryRun: boolean; force: boolean; runId?: string }) =>
      catalogApi().install({
        name: vars.name,
        dryRun: vars.dryRun,
        yes: !vars.dryRun,
        force: vars.force,
        confirmForce: vars.force, // the deep-red typed-confirm pairs the force flag
        // §9: without a runId main omits `event.runId`, and appendLifecycleLog's strict
        // filter drops every line — the single root cause of the dead install log.
        ...(vars.runId ? { runId: vars.runId } : {}),
      }),
    onSuccess: (res: CatalogInstallResult, vars) => {
      if (res.forcedDanger && res.forcedDanger.length > 0) {
        const fd = res.forcedDanger[0];
        setBanner({ name: vars.name, reasons: fd?.blockingReasons ?? [] });
        noteVerdict(vars.name, fd?.verdict ?? "block");
        setInstallLeg(null);
        endRun();
        refetchAll();
        return;
      }
      // a blocked preview rides back as ok:false — surface the verdict if present.
      const raw = (res.data ?? {}) as Record<string, unknown>;
      const verdict = (raw.verdict ?? raw.worst_verdict) as string | undefined;
      noteVerdict(vars.name, verdict);
      if (!res.ok && verdict && verdict !== "allow") {
        setPendingGate({
          gate: gateFromEnvelope(raw),
          name: vars.name,
          target: vars.name,
        });
        setInstallLeg(null);
        endRun();
        return;
      }
      if (vars.dryRun && res.ok) {
        // clean preview → commit for real (the engine re-gates). Deliberately NOT
        // endRun(): the commit re-arms with its own run below, and closing here would
        // blank the pane between the two legs.
        install.mutate({ ...beginInstallRun(vars.name, "commit"), dryRun: false, force: false });
        return;
      }
      if (res.ok) setInstallDone(vars.name);
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
      setInstallLeg(null);
      endRun();
      refetchAll();
    },
    onError: (e, vars) => {
      setInstallError({
        name: vars.name,
        error: e instanceof Error ? e.message : "install failed",
      });
      setInstallLeg(null);
      endRun();
    },
  });

  /**
   * Uninstall (APP-006): dry-run FIRST (the engine returns the removal plan),
   * PurgeDialog typed-confirm, then commit with {dryRun:false, yes:true}. The
   * pure step logic is node:test-pinned in catalog-uninstall-view.ts — an
   * ok:false envelope surfaces inline and never refetches (no optimistic removal).
   */
  const uninstall = useMutation({
    mutationFn: (vars: { name: string; dryRun: boolean; runId?: string }) =>
      catalogApi().uninstall({
        name: vars.name,
        dryRun: vars.dryRun,
        yes: !vars.dryRun,
        ...(vars.runId ? { runId: vars.runId } : {}),
      }),
    onSuccess: (res: CatalogInstallResult, vars) => {
      const step = uninstallStep(vars, res);
      setUninstallPending(step.pending);
      setUninstallError(step.error);
      endRun();
      if (step.refetch) refetchAll();
    },
    onError: (e, vars) => {
      const step = uninstallFailure(vars.name, e);
      setUninstallPending(step.pending);
      setUninstallError(step.error);
      endRun();
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

  const onAudit = useCallback(
    async (name: string): Promise<void> => {
      try {
        const res = await catalogApi().audit(name);
        const raw = (res.data ?? {}) as Record<string, unknown>;
        const gate = gateFromEnvelope(raw);
        // an audit is the ONE read that gives a never-installed row a real tier — record it
        // so its §2 chip stops saying QUEUED.
        noteVerdict(name, gate.verdict);
        setPendingGate({ gate, name, target: name });
      } catch {
        /* audit IPC failed — surfaced via the global rejection handler; no stuck UI */
      }
    },
    [noteVerdict],
  );

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

  /** What the install island is about: the armed run's tool, else the selected row. */
  const installTarget = activeRun?.tool ?? selected?.id ?? null;
  /** The §2 stepper phase, derived from the run's REAL signals (node:test-pinned). */
  const phase = installPhase({
    running: activeRun !== null,
    leg: installLeg,
    hasOutput: logLines.length > 0,
    awaitingVerdict: pendingGate !== null,
    completed: installDone !== null && installDone === installTarget,
  });

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

      {/* §2's header: title + the segmented control + search. The control lives here rather
          than inside the browse island so it stays put across all three segments — moving it
          would make the strip jump when you switch to Extensions, which paints its own body. */}
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--space-4, 8px)",
          minWidth: 0,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: "0.95rem",
            fontWeight: 700,
            color: "var(--text-title)",
            whiteSpace: "nowrap", // §7
          }}
        >
          Catalog
        </h2>
        <Segmented
          label="Catalog sections"
          options={SEGMENTS}
          value={tab}
          onChange={(t: CatalogTab) => setTab(t)}
        />
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3, 6px)",
            minWidth: 0,
          }}
        >
          <button
            type="button"
            onClick={() => void onSuperscan()}
            disabled={superscanning}
            title="Scan every installed source for threats"
            style={{
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md, 6px)",
              color: "var(--text-primary)",
              cursor: superscanning ? "default" : "pointer",
              fontSize: "0.8rem",
              padding: "3px 9px",
              whiteSpace: "nowrap", // §7
            }}
          >
            {superscanning ? "Scanning…" : "🛡 Superscan"}
          </button>
          {tab === "plugins" && (
            <input
              type="search"
              aria-label="Search the catalog"
              placeholder="search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                background: "var(--bg-surface-2)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-md, 6px)",
                color: "var(--text-primary)",
                padding: "4px 8px",
                fontSize: "0.85rem",
                minWidth: 0,
                maxWidth: 200,
              }}
            />
          )}
        </div>
      </header>

      {tab === "extensions" ? (
        /* handoff_3 §1: Catalog absorbed Extensions. The MCP / ACP connector manager is
           mounted UNCHANGED — every launch command it configures is still nemesis-gated
           before it can connect. Until this line existed the file had no import site at
           all: the rail had dropped Extensions and `resolveActivity` redirected here, so
           the whole connector manager was unreachable from the GUI.

           NOT wrapped in <EngineGate>: it reads the main-process McpHostManager, not the
           engine, so an engine that is down has nothing to do with whether this works. */
        <ExtensionsRoute />
      ) : tab === "skills" ? (
        // `skillsList` IS an engine read, so this one degrades (§6).
        <EngineGate>
          <SkillsPanel />
        </EngineGate>
      ) : (
        // the browse + install islands ARE the engine's catalog, so §6's degraded wrapper
        // belongs here rather than around the whole route (see App.tsx ENGINE_BACKED).
        <EngineGate>
          <div
            style={{
              display: "flex",
              // §7: `flex-wrap` + a min-width on BOTH islands. The old layout was a grid whose
              // auto-fit column crushed the list to a sliver on a narrow window.
              flexWrap: "wrap",
              alignItems: "flex-start",
              gap: "var(--space-8, 16px)",
            }}
          >
            {/* ── browse island (§2) ──────────────────────────────────────────────── */}
            <section style={{ flex: "1.25 1 340px", minWidth: 340 }}>
              <Panel
                title={reachOpen ? "Reach Matrix" : "Browse"}
                elevation="e1"
                actions={
                  <div
                    style={{ display: "flex", alignItems: "center", gap: "var(--space-3, 6px)" }}
                  >
                    <button
                      type="button"
                      aria-pressed={reachOpen}
                      onClick={() => setReachOpen((v) => !v)}
                      style={{
                        background: reachOpen ? "var(--bg-active)" : "transparent",
                        border: `1px solid ${reachOpen ? "var(--border-strong)" : "var(--border-subtle)"}`,
                        borderRadius: "var(--radius-md, 6px)",
                        color: reachOpen ? "var(--text-title)" : "var(--text-secondary)",
                        cursor: "pointer",
                        fontSize: "0.78rem",
                        padding: "2px 8px",
                        whiteSpace: "nowrap", // §7
                      }}
                    >
                      ⊞ Reach matrix
                    </button>
                  </div>
                }
              >
                {reachOpen ? (
                  <ReachMatrix items={plugins} loading={loading} />
                ) : (
                  <>
                    {/* The four registries the §1 merge would otherwise have stranded — apps,
                      model tools, world-sims and documented-only entries all arrive in the
                      same browse() payload, so they are a filter here rather than four
                      deleted rail nouns. */}
                    <fieldset
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 4,
                        marginBottom: "var(--space-4, 8px)",
                        // a fieldset (not a div+role=group) so the grouping is native; its
                        // default border/padding would otherwise draw a box nobody asked for.
                        border: "none",
                        margin: 0,
                        padding: 0,
                        minInlineSize: 0,
                      }}
                    >
                      <legend
                        style={{
                          position: "absolute",
                          width: 1,
                          height: 1,
                          padding: 0,
                          overflow: "hidden",
                          clipPath: "inset(50%)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Filter by kind
                      </legend>
                      {CATALOG_KINDS.map((k) => {
                        const on = kind === k.id;
                        return (
                          <button
                            key={k.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() => setKind(k.id)}
                            style={{
                              background: on ? "var(--bg-active)" : "var(--bg-inset)",
                              border: `1px solid ${on ? "var(--border-strong)" : "var(--border-chip)"}`,
                              borderRadius: "var(--radius-md, 6px)",
                              color: on ? "var(--text-title)" : "var(--text-secondary)",
                              cursor: "pointer",
                              fontSize: "0.75rem",
                              fontWeight: on ? 600 : 500,
                              padding: "2px 8px",
                              whiteSpace: "nowrap", // §7
                            }}
                          >
                            {k.label}
                          </button>
                        );
                      })}
                    </fieldset>

                    {loading ? (
                      <p style={{ color: "var(--text-secondary)" }}>loading catalog…</p>
                    ) : filtered.length === 0 ? (
                      <p style={{ color: "var(--text-secondary)" }}>no items.</p>
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
                          <BrowseRow
                            key={i.id}
                            item={i}
                            verdict={verdicts[i.id] ?? "queued"}
                            selected={i.id === selectedId}
                            onSelect={() => setSelectedId(i.id)}
                            onInstall={() => {
                              setSelectedId(i.id);
                              install.mutate({
                                ...beginInstallRun(i.id, "dry"),
                                dryRun: true,
                                force: false,
                              });
                            }}
                            onOpenDocs={() => {
                              setSelectedId(i.id);
                              void onAudit(i.id);
                            }}
                          />
                        ))}
                      </ul>
                    )}
                  </>
                )}

                {/* §2's footer strip — the promise the QUEUED chip above is the honest half of. */}
                <p
                  style={{
                    margin: "var(--space-4, 8px) 0 0",
                    paddingTop: "var(--space-3, 6px)",
                    borderTop: "1px solid var(--border-subtle)",
                    color: "var(--text-muted)",
                    fontSize: "0.72rem",
                    lineHeight: 1.45,
                  }}
                >
                  {CATALOG_FOOTER_NOTE}
                </p>
              </Panel>
            </section>

            {/* ── install island (§2) ─────────────────────────────────────────────── */}
            <section style={{ flex: "1 1 300px", minWidth: 300, maxWidth: 420 }}>
              <Panel
                elevation="e1"
                title={
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      minWidth: 0, // §7: without this the mono name refuses to ellipsize
                    }}
                  >
                    <span style={{ whiteSpace: "nowrap" }}>Install</span>
                    {installTarget && (
                      <code
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "0.78rem",
                          color: "var(--text-secondary)",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {installTarget}
                      </code>
                    )}
                  </span>
                }
                actions={
                  installTarget ? (
                    <button
                      type="button"
                      aria-label="Close the install panel"
                      onClick={() => {
                        setSelectedId(null);
                        setLogLines([]);
                        setInstallDone(null);
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        fontSize: "0.9rem",
                        lineHeight: 1,
                        padding: 2,
                      }}
                    >
                      ✕
                    </button>
                  ) : null
                }
              >
                <InstallStepper phase={phase} />

                {/* the verdict mini-card: finding COUNT + the two actions. The full card and the
                  typed-confirm still live in the §9 overlay — this is the always-visible
                  summary, not a second decision surface. */}
                {pendingGate && (
                  <div
                    style={{
                      marginTop: "var(--space-4, 8px)",
                      padding: "8px 10px",
                      borderRadius: "var(--radius-md, 6px)",
                      background: "color-mix(in srgb, var(--warn) 12%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--warn) 34%, transparent)",
                    }}
                  >
                    <div
                      style={{
                        color: "var(--warn)",
                        fontSize: "0.78rem",
                        fontWeight: 700,
                        letterSpacing: "0.03em",
                      }}
                    >
                      {/* `reasons` are the gate's sentences; the VerdictCard 350 lines below
                          carefully separates them from findings, and this header was
                          undoing that by counting them as findings. */}
                      {CATALOG_VERDICT_CHIP[catalogVerdictOf(pendingGate.gate.verdict)].label} ·{" "}
                      {pendingGate.gate.reasons.length}{" "}
                      {pendingGate.gate.reasons.length === 1 ? "reason" : "reasons"}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 6,
                        marginTop: 8,
                      }}
                    >
                      <Button
                        variant="ghost"
                        onClick={() => {
                          const name = pendingGate.name;
                          const blocking = pendingGate.gate.verdict === "block";
                          setPendingGate(null);
                          if (blocking) {
                            // §9: a BLOCK override is NEVER one click — the typed confirm is
                            // the only place the engine's own `install-dangerous` prompt can
                            // exist, since the GUI reaches it with piped stdin + --yes.
                            force.ask({
                              target: name,
                              blockingReasons: pendingGate.gate.reasons,
                              onConfirm: () =>
                                install.mutate({
                                  ...beginInstallRun(name, "commit"),
                                  dryRun: false,
                                  force: true,
                                }),
                            });
                          } else {
                            install.mutate({
                              ...beginInstallRun(name, "commit"),
                              dryRun: false,
                              force: false,
                            });
                          }
                        }}
                      >
                        Install anyway…
                      </Button>
                      <Button variant="ghost" onClick={() => setPendingGate(null)}>
                        Abort
                      </Button>
                    </div>
                  </div>
                )}

                {selected ? (
                  <div style={{ marginTop: "var(--space-4, 8px)" }}>
                    <ItemCard
                      item={selected}
                      installing={install.isPending}
                      uninstalling={uninstall.isPending}
                      uninstallError={
                        uninstallError?.name === selected.id ? uninstallError.error : null
                      }
                      lifecycleBusy={lifecycle.isPending}
                      lifecycleError={
                        lifecycleError?.name === selected.id ? lifecycleError.error : null
                      }
                      onLifecycle={(action) => {
                        const surface = lifecycleSurfaceFor(selected.kind);
                        if (surface) runLifecycle(surface, action, selected.id);
                      }}
                      onInstall={() =>
                        install.mutate({
                          ...beginInstallRun(selected.id, "dry"),
                          dryRun: true,
                          force: false,
                        })
                      }
                      onUninstall={() => {
                        setUninstallError(null);
                        uninstall.mutate({
                          name: selected.id,
                          dryRun: true,
                          runId: beginRun("uninstall", selected.id, "uninstall"),
                        });
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
                  </div>
                ) : (
                  <p style={{ color: "var(--text-secondary)", marginTop: "var(--space-4, 8px)" }}>
                    Select an item to install it.
                  </p>
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
                        gap: 8,
                        color: "var(--text-secondary)",
                        fontSize: "0.75rem",
                        marginBottom: 4,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
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
                    {/* §9: the SHARED log component — the same one the Security console
                      renders — instead of a hand-rolled <pre>. It brings auto-scroll,
                      pin-detection, copy-as-text and inert() rendering for free. */}
                    <StreamLog
                      lines={
                        logLines.length > 0
                          ? logLines.map((raw, i) => ({
                              id: `${activeRun?.runId ?? "log"}:${i}`,
                              ...classifyStreamLine(raw, "lifecycle"),
                            }))
                          : [
                              {
                                id: "waiting",
                                text: "waiting for engine output…",
                                level: "debug" as const,
                              },
                            ]
                      }
                      maxHeight="min(28vh, 320px)"
                    />
                  </div>
                )}
              </Panel>
            </section>
          </div>
        </EngineGate>
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
            uninstall.mutate({
              name,
              dryRun: false,
              runId: beginRun("uninstall", name, "uninstall"),
            });
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
          ref={rollbackRef}
          // It blocks the page, so it says so: assistive tech treats the rest as inert, and the
          // shell refuses to open the ⌘K palette underneath it (App.tsx anotherModalOpen).
          aria-modal="true"
          aria-label={`Roll back ${rollbackPick.tool}`}
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "color-mix(in srgb, var(--bg-app) 65%, transparent)",
            // Rollback is a decision the user must answer — the modal rung, not the dropdown one.
            zIndex: Z.modal,
          }}
        >
          <section
            style={{
              width: "min(420px, 90%)",
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-strong)",
              borderRadius: 10,
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <strong>Roll back {rollbackPick.tool}</strong>
            <span style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
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
      {/* "Learn more" — the deep tutorial (dossier) for the selected item. Rendered
          BEFORE the decision surfaces below: all three sit on Z.modal, and a tie on that
          rung is settled by DOM order, so a force-gate or a verdict stays answerable on
          top of an open tutorial rather than underneath it. */}
      {tutorial && (
        // biome-ignore lint/a11y/useSemanticElements: full-screen tutorial reader is the WAI-ARIA dialog pattern; the app does not use native <dialog>.
        <div
          role="dialog"
          ref={tutorialRef}
          // A full-screen reader over the page: modal, trapped (above), and so ⌘K is refused
          // under it rather than opening a hidden, focused palette.
          aria-modal="true"
          aria-label={`Tutorial: ${tutorial.id}`}
          style={{
            position: "fixed",
            inset: 0,
            background: "var(--bg-app)",
            display: "flex",
            flexDirection: "column",
            // A full-screen reader is a surface the user must dismiss — the modal rung.
            // At Z.dropdown it sat UNDER nothing, but it also could not cover the page it
            // replaces; and it must still lose to the decision overlays, which is why the
            // block itself is rendered BEFORE them (a tie at Z.modal is settled by DOM
            // order, so "later wins" is what keeps a force-gate answerable on top of it).
            zIndex: Z.modal,
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
              fontSize: "var(--text-code-size, 0.78125rem)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "var(--text-primary)",
            }}
          >
            {tutorial.text}
          </pre>
        </div>
      )}

      {pendingGate && (
        // Fixed-overlay modal (mirrors the sibling dialogs). WITHOUT this the sheet was an
        // in-flow child appended below the catalog grid, inside <main overflow:auto> —
        // below the fold, so a block verdict + the force-override escape hatch were invisible
        // and Install/Audit looked like it did nothing.
        // §9: the SHARED decision overlay — fixed, focus-trapped, Escape-dismissible,
        // with a visible close. This route hand-rolled the wrapper first; promoting it
        // means models/repos/environments get the same guarantees instead of three more
        // near-copies that each forget a different part of the contract.
        <DecisionOverlay
          label={`Security verdict: ${pendingGate.name}`}
          onDismiss={() => setPendingGate(null)}
        >
          <div>
            {/* handoff §4: the SAME verdict card Home, the security console and the chat
                render, as this dialog's summary. Actions are OFF here — the VerdictSheet
                below owns Proceed / Cancel / the typed-confirm force override, and two
                competing button rows would be worse than one consistent header. */}
            <div
              style={{
                borderRadius: "var(--radius-xl)",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                marginBottom: "var(--space-4, 8px)",
              }}
            >
              <VerdictCard
                verdict={pendingGate.gate.verdict}
                artifact={pendingGate.name}
                sourceKind="catalog item"
                riskScore={pendingGate.gate.score}
                // `reasons` are the gate's SENTENCES, not findings: they have no rule id
                // and no severity of their own. Synthesising `R-{n}` and deriving a
                // severity from the tier put invented identifiers in the mono,
                // severity-coloured slot — exactly the conflation §4 forbids.
                reasons={pendingGate.gate.reasons}
                actions={false}
              />
            </div>
            <VerdictSheet
              verdict={gateToVerdict(pendingGate.gate, pendingGate.target)}
              onProceed={() => {
                // proceed = commit the install (the engine still gates; warn ⇒ allowed via --yes).
                install.mutate({
                  ...beginInstallRun(pendingGate.name, "commit"),
                  dryRun: false,
                  force: false,
                });
                setPendingGate(null);
              }}
              onCancel={() => setPendingGate(null)}
              onRequestForce={() => {
                // §9 (HIGH): a BLOCK override is NEVER one click. Raise the typed confirm
                // first — the engine's own `install-dangerous` prompt is unreachable from
                // the GUI (piped stdin + --yes), so this is the only place it can exist.
                const name = pendingGate.name;
                force.ask({
                  target: pendingGate.target,
                  blockingReasons: pendingGate.gate.reasons,
                  onConfirm: () =>
                    install.mutate({
                      ...beginInstallRun(name, "commit"),
                      dryRun: false,
                      force: true,
                    }),
                });
                setPendingGate(null);
              }}
            />
          </div>
        </DecisionOverlay>
      )}

      {/* §9: the typed confirm that gates every deep-red override on this route. */}
      <ForceGate gate={force} />
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

/* ── the §2 verdict chip ─────────────────────────────────────────────────────*/

/**
 * `● ALLOW` / `◑ WARN` / `✕ BLOCK` / `◌ QUEUED`.
 *
 * §2 specifies the tint as `color+"1f"` on the background and `color+"55"` on the border.
 * Raw hex is a build failure here (08 §6), so those alphas are expressed as the same
 * fractions of the role token: 0x1f/0xff ≈ 12%, 0x55/0xff ≈ 33%. Same result, and it
 * re-themes with the palette instead of being frozen to one scheme's colours.
 */
function VerdictChip({ verdict }: { verdict: CatalogVerdict }): ReactElement {
  const chip = CATALOG_VERDICT_CHIP[verdict];
  const color = roleVar(chip.role);
  return (
    <span
      // the glyph carries the meaning without colour (08 §7) — a red/green-only chip is
      // unreadable to ~8% of men, and this one gates an install.
      aria-label={`nemesis verdict: ${chip.label.toLowerCase()}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flex: "none",
        padding: "1px 6px",
        borderRadius: "var(--radius-sm, 4px)",
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 33%, transparent)`,
        color,
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.06em",
        lineHeight: 1.5,
        whiteSpace: "nowrap", // §7
      }}
    >
      <span aria-hidden="true">{chip.glyph}</span>
      {chip.label}
    </span>
  );
}

/* ── the §2 install stepper ──────────────────────────────────────────────────*/

/** Fetch → Dry-run → Verdict → Confirm → Install, with hairline connectors. */
function InstallStepper({ phase }: { phase: InstallPhase }): ReactElement {
  const states = stepStates(phase);
  return (
    <ol
      aria-label="Install progress"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 0,
        listStyle: "none",
        margin: 0,
        padding: 0,
      }}
    >
      {INSTALL_STEPS.map((step, i) => {
        const state = states[i] ?? "pending";
        const color =
          state === "done"
            ? "var(--ok)"
            : state === "active"
              ? "var(--warn)"
              : "var(--border-strong)";
        return (
          <li
            key={step}
            aria-current={state === "active" ? "step" : undefined}
            style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                flex: "none",
                borderRadius: "50%",
                background: color,
                // the active dot pulses on the SHARED keyframe (tokens.css) — an inline
                // style cannot declare @keyframes, and a second copy would drift.
                animation: state === "active" ? "prom-pulse 1.4s ease-in-out infinite" : undefined,
              }}
            />
            <span
              style={{
                fontSize: 10.5,
                fontWeight: state === "pending" ? 500 : 700,
                letterSpacing: "0.04em",
                color:
                  state === "pending"
                    ? "var(--text-muted)"
                    : state === "active"
                      ? "var(--warn)"
                      : "var(--text-secondary)",
                whiteSpace: "nowrap", // §7
              }}
            >
              {step}
            </span>
            {i < INSTALL_STEPS.length - 1 && (
              <span
                aria-hidden="true"
                style={{
                  width: 14,
                  height: 1,
                  flex: "none",
                  margin: "0 5px",
                  background: "var(--border-subtle)",
                }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ── the §2 browse row ───────────────────────────────────────────────────────*/

/**
 * glyph chip · mono name + source · one-line description · verdict chip · action button.
 *
 * The row is a `<div>` with an inner select button rather than one big `<button>`: §2 puts an
 * ACTION button inside the row, and a button inside a button is invalid HTML that browsers
 * silently un-nest, which drops the inner click handler.
 */
function BrowseRow(props: {
  item: CatalogItem;
  verdict: CatalogVerdict;
  selected: boolean;
  onSelect: () => void;
  onInstall: () => void;
  onOpenDocs: () => void;
}): ReactElement {
  const { item, verdict, selected, onSelect, onInstall, onOpenDocs } = props;
  const documented = item.tier === "documented";
  const present =
    (item.state?.presence ?? (item.state?.installed ? "present" : "absent")) === "present";
  return (
    <li>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 6px",
          borderRadius: "var(--radius-md, 6px)",
          background: selected ? "var(--bg-active)" : "transparent",
          minWidth: 0, // §7: the parent of an ellipsizing child MUST be able to shrink
        }}
      >
        {/* the 30px tinted glyph chip */}
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 30,
            height: 30,
            flex: "none",
            borderRadius: "var(--radius-md, 6px)",
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 26%, transparent)",
            color: "var(--accent)",
            fontSize: 13,
          }}
        >
          {kindGlyph(item.kind, item.tier)}
        </span>

        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "true" : undefined}
          style={{
            flex: 1,
            minWidth: 0, // §7
            textAlign: "left",
            background: "transparent",
            border: "none",
            color: "var(--text-primary)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              minWidth: 0, // §7
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.82rem",
                fontWeight: 600,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.tier === "official" ? "★ " : ""}
              {item.title}
            </span>
            {item.repo && (
              <span
                style={{
                  flex: "none",
                  fontSize: "0.68rem",
                  color: "var(--text-muted)",
                  whiteSpace: "nowrap",
                }}
              >
                {item.repo}
              </span>
            )}
          </span>
          <span
            style={{
              display: "block",
              fontSize: "0.72rem",
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
              whiteSpace: "nowrap",
            }}
          >
            {item.summary}
          </span>
        </button>

        {/* the tri-state install mark stays: it is a DIFFERENT fact from the verdict
            (is it on disk) and the CLI list + /invoke picker read the same source. */}
        <StatusMark
          presence={item.state?.presence ?? (item.state?.installed ? "present" : "absent")}
        />
        <VerdictChip verdict={verdict} />

        <button
          type="button"
          onClick={documented ? onOpenDocs : onInstall}
          style={{
            flex: "none",
            // §2's primary variant. The spec names a deep-navy fill; expressed with the
            // app's own tokens so it re-themes (raw hex is a build failure, 08 §6).
            background: documented ? "transparent" : "var(--bg-active)",
            border: `1px solid ${documented ? "var(--border-subtle)" : "var(--border-strong)"}`,
            borderRadius: "var(--radius-md, 6px)",
            color: documented ? "var(--text-secondary)" : "var(--text-title)",
            cursor: "pointer",
            fontSize: "0.74rem",
            fontWeight: 600,
            padding: "3px 9px",
            whiteSpace: "nowrap", // §7
          }}
        >
          {documented ? "Audit" : present ? "Reinstall" : "Install"}
        </button>
      </div>
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
        <div style={{ color: "var(--text-secondary)" }}>
          {item.tier}
          {item.bundle ? " · bundle" : ""}
          {item.scope ? ` · ${item.scope}` : ""}
        </div>
      </div>
      {item.repo && (
        <div style={{ color: "var(--text-secondary)" }}>
          {item.repo}
          {item.license ? ` · ${item.license}` : ""}
          {item.stars !== undefined ? ` · ★${item.stars}` : ""}
        </div>
      )}
      <p style={{ margin: 0 }}>{item.summary}</p>
      {reachEntries.length > 0 && (
        <div>
          <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>Reach</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {reachEntries.map(([agent, cell]) => (
              <span
                key={agent}
                style={{
                  fontSize: "0.72rem",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 4,
                  padding: "0 5px",
                  color:
                    cell === "native"
                      ? "var(--ok)"
                      : cell === "sync"
                        ? "var(--accent)"
                        : "var(--text-secondary)",
                }}
              >
                {agent} {cell === "native" ? "✓" : cell === "sync" ? "↔" : "–"}
              </span>
            ))}
          </div>
        </div>
      )}
      {item.components && item.components.length > 0 && (
        <div style={{ color: "var(--text-secondary)" }}>
          Components: {item.components.map((c) => c.id).join(", ")}
        </div>
      )}
      {item.automation && <div>Automation: {item.automation}</div>}
      {item.securityNote && (
        <div style={{ color: "var(--warn)" }}>Security: {item.securityNote}</div>
      )}
      {item.tier === "documented" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {item.whyExcluded && (
            <div
              style={{
                color: "var(--warn)",
                border: "1px solid var(--warn)",
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
              style={{ color: "var(--accent)" }}
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
      <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.82rem" }}>
        ✓ native · ↔ via sync · – unavailable. Install from the catalog list; cross-agent sync then
        propagates it to ↔ agents.
      </p>
      {loading ? (
        <p style={{ color: "var(--text-secondary)" }}>loading matrix…</p>
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
                <tr key={i.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
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
                              ? "var(--ok)"
                              : cell === "sync"
                                ? "var(--accent)"
                                : "var(--text-secondary)",
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
            background: "var(--bg-surface-2)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            color: "var(--text-primary)",
            padding: "4px 8px",
          }}
        />
        <Button variant="primary" type="submit" disabled={scaffolding || !newName.trim()}>
          {scaffolding ? "…" : "+ New skill"}
        </Button>
      </form>
      {skillsQ.isPending ? (
        <p style={{ color: "var(--text-secondary)" }}>loading skills…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "var(--text-secondary)" }}>no skills on disk.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
              <th style={{ padding: "4px 8px" }}>name</th>
              <th style={{ padding: "4px 8px" }}>fires</th>
              <th style={{ padding: "4px 8px" }}>state</th>
              <th style={{ padding: "4px 8px" }}>actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.name} style={{ borderTop: "1px solid var(--border-subtle)" }}>
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
