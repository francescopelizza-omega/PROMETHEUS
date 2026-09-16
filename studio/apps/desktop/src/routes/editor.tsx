/**
 * routes/editor.tsx — the IDE shell route (file 07 §2/§3/§6/§7/§8).
 *
 * Assembles the file-07 IDE surface into the App's "editor" tab: the primary side panel —
 * driven by the SHELL's activity rail, not an icon nav of its own (this route deliberately
 * paints none; see editor-rail.test.ts) — the editor group(s)
 * (EditorPane: Monaco, multi-tab, split), the bottom panel (terminal / problems), and
 * the right Agent/Chat pane. The command palette (Cmd-Shift-P) + quick-open (Cmd-P)
 * mount on top; Cmd-K opens the inline-edit overlay anchored to the editor.
 *
 * The host feed (window.prometheus.ide.onEvent) is subscribed once here and fanned out
 * to the diagnostics store (LSP publishDiagnostics) — the renderer routes the multiplex
 * by `channel`. The FIRST Run/Debug routes through the engine run-gate (DebugPanel,
 * §5.2). The renderer drives the MAIN hosts over IPC and decides nothing about safety
 * (C5).
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the IDE components/stores +
 * window.prometheus only. NO node/electron/engine-bridge.
 */

import { ActivityIcon, type ActivityId, EmptyState, Z, elevation } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { BlameView } from "../renderer/ide/BlameView.js";
import { BookmarksPanel } from "../renderer/ide/BookmarksPanel.js";
import { CallHierarchyView } from "../renderer/ide/CallHierarchyView.js";
import { ClipboardHistory } from "../renderer/ide/ClipboardHistory.js";
import { CommandPalette } from "../renderer/ide/CommandPalette.js";
import { CoverageView } from "../renderer/ide/CoverageView.js";
import { DebugPanel } from "../renderer/ide/DebugPanel.js";
import { EditorPane } from "../renderer/ide/EditorPane.js";
import { FileTree } from "../renderer/ide/FileTree.js";
import { GitPanel } from "../renderer/ide/GitPanel.js";
import { HistoryPanel } from "../renderer/ide/HistoryPanel.js";
import { MethodHierarchyView } from "../renderer/ide/MethodHierarchyView.js";
import { OutlineView } from "../renderer/ide/OutlineView.js";
import { Problems } from "../renderer/ide/Problems.js";
import { RecentLocations } from "../renderer/ide/RecentLocations.js";
import { RunToolbar } from "../renderer/ide/RunToolbar.js";
import { SearchPanel } from "../renderer/ide/SearchPanel.js";
import { TerminalPanel } from "../renderer/ide/TerminalPanel.js";
import { TodoView } from "../renderer/ide/TodoView.js";
import { TypeHierarchyView } from "../renderer/ide/TypeHierarchyView.js";
import { AgentPane } from "../renderer/ide/ai/AgentPane.js";
import { DatabasePanel } from "../renderer/ide/db/DatabasePanel.js";
import { SystemHealthPanel } from "../renderer/ide/health/SystemHealthPanel.js";
import { deriveSystemHealthView } from "../renderer/ide/health/health-panel-view.js";
import { ProfilePanel } from "../renderer/ide/profile/ProfilePanel.js";
import { byMnemonic, useBookmarksStore } from "../renderer/ide/state/bookmarks.js";
import { useCodeIndexStore } from "../renderer/ide/state/code-index-store.js";
import {
  type IndexedSymbol,
  advance,
  buildIndex,
  buildWordIndex,
  mergeRepoMap,
  startIndexing,
} from "../renderer/ide/state/code-index.js";
import type { Diagnostic } from "../renderer/ide/state/diagnostics.js";
import { isEditorActionId } from "../renderer/ide/state/editor-commands.js";
import { useEditorVisionStore } from "../renderer/ide/state/editor-vision-store.js";
import { drainGateUris, hasPendingGateUris } from "../renderer/ide/state/gate-queue.js";
import { GENERATE_TRANSFORM_BY_ID } from "../renderer/ide/state/generate-actions.js";
import { useInlineBlameStore } from "../renderer/ide/state/inline-blame-store.js";
import { detectLanguage, hasKnownLsp } from "../renderer/ide/state/lang-detect.js";
import { type NormalizedSymbol, normalizeSymbols } from "../renderer/ide/state/lsp-convert.js";
import { type NavLoc, useNavStore } from "../renderer/ide/state/nav-history.js";
import {
  type RunConfig,
  type RunPickerRow,
  parseLaunchJson,
} from "../renderer/ide/state/run-config.js";
import { useRunSessionStore } from "../renderer/ide/state/run-session-store.js";
import { useDiagnosticsStore, useTabsStore } from "../renderer/ide/state/stores.js";
import { TestExplorer } from "../renderer/ide/test/TestExplorer.js";
import { BottomPanel, type BottomTab as ShellBottomTab } from "../renderer/shell/BottomPanel.js";
import { ResizeHandle, useResizable } from "../renderer/shell/Resizable.js";
import { useEngineStore } from "../renderer/stores/engine.js";
import { terminalCwd } from "./no-folder-guard.js";
import { requestRouteTab } from "./route-tabs.js";

type Activity =
  | "explorer"
  | "search"
  | "git"
  | "debug"
  | "test"
  | "todo"
  | "outline"
  | "callhierarchy"
  | "typehierarchy"
  | "methodhierarchy"
  | "blame"
  | "coverage";
type BottomTab = "terminal" | "claude" | "problems" | "health" | "database" | "profiler";
// APP-021: the fused Search Everywhere popup. The 4 legacy strings still open it (on the
// equivalent tab via `tabForMode`); "all" is the double-Shift entry point.
type Palette =
  | "none"
  | "run"
  | "commands"
  | "files"
  | "symbols"
  | "structure"
  | "all"
  | "text"
  | "git";

// The tool-panel list moved to `@prometheus/ui` (shell/subpanels.ts) when the route's own icon
// strip was fused into the shell rail's lower half. It lives there because the SHELL renders it
// now, and because a list the route kept privately could not be shown by the component that
// paints it. `Activity` (the id union) stays here: it is what this route switches its body on.

// APP-072: the editor's bottom-panel tab subset (shell BottomTab ids) — passed to the shared
// BottomPanel `tabs` prop so it reuses the canonical tabStyle + badge/collapse/maximize chrome.
// handoff §2.4 names four: Terminal · ✳ Claude Code · Problems · Health. Database and
// Profiler stay on the strip after them — this bottom panel is their ONLY entry point, and
// silently deleting a working surface is a bigger regression than a six-tab strip.
const EDITOR_BOTTOM_TABS: readonly { id: ShellBottomTab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "claude", label: "✳ Claude Code" },
  { id: "problems", label: "Problems" },
  { id: "health", label: "Health" },
  { id: "database", label: "Database" },
  { id: "profiler", label: "Profiler" },
];

/** The launcher-menu id the "✳ Claude Code" tab opens (TerminalPanel's FALLBACK_MENU). */
const CLAUDE_PRESET_ID = "ai.claude";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** Monotonic id for throwaway scratch buffers (unique `scratch:` uris this session). */
let scratchSeq = 0;

/** Flatten an LSP symbol tree → the code-index's flat IndexedSymbol[] (plan 39). */
function flattenToIndexed(syms: NormalizedSymbol[], uri: string, parent: string): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  for (const s of syms) {
    out.push({
      name: s.name || "?",
      kind: typeof s.kind === "number" ? s.kind : 0,
      uri,
      line: s.selectionRange.start.line,
      container: parent,
    });
    if (s.children.length > 0) {
      out.push(...flattenToIndexed(s.children, uri, parent ? `${parent}.${s.name}` : s.name));
    }
  }
  return out;
}

export function EditorRoute({
  onNavigate,
  onOpenShellPanel,
  treeOverlay = false,
  subPanel,
  onSubPanel,
}: {
  /** jump to another shell activity (Model Hub / Chat) — threaded to the AgentPane CTAs. */
  onNavigate?: (id: ActivityId) => void;
  /** open a SHELL bottom-panel tab (App owns that state) — the `panel.*` palette seam
   *  (APP-004). Editor→shell prop direction only; never re-dispatched on the window bus. */
  onOpenShellPanel?: (tab: ShellBottomTab) => void;
  /**
   * §2's second collapse step: on a narrow viewport the side panel FLOATS over the editor
   * instead of taking a column from it. The shell owns the breakpoint (shell/responsive.ts)
   * because it also owns the first step — traying the chat rail — and the two have to
   * happen in that order.
   */
  treeOverlay?: boolean;
  /**
   * Which tool panel is open — now owned by the SHELL, because the buttons that switch it
   * moved into the shell's activity rail (its lower half). Uncontrolled when omitted, so the
   * route still stands up on its own in tests and in isolation.
   */
  subPanel?: string;
  onSubPanel?: (id: string) => void;
} = {}): ReactElement {
  // Controlled-or-not, the standard pattern: the shell drives this in the app, and the route
  // keeps working with no props at all.
  const [ownActivity, setOwnActivity] = useState<Activity>("explorer");
  const activity = (subPanel ?? ownActivity) as Activity;
  const setActivity = useCallback(
    (a: Activity): void => {
      if (onSubPanel) onSubPanel(a);
      else setOwnActivity(a);
    },
    [onSubPanel],
  );
  const [bottom, setBottom] = useState<BottomTab>("terminal");
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [bottomMax, setBottomMax] = useState(false);
  // APP-072: live PROBLEMS badge — sum diagnostics across every open URI (a closed file's
  // contribution clears when the store drops its uri). 0 renders no badge (shell behavior).
  const problemsCount = useDiagnosticsStore((s) =>
    Object.values(s.byUri).reduce((sum, list) => sum + list.length, 0),
  );
  const [palette, setPalette] = useState<Palette>("none");
  // Run toolbar (APP-034): the launch.json configs + the toolbar selection.
  const [runConfigs, setRunConfigs] = useState<RunConfig[]>([]);
  const [runCfgIdx, setRunCfgIdx] = useState(0);
  const [clipOpen, setClipOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  // APP-061: the Bookmarks window + the last known caret (for set-mnemonic on the caret line).
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const caretRef = useRef<{ uri: string; line: number } | null>(null);
  // APP-063: the Local History window.
  const [historyOpen, setHistoryOpen] = useState(false);
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const setWorkspaceRoot = useTabsStore((s) => s.setWorkspaceRoot);
  const openTab = useTabsStore((s) => s.open);
  const publishDiag = useDiagnosticsStore((s) => s.publish);
  const resetDiag = useDiagnosticsStore((s) => s.reset);
  // APP-073: null until a real folder is picked (or a persisted one is restored) — NO "." shim,
  // so nothing in the sidebar ever fs-lists the Electron process CWD.
  const root = workspaceRoot;
  // §2.4: the Health tab's body + its badge come from the SAME engine store the shell
  // reads — one health truth, two surfaces.
  const engineHealth = useEngineStore((st) => st.health);
  const enginePill = useEngineStore((st) => st.pill);
  const refreshEngineHealth = useEngineStore((st) => st.refreshHealth);
  const healthIssueCount = deriveSystemHealthView(engineHealth, enginePill).components.filter(
    (c) => c.status !== "ok",
  ).length;

  // drag-resizable workbench panes (was hardcoded 260 / 320 / flex-only split).
  const sidePane = useResizable({
    axis: "x",
    initial: 200,
    min: 200,
    max: () => Math.max(200, Math.round(window.innerWidth * 0.5)),
    storageKey: "prometheus.layout.editor.sideWidth",
  });
  // APP-072: the bottom panel now owns its own resize (shell BottomPanel's useResizable) —
  // the editor no longer keeps a bespoke bottomPane.

  // navigation history (plan 05): jump to a recorded location — open its file + reveal,
  // guarding the recorder so the reveal's own caret echo isn't re-recorded as a new nav.
  const navigatingRef = useRef(false);
  /** uris found dead (closed→deleted) during a Back/Forward walk — memoized so the reducer
   *  skips them synchronously on the next traversal (APP-022 dead-entry skip). */
  const deadUrisRef = useRef<Set<string>>(new Set());
  const navigateTo = useCallback(
    (loc: NavLoc | null): void => {
      if (!loc) return;
      navigatingRef.current = true;
      // try/finally so a throw in openTab can NEVER leave the recorder suppressed forever
      // (the GOTCHA "dead-freeze": one failed open would freeze recording otherwise).
      try {
        openTab(loc.uri, {
          name: loc.uri.split("/").pop() ?? loc.uri,
          languageId: detectLanguage(loc.uri),
          preview: true,
        });
      } finally {
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("ide:reveal-position", {
              detail: { line: loc.line, column: loc.column },
            }),
          );
          setTimeout(() => {
            navigatingRef.current = false;
          }, 120);
        }, 160);
      }
    },
    [openTab],
  );

  /**
   * Walk Back/Forward past DEAD entries (files closed then deleted). The reducer skips any
   * already-known-dead uri synchronously; for a not-currently-open file:// target we probe
   * the path-guarded fs read once (an open tab is definitely alive → no probe, no latency),
   * marking a missing file dead + pruning it so it never resurfaces.
   */
  const stepNav = useCallback(
    async (dir: "back" | "forward"): Promise<void> => {
      const alive = (uri: string): boolean => !deadUrisRef.current.has(uri);
      const isOpen = (uri: string): boolean =>
        useTabsStore.getState().tabs.docs.some((d) => d.uri === uri);
      const before = deadUrisRef.current.size;
      let target: NavLoc | null = null;
      for (;;) {
        const store = useNavStore.getState();
        const loc = dir === "back" ? store.goBack(alive) : store.goForward(alive);
        if (!loc) break;
        if (isOpen(loc.uri) || !loc.uri.startsWith("file://")) {
          target = loc;
          break;
        }
        const r = await ide()
          ?.fsRead(loc.uri)
          .catch(() => undefined);
        if (r?.ok) {
          target = loc;
          break;
        }
        deadUrisRef.current.add(loc.uri); // deleted → skip on this + every future traversal
      }
      if (deadUrisRef.current.size !== before) useNavStore.getState().prune(alive);
      if (target) navigateTo(target);
    },
    [navigateTo],
  );

  // rebuild the local code index (plan 39) from the OPEN files' symbols — a bounded,
  // safe pass (no full-repo fs walk) that powers the offline Search-Everywhere fallback.
  const rebuildIndex = useCallback(async (): Promise<void> => {
    const api = ide();
    const wsRoot = workspaceRoot ?? root;
    if (!api || !wsRoot) return;
    const docs = useTabsStore
      .getState()
      .tabs.docs.filter((d) => hasKnownLsp(d.languageId) && !d.uri.startsWith("scratch:"));
    const store = useCodeIndexStore.getState();
    store.setStatus(startIndexing(docs.length));
    const entries: { uri: string; symbols: IndexedSymbol[] }[] = [];
    for (const d of docs) {
      let symbols: IndexedSymbol[] = [];
      const ens = await api.lspEnsure(d.languageId ?? "", wsRoot).catch(() => undefined);
      if (ens?.ok && ens.serverId) {
        const r = await api
          .lspRequest(ens.serverId, wsRoot, "textDocument/documentSymbol", {
            textDocument: { uri: d.uri },
          })
          .catch(() => undefined);
        if (r?.ok) symbols = flattenToIndexed(normalizeSymbols(r.result), d.uri, "");
      }
      entries.push({ uri: d.uri, symbols });
      store.setStatus(advance(useCodeIndexStore.getState().status));
    }
    store.setIndex(buildIndex(entries));
  }, [workspaceRoot, root]);

  // APP-065: build the WHOLE-repo index — fsWalk the root, read files in bounded-concurrency
  // batches (yielding so the renderer paints), build the repo-wide WORD index, and merge the
  // repo-map symbols (APP-053, LSP-free) so Search-Everywhere sees UNopened files too.
  const buildFullIndex = useCallback(async (): Promise<void> => {
    const api = ide();
    const wsRoot = workspaceRoot ?? root;
    if (!api?.fsWalk || !wsRoot) return;
    const walk = await api.fsWalk(wsRoot).catch(() => undefined);
    if (!walk?.ok || !walk.files || walk.files.length === 0) return;
    const files = walk.files;
    const store = useCodeIndexStore.getState();
    store.setStatus(startIndexing(files.length));
    // read on-disk content; a dirty tab's newer text folds in when it saves (fs.change → upsert).
    const entries: { uri: string; text: string }[] = [];
    let cursor = 0;
    const CONCURRENCY = 8;
    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const i = cursor++;
        const p = files[i];
        if (!p) break;
        const uri = `file://${p}`;
        const r = await api.fsRead(uri).catch(() => undefined);
        if (r?.ok && typeof r.text === "string") entries.push({ uri, text: r.text });
        store.setStatus(advance(useCodeIndexStore.getState().status));
        if (i % 64 === 0) await new Promise((res) => setTimeout(res, 0)); // yield to paint
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    store.setWords(buildWordIndex(entries));
    // repo-wide SYMBOLS via the tree-sitter/stdlib repo-map sidecar (APP-053).
    const map = await api.repoMap?.build({ root: wsRoot, budget: 20_000 }).catch(() => undefined);
    if (map?.ok && map.files) {
      store.setIndex(
        mergeRepoMap(
          useCodeIndexStore.getState().index,
          { files: map.files },
          (rel) => `file://${wsRoot}/${rel}`,
        ),
      );
    }
  }, [workspaceRoot, root]);

  // full-repo index on workspace bind; incremental word updates on the debounced fs.change feed.
  useEffect(() => {
    void buildFullIndex();
  }, [buildFullIndex]);
  useEffect(() => {
    const api = ide();
    if (!api) return;
    return api.onEvent((ev) => {
      if (ev.channel !== "fs.change" || !Array.isArray(ev.paths)) return;
      const store = useCodeIndexStore.getState();
      for (const p of ev.paths as string[]) {
        const uri = p.startsWith("file://") ? p : `file://${p}`;
        void api
          .fsRead(uri)
          .then((r) => {
            if (r?.ok && typeof r.text === "string") store.upsertWords(uri, r.text);
            else store.dropFile(uri); // unreadable → treat as deleted
          })
          .catch(() => store.dropFile(uri)); // ENOENT (deleted/renamed) → drop it
      }
    });
  }, []);

  // record every genuine caret jump (the reducer coalesces nearby same-file moves).
  useEffect(() => {
    const onCursor = (e: Event): void => {
      const d = (e as CustomEvent<{ uri?: string; line?: number; column?: number }>).detail;
      if (!d || typeof d.uri !== "string" || typeof d.line !== "number") return;
      caretRef.current = { uri: d.uri, line: d.line }; // APP-061: track the caret always
      if (navigatingRef.current) return;
      useNavStore.getState().record({ uri: d.uri, line: d.line, column: d.column ?? 1 });
    };
    window.addEventListener("ide:cursor-position", onCursor);
    return () => window.removeEventListener("ide:cursor-position", onCursor);
  }, []);

  // APP-023: Find Usages populates useUsagesStore + fires this — surface the SearchPanel
  // (which renders the usages tree in its usages mode) so the tool window is visible.
  useEffect(() => {
    const onOpenUsages = (): void => setActivity("search");
    window.addEventListener("ide:open-usages", onOpenUsages);
    return () => window.removeEventListener("ide:open-usages", onOpenUsages);
  }, []);

  // APP-073: no auto-seed — workspaceRoot stays null until the user opens a folder (or a
  // persisted root is restored). The explorer shows the Open-Folder prompt meanwhile.

  // APP-075: go-to-super / related-symbol pick a target in EditorPane, then jump here so the
  // open+reveal rides the SAME nav-history-recording path as every other navigation.
  useEffect(() => {
    const onNavLoc = (e: Event): void => {
      const d = (e as CustomEvent<{ uri?: string; line?: number; column?: number }>).detail;
      if (!d || typeof d.uri !== "string" || typeof d.line !== "number") return;
      navigateTo({ uri: d.uri, line: d.line, column: d.column ?? 1 });
    };
    window.addEventListener("ide:navigate-location", onNavLoc);
    return () => window.removeEventListener("ide:navigate-location", onNavLoc);
  }, [navigateTo]);

  // APP-061: point the bookmarks store at the active workspace root so it loads THAT
  // project's persisted bookmarks (opening a different folder shows different bookmarks).
  useEffect(() => {
    useBookmarksStore.getState().setRoot(root ?? "");
  }, [root]);

  // APP-063: bind Local History to the active workspace so captures target it + its
  // persisted timeline loads (a different folder shows a different history). No folder → skip.
  useEffect(() => {
    if (root) void window.prometheus?.ide?.history?.bind(root);
  }, [root]);

  // drop diagnostics from the previous workspace when the root changes (else stale
  // problems from another project linger).
  useEffect(() => {
    return () => resetDiag();
  }, [root, resetDiag]);

  // subscribe to the multiplexed host feed → route LSP diagnostics to the store.
  // RETRY if the bridge isn't injected yet on the first run (boot race) — otherwise the
  // subscription is never made for the whole session and diagnostics never appear.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const attach = (): void => {
      const api = ide();
      if (!api) {
        retry = setTimeout(attach, 200);
        return;
      }
      unsub = api.onEvent((ev) => {
        if (ev.channel === "lsp.diagnostics") {
          publishDiag(ev.uri, ev.diagnostics as Diagnostic[]);
        } else if (ev.channel === "lsp.applyEdit") {
          // APP-078: hand the server→client edit to EditorPane (it owns Monaco + the applier).
          window.dispatchEvent(new CustomEvent("ide:apply-workspace-edit", { detail: ev }));
        }
      });
    };
    attach();
    return () => {
      if (retry) clearTimeout(retry);
      unsub?.();
    };
  }, [publishDiag]);

  // AI-authored NEW files are untrusted-until-gated (§5.2). DiffReview enqueues the
  // written uris in the gate-queue AND dispatches `ide:gate-new-files`; this route
  // owns the ONLY listener, so on mount it also DRAINS anything queued while it was
  // unmounted (DiffReview lives in the shell AgentPane too — a drop here would let a
  // gated file slip through un-gated). Run the workspace gate and surface it in the
  // Run & Debug panel where the verdict is shown.
  useEffect(() => {
    const runGate = (): void => {
      if (!root) return; // no workspace → nothing to gate
      setActivity("debug");
      void ide()?.gate({ workspaceRoot: root });
    };
    if (hasPendingGateUris() && drainGateUris().length > 0) runGate();
    const onGateNew = (e: Event): void => {
      const uris = (e as CustomEvent<string[]>).detail;
      drainGateUris(); // same batch as the event — consume so a remount can't re-fire
      if (!Array.isArray(uris) || uris.length === 0) return;
      runGate();
    };
    window.addEventListener("ide:gate-new-files", onGateNew);
    return () => window.removeEventListener("ide:gate-new-files", onGateNew);
  }, [root]);

  // load launch.json configs for the Run toolbar + the ⌘⇧R picker (one PURE parser).
  useEffect(() => {
    let alive = true;
    setRunConfigs([]);
    setRunCfgIdx(0);
    void (async () => {
      const api = window.prometheus?.ide;
      if (!api || !root) return;
      const found: RunConfig[] = [];
      for (const rel of [".vscode/launch.json", ".prometheus/launch.json"]) {
        const r = await api.fsRead(`file://${root}/${rel}`).catch(() => undefined);
        if (r?.ok && typeof r.text === "string") found.push(...parseLaunchJson(r.text));
      }
      if (alive) setRunConfigs(found);
      await useRunSessionStore.getState().loadTasks(root); // before-launch tasks (APP-035)
    })();
    return () => {
      alive = false;
    };
  }, [root]);

  /** Dispatch a run-picker row (named config OR freeform argv) through the ONE
   *  gated engine path (APP-032; the store owns the session). */
  const dispatchRunPick = useCallback(
    (row: RunPickerRow): void => {
      if (!root) return;
      setActivity("debug"); // the Run output lives in the Run&Debug panel
      if (row.kind === "freeform") {
        void useRunSessionStore.getState().startArgv(row.argv, root);
      } else {
        // startByName runs before-launch tasks + compound members, one gated path (APP-035).
        void useRunSessionStore.getState().startByName(row.label, runConfigs, root);
      }
    },
    [root, runConfigs],
  );

  // global keybinds: Cmd/Ctrl-Shift-P (commands), Cmd/Ctrl-P (quick-open), double-⇧ (all).
  useEffect(() => {
    // JetBrains "Search Everywhere" = a double-tap of Shift (two lone Shift keydowns within
    // ~350ms, nothing between) → open the fused popup on the All tab (APP-021).
    let lastShift = 0;
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Shift" && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const now = e.timeStamp;
        if (now - lastShift < 350) {
          lastShift = 0;
          setPalette("all");
        } else {
          lastShift = now;
        }
        return;
      }
      // any other key breaks a pending double-Shift.
      if (e.key !== "Shift") lastShift = 0;
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPalette("commands");
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPalette("files");
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "t") {
        // Go to Symbol in Workspace (VS Code ⌘T / JetBrains double-⇧ analog).
        e.preventDefault();
        setPalette("symbols");
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
        // Go to Symbol in Editor (VS Code ⌘⇧O): speed-search the ACTIVE file's symbols.
        // ⌘F12 now opens the richer File Structure popup (APP-097), bound in EditorPane on the
        // FOCUSED editor via a Monaco command so it can't double-fire with this shell handler.
        e.preventDefault();
        setPalette("structure");
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "v") {
        // Paste from History (JetBrains ⌘⇧V · VS Code clipboard-ring).
        e.preventDefault();
        setClipOpen(true);
      } else if (mod && e.altKey && e.key === "ArrowLeft") {
        // Navigate Back (JetBrains ⌘[ · VS Code Alt+←) — ⌥⌘←/Ctrl+Alt+← (conflict-free).
        e.preventDefault();
        void stepNav("back");
      } else if (mod && e.altKey && e.key === "ArrowRight") {
        // Navigate Forward (JetBrains ⌘] · VS Code Alt+→).
        e.preventDefault();
        void stepNav("forward");
      } else if (mod && e.shiftKey && (e.key === "Backspace" || e.key === "Delete")) {
        // Last Edit Location (JetBrains ⌘⇧⌫).
        e.preventDefault();
        navigateTo(useNavStore.getState().lastEdit);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "r") {
        // Run Anything (APP-034) — ⌘⇧R, deliberately NOT ⌘⇧B (claimed by the
        // Run-Build-Task default in tasks-config.ts).
        e.preventDefault();
        setPalette("run");
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "e") {
        // Recent Locations (JetBrains ⌘⇧E).
        e.preventDefault();
        setRecentOpen(true);
      } else if (mod && e.shiftKey && /^[0-9]$/.test(e.key)) {
        // APP-061: set numbered mnemonic N on the caret line (⌘/Ctrl-Shift-<digit>).
        e.preventDefault();
        const caret = caretRef.current;
        if (caret) useBookmarksStore.getState().setMnemonic(caret.uri, caret.line, Number(e.key));
      } else if (mod && !e.shiftKey && !e.altKey && /^[0-9]$/.test(e.key)) {
        // APP-061: jump to mnemonic N's file+line (⌘/Ctrl-<digit>), opening the tab if closed.
        e.preventDefault();
        const target = byMnemonic(useBookmarksStore.getState().state, Number(e.key));
        if (target) navigateTo({ uri: target.uri, line: target.line, column: 1 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigateTo, stepNav]);

  // Open a real project folder (workspaceRoot was hardcoded to "." → the explorer, git
  // panel, and run-gate all scoped the process CWD, not the user's project).
  const onOpenFolder = async (): Promise<void> => {
    const r = await window.prometheus?.folderOpen?.({ title: "Open project folder" });
    if (r?.ok && r.path) setWorkspaceRoot(r.path);
  };

  // Open ANY file from anywhere (PyCharm-style File ▸ Open) — the native picker returns
  // an absolute path; open it as a pinned tab even if it lives outside the workspace.
  const onOpenFile = async (): Promise<void> => {
    const r = await window.prometheus?.fileOpen?.({ title: "Open file" });
    if (!r?.ok || !r.path) return;
    const uri = r.path.startsWith("file://") ? r.path : `file://${r.path}`;
    const name =
      r.path
        .replace(/[/\\]+$/, "")
        .split(/[/\\]/)
        .pop() ?? r.path;
    openTab(uri, { name, languageId: detectLanguage(r.path), preview: false });
  };

  // ⌘O / Ctrl-O → the native open-file picker (PyCharm/VS Code parity).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void onOpenFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Dispatch a palette command id (maps the always-present surface to the shell). */
  const runCommand = useCallback(
    (id: string): void => {
      // any Monaco editor-action id routes to the focused editor (EditorPane runs it).
      if (isEditorActionId(id)) {
        window.dispatchEvent(new CustomEvent("ide:editor-action", { detail: id }));
        return;
      }
      switch (id) {
        case "search.findInFiles":
          setActivity("search");
          break;
        // APP-097: File Structure popup — EditorPane's FileStructureHost listens and opens it
        // over the focused editor (the ⌘F12 chord is bound there directly).
        case "structure.filePopup":
          window.dispatchEvent(new CustomEvent("ide:file-structure"));
          break;
        // APP-098: documentation surfaces — EditorPane hosts/listeners act on the focused editor.
        case "docs.quickDoc":
          window.dispatchEvent(new CustomEvent("ide:quick-doc"));
          break;
        case "docs.generateStub":
          window.dispatchEvent(new CustomEvent("ide:generate-docstring"));
          break;
        case "docs.readerMode":
          window.dispatchEvent(new CustomEvent("ide:toggle-reader-mode"));
          break;
        case "git.commit":
          setActivity("git");
          break;
        // Task #5 (desktop parity): the Worktrees section lives inside GitPanel — open the
        // Git activity, then tell it to reveal the section (it may already be hidden).
        case "git.worktrees":
          setActivity("git");
          window.dispatchEvent(new CustomEvent("ide:open-worktrees"));
          break;
        case "debug.start":
          setActivity("debug");
          break;
        // APP-074: the 3 reading-aid toggles (persisted; the Monaco providers read the live value).
        case "editor.vision.toggleFolding":
          useEditorVisionStore.getState().toggle("folding");
          break;
        case "editor.vision.toggleInlayHints":
          useEditorVisionStore.getState().toggle("inlayHints");
          break;
        case "editor.vision.toggleCodeVision":
          useEditorVisionStore.getState().toggle("codeVision");
          break;
        // APP-083: inline blame opt-in (EditorPane re-fetches/clears on the fire event).
        case "git.toggleInlineBlame":
          useInlineBlameStore.getState().toggle();
          break;
        // APP-075 — Go-to family. Go-to-line = Monaco's built-in widget via the editor bridge;
        // super/related are LSP-at-caret flows EditorPane runs (it owns the Monaco instance).
        case "nav.goToLine":
          window.dispatchEvent(
            new CustomEvent("ide:editor-action", { detail: "editor.action.gotoLine" }),
          );
          break;
        case "nav.goToSuper":
          window.dispatchEvent(new CustomEvent("ide:go-to-super"));
          break;
        case "nav.relatedSymbol":
          window.dispatchEvent(new CustomEvent("ide:related-symbol"));
          break;
        case "gate.runWorkspaceScan":
        case "gate.showLog":
        case "prometheus.scan":
        case "prometheus.audit":
          setActivity("debug");
          break;
        case "editor.newScratchFile": {
          // a throwaway in-memory buffer (no project folder needed); EditorPane handles
          // the `scratch:` scheme with an empty editable model + no fs read/write.
          scratchSeq += 1;
          const name = `scratch-${scratchSeq}.txt`;
          openTab(`scratch:/${name}`, { name, languageId: "plaintext", preview: false });
          break;
        }
        case "ai.inlineEdit":
          // open the Cmd-K inline-edit overlay (also bound to the keydown below).
          window.dispatchEvent(new CustomEvent("ide:inline-edit"));
          break;
        // smart keys + column mode + paste-history (APP-018): the focused EditorPane
        // group handles these window events (same bus as ide:editor-action).
        case "editor.completeStatement":
          window.dispatchEvent(new CustomEvent("ide:complete-statement"));
          break;
        case "editor.smartEnter":
          window.dispatchEvent(new CustomEvent("ide:smart-enter"));
          break;
        case "editor.toggleColumnSelection":
          window.dispatchEvent(new CustomEvent("ide:toggle-column-selection"));
          break;
        case "editor.pasteFromHistory":
          setClipOpen(true);
          break;
        case "editor.organizeImports":
          window.dispatchEvent(new CustomEvent("ide:organize-imports"));
          break;
        case "editor.surroundWith":
          // wrap the focused editor's selection with a surround template (APP-020); the
          // EditorPane group handles it (SnippetController2 + ${TM_SELECTED_TEXT}).
          window.dispatchEvent(new CustomEvent("ide:surround-with"));
          break;
        case "usages.findUsages":
          // fan LSP references + grep fallback on the caret symbol (APP-023); the focused
          // EditorPane group runs it + opens the usages tool window.
          window.dispatchEvent(new CustomEvent("ide:find-usages"));
          break;
        // Refactor Preview (APP-027): the focused EditorPane group captures its
        // caret/selection context and opens the gated preview dialog. The id suffix
        // IS the preload transform method name (refactor.<t> ↔ ide.refactor.<t>).
        case "refactor.rename":
        case "refactor.extract":
        case "refactor.inline":
        case "refactor.move":
        case "refactor.changeSignature":
        case "refactor.safeDelete":
          window.dispatchEvent(
            new CustomEvent("ide:refactor", {
              detail: { transform: id.slice("refactor.".length) },
            }),
          );
          break;
        // Generate menu (APP-028): same bus, transform resolved from the pure
        // generate-actions table (generate.init → genInit, …, generate.copyright →
        // copyrightHeader); the focused EditorPane opens the gated preview.
        case "generate.init":
        case "generate.repr":
        case "generate.eq":
        case "generate.dataclass":
        case "generate.property":
        case "generate.override":
        case "generate.delegate":
        case "generate.docstring":
        case "generate.newFile":
        case "generate.copyright":
          window.dispatchEvent(
            new CustomEvent("ide:refactor", {
              detail: { transform: GENERATE_TRANSFORM_BY_ID[id] },
            }),
          );
          break;
        // Run toolbar surface (APP-034) — ids namespaced run.* (the prometheus CLI
        // reserves plain `run`).
        case "run.config": {
          const cfg = runConfigs[runCfgIdx];
          if (cfg && root) {
            setActivity("debug");
            void useRunSessionStore.getState().startByName(cfg.name, runConfigs, root);
          }
          break;
        }
        case "run.debug":
          setActivity("debug");
          setTimeout(() => window.dispatchEvent(new CustomEvent("ide:debug-start")), 120);
          break;
        case "run.stop":
          if (useRunSessionStore.getState().runId) void useRunSessionStore.getState().kill();
          if (useRunSessionStore.getState().dapSessionId) {
            window.dispatchEvent(new CustomEvent("ide:debug-stop"));
          }
          break;
        case "run.anything":
          setPalette("run");
          break;
        case "nav.back":
          void stepNav("back");
          break;
        case "nav.forward":
          void stepNav("forward");
          break;
        case "nav.lastEdit":
          navigateTo(useNavStore.getState().lastEdit);
          break;
        case "nav.recent":
          setRecentOpen(true);
          break;
        case "bookmarks.show":
          setBookmarksOpen(true);
          break;
        case "history.show":
          setHistoryOpen(true);
          break;
        case "index.rebuild":
          void rebuildIndex();
          break;
        // SHELL bottom-panel openers (APP-004): handled LOCALLY via the prop seam —
        // never re-dispatched on the window bus (shell→editor is the only bus direction).
        case "panel.tokens":
          onOpenShellPanel?.("tokens");
          break;
        case "panel.health":
          onOpenShellPanel?.("health");
          break;
        case "panel.metadata":
          onOpenShellPanel?.("metadata");
          break;
        // Pickers are later program files — scope here is routing to the REAL owning
        // surface (APP-004): the Environments route lists interpreters (EnvPicker),
        // the Model Hub owns endpoints/serving. Navigation, not silence.
        case "python.selectInterpreter":
          (() => {
            requestRouteTab("workspace", "environments");
            onNavigate?.("workspace");
          })();
          break;
        case "models.selectEndpoint":
          onNavigate?.("models");
          break;
        default:
          // every PALETTE_COMMANDS id must have a case above (pinned by
          // state/palette-commands.test.ts) — reaching here means a future entry
          // shipped without a dispatcher; fail loudly instead of dying silently.
          console.warn(`[editor] palette command with no dispatcher case: ${id}`);
          break;
      }
    },
    [
      openTab,
      navigateTo,
      stepNav,
      rebuildIndex,
      onNavigate,
      onOpenShellPanel,
      root,
      runConfigs,
      runCfgIdx,
    ],
  );

  // The shell palette / global keybindings dispatch editor-scoped commands here via the
  // `ide:run-command` bus (leap #1) — the editor route is the only surface that can run
  // them (its internal activity + Monaco), so the shell navigates to it and re-dispatches.
  useEffect(() => {
    const onRun = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === "string") runCommand(id);
    };
    window.addEventListener("ide:run-command", onRun);
    return () => window.removeEventListener("ide:run-command", onRun);
  }, [runCommand]);

  return (
    // handoff §2/§2.4: 8px-gapped ISLANDS on the inset ground — no full-bleed panels,
    // no shared hairlines. The agent rail is NOT here: it is the shell's global
    // RightRail (§2.5), so the editor never mounts a second AgentPane.
    <div
      style={{
        display: "flex",
        height: "100%",
        minHeight: 0,
        gap: 8,
        // the containing block for §2-j's overlaid file tree; harmless when inline
        position: "relative",
      }}
    >
      {/* The editor's own icon strip USED to be here — a second vertical rail sitting
          immediately right of the shell's, identical in size and styling, meaning something
          completely different. It now renders as the LOWER HALF of the shell's one rail
          (renderer/shell/ActivityBar.tsx), driven by `subPanel`/`onSubPanel` above. */}

      {/* primary side panel — in-flow, or floated over the editor on a narrow window (§2) */}
      <aside
        style={{
          position: treeOverlay ? "absolute" : "relative",
          width: sidePane.size,
          flexShrink: 0,
          // The aside cannot shrink and <main> is `flex: 1` (basis 0%), so at a narrow
          // window the tree kept its full dragged width and Monaco was squeezed to 0px.
          // A percentage cap clamps the aside's hypothetical size so the remainder still
          // flows to main; it is inert at any normal window width.
          maxWidth: "55%",
          borderRadius: "var(--radius-island)",
          border: "1px solid var(--border-subtle)",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-surface)",
          overflow: "hidden",
          ...(treeOverlay
            ? {
                // It floats over the editor rather than out of the window; the shadow is what
                // makes it read as ABOVE the content instead of a column that lost its border.
                //
                // `left: 0`, not 52: the 52px cleared the editor's OWN icon nav, which no longer
                // exists (editor-rail.test.ts now asserts the route must never re-grow one). The
                // positioning context is the route root, so the offset had become a dead band of
                // editor showing to the left of the floating tree.
                left: 0,
                top: 0,
                bottom: 0,
                zIndex: Z.dropdown,
                boxShadow: elevation.e2,
              }
            : {}),
        }}
      >
        <ResizeHandle axis="x" edge="right" rz={sidePane} label="Resize side panel" min={200} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "9px 12px",
            borderBottom: "1px solid var(--border-header)",
          }}
        >
          <button
            type="button"
            onClick={() => void onOpenFile()}
            title="Open any file (⌘O)"
            style={{
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              color: "var(--text-primary)",
              cursor: "pointer",
              fontSize: "var(--text-small-size)",
              padding: "3px 8px",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              // A button is its LABEL. Without these two it was a shrinkable flex item next to a
              // sibling that would not shrink, so the row balanced itself by squeezing the
              // buttons until "Open Folder" wrapped onto two lines INSIDE its own border.
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            <ActivityIcon name="FileText" size={13} /> Open File
          </button>
          <button
            type="button"
            onClick={() => void onOpenFolder()}
            title="Open a project folder"
            style={{
              background: "transparent",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              color: "var(--text-primary)",
              cursor: "pointer",
              fontSize: "var(--text-small-size)",
              padding: "3px 8px",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              // A button is its LABEL. Without these two it was a shrinkable flex item next to a
              // sibling that would not shrink, so the row balanced itself by squeezing the
              // buttons until "Open Folder" wrapped onto two lines INSIDE its own border.
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            <ActivityIcon name="FolderOpen" size={13} /> Open Folder
          </button>
          <span
            title={root ?? undefined}
            style={{
              fontSize: "var(--text-small-size)",
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              // THE flexbox trap. `overflow:hidden` + `text-overflow:ellipsis` do nothing on a
              // flex item until it is allowed to shrink: a flex item's floor is its min-content
              // width, so this span held the row open at the full folder name and pushed the
              // cost onto its siblings. `minWidth: 0` is what makes the ellipsis reachable.
              minWidth: 0,
              flex: "1 1 auto",
            }}
          >
            {root === null
              ? "(no folder open)"
              : (root.replace(/\/$/, "").split("/").pop() ?? root)}
          </span>
        </div>
        {/* APP-073: no folder open → an explicit Open-Folder prompt (NOT a "." tree that leaks
            the Electron process CWD). Guarding here keeps EVERY sidebar view + its fs IPC from
            ever firing with a null/"." root. `root` narrows to string inside the else branch. */}
        {root === null ? (
          <EmptyState
            title="No folder open"
            hint="Open a project folder to browse files, search, use source control, and run."
            actionLabel="Open Folder"
            onAction={() => void onOpenFolder()}
          />
        ) : (
          <>
            {activity === "explorer" && <FileTree root={root} />}
            {activity === "search" && <SearchPanel root={root} />}
            {activity === "git" && <GitPanel root={root} />}
            {activity === "debug" && <DebugPanel />}
            {activity === "test" && <TestExplorer root={root} />}
            {activity === "todo" && <TodoView root={root} />}
            {activity === "outline" && <OutlineView root={root} />}
            {activity === "callhierarchy" && <CallHierarchyView root={root} />}
            {activity === "typehierarchy" && <TypeHierarchyView root={root} />}
            {activity === "methodhierarchy" && <MethodHierarchyView root={root} />}
            {activity === "blame" && <BlameView root={root} />}
            {activity === "coverage" && <CoverageView root={root} />}
          </>
        )}
      </aside>

      {/* center: editor + bottom panel */}
      {/* minHeight:0 + overflow:hidden: without a height floor a flex column child refuses
          to go below its content height, so maximizing the bottom panel pushed the column
          past the window instead of taking room from the editor above it. */}
      <main
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <RunToolbar
          configs={runConfigs}
          selectedIdx={runCfgIdx}
          onSelect={setRunCfgIdx}
          workspaceRoot={root || null}
          onShowDebugPanel={() => setActivity("debug")}
        />
        {/* the EDITOR island — its own ground (bg-inset), radius + border (§2.4). */}
        <div
          style={{
            flex: 1,
            // 0, not 80: an 80px floor here is what overflowed the column when the bottom
            // panel is maximized. The island already clips its own content.
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            borderRadius: "var(--radius-island)",
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-inset)",
            overflow: "hidden",
          }}
        >
          <EditorPane />
        </div>
        {/* APP-072: shell BottomPanel parity — badge counts, collapse, maximize, tabStyle.
            TerminalPanel stays MOUNTED (display toggle) across tab switches so the pty survives. */}
        <BottomPanel
          collapsed={bottomCollapsed}
          active={bottom}
          tabs={EDITOR_BOTTOM_TABS}
          counts={{ problems: problemsCount, health: healthIssueCount }}
          onSelect={(t) => {
            const tab = t as BottomTab;
            setBottom(tab);
            // opening the tab IS the launch action (TerminalPanel de-dupes repeats).
            if (tab === "claude")
              window.dispatchEvent(
                new CustomEvent("ide:terminal-preset", { detail: CLAUDE_PRESET_ID }),
              );
          }}
          onToggle={() => setBottomCollapsed((v) => !v)}
          maximized={bottomMax}
          onMaximize={setBottomMax}
        >
          {/* Terminal AND ✳ Claude Code share one mounted TerminalPanel — the Claude tab is
              a terminal SESSION running the CLI, so a second panel would fork the ptys. */}
          <div
            style={{
              display: bottom === "terminal" || bottom === "claude" ? "block" : "none",
              height: "100%",
            }}
          >
            <TerminalPanel cwd={terminalCwd(root)} />
          </div>
          {bottom === "problems" && <Problems />}
          {bottom === "health" && (
            <SystemHealthPanel
              view={deriveSystemHealthView(engineHealth, enginePill)}
              onRefresh={() => void refreshEngineHealth()}
            />
          )}
          {bottom === "database" && <DatabasePanel />}
          {bottom === "profiler" && <ProfilePanel />}
        </BottomPanel>
      </main>

      {/* NO agent aside here (handoff §2.5): the chat rail is GLOBAL — the shell's
          RightRail hosts the one AgentPane on every route, so the editor cannot mount a
          second one against the same session store. */}

      {palette !== "none" && (
        <CommandPalette
          mode={palette}
          root={root ?? ""}
          onRunCommand={runCommand}
          onClose={() => setPalette("none")}
          runConfigs={runConfigs}
          onRunPick={dispatchRunPick}
        />
      )}
      {clipOpen && <ClipboardHistory onClose={() => setClipOpen(false)} />}
      {recentOpen && root && <RecentLocations root={root} onClose={() => setRecentOpen(false)} />}
      {bookmarksOpen && (
        <BookmarksPanel
          onNavigate={(uri, line) => navigateTo({ uri, line, column: 1 })}
          onClose={() => setBookmarksOpen(false)}
        />
      )}
      {historyOpen &&
        root &&
        (() => {
          const target = caretRef.current?.uri ?? useTabsStore.getState().tabs.docs[0]?.uri ?? null;
          if (!target) return null;
          const name = target.split(/[/\\]/).pop() ?? target;
          return (
            <HistoryPanel
              root={root}
              uri={target}
              name={name}
              onReverted={(uri) => {
                // reload the tab from the reverted disk content (fs watcher also refreshes an
                // already-open buffer); a deleted-file recover opens the re-created file.
                openTab(uri, { name, languageId: detectLanguage(uri), preview: true });
                window.dispatchEvent(new CustomEvent("ide:reload-file", { detail: { uri } }));
              }}
              onClose={() => setHistoryOpen(false)}
            />
          );
        })()}
    </div>
  );
}

export default EditorRoute;
