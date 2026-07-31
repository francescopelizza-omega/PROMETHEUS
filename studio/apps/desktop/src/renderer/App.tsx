/**
 * renderer/App.tsx — the Prometheus Studio shell (file 08 §4).
 *
 * The §4 IDE frame: an Odysseus-style 48px ACTIVITY RAIL → a contextual SIDEBAR →
 * the route-dependent WORKBENCH → a collapsible RIGHT RAIL (AI / inspector) over a
 * collapsible BOTTOM PANEL (Terminal/Problems/Security/Output/Tasks), all above the
 * always-true STATUS BAR whose permanent nemesis SHIELD makes security ambient
 * (rule #2). ⌘K opens the universal command palette (§4.3); ⌥⌘B toggles the right
 * rail; ⌃` toggles the bottom panel. A Settings overlay drives the §6 theme/density.
 *
 * The shell is pure chrome: each activity mounts its OWN feature route
 * (Home/Editor/Catalog/Model Hub/Environments/Security/Repos/Extensions). It talks
 * to the engine ONLY through `window.prometheus.*` (the contextBridge seam, C5):
 * the engine pill + the latest verdict come from the Zustand slices the routes feed.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the shell/routes/stores only.
 * No node:* / electron / engine-bridge — every byte crosses the contextBridge.
 */

import type { ActivityId, ThemePreference } from "@prometheus/ui";
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CatalogRoute } from "../routes/catalog.js";
import { ChatRoute } from "../routes/chat.js";
import { DocsRoute } from "../routes/docs.js";
import { EditorRoute } from "../routes/editor.js";
import { EnvironmentsRoute } from "../routes/environments.js";
import { ExtensionsRoute } from "../routes/extensions.js";
import { ModelsRoute } from "../routes/models.js";
import { ReposRoute } from "../routes/repos.js";
import { SecurityRoute } from "../routes/security.js";
import { type CommandContext, executeCommandId, handleChord } from "./commands/registry.js";
import { HardenPanel } from "./ide/HardenPanel.js";
import { Problems } from "./ide/Problems.js";
import { TokenEconomyPanel } from "./ide/TokenEconomyPanel.js";
import { AgentPane } from "./ide/ai/AgentPane.js";
import { agentRuns } from "./ide/ai/run-controller.js";
import { SystemHealthPanel } from "./ide/health/SystemHealthPanel.js";
import { deriveSystemHealthView } from "./ide/health/health-panel-view.js";
import { MetadataPanel } from "./ide/metadata/MetadataPanel.js";
import { countDiagnostics } from "./ide/state/diagnostics.js";
import { detectLanguage } from "./ide/state/lang-detect.js";
import { useDiagnosticsStore, useTabsStore } from "./ide/state/stores.js";
import { TelemetryPanel } from "./ide/telemetry/TelemetryPanel.js";
import { TelemetryStrip } from "./ide/telemetry/TelemetryStrip.js";
import { useTelemetryPolling } from "./ide/telemetry/useTelemetryPolling.js";
import { OnboardingWizard } from "./onboarding/OnboardingWizard.js";
import {
  ONBOARDING_KEY,
  finalizeResult,
  serializeResult,
  shouldShowWizard,
} from "./onboarding/onboarding-state.js";
import { OPEN_FILE_EVENT, OPEN_FOLDER_EVENT } from "./open-resource.js";
import { useEnvList, useHealth } from "./query/hooks.js";
import { HomeRoute } from "./routes/home.js";
import { SettingsPanel } from "./settings/SettingsPanel.js";
import {
  KEYMAP_CHANGED_EVENT,
  KEYMAP_OVERRIDES_STORAGE,
  overridesToMap,
  parseOverrides,
} from "./settings/keymap-overrides.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.js";
import { UpdateBanner } from "./shell/UpdateBanner.js";
import { nextRegion } from "./shell/a11y.js";
import {
  ActivityBar,
  BottomPanel,
  type BottomTab,
  CommandPalette,
  RightRail,
  type RightRailMode,
  ShellStatusBar,
  Sidebar,
  useTheme,
} from "./shell/index.js";
import {
  type SidebarCollapsedMap,
  effectiveSidebarCollapsed,
  hasSidebarBody,
  parseSidebarCollapsed,
  toggleSidebarMap,
} from "./shell/sidebar-view.js";
import {
  UPDATE_IDLE,
  updateActionLabel,
  updateOnAvailable,
  updateOnDismiss,
  updateOnDownloadError,
  updateOnDownloadStart,
  updateOnProgress,
  updateOnReady,
} from "./shell/update-view.js";
import { venvStatusLabel } from "./shell/venv-label.js";
import { sidebarBodyFor } from "./sidebar-bodies.js";
import { useEngineStore } from "./stores/engine.js";
import { useSecurityStore } from "./stores/features.js";
import { useModelsStore } from "./stores/models.js";

/** The bottom-panel tabs the SHELL itself can render bodies for. The Terminal /
 *  Output / Tasks tabs are part of the Editor workbench (routes/editor.tsx), not
 *  the shell — listing them here would open a blank pane. Problems IS shell-safe
 *  (APP-009): ide/Problems binds only global zustand stores, no editor context. */
const SHELL_BOTTOM_TABS: readonly { id: BottomTab; label: string }[] = [
  { id: "problems", label: "Problems" },
  { id: "security", label: "Security" },
  { id: "health", label: "Health" },
  { id: "metadata", label: "Metadata" },
  { id: "tokens", label: "Save tokens" },
  { id: "system", label: "System" },
];
const SHELL_BOTTOM_TAB_IDS = new Set<BottomTab>(SHELL_BOTTOM_TABS.map((t) => t.id));

/* ── workbench layout persistence (leap #13) ──────────────────────────────────
 * The whole layout (active activity, panel collapse states, right-rail mode, bottom
 * tab) used to reset on every reload. Persist it to localStorage and rehydrate on
 * mount — validating every field so a stale/corrupt blob can never wedge the shell. */
interface PersistedLayout {
  /** bumped when the shape changes; v2 = per-activity sidebar map (APP-002). */
  layoutVersion: number;
  activity: ActivityId;
  /** per-route sidebar collapse overrides (v1 stored one global boolean —
   *  parseSidebarCollapsed migrates it; absent key = the route's default). */
  sidebarCollapsedByActivity: SidebarCollapsedMap;
  rightCollapsed: boolean;
  rightMode: RightRailMode;
  bottomCollapsed: boolean;
  bottomTab: BottomTab;
}
const LAYOUT_KEY = "prometheus.layout";
const LAYOUT_VERSION = 2;

function loadLayout(): Partial<PersistedLayout> {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<PersistedLayout> = {};
    if (typeof o.activity === "string") out.activity = o.activity as ActivityId;
    const sidebarMap = parseSidebarCollapsed(o);
    if (sidebarMap) out.sidebarCollapsedByActivity = sidebarMap;
    if (typeof o.rightCollapsed === "boolean") out.rightCollapsed = o.rightCollapsed;
    if (o.rightMode === "agent" || o.rightMode === "inspector") out.rightMode = o.rightMode;
    if (typeof o.bottomCollapsed === "boolean") out.bottomCollapsed = o.bottomCollapsed;
    if (typeof o.bottomTab === "string" && SHELL_BOTTOM_TAB_IDS.has(o.bottomTab as BottomTab))
      out.bottomTab = o.bottomTab as BottomTab;
    return out;
  } catch {
    return {};
  }
}

function saveLayout(layout: PersistedLayout): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* private mode / quota — layout just won't persist this session. */
  }
}

/** Route a palette command id to the activity where it actually works. The shell can't
 *  execute editor-scoped commands itself, so picking one navigates the user to its home
 *  surface instead of silently no-op'ing. Returns null for `panel.*` (handled inline). */
function activityForCommand(id: string): ActivityId | null {
  if (id.startsWith("panel.")) return null;
  if (id.startsWith("models.")) return "models";
  if (id.startsWith("prometheus.") || id.startsWith("gate.")) return "security";
  if (id.startsWith("python.")) return "environments";
  // ai.* / git.* / debug.* / search.* / editor.* all live in the Editor workbench.
  return "editor";
}

/** Map an activity id → its workbench route (extensions = file 09, placeholder). */
function renderActivity(
  activity: ActivityId,
  onNavigate: (id: ActivityId) => void,
  onOpenPanel: (tab: BottomTab) => void,
): ReactElement {
  switch (activity) {
    case "home":
      return <HomeRoute onNavigate={onNavigate} onOpenTokens={() => onOpenPanel("tokens")} />;
    case "editor":
      // the panel.* palette seam (APP-004): the editor palette opens SHELL bottom tabs.
      return <EditorRoute onNavigate={onNavigate} onOpenShellPanel={onOpenPanel} />;
    case "catalog":
      return <CatalogRoute />;
    case "chat":
      return <ChatRoute />;
    case "models":
      return <ModelsRoute />;
    case "environments":
      return <EnvironmentsRoute />;
    case "security":
      return <SecurityRoute />;
    case "repos":
      return <ReposRoute />;
    case "docs":
      return <DocsRoute />;
    case "extensions":
      return <ExtensionsRoute />;
    default:
      return <ExtensionsRoute />;
  }
}

/* Contextual-sidebar bodies (#6, APP-002) live in ./sidebar-bodies.tsx; which
 * activities have one is shell/sidebar-view.ts's SIDEBAR_BODY_ACTIVITIES (the single
 * source hasSidebarBody reads — APP-003's ⌘B/rail-toggle gates on it too). An
 * activity without a body still shows NO empty titled column. */

/* ── §6 settings overlay — the rich Appearance surface (theme base + 41-scheme
 *    picker + density + custom-theme editor + live preview) instead of two selects ── */

const PREF_OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "high-contrast", label: "High contrast" },
];

function SettingsOverlay({
  onClose,
  workspaceRoot,
}: {
  onClose: () => void;
  workspaceRoot?: string;
}): ReactElement {
  const { preference, setPreference } = useTheme();
  // Esc closes the overlay — keyboard parity with the backdrop click + the ✕ button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.4)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8vh",
        zIndex: 60,
      }}
    >
      <section
        aria-label="Settings"
        style={{
          width: "min(900px, 94vw)",
          maxHeight: "84vh",
          overflow: "auto",
          background: "var(--bg-surface-2)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-xl, 14px)",
          boxShadow: "var(--elevation-e3)",
          padding: "var(--space-12, 24px)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-8, 16px)",
          fontFamily: "var(--font-ui)",
          color: "var(--text-primary)",
        }}
      >
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, fontSize: "var(--text-h2-size, 1.125rem)", fontWeight: 600 }}>
            Settings
          </h2>
          <button type="button" onClick={onClose} aria-label="Close settings" style={iconBtn()}>
            ✕
          </button>
        </header>

        <label style={fieldLabel()}>
          Theme base
          <select
            value={preference}
            onChange={(e) => setPreference(e.target.value as ThemePreference)}
            style={selectStyle()}
          >
            {PREF_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {/* the two-pane settings surface (Appearance + Keymap) — mounts the finished
            AppearancePage + KeymapPage that previously had no importer (leap #5a/#5b). */}
        <SettingsPanel workspaceRoot={workspaceRoot} />
      </section>
    </div>
  );
}

/** APP-100: move keyboard focus to the next/previous VISIBLE shell landmark region (F6/⇧F6).
 *  Regions declare `data-shell-region` + `tabIndex=-1`; a collapsed sidebar/rail unmounts so it
 *  drops out of the cycle. Pure DOM — no React state, so it doesn't widen the cmdCtx memo deps. */
function cycleShellFocus(dir: 1 | -1): void {
  const regions = Array.from(document.querySelectorAll<HTMLElement>("[data-shell-region]")).filter(
    (el) => el.offsetParent !== null,
  );
  if (regions.length === 0) return;
  const activeEl = document.activeElement;
  const current = regions.findIndex((r) => r === activeEl || r.contains(activeEl));
  regions[nextRegion(regions.length, current, dir)]?.focus();
}

function App(): ReactElement {
  useHealth(); // seed the engine pill (Zustand) — no local data needed here.
  const enginePill = useEngineStore((s) => s.pill);
  const engineHealth = useEngineStore((s) => s.health);
  const refreshHealth = useEngineStore((s) => s.refreshHealth);
  const shieldTier = useSecurityStore((s) => s.shieldTier);
  const lastVerdict = useSecurityStore((s) => s.lastVerdict);
  // live problem counts for the status bar + bottom-panel badge (was hardcoded 0).
  const diagByUri = useDiagnosticsStore((s) => s.byUri);
  const diagCounts = countDiagnostics(diagByUri);
  const securityCount = lastVerdict?.findingsCount ?? 0;

  // hydrate the workbench layout from localStorage once (leap #13) — falls back to
  // the defaults for any missing/invalid field.
  const saved = useState(loadLayout)[0];
  const [activity, setActivity] = useState<ActivityId>(saved.activity ?? "home");
  // per-route overrides only — a route absent here uses its default (open where a
  // body exists, editor collapsed; see shell/sidebar-view.ts).
  const [sidebarCollapsedMap, setSidebarCollapsedMap] = useState<SidebarCollapsedMap>(
    saved.sidebarCollapsedByActivity ?? {},
  );
  const [rightCollapsed, setRightCollapsed] = useState(saved.rightCollapsed ?? true);
  const [rightMode, setRightMode] = useState<RightRailMode>(saved.rightMode ?? "agent");
  // APP-056: background agent-run count for the ✦ rail badge — sourced from the MODULE-LEVEL
  // run controller (NOT any pane), so it stays correct while the AI pane is collapsed/unmounted.
  const [aiRunningCount, setAiRunningCount] = useState(0);
  useEffect(() => agentRuns.subscribe(() => setAiRunningCount(agentRuns.runningIds().length)), []);
  // APP-057: the user keymap override map (command id → keys) the LIVE chord matcher reads.
  // Loaded from persistence + reloaded on the same-tab change signal (SettingsPanel) and the
  // cross-tab 'storage' event, so a rebind takes effect immediately + survives relaunch.
  const [keymapOverrides, setKeymapOverrides] = useState<Record<string, string>>(() =>
    overridesToMap(parseOverrides(window.localStorage.getItem(KEYMAP_OVERRIDES_STORAGE))),
  );
  useEffect(() => {
    const reload = (): void =>
      setKeymapOverrides(
        overridesToMap(parseOverrides(window.localStorage.getItem(KEYMAP_OVERRIDES_STORAGE))),
      );
    window.addEventListener(KEYMAP_CHANGED_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(KEYMAP_CHANGED_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, []);
  const [bottomCollapsed, setBottomCollapsed] = useState(saved.bottomCollapsed ?? true);
  // default to a tab the SHELL can actually render (the Terminal tab is editor-only).
  const [bottomTab, setBottomTab] = useState<BottomTab>(saved.bottomTab ?? "health");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // APP-064: the first-run wizard shows ONLY when the flag is absent; a re-entry action
  // (`prometheus:run-onboarding` from Home / Settings) relaunches it with the flag already set.
  const [showWizard, setShowWizard] = useState(() => {
    try {
      return shouldShowWizard(window.localStorage.getItem(ONBOARDING_KEY));
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const relaunch = (): void => setShowWizard(true);
    window.addEventListener("prometheus:run-onboarding", relaunch);
    return () => window.removeEventListener("prometheus:run-onboarding", relaunch);
  }, []);
  // the update-flow banner state (APP-005) — pure machine in shell/update-view.ts.
  const [updateState, setUpdateState] = useState(UPDATE_IDLE);

  // persist the layout whenever any piece of it changes (leap #13).
  useEffect(() => {
    saveLayout({
      layoutVersion: LAYOUT_VERSION,
      activity,
      sidebarCollapsedByActivity: sidebarCollapsedMap,
      rightCollapsed,
      rightMode,
      bottomCollapsed,
      bottomTab,
    });
  }, [activity, sidebarCollapsedMap, rightCollapsed, rightMode, bottomCollapsed, bottomTab]);

  // one poll loop for the live PC telemetry (bottom-bar strip + System panel share it).
  useTelemetryPolling();

  // status-bar facts (leap #15): served model (the READY serve row) + git branch
  // + the active venv (APP-009 — rides the shared qk.envs read, no new IPC).
  const serveRows = useModelsStore((s) => s.serveRows);
  const servedModel = Object.values(serveRows).find((r) => r.status === "ready")?.modelId;
  const envsQ = useEnvList();
  const venvLabel = venvStatusLabel(envsQ.data);
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const [branch, setBranch] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const root = workspaceRoot;
    if (!root) {
      setBranch(undefined);
      return;
    }
    void (async () => {
      try {
        const s = await window.prometheus?.ide?.gitStatus(root);
        if (!alive || !s?.ok || !s.branch) {
          if (alive) setBranch(undefined);
          return;
        }
        const ahead = s.ahead ? ` ↑${s.ahead}` : "";
        const behind = s.behind ? ` ↓${s.behind}` : "";
        setBranch(`${s.branch}${ahead}${behind}`);
      } catch {
        if (alive) setBranch(undefined);
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceRoot]);

  // Auto-updater flow (file 10 §5, APP-005): subscribe to the three event feeds and
  // re-poll once via check() — events emitted before this subscription (multi-window/
  // dev timing) are lost, and check() reconstructs the announce. In dev the handler is
  // absent (registerUpdater no-ops) so the invoke REJECTS → swallow, banner stays idle;
  // an {ok:false} check (offline / unsigned build) also renders nothing by design.
  useEffect(() => {
    const api = window.prometheus?.updates;
    if (!api) return;
    const offAvailable = api.onAvailable((info) =>
      setUpdateState((s) => updateOnAvailable(s, info)),
    );
    const offProgress = api.onProgress((p) => setUpdateState((s) => updateOnProgress(s, p)));
    const offReady = api.onReady(() => setUpdateState((s) => updateOnReady(s)));
    void api
      .check()
      .then((r) => {
        if (r?.ok && typeof r.version === "string" && r.version) {
          const version = r.version;
          setUpdateState((s) => updateOnAvailable(s, { version }));
        }
      })
      .catch(() => {});
    return () => {
      offAvailable();
      offProgress();
      offReady();
    };
  }, []);

  // Download only on the explicit click (main has autoDownload=false); an ok:false
  // result falls back to "available" with the message — never a crash, never a retry loop.
  const onUpdateDownload = useCallback((): void => {
    setUpdateState((s) => updateOnDownloadStart(s));
    void window.prometheus?.updates
      ?.download()
      .then((r) => {
        if (!r?.ok) setUpdateState((s) => updateOnDownloadError(s, r?.error ?? "download failed"));
      })
      .catch((e) => setUpdateState((s) => updateOnDownloadError(s, String(e))));
  }, []);
  // quitAndInstall — reachable only from the "ready" phase (the banner gates the button).
  const onUpdateInstall = useCallback((): void => {
    void window.prometheus?.updates?.install().catch(() => {});
  }, []);

  // RightRail Inspector payload (file 08 §4.2): the current selection/route context as
  // raw JSON for power users. Always defined (never `undefined`) once the shell has
  // mounted — `undefined` is reserved for RightRail's own "nothing to show yet" branch,
  // which otherwise never fires now that every field here has a concrete fallback.
  const inspectorJson = useMemo(
    () => ({
      activity,
      shield: shieldTier,
      model: servedModel ?? null,
      branch: branch ?? null,
      problems: diagCounts,
      security: { findings: securityCount, verdict: lastVerdict?.verdict ?? null },
      engine: { pill: enginePill, health: engineHealth?.ok ?? null },
    }),
    [
      activity,
      shieldTier,
      servedModel,
      branch,
      diagCounts,
      securityCount,
      lastVerdict,
      enginePill,
      engineHealth,
    ],
  );

  // The sidebar toggle acts on the CURRENT route's entry in the per-route map
  // (APP-002/003). Reads the activity through a ref so the callback stays stable and
  // cmdCtx below keeps its one identity. toggleSidebarMap returns the SAME reference
  // on a body-less route — React bails out, so ⌘B never flips invisible dead state.
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const toggleSidebarForActivity = useCallback((): void => {
    const a = activityRef.current;
    setSidebarCollapsedMap((m) => toggleSidebarMap(m, a));
  }, []);

  // The shell COMMAND CONTEXT (leap #1): the callbacks a registry command acts through.
  // Stable across renders (all useState setters are stable) so the keydown listener and
  // the palette share one identity. Editor-scoped commands navigate to the editor and
  // re-dispatch through the window bus the editor route already listens on.
  const cmdCtx = useMemo<CommandContext>(
    () => ({
      navigate: (id) => setActivity(id),
      togglePalette: () => setPaletteOpen((v) => !v),
      toggleSidebar: toggleSidebarForActivity,
      toggleRightRail: () => setRightCollapsed((v) => !v),
      toggleBottomPanel: () => setBottomCollapsed((v) => !v),
      openBottomPanel: (tab) => {
        setBottomTab(tab);
        setBottomCollapsed(false);
      },
      openSettings: () => setSettingsOpen(true),
      runEditorCommand: (id) => {
        setActivity("editor");
        // the editor route attaches its `ide:run-command` listener on mount; defer past
        // the React commit (two frames) so the listener exists before we dispatch.
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            window.dispatchEvent(new CustomEvent("ide:run-command", { detail: id })),
          ),
        );
      },
      // APP-100: F6/⇧F6 cycle focus across the visible shell landmark regions (queried by the
      // `data-shell-region` attribute; a collapsed sidebar/rail unmounts → excluded).
      focusNext: () => cycleShellFocus(1),
      focusPrev: () => cycleShellFocus(-1),
    }),
    [toggleSidebarForActivity],
  );

  // Global keybindings driven by the registry (⌘K palette · ⌘B sidebar · ⌥⌘B right rail ·
  // ⌃` bottom panel · ⌘, settings · ⇧⌥F format · ⇧⌘F find) — one source for chords + palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      handleChord(e, cmdCtx, undefined, keymapOverrides); // APP-057: honor user rebinds live
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cmdCtx, keymapOverrides]);

  // APP-092: the editor-route AgentPane's `/` slash menu runs SHELL registry commands via
  // this event (it has no shell CommandContext of its own); the shell AgentPane runs them
  // directly. One executor for both.
  useEffect(() => {
    const onRun = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === "string") executeCommandId(id, cmdCtx);
    };
    window.addEventListener("ide:run-shell-command", onRun);
    return () => window.removeEventListener("ide:run-shell-command", onRun);
  }, [cmdCtx]);

  // Open-resource bus: any surface can dispatch prometheus:open-file / open-folder and
  // we route it to the editor (a tab for a file, the workspace root for a folder) — so a
  // double-clicked path anywhere lands in the editor without that component knowing the
  // App's nav/store wiring. (Software/external opens go straight through openPath.)
  useEffect(() => {
    const onFile = (e: Event): void => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      const uri = path.startsWith("file://") ? path : `file://${path}`;
      const name =
        path
          .replace(/[/\\]+$/, "")
          .split(/[/\\]/)
          .pop() ?? path;
      useTabsStore.getState().open(uri, { name, languageId: detectLanguage(path), preview: false });
      setActivity("editor");
    };
    const onFolder = (e: Event): void => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      useTabsStore.getState().setWorkspaceRoot(path);
      setActivity("editor");
    };
    window.addEventListener(OPEN_FILE_EVENT, onFile);
    window.addEventListener(OPEN_FOLDER_EVENT, onFolder);
    return () => {
      window.removeEventListener(OPEN_FILE_EVENT, onFile);
      window.removeEventListener(OPEN_FOLDER_EVENT, onFolder);
    };
  }, []);

  // Re-clicking the ALREADY-active rail icon toggles its contextual sidebar (VS Code
  // behavior) — a discoverable re-expand path. Switching activities keeps each route's
  // own persisted collapse preference. Only body-bearing routes toggle (no blank column).
  const handleSelectActivity = (id: ActivityId): void => {
    if (id === activity) {
      if (hasSidebarBody(id)) toggleSidebarForActivity();
    } else {
      setActivity(id);
    }
  };

  // An activity with no registered sidebar body shows no empty column (#6); otherwise
  // honor the per-route preference (editor defaults collapsed — it owns its own tools,
  // but a registered body means the user CAN open it deliberately, APP-002).
  const sidebarCollapsedForRoute = !hasSidebarBody(activity)
    ? true
    : effectiveSidebarCollapsed(sidebarCollapsedMap, activity);
  // The editor is full-bleed; discovery surfaces get calm padding (08 §2.4 density).
  const workMainStyle: CSSProperties =
    // minWidth:0 lets the editor/main flex child shrink below its content width so a narrow
    // (900px) window never overflows/clips the shell chrome (APP-100 responsive sweep).
    activity === "editor"
      ? { flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }
      : { flex: 1, minWidth: 0, minHeight: 0, overflow: "auto", padding: "var(--space-12, 24px)" };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-app)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <div style={{ flex: 1, display: "flex", minHeight: 0, minWidth: 0 }}>
        <ActivityBar
          active={activity}
          sidebarOpen={!sidebarCollapsedForRoute}
          onSelect={handleSelectActivity}
          enginePill={enginePill}
          aiOpen={!rightCollapsed}
          aiRunningCount={aiRunningCount}
          onToggleAI={() => setRightCollapsed((v) => !v)}
          onSettings={() => setSettingsOpen(true)}
          onEngineStatus={() => {
            setBottomCollapsed(false);
            setBottomTab("health");
          }}
        />
        <Sidebar
          activity={activity}
          collapsed={sidebarCollapsedForRoute}
          onToggle={toggleSidebarForActivity}
        >
          {hasSidebarBody(activity) ? sidebarBodyFor(activity) : null}
        </Sidebar>
        <div
          style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}
        >
          <main style={workMainStyle} data-shell-region="editor" aria-label="Editor" tabIndex={-1}>
            {/* per-route boundary: a crash in one route shows a fallback there and
                keeps the rail / palette / status bar alive (resets on navigation). */}
            <ErrorBoundary label={activity} resetKey={activity}>
              {renderActivity(activity, setActivity, (tab) => {
                setBottomTab(tab);
                setBottomCollapsed(false);
              })}
            </ErrorBoundary>
          </main>
          <BottomPanel
            collapsed={bottomCollapsed}
            active={bottomTab}
            tabs={SHELL_BOTTOM_TABS}
            onSelect={setBottomTab}
            onToggle={() => setBottomCollapsed((v) => !v)}
            counts={{ problems: diagCounts.errors + diagCounts.warnings, security: securityCount }}
            rightSlot={
              <TelemetryStrip
                onOpen={() => {
                  setBottomTab("system");
                  setBottomCollapsed(false);
                }}
              />
            }
          >
            {bottomTab === "problems" ? (
              <Problems />
            ) : bottomTab === "health" ? (
              <SystemHealthPanel
                view={deriveSystemHealthView(engineHealth, enginePill)}
                onRefresh={() => void refreshHealth()}
              />
            ) : bottomTab === "metadata" ? (
              <MetadataPanel />
            ) : bottomTab === "security" ? (
              <HardenPanel />
            ) : bottomTab === "tokens" ? (
              <TokenEconomyPanel onNavigate={setActivity} />
            ) : bottomTab === "system" ? (
              <TelemetryPanel />
            ) : null}
          </BottomPanel>
        </div>
        <RightRail
          collapsed={rightCollapsed}
          mode={rightMode}
          onModeChange={setRightMode}
          onToggle={() => setRightCollapsed((v) => !v)}
          // the Editor route mounts its OWN AgentPane on the right — mounting a second
          // one here would double-bind the shared AI session store. Only provide the
          // shell AgentPane for non-editor activities.
          agent={
            activity === "editor" ? undefined : (
              <AgentPane
                onNavigate={setActivity}
                onRunCommand={(id) => executeCommandId(id, cmdCtx)}
              />
            )
          }
          inspectorJson={inspectorJson}
        />
      </div>

      <UpdateBanner
        state={updateState}
        onDownload={onUpdateDownload}
        onInstall={onUpdateInstall}
        onDismiss={() => setUpdateState(updateOnDismiss)}
      />

      <ShellStatusBar
        verdict={shieldTier}
        venv={venvLabel}
        model={servedModel}
        branch={branch}
        problems={{ errors: diagCounts.errors, warnings: diagCounts.warnings }}
        onProblemsClick={() => {
          // same mechanics as the TelemetryStrip/engine-status openers: select the
          // shell Problems tab (real body, APP-009) + uncollapse — works on any route.
          setBottomTab("problems");
          setBottomCollapsed(false);
        }}
        update={
          updateState.phase !== "idle"
            ? {
                label: updateActionLabel(updateState) ?? "",
                title: `Update ${updateState.version ?? ""} (${updateState.phase})`,
              }
            : undefined
        }
        onShieldClick={() => setActivity("security")}
        onCommandPalette={() => setPaletteOpen(true)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(id) => {
          setActivity(id);
          setPaletteOpen(false);
        }}
        onRunCommand={(id) => {
          // EXECUTE the command via the registry (leap #1) — panel openers, view toggles,
          // settings, and editor-scoped actions all actually run now. Unknown ids (e.g.
          // models.* / python.* surfaced from other routes) fall back to a navigate.
          if (!executeCommandId(id, cmdCtx)) {
            const target = activityForCommand(id);
            if (target) setActivity(target);
          }
          setPaletteOpen(false);
        }}
      />

      {settingsOpen && (
        <SettingsOverlay
          onClose={() => setSettingsOpen(false)}
          workspaceRoot={workspaceRoot ?? undefined}
        />
      )}
      {showWizard && (
        <OnboardingWizard
          workspaceRoot={workspaceRoot ?? undefined}
          onOpenTokens={() => {
            setBottomTab("tokens");
            setBottomCollapsed(false);
          }}
          onComplete={(result, skipped) => {
            try {
              window.localStorage.setItem(
                ONBOARDING_KEY,
                serializeResult(finalizeResult(result, { skipped, ts: Date.now() })),
              );
            } catch {
              /* storage disabled — the wizard just won't persist this session */
            }
            setShowWizard(false);
          }}
        />
      )}
    </div>
  );
}

/* ── tiny token-styled surfaces local to the shell chrome ─────────────────────── */

function iconBtn(): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    fontSize: "0.9rem",
    lineHeight: 1,
    padding: "var(--space-2, 4px)",
  };
}
function fieldLabel(): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3, 6px)",
    fontSize: "var(--text-small-size, 0.8125rem)",
    color: "var(--text-secondary)",
  };
}
function selectStyle(): CSSProperties {
  return {
    appearance: "none",
    background: "var(--bg-inset)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md, 6px)",
    padding: "var(--space-3, 6px) var(--space-4, 8px)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-body-size, 0.9375rem)",
  };
}

export default App;
