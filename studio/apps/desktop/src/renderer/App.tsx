// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
import type { IdeEvent } from "../shared/ipc-contract.js";

import { Z, resolveActivity, resolveSubPanel, subPanelsFor } from "@prometheus/ui";
import { CatalogRoute } from "../routes/catalog.js";
import { ChatRoute } from "../routes/chat.js";
import { EditorRoute } from "../routes/editor.js";
import { ModelsRoute } from "../routes/models.js";
import { requestRouteTab } from "../routes/route-tabs.js";
import { SecurityRoute } from "../routes/security.js";
import { WorkspaceRoute } from "../routes/workspace.js";
import {
  type CommandContext,
  commandTarget,
  executeCommandId,
  handleChord,
} from "./commands/registry.js";
import { HardenPanel } from "./ide/HardenPanel.js";
import { Problems } from "./ide/Problems.js";
import { TokenEconomyPanel } from "./ide/TokenEconomyPanel.js";
import { AgentPane } from "./ide/ai/AgentPane.js";
import { declareWorkingSet } from "./ide/ai/permission-gate.js";
import { agentRuns } from "./ide/ai/run-controller.js";
import { SystemHealthPanel } from "./ide/health/SystemHealthPanel.js";
import { deriveSystemHealthView } from "./ide/health/health-panel-view.js";
import { MetadataPanel } from "./ide/metadata/MetadataPanel.js";
import { countDiagnostics } from "./ide/state/diagnostics.js";
import { detectLanguage } from "./ide/state/lang-detect.js";
import { useRunSessionStore } from "./ide/state/run-session-store.js";
import { useDiagnosticsStore, useTabsStore } from "./ide/state/stores.js";
import { useAiSessionStore } from "./ide/state/stores.js";
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
import { AuthPicker } from "./shell/AuthPill.js";
import { EngineGate } from "./shell/EngineGate.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.js";
import { UpdateBanner } from "./shell/UpdateBanner.js";
import { nextRegion, useFocusTrap } from "./shell/a11y.js";
import {
  ActivityBar,
  type AgentActivity,
  BottomPanel,
  type BottomTab,
  CommandPalette,
  RightRail,
  type RightRailMode,
  ShellStatusBar,
  Sidebar,
  TopBar,
  useTheme,
} from "./shell/index.js";
import {
  type RailState,
  clearOverrideIfRoomy,
  toggleRail as nextRailState,
  openRail,
  railCollapsedNow,
  shellCollapse,
} from "./shell/responsive.js";
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
import { useRecentsStore } from "./stores/recents.js";

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

/**
 * Routes whose CONTENT comes from the engine — these get the §6 degraded wrapper.
 *
 * Catalog and Workspace are deliberately NOT here, and the reason is a bug the §1 merge
 * introduced. `DegradedState` renders the last-known content under `pointerEvents:"none"`,
 * which is right for stale data and wrong for navigation: gating the whole route also froze
 * the segmented control, so with the engine down the user could not switch to Catalog /
 * Extensions (the MCP connector manager, which runs in MAIN and never touches the engine) or
 * to Workspace / Docs (local markdown, likewise). Before the merge both were their own rail
 * routes and stayed usable. Those two routes now apply `EngineGate` to the engine-backed
 * SEGMENT BODIES themselves, so the chrome stays live and the gate still covers what it
 * should.
 */
const ENGINE_BACKED: ReadonlySet<ActivityId> = new Set<ActivityId>(["models", "security"]);

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
  /**
   * Which TOOL PANEL is open, per activity — the rail's lower half (APP: rail fusion).
   *
   * Per activity rather than one global value, for the same reason `sidebarCollapsedByActivity`
   * is: "Search" is a sensible thing to be looking at in the Editor and meaningless anywhere
   * else, so one shared slot would make every route inherit the last route's choice.
   */
  subPanelByActivity: Record<string, string>;
}
const LAYOUT_KEY = "prometheus.layout";
const LAYOUT_VERSION = 2;

function loadLayout(): Partial<PersistedLayout> {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<PersistedLayout> = {};
    if (typeof o.activity === "string") {
      // MIGRATE, never cast. handoff_3 §1 retired four activities into two merged routes,
      // and this blob is on disk for anyone who quit while on Repos/Environments/Docs/
      // Extensions. A raw cast let a stale id through to `renderActivity`, which fell to
      // its `default:` branch and silently opened an unrelated route. `resolveActivity`
      // also latches the segment, so the redirect lands on the right TAB, not just the
      // right route.
      const resolved = resolveActivity(o.activity);
      out.activity = resolved.activity;
      if (resolved.tab && (resolved.activity === "catalog" || resolved.activity === "workspace")) {
        requestRouteTab(resolved.activity, resolved.tab);
      }
    }
    const sidebarMap = parseSidebarCollapsed(o);
    if (sidebarMap) out.sidebarCollapsedByActivity = sidebarMap;
    if (typeof o.rightCollapsed === "boolean") out.rightCollapsed = o.rightCollapsed;
    if (o.rightMode === "agent" || o.rightMode === "inspector") out.rightMode = o.rightMode;
    if (typeof o.bottomCollapsed === "boolean") out.bottomCollapsed = o.bottomCollapsed;
    if (typeof o.bottomTab === "string" && SHELL_BOTTOM_TAB_IDS.has(o.bottomTab as BottomTab))
      out.bottomTab = o.bottomTab as BottomTab;
    // Values are NOT validated against the panel list here — `resolveSubPanel` does that at
    // render time, against the activity actually being shown. Validating on load would have to
    // guess which activity each key belongs to, and a panel renamed between releases would
    // silently drop the whole map instead of falling back one entry.
    if (o.subPanelByActivity && typeof o.subPanelByActivity === "object") {
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.subPanelByActivity as Record<string, unknown>)) {
        if (typeof v === "string") map[k] = v;
      }
      out.subPanelByActivity = map;
    }
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

/** Map an activity id → its workbench route (extensions = file 09, placeholder). */
function renderActivity(
  activity: ActivityId,
  onNavigate: (id: ActivityId) => void,
  onOpenPanel: (tab: BottomTab) => void,
  /** §2's second collapse step — the editor's file tree floats instead of taking a column. */
  treeOverlay = false,
): ReactElement {
  switch (activity) {
    case "home":
      return (
        <HomeRoute
          onNavigate={onNavigate}
          onOpenTokens={() => onOpenPanel("tokens")}
          onOpenHealth={() => onOpenPanel("health")}
        />
      );
    case "editor":
      // the panel.* palette seam (APP-004): the editor palette opens SHELL bottom tabs.
      return (
        <EditorRoute
          onNavigate={onNavigate}
          onOpenShellPanel={onOpenPanel}
          treeOverlay={treeOverlay}
        />
      );
    case "catalog":
      return <CatalogRoute />;
    case "chat":
      return <ChatRoute />;
    case "models":
      return <ModelsRoute />;
    case "security":
      return <SecurityRoute />;
    case "workspace":
      // handoff_3 §1: Repos + Environments + Docs, segmented.
      return <WorkspaceRoute />;
    default:
      // Home, not a route that happened to be last in the switch. `resolveActivity`
      // already redirects every retired id, so reaching here means a genuinely unknown
      // activity — and Mission Control is the honest place to land.
      return (
        <HomeRoute
          onNavigate={onNavigate}
          onOpenTokens={() => onOpenPanel("tokens")}
          onOpenHealth={() => onOpenPanel("health")}
        />
      );
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
  // focus trap + Escape + focus-restore on close (parity with CommandPalette) so Tab stays
  // inside the modal instead of walking the workbench controls behind it. Escape used to be
  // a separate window listener here; the trap owns it now, on the document in CAPTURE, so
  // it fires before anything below can swallow the key.
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, true, onClose, {
    deferTabToTextFields: true,
    // this overlay focuses the SECTION (not its first control) so the screen reader reads
    // the dialog label before the first setting.
    skipInitialFocus: true,
  });
  useEffect(() => {
    const id = requestAnimationFrame(() => dialogRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
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
        // A modal is a DECISION surface: it must outrank the ⌘K palette (Z.palette, one rung
        // below) and tie the auth picker (Z.modal), winning that tie by rendering later in the
        // DOM. Both used to paint over the open Settings dialog. ⌘K is also refused while this
        // is open (see `anotherModalOpen`), so the palette cannot open, focused, underneath it.
        zIndex: Z.modal,
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
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
          <h2 style={{ margin: 0, fontSize: "var(--text-h2-size, 1rem)", fontWeight: 600 }}>
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

/**
 * Is a modal decision other than the ⌘K palette currently VISIBLE? Every such surface in this
 * renderer declares `aria-modal="true"`; the visibility test (a rendered box) keeps a dialog that
 * is mounted but hidden from blocking ⌘K for good.
 */
function anotherModalOpen(): boolean {
  if (typeof document === "undefined") return false;
  for (const el of document.querySelectorAll<HTMLElement>('[aria-modal="true"]')) {
    if (el.getAttribute("aria-label") === "Command palette") continue;
    if (el.getClientRects().length > 0) return true;
  }
  return false;
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
  /**
   * Has the editor been opened at least once this run?
   *
   * Once true it never goes back: the editor subtree stays mounted (hidden when another activity
   * is showing) so navigating away cannot unmount TerminalPanel and kill its ptys. Deferring the
   * first mount keeps the cost off sessions that never open the editor.
   */
  const [editorEverVisited, setEditorEverVisited] = useState(activity === "editor");
  useEffect(() => {
    if (activity === "editor") setEditorEverVisited(true);
  }, [activity]);
  // per-route overrides only — a route absent here uses its default (open where a
  // body exists, editor collapsed; see shell/sidebar-view.ts).
  const [sidebarCollapsedMap, setSidebarCollapsedMap] = useState<SidebarCollapsedMap>(
    saved.sidebarCollapsedByActivity ?? {},
  );
  const [rightCollapsed, setRightCollapsed] = useState(saved.rightCollapsed ?? true);
  const [rightMode, setRightMode] = useState<RightRailMode>(saved.rightMode ?? "agent");
  /** the rail's lower half: which tool panel each activity is showing. */
  const [subPanelByActivity, setSubPanelByActivity] = useState<Record<string, string>>(
    saved.subPanelByActivity ?? {},
  );

  /**
   * §2's collapse order: below 1100px the chat rail trays, below ~900 the file tree floats.
   *
   * Tracked here because the shell owns the rail. `rightCollapsed` remains the USER's
   * choice and is what gets persisted; the narrow-window tray is unioned in at render time
   * (`railCollapsed`), so widening the window restores exactly what they last chose and a
   * resize never rewrites a preference.
   */
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = (): void => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const collapse = shellCollapse(viewportWidth);
  /**
   * §2-j's escape hatch. `rightCollapsed` stays the persisted preference; `narrowOverride`
   * records "the user opened the rail anyway while the window was narrow", and is retired
   * the moment the window is roomy again so the auto-tray default survives a resize.
   */
  const [narrowOverride, setNarrowOverride] = useState(false);
  useEffect(() => {
    setNarrowOverride(
      (o) =>
        clearOverrideIfRoomy({ userCollapsed: rightCollapsed, narrowOverride: o }, viewportWidth)
          .narrowOverride,
    );
  }, [viewportWidth, rightCollapsed]);
  const railState: RailState = { userCollapsed: rightCollapsed, narrowOverride };
  const railIsCollapsed = railCollapsedNow(railState, viewportWidth);
  /**
   * The live rail state + viewport width, read through a ref so the two callbacks below can be
   * `useCallback([])`-stable — the same pattern as `activityRef` further down.
   *
   * This is load-bearing, not tidiness. Both callbacks are captured by consumers that never
   * re-subscribe: `toggleRail` by `cmdCtx` (a `useMemo` on `[toggleSidebarForActivity]`, which
   * never changes) and `forceOpenRail` by the `prometheus:open-agent` effect (`[]`). As plain
   * per-render arrows they froze the render-1 snapshot, so `nextRailState`/`openRail` — pure
   * functions of that snapshot — kept returning the same answer forever: ⌥⌘B and the palette's
   * "Toggle AI Panel" became one-way, and on a window narrowed after mount `forceOpenRail`
   * computed `narrowOverride: false` from the stale wide width, leaving the rail trayed and the
   * AgentPane unmounted so Home's seeded prompt was dispatched at a listener that did not exist.
   */
  const railRef = useRef({ state: railState, width: viewportWidth });
  railRef.current = { state: railState, width: viewportWidth };
  /** Every rail toggle goes through this, so none of them can be inert below 1100px. */
  const toggleRail = useCallback((): void => {
    const { state, width } = railRef.current;
    const next = nextRailState(state, width);
    setRightCollapsed(next.userCollapsed);
    setNarrowOverride(next.narrowOverride);
  }, []);
  /** Force the rail open — used by anything about to hand the agent work to do. */
  const forceOpenRail = useCallback((): void => {
    const next = openRail(railRef.current.width);
    setRightCollapsed(next.userCollapsed);
    setNarrowOverride(next.narrowOverride);
  }, []);
  // APP-056: background agent-run count for the ✦ rail badge — sourced from the MODULE-LEVEL
  // run controller (NOT any pane), so it stays correct while the AI pane is collapsed/unmounted.
  const [aiRunningCount, setAiRunningCount] = useState(0);
  /**
   * A RUN or DEBUG session is live — what the toolbar's Stop button acts on.
   *
   * `running` used to be `aiRunningCount > 0`, so the Run/Debug/Stop cluster lit up while
   * the AGENT was thinking and stayed dark through an actual debug session. Two different
   * kinds of "busy" sharing one indicator, next to a button that only stops one of them.
   */
  const runSessionActive = useRunSessionStore(
    (st) => st.runId !== null || st.dapSessionId !== null,
  );
  useEffect(() => agentRuns.subscribe(() => setAiRunningCount(agentRuns.runningIds().length)), []);
  // §2.5: the rail header's session chip + the tray's status dot. Both read the SAME
  // module-level run controller the ✦ badge does, so a minimised rail still tells the
  // truth about a background run (and about one that is blocked awaiting approval).
  const activeSessionTitle = useAiSessionStore((s) =>
    s.activeId ? s.sessions[s.activeId]?.title : undefined,
  );
  const activeSessionId = useAiSessionStore((s) => s.activeId);
  const agentActivity: AgentActivity =
    aiRunningCount > 0
      ? "running"
      : activeSessionId && agentRuns.isAwaiting(activeSessionId)
        ? "attention"
        : "idle";
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
  /** §7: the StatusBar's auth entry opens the §5 picker upward. */
  const [authPickerOpen, setAuthPickerOpen] = useState(false);
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
      subPanelByActivity,
    });
  }, [
    activity,
    sidebarCollapsedMap,
    rightCollapsed,
    rightMode,
    bottomCollapsed,
    bottomTab,
    subPanelByActivity,
  ]);

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
  // The pointer entry points (TopBar pill, StatusBar) obey the same rule as ⌘K: never open the
  // palette under another modal. History/Bookmarks have no backdrop, so the pill stays
  // clickable while they are open, and it opened a hidden, focused palette beneath them.
  const openPalette = useCallback((): void => {
    if (!anotherModalOpen()) setPaletteOpen(true);
  }, []);

  const cmdCtx = useMemo<CommandContext>(
    () => ({
      navigate: (id) => setActivity(id),
      // CLOSING always works; OPENING is refused while another modal decision is on screen.
      // The palette focuses its input on open, so opening it under Settings (or the catalog's
      // rollback dialog) put keyboard focus in a palette nobody could see: typing filtered it
      // and Enter ran a command blind.
      togglePalette: () => {
        const blocked = anotherModalOpen();
        setPaletteOpen((v) => (v ? false : !blocked));
      },
      toggleSidebar: toggleSidebarForActivity,
      toggleRightRail: () => toggleRail(),
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
    // `toggleRail` is `useCallback([])`-stable, so listing it costs no re-memo and makes the
    // dependency explicit instead of relying on a reader to verify the identity by hand.
    [toggleSidebarForActivity, toggleRail],
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

  // §2.3.4: record EVERY workspace root the app opens into the recent-projects MRU.
  // Subscribing to the tabs store (rather than patching each opener) means the picker,
  // a deep link, a recents click and a drag-drop all land in the list the same way.
  useEffect(() => {
    if (workspaceRoot) useRecentsStore.getState().record(workspaceRoot);
  }, [workspaceRoot]);

  // handoff §3: tell MAIN which roots the applier guard should gate writes against.
  // Re-declared on every workspace change (which also drops any prior out-of-scope
  // approvals — they were granted against the old scope). With no folder open the list
  // is empty, which disables the scope check rather than refusing every save.
  useEffect(() => {
    void declareWorkingSet(workspaceRoot ? [workspaceRoot] : []);
  }, [workspaceRoot]);

  // §2.3.2: Home's ask bar hands its draft to the AGENT RAIL (which is always present)
  // instead of navigating away. Open the rail, seed the composer, and let the pane read
  // the seeded prompt on mount.
  useEffect(() => {
    const onOpenAgent = (e: Event): void => {
      const prompt = (e as CustomEvent<{ prompt?: string }>).detail?.prompt;
      forceOpenRail();
      setRightMode("agent");
      if (prompt) {
        // defer past the commit so the (possibly just-mounted) pane is listening.
        requestAnimationFrame(() =>
          window.dispatchEvent(new CustomEvent("prometheus:seed-agent-prompt", { detail: prompt })),
        );
      }
    };
    window.addEventListener("prometheus:open-agent", onOpenAgent);
    return () => window.removeEventListener("prometheus:open-agent", onOpenAgent);
    // `forceOpenRail` is `useCallback([])`-stable, so this still subscribes exactly once —
    // listing it is what makes that a checked fact rather than a comment.
  }, [forceOpenRail]);

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
    /**
     * OS drag-and-drop arrives from MAIN, not from a DOM drop handler.
     *
     * A dropped path read out of renderer JavaScript could never earn a working-set grant — the
     * renderer granting itself a root is exactly what that guard exists to prevent. Main sees the
     * drop through Chromium's own `will-navigate`, records the grant (folder) or the single-path
     * approval (file), and only then sends `shell.dropped`. By the time this runs the scope
     * decision has already been made by the side that is allowed to make it, so this is pure
     * routing onto the SAME open-resource bus as every other opener.
     */
    const ide = window.prometheus?.ide;
    const offDropped = ide?.onEvent?.((ev: IdeEvent) => {
      if (ev.channel !== "shell.dropped") return;
      const detail = { detail: { path: ev.path } };
      window.dispatchEvent(
        new CustomEvent(ev.kind === "folder" ? OPEN_FOLDER_EVENT : OPEN_FILE_EVENT, detail),
      );
    });
    return () => {
      window.removeEventListener(OPEN_FILE_EVENT, onFile);
      window.removeEventListener(OPEN_FOLDER_EVENT, onFolder);
      offDropped?.();
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
  /**
   * The rail's lower half for the CURRENT activity.
   *
   * `resolveSubPanel` falls back to the activity's first panel when the persisted id names a
   * panel that no longer exists — an operator who quit on "Coverage" after that panel was
   * renamed would otherwise reopen to a rail with nothing selected and a blank side pane.
   */
  const railSubPanels = subPanelsFor(activity);
  const activeSubPanel = resolveSubPanel(activity, subPanelByActivity[activity]);
  const selectSubPanel = useCallback(
    (id: string): void => {
      setSubPanelByActivity((m) => (m[activity] === id ? m : { ...m, [activity]: id }));
    },
    [activity],
  );
  /**
   * The KEEP-ALIVE editor's own panel selection — bound to the `editor` key, never to whichever
   * activity happens to be showing.
   *
   * The pair above is activity-relative, which is right for the rail and wrong for the editor:
   * the editor subtree stays mounted across navigations (`editorEverVisited`) and is now
   * CONTROLLED, so its internal `setActivity` calls `onSubPanel` instead of its own state. Handed
   * the activity-relative setter it wrote the editor's panel id under the VISIBLE route's key —
   * approving an agent diff from Home persisted `home: "debug"` into `prometheus.layout` while
   * the editor's real selection never moved, so the gate verdict it switched to was never
   * surfaced. The read side matters equally: `subPanelByActivity[activity]` is undefined for any
   * non-editor activity, so while hidden the editor saw no panel at all.
   *
   * Hard-coding `"editor"` is safe — `SUBPANELS` registers panels for that key only, and
   * `EditorRoute` is rendered under no other.
   */
  const editorSubPanel = resolveSubPanel("editor", subPanelByActivity.editor);
  const selectEditorSubPanel = useCallback((id: string): void => {
    setSubPanelByActivity((m) => (m.editor === id ? m : { ...m, editor: id }));
  }, []);

  const sidebarCollapsedForRoute = !hasSidebarBody(activity)
    ? true
    : effectiveSidebarCollapsed(sidebarCollapsedMap, activity);
  // The editor owns its own island gaps; discovery surfaces get calm padding (08 §2.4).
  const workMainStyle: CSSProperties =
    // minWidth:0 lets the editor/main flex child shrink below its content width so a narrow
    // window never overflows/clips the shell chrome (APP-100 responsive sweep).
    // Editor owns its own 8px island gaps; Home owns its own 26/30px mission-control
    // padding; every other route gets the calm default (08 §2.4 density).
    activity === "editor"
      ? // The editor MUST be a flex column here.
        //
        // Without it `<main>` is a block box, so the keep-alive wrapper's `flex: 1` is inert and
        // the wrapper is auto-height; `EditorRoute`'s own `height: 100%` then resolves against an
        // auto-height parent, which CSS defines as `auto`. The whole IDE therefore sized itself to
        // its CONTENT and left the bottom of the window empty — the "editor is shrunk for no
        // apparent reason" report. Every link in the chain below this one was already correct,
        // which is why it survived so long: the single missing `display` was two levels up from
        // anything that looked wrong.
        {
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }
      : activity === "home"
        ? { flex: 1, minWidth: 0, minHeight: 0, overflow: "auto" }
        : { flex: 1, minWidth: 0, minHeight: 0, overflow: "auto", padding: "18px 20px" };

  // The project chip's display name — the workspace folder's basename (§2.1).
  const projectName = workspaceRoot
    ? (workspaceRoot
        .replace(/[/\\]+$/, "")
        .split(/[/\\]/)
        .pop() ?? undefined)
    : undefined;

  const openHealth = (): void => {
    setBottomTab("health");
    setBottomCollapsed(false);
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        // §2: the app ROOT carries the radial wash; every panel is an island floating on it.
        background: "var(--gradient-app)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-ui)",
        overflow: "hidden",
      }}
    >
      <TopBar
        {...(projectName ? { project: projectName } : {})}
        {...(branch ? { branch } : {})}
        onCommandPalette={openPalette}
        enginePill={enginePill}
        onEngineStatus={openHealth}
        onRun={() => executeCommandId("run.config", cmdCtx)}
        onDebug={() => executeCommandId("run.debug", cmdCtx)}
        onStop={() => executeCommandId("run.stop", cmdCtx)}
        // …and `running` now means a RUN or DEBUG session, which is what the Stop button
        // next to it acts on. It was wired to the agent-run count, so the toolbar lit up
        // while the agent was thinking and stayed dark through an actual debug session.
        running={runSessionActive}
        onOpenProject={() => setActivity("editor")}
      />
      {/* §2: the main row lays islands out with 8px gaps on the inset ground. */}
      <div
        style={{
          flex: 1,
          display: "flex",
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
          gap: 8,
          padding: 8,
          paddingLeft: 0,
        }}
      >
        <ActivityBar
          active={activity}
          sidebarOpen={!sidebarCollapsedForRoute}
          onSelect={handleSelectActivity}
          aiOpen={!railIsCollapsed}
          aiRunningCount={aiRunningCount}
          onToggleAI={() => toggleRail()}
          onSettings={() => setSettingsOpen(true)}
          subPanels={railSubPanels}
          activeSubPanel={activeSubPanel}
          onSelectSubPanel={selectSubPanel}
        />
        <Sidebar
          activity={activity}
          collapsed={sidebarCollapsedForRoute}
          onToggle={toggleSidebarForActivity}
        >
          {hasSidebarBody(activity) ? sidebarBodyFor(activity) : null}
        </Sidebar>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            minHeight: 0,
            gap: 8,
          }}
        >
          <main style={workMainStyle} data-shell-region="editor" aria-label="Editor" tabIndex={-1}>
            {/* per-route boundary: a crash in one route shows a fallback there and
                keeps the rail / palette / status bar alive (resets on navigation). */}
            <ErrorBoundary label={activity} resetKey={activity}>
              {/**
               * The EDITOR route stays MOUNTED once it has been visited; every other route is
               * swapped normally.
               *
               * `renderActivity` returned `<EditorRoute>` from a bare switch, so navigating to
               * any other activity unmounted the whole editor subtree — including TerminalPanel.
               * Every `<Terminal>` cleanup then ran `ptyKill`, and the host killed the shell
               * along with its children: clicking "Models" while `npm run dev` was running in the
               * integrated terminal killed the dev server, and coming back gave a fresh empty
               * shell with no scrollback. This is the same defect as the bottom panel's collapse
               * control, one level up, and the wider of the two.
               *
               * It is not mounted until first visited, so an app that never opens the editor pays
               * nothing; after that it is hidden rather than destroyed. Editor is not in
               * ENGINE_BACKED (it reads no engine), so it never needed the EngineGate wrapper.
               */}
              {editorEverVisited && (
                <div
                  style={{
                    minWidth: 0,
                    minHeight: 0,
                    flex: 1,
                    display: activity === "editor" ? "flex" : "none",
                    flexDirection: "column",
                  }}
                  {...(activity === "editor" ? {} : { "aria-hidden": true, inert: true })}
                >
                  <EditorRoute
                    onNavigate={setActivity}
                    onOpenShellPanel={(tab) => {
                      setBottomTab(tab);
                      setBottomCollapsed(false);
                    }}
                    // §2-j's second step. THIS is the live editor mount — the one below in
                    // `renderActivity` is unreachable (`activity === "editor" ? null : …`),
                    // because the editor is kept alive here across navigations. Passing the
                    // prop to the switch alone put it into dead code.
                    treeOverlay={collapse.tree === "overlay"}
                    // the rail's lower half drives this now — see shell/ActivityBar.tsx. Bound to
                    // the EDITOR's own key, not the visible activity's: this mount outlives
                    // navigation away from the editor (see `selectEditorSubPanel`).
                    {...(editorSubPanel !== undefined ? { subPanel: editorSubPanel } : {})}
                    onSubPanel={selectEditorSubPanel}
                  />
                </div>
              )}
              {/* §6: DEGRADED wraps every ENGINE-BACKED route — the engine being down is a
                  fact about the whole route, not about one panel inside it. Home has its
                  own per-island degraded states (its islands degrade independently), and
                  Editor/Docs/Chat do not read the engine at all. */}
              {activity === "editor" ? null : ENGINE_BACKED.has(activity) ? (
                <EngineGate>
                  {renderActivity(
                    activity,
                    setActivity,
                    (tab) => {
                      setBottomTab(tab);
                      setBottomCollapsed(false);
                    },
                    collapse.tree === "overlay",
                  )}
                </EngineGate>
              ) : (
                renderActivity(
                  activity,
                  setActivity,
                  (tab) => {
                    setBottomTab(tab);
                    setBottomCollapsed(false);
                  },
                  collapse.tree === "overlay",
                )
              )}
            </ErrorBoundary>
          </main>
          {/* The EDITOR route owns its own bottom island (Terminal/Claude/Problems/Health/
              …), so the shell must not stack a second one under it — that was two panels
              deep on the one route that needs the vertical space most. */}
          {activity !== "editor" && (
            <BottomPanel
              collapsed={bottomCollapsed}
              active={bottomTab}
              tabs={SHELL_BOTTOM_TABS}
              onSelect={setBottomTab}
              onToggle={() => setBottomCollapsed((v) => !v)}
              counts={{
                problems: diagCounts.errors + diagCounts.warnings,
                security: securityCount,
              }}
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
          )}
        </div>
        <RightRail
          collapsed={railIsCollapsed}
          mode={rightMode}
          onModeChange={setRightMode}
          onToggle={() => toggleRail()}
          // §2.5: the rail is GLOBAL and hosts the ONE AgentPane on every route (the editor
          // no longer mounts its own), so a chat started on Home is the same session you
          // keep talking to in the editor.
          agent={
            // §6: the agent pane is the busiest surface in the app; a throw in it must not
            // take the shell with it.
            <ErrorBoundary label="agent">
              <AgentPane
                onNavigate={setActivity}
                onRunCommand={(id) => executeCommandId(id, cmdCtx)}
              />
            </ErrorBoundary>
          }
          inspectorJson={inspectorJson}
          {...(activeSessionTitle ? { sessionLabel: activeSessionTitle } : {})}
          onNewSession={() => {
            useAiSessionStore.getState().newSession();
            forceOpenRail();
          }}
          activity={agentActivity}
        />
      </div>

      <UpdateBanner
        state={updateState}
        onDownload={onUpdateDownload}
        onInstall={onUpdateInstall}
        onDismiss={() => setUpdateState(updateOnDismiss)}
      />

      {/* §5/§7: the StatusBar's `A{n} name` opens the SAME picker as the TopBar pill, but
          upward — anchored above the 26px bar so it never opens off-screen. */}
      <div style={{ position: "relative", flex: "none" }}>
        {authPickerOpen && (
          <div style={{ position: "absolute", left: 44, bottom: 0, zIndex: Z.modal }}>
            <AuthPicker placement="above" onClose={() => setAuthPickerOpen(false)} />
          </div>
        )}
        <ShellStatusBar
          verdict={shieldTier}
          // §7's first entry is "🛡 gate armed" — an ARMED claim, which only the health
          // probe can answer. Home's chip learned this first; the status bar is the same
          // question in the piece of chrome that is never off screen.
          {...(engineHealth ? { armed: engineHealth.nemesisPresent === true } : {})}
          venv={venvLabel}
          model={servedModel}
          branch={branch}
          enginePill={enginePill}
          onEngineClick={openHealth}
          onAuthClick={() => setAuthPickerOpen((v) => !v)}
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
          onCommandPalette={openPalette}
        />
      </div>

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
            const target = commandTarget(id);
            if (target) {
              // LATCH THE SEGMENT FIRST — the route mounts after setActivity, and a bare
              // navigate lands `python.selectInterpreter` on Workspace/Repos.
              if (target.tab && (target.activity === "catalog" || target.activity === "workspace"))
                requestRouteTab(target.activity, target.tab);
              setActivity(target.activity);
            }
          }
          setPaletteOpen(false);
        }}
      />

      {settingsOpen && (
        <ErrorBoundary label="settings">
          <SettingsOverlay
            onClose={() => setSettingsOpen(false)}
            workspaceRoot={workspaceRoot ?? undefined}
          />
        </ErrorBoundary>
      )}
      {showWizard && (
        <ErrorBoundary label="onboarding">
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
        </ErrorBoundary>
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
    fontSize: "var(--text-body-size, 0.875rem)",
  };
}

export default App;
