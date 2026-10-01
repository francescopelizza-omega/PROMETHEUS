// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/TerminalPanel.tsx — the SPLIT-PANE multi-session integrated terminal (07 §6.1 + APP-049).
 *
 * N panes laid out row/column (shell/Resizable divider), each pane a tab strip over its
 * own keep-mounted <Terminal> instances (inactive hidden via display:none so pty +
 * scrollback survive switches). Splitting only ADDS a pane + a fresh session — existing
 * Terminals are NEVER re-keyed/remounted (a remount kills the live pty), so panes move by
 * changing the layout tree, not the Terminal's React key. The pane/session model is the
 * pure `terminal-session` reducer (node:test-ed); this is the thin view. Layout DESCRIPTORS
 * (titles/cwd/direction) persist to localStorage and restore with FRESH shells.
 *
 * Renderer-SANDBOXED (C5): react + the pure reducer + the Terminal view + the APP-048 menu IPC.
 */

import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Z, useAnchoredLayer } from "@prometheus/ui";
import type { IdeEvent, IdeTerminalEnv, IdeTerminalMenuItem } from "../../shared/ipc-contract.js";
import { ResizeHandle, useResizable } from "../shell/Resizable.js";
import { useTheme } from "../shell/ThemeProvider.js";
import { Terminal } from "./Terminal.js";
import { pickActiveVenv } from "./state/active-venv.js";
import { useGitStore } from "./state/stores.js";
import {
  type FloatingState,
  initialFloatingState,
  pickActive,
  redock,
  tearOut,
  visibleSessions,
} from "./state/terminal-floating.js";
import {
  type TerminalLayout,
  type TerminalPane,
  type TerminalSession,
  closePane,
  defaultTitle,
  deserializeLayout,
  focusPane,
  paneActivateSession,
  paneAddSession,
  paneCloseSession,
  paneRenameSession,
  serializeLayout,
  splitPane,
} from "./state/terminal-session.js";

/**
 * Fallback "+ ▾" menu when the core-backed IPC (ide.terminal.menu, APP-048) is absent —
 * so the "+" never dead-ends. The LIVE menu replaces this whenever the IPC answers.
 */
const FALLBACK_MENU: readonly IdeTerminalMenuItem[] = Object.freeze([
  { id: "shell.project", title: "Project shell", kind: "shell" },
  { id: "ai.prom-chat", title: "prometheus chat", kind: "ai-preset", detectBin: "prometheus" },
  {
    id: "ai.claude",
    title: "claude",
    kind: "ai-preset",
    detectBin: "claude",
    install: "npm i -g @anthropic-ai/claude-code",
  },
  {
    id: "ai.codex",
    title: "codex",
    kind: "ai-preset",
    detectBin: "codex",
    install: "npm i -g @openai/codex",
  },
  {
    id: "ai.gemini",
    title: "gemini",
    kind: "ai-preset",
    detectBin: "gemini",
    install: "npm i -g @google/gemini-cli",
  },
]);

const LAYOUT_KEY = "prometheus.ide.terminal.layout.v1";

/** Monotonic id source (module-level so re-mounts don't collide). */
let SEQ = 0;
function nextId(): string {
  SEQ += 1;
  return `term-${Date.now()}-${SEQ}`;
}
function nextPaneId(): string {
  SEQ += 1;
  return `pane-${Date.now()}-${SEQ}`;
}

/** Trim + cap a shell OSC title for the tab (keep the tail — usually cwd/command). */
function tabTitle(raw: string): string {
  const t = raw.trim();
  return t.length > 32 ? `…${t.slice(-31)}` : t;
}

type CreateOpts = {
  launch?: string;
  prime?: boolean;
  title?: string;
  cwd?: string;
  shell?: string;
  venv?: { root: string; platform?: "win32" | "posix" } | null;
};

export function TerminalPanel({ cwd }: { cwd: string }): ReactElement {
  const [layout, setLayout] = useState<TerminalLayout>(() =>
    deserializeLayout(
      typeof window !== "undefined" ? window.localStorage.getItem(LAYOUT_KEY) : null,
      nextId,
      cwd,
    ),
  );
  const countRef = useRef(0);
  const didInit = useRef(false);
  const manualTitles = useRef<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [openMenuPaneId, setOpenMenuPaneId] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<readonly IdeTerminalMenuItem[]>(FALLBACK_MENU);
  const envsRef = useRef<IdeTerminalEnv[]>([]);
  // APP-090: tear-out (dock/undock) view-state + each session's MAIN-spawned ptyId.
  const [floating, setFloating] = useState<FloatingState>(initialFloatingState);
  const [ptyIds, setPtyIds] = useState<Record<string, string>>({});
  const { activeSchemeId } = useTheme();

  // divider between the first pane and the rest (2-pane case). One stable hook.
  const splitRef = useRef<HTMLDivElement>(null);
  const rz = useResizable({
    axis: layout.direction === "row" ? "x" : "y",
    initial: 320,
    min: 140,
    // Without a ceiling the divider could be dragged until the SECOND pane had no width
    // left and its terminal sat off-screen with no way back. The bound is the SPLIT
    // CONTAINER, not the window: a bottom panel is ~212px tall and a row split shares the
    // width with the sidebar and the rail, so a window fraction left pane 2 no room at all.
    // It must bound the STATE, not only the CSS: a CSS max alone left the stored size above
    // what was painted, so the divider had a dead zone and aria-valuenow lied. The window
    // fraction still applies before the container has been laid out.
    max: () => {
      const row = layout.direction === "row";
      const winCap = (row ? window.innerWidth : window.innerHeight) * 0.6;
      const el = splitRef.current;
      const box = el ? (row ? el.clientWidth : el.clientHeight) : 0;
      return Math.max(140, box > 0 ? Math.min(box - 140, winCap) : winCap);
    },
    storageKey: "prometheus.ide.terminal.split-size.v1",
  });
  // …and re-clamp when the CONTAINER changes size (the panel is resized, the sidebar or rail
  // opens), which useResizable's window-resize listener cannot see.
  const rzRef = useRef(rz);
  rzRef.current = rz;
  const multiPane = layout.panes.length > 1;
  useEffect(() => {
    const el = splitRef.current;
    if (!multiPane || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => rzRef.current.setSize(rzRef.current.size));
    ro.observe(el);
    return () => ro.disconnect();
  }, [multiPane]);

  /** Open a session in a specific pane (defaults to the focused pane). */
  const create = useCallback(
    (opts?: CreateOpts, paneId?: string) => {
      countRef.current += 1;
      const session: TerminalSession = {
        id: nextId(),
        title: opts?.title ?? defaultTitle(countRef.current),
        cwd: opts?.cwd ?? cwd,
        ...(opts?.launch ? { launch: opts.launch } : {}),
        ...(opts?.prime ? { prime: true } : {}),
        ...(opts?.shell ? { shell: opts.shell } : {}),
        ...(opts?.venv !== undefined ? { venv: opts.venv } : {}),
      };
      setLayout((l) => paneAddSession(l, paneId ?? l.focusedPaneId, session));
      setOpenMenuPaneId(null);
    },
    [cwd],
  );

  // Load the core-backed launcher menu + probe AI bins (best-effort). APP-048.
  useEffect(() => {
    const api = window.prometheus?.ide;
    if (!api) return;
    let alive = true;
    void (async () => {
      const envList = await window.prometheus?.env?.list?.().catch(() => undefined);
      const envs: IdeTerminalEnv[] = (envList?.envs ?? [])
        .map((e) => ({
          name: String((e as { name?: unknown }).name ?? ""),
          path: String((e as { path?: unknown }).path ?? ""),
          kind: String((e as { kind?: unknown }).kind ?? "venv"),
          pythonVersion:
            ((e as { pythonVersion?: unknown }).pythonVersion as string | null) ?? null,
        }))
        .filter((e) => e.name && e.path);
      envsRef.current = envs;
      /**
       * Publish the workspace's ACTIVE env so a new terminal inherits it.
       *
       * pty-host's header calls this "THE LOAD-BEARING BEHAVIOUR" of §6.1 — a new terminal comes
       * up as `(.venv) $` so `python` and `pip install` hit the project env without a manual
       * activate — and the whole path existed except for a writer: `setVenv` had ZERO callers
       * app-wide, so `useGitStore(s => s.venv)` was permanently null and `Terminal.tsx`'s only
       * fallback for a session with no explicit venv resolved to nothing. The default ★ Project
       * shell profile has no `envRef`, so it depends on exactly this fallback.
       *
       * The active env is the one that lives INSIDE the workspace, preferring a conventional
       * `.venv`; an env registered elsewhere on the machine is not this project's and must not be
       * force-activated in its terminals.
       */
      useGitStore.getState().setVenv(pickActiveVenv(cwd, envs));
      const items = await api.terminal
        ?.menu({ workspaceRoot: cwd, envs })
        .then((r) => (r.ok && r.items.length ? r.items : undefined))
        .catch(() => undefined);
      if (alive && items) setMenu(items);
      const bins = (items ?? FALLBACK_MENU).map((m) => m.detectBin).filter((b): b is string => !!b);
      if (api.detectBins && bins.length) {
        const r = await api.detectBins(bins).catch(() => undefined);
        if (alive && r) setInstalled(r);
      }
    })();
    return () => {
      alive = false;
    };
  }, [cwd]);

  /**
   * handoff §2.4: the terminal island's "✳ Claude Code" tab. Selecting that tab dispatches
   * `ide:terminal-preset` with a menu-item id; we resolve it through the SAME launcher the
   * `+ ▾` menu uses, so a missing binary still lands on the install path rather than a
   * silently dead tab. Fires once per selection — `launchedPresets` keeps a repeat click
   * from stacking sessions.
   */
  const launchedPresets = useRef<Set<string>>(new Set());

  /** Resolve a menu item via core (in MAIN) then open the matching session in `paneId`. */
  const launchItem = useCallback(
    async (item: IdeTerminalMenuItem, paneId: string): Promise<void> => {
      const api = window.prometheus?.ide;
      const binOk = !item.detectBin || installed[item.detectBin];
      if (item.kind === "ai-preset" && !binOk) {
        if (item.install)
          create({ launch: item.install, prime: true, title: `Install ${item.title}` }, paneId);
        else create({ title: item.title }, paneId);
        return;
      }
      const resolved = await api?.terminal
        ?.resolve({ id: item.id, workspaceRoot: cwd, envs: envsRef.current })
        .then((r) => (r.ok ? r.resolved : undefined))
        .catch(() => undefined);
      if (!resolved) {
        create({ title: item.title }, paneId);
        return;
      }
      create(
        {
          title: resolved.title,
          cwd: resolved.cwd,
          ...(resolved.shell ? { shell: resolved.shell } : {}),
          ...(resolved.venv !== undefined ? { venv: resolved.venv } : {}),
          ...(resolved.launch
            ? { launch: resolved.launch, ...(resolved.autorun ? {} : { prime: true }) }
            : {}),
        },
        paneId,
      );
    },
    [cwd, installed, create],
  );

  // handoff §2.4: the "✳ Claude Code" tab. `launchedPresets` makes re-selecting the tab a
  // no-op instead of stacking a new session each time; the tab itself keeps showing the
  // same TerminalPanel, so the pty survives tab switches exactly like Terminal does.
  useEffect(() => {
    const onPreset = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id !== "string" || launchedPresets.current.has(id)) return;
      const item = menu.find((m) => m.id === id);
      if (!item) return;
      launchedPresets.current.add(id);
      void launchItem(item, layout.focusedPaneId);
    };
    window.addEventListener("ide:terminal-preset", onPreset);
    return () => window.removeEventListener("ide:terminal-preset", onPreset);
  }, [menu, launchItem, layout.focusedPaneId]);

  // Open ONE session on first mount (only when the restored layout is empty).
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const empty = layout.panes.every((p) => p.sessions.length === 0);
    if (empty) create();
  }, [create, layout.panes]);

  // Persist the layout DESCRIPTORS (titles/cwd/direction) on every change — fresh shells
  // restore on next boot; pty ids / launch strings (secrets) are never written.
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(serializeLayout(layout)));
    } catch {
      /* private mode / quota — layout just won't persist */
    }
  }, [layout]);

  const setSessionTitle = useCallback((paneId: string, id: string, title: string) => {
    if (manualTitles.current.has(id)) return;
    const t = tabTitle(title);
    if (t) setLayout((l) => paneRenameSession(l, paneId, id, t));
  }, []);

  // APP-090: each session's MAIN-spawned ptyId (kept in a ref for the reverse lookup the
  // returned-event listener needs, mirrored to state so the ⧉ button's enabled-ness renders).
  const ptyIdsRef = useRef<Record<string, string>>({});
  const rememberPty = useCallback((sessId: string, ptyId: string) => {
    ptyIdsRef.current = { ...ptyIdsRef.current, [sessId]: ptyId };
    setPtyIds((m) => (m[sessId] === ptyId ? m : { ...m, [sessId]: ptyId }));
  }, []);

  const closeTab = useCallback((paneId: string, id: string) => {
    manualTitles.current.delete(id);
    delete ptyIdsRef.current[id];
    setPtyIds((m) => {
      if (!(id in m)) return m;
      const next = { ...m };
      delete next[id];
      return next;
    });
    setFloating((f) => redock(f, id));
    setLayout((l) => paneCloseSession(l, paneId, id));
  }, []);

  // APP-090: tear a session out into a hardened float. Creates the window in MAIN (validated
  // IPC, never window.open); on success hide the tab + activate a neighbor if it was active.
  const tearOutSession = useCallback(
    (paneId: string, sess: TerminalSession) => {
      const api = window.prometheus?.ide;
      const ptyId = ptyIdsRef.current[sess.id];
      if (!api?.floatingTerminal || !ptyId) return;
      void api.floatingTerminal
        .create({
          ptyId,
          title: sess.title,
          ...(activeSchemeId ? { scheme: activeSchemeId } : {}),
        })
        .then((r) => {
          if (!r.ok) return;
          setFloating((f) => {
            const next = tearOut(f, sess.id);
            setLayout((l) => {
              const pane = l.panes.find((p) => p.id === paneId);
              if (!pane || pane.activeId !== sess.id) return l;
              const activate = pickActive(pane.sessions, pane.activeId, next);
              return activate ? paneActivateSession(l, paneId, activate) : l;
            });
            return next;
          });
        });
    },
    [activeSchemeId],
  );

  // APP-090: when a float returns (its ⭰ dock button or the window closed), MAIN emits
  // `floatingTerminal.returned` — re-dock the session (re-show + re-activate its tab).
  useEffect(() => {
    const api = window.prometheus?.ide;
    if (!api?.onEvent) return;
    return api.onEvent((ev: IdeEvent) => {
      if (ev.channel !== "floatingTerminal.returned") return;
      const sessId = Object.keys(ptyIdsRef.current).find((k) => ptyIdsRef.current[k] === ev.ptyId);
      if (!sessId) return;
      setFloating((f) => redock(f, sessId));
      setLayout((l) => {
        const pane = l.panes.find((p) => p.sessions.some((s) => s.id === sessId));
        return pane ? paneActivateSession(l, pane.id, sessId) : l;
      });
    });
  }, []);

  const commitRename = useCallback(
    (paneId: string) => {
      if (editingId) {
        manualTitles.current.add(editingId);
        setLayout((l) => paneRenameSession(l, paneId, editingId, draft));
      }
      setEditingId(null);
    },
    [editingId, draft],
  );

  const splitInto = useCallback(
    (direction: "row" | "column", fromPaneId: string) => {
      const newPaneId = nextPaneId();
      setLayout((l) => {
        // split the source pane, then seed a fresh shell in the new pane.
        const split = splitPane(focusPane(l, fromPaneId), newPaneId, direction);
        countRef.current += 1;
        const session: TerminalSession = {
          id: nextId(),
          title: defaultTitle(countRef.current),
          cwd,
        };
        return paneAddSession(split, newPaneId, session);
      });
      setOpenMenuPaneId(null);
    },
    [cwd],
  );

  const multi = multiPane;
  return (
    <div
      ref={splitRef}
      style={{
        display: "flex",
        flexDirection: layout.direction === "row" ? "row" : "column",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
      }}
    >
      {layout.panes.map((pane, i) => (
        <Fragment key={pane.id}>
          <div
            onFocusCapture={() => setLayout((l) => focusPane(l, pane.id))}
            onMouseDownCapture={() => setLayout((l) => focusPane(l, pane.id))}
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              minWidth: 0,
              position: "relative",
              // the FIRST pane is sized by the divider (2-pane case); the rest flex equally.
              ...(multi && i === 0
                ? layout.direction === "row"
                  ? // the CSS max is only a backstop between a container resize and its re-clamp
                    { width: rz.size, maxWidth: "calc(100% - 140px)", flex: "0 0 auto" }
                  : { height: rz.size, maxHeight: "calc(100% - 140px)", flex: "0 0 auto" }
                : { flex: 1 }),
              outline:
                multi && pane.id === layout.focusedPaneId ? "1px solid var(--accent)" : "none",
              outlineOffset: -1,
            }}
          >
            {/* the split divider straddles the first pane's trailing edge (2-pane case). */}
            {multi && i === 0 && (
              <ResizeHandle
                axis={layout.direction === "row" ? "x" : "y"}
                edge={layout.direction === "row" ? "right" : "bottom"}
                rz={rz}
                label="Resize terminal split"
                min={140}
              />
            )}
            <PaneStrip
              pane={pane}
              floating={floating}
              ptyIds={ptyIds}
              menu={menu}
              installed={installed}
              menuOpen={openMenuPaneId === pane.id}
              editingId={editingId}
              draft={draft}
              canClosePane={multi}
              onToggleMenu={() => setOpenMenuPaneId((cur) => (cur === pane.id ? null : pane.id))}
              onCloseMenu={() => setOpenMenuPaneId(null)}
              onLaunch={(item) => void launchItem(item, pane.id)}
              onActivate={(id) => setLayout((l) => paneActivateSession(l, pane.id, id))}
              onCloseTab={(id) => closeTab(pane.id, id)}
              onTearOut={(sess) => tearOutSession(pane.id, sess)}
              onClosePane={() => setLayout((l) => closePane(l, pane.id))}
              onSplitRight={() => splitInto("row", pane.id)}
              onSplitDown={() => splitInto("column", pane.id)}
              onStartRename={(id, title) => {
                setDraft(title);
                setEditingId(id);
              }}
              onDraft={setDraft}
              onCommitRename={() => commitRename(pane.id)}
              onCancelRename={() => setEditingId(null)}
            />
            <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
              {pane.sessions.length === 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: "100%",
                    color: "var(--text-secondary)",
                    fontSize: "0.8rem",
                  }}
                >
                  No terminal — press + to open one.
                </div>
              )}
              {pane.sessions.map((sess) => (
                <div
                  key={sess.id}
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: sess.id === pane.activeId ? "block" : "none",
                  }}
                >
                  <Terminal
                    cwd={sess.cwd}
                    onTitle={(t) => setSessionTitle(pane.id, sess.id, t)}
                    onSpawn={(ptyId) => rememberPty(sess.id, ptyId)}
                    {...(sess.launch ? { launch: sess.launch } : {})}
                    {...(sess.prime ? { prime: true } : {})}
                    {...(sess.shell ? { shell: sess.shell } : {})}
                    {...(sess.venv !== undefined ? { venv: sess.venv } : {})}
                  />
                </div>
              ))}
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** One pane's tab strip + "+" launcher menu + split/close controls. */
function PaneStrip({
  pane,
  floating,
  ptyIds,
  menu,
  installed,
  menuOpen,
  editingId,
  draft,
  canClosePane,
  onToggleMenu,
  onCloseMenu,
  onLaunch,
  onActivate,
  onCloseTab,
  onTearOut,
  onClosePane,
  onSplitRight,
  onSplitDown,
  onStartRename,
  onDraft,
  onCommitRename,
  onCancelRename,
}: {
  pane: TerminalPane;
  floating: FloatingState;
  ptyIds: Record<string, string>;
  menu: readonly IdeTerminalMenuItem[];
  installed: Record<string, boolean>;
  menuOpen: boolean;
  editingId: string | null;
  draft: string;
  canClosePane: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onLaunch: (item: IdeTerminalMenuItem) => void;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onTearOut: (sess: TerminalSession) => void;
  onClosePane: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onStartRename: (id: string, title: string) => void;
  onDraft: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}): ReactElement {
  // APP-090: torn-out sessions are hidden from the strip (they live in a float window).
  const shownSessions = visibleSessions(pane.sessions, floating);
  /**
   * The launcher menu is PORTALED, not absolutely positioned inside the strip.
   *
   * `position: absolute; top: 100%` put it inside three nested clipping boxes — the strip,
   * BottomPanel's scrolling body (`overflow: auto`) and the panel section's `overflow:
   * hidden`. A ~240px menu opening 26px down a 212px panel was simply cut off, so the AI-CLI
   * and Environment groups at the bottom of the list could not be reached at all. A layer
   * anchored to the button and mounted on `document.body` escapes every one of them, and
   * `useAnchoredLayer` clamps it into the viewport.
   */
  const plusRef = useRef<HTMLButtonElement>(null);
  const menuBox = useAnchoredLayer(plusRef, menuOpen, {
    width: 230,
    // The layer's EXPECTED height — the input useAnchoredLayer clamps against so a menu
    // opening near the bottom edge is shifted up instead of running off-screen. Pairs with
    // the menu's own maxHeight:240 + overflowY:auto.
    height: 240, // layout-allow: a measurement input to the positioner, not a CSS pane height
    placement: "below",
  });
  /**
   * Keyboard reach for the portaled menu. Inline, it was the next thing in DOM order after the
   * `+ ▾` button, so Tab walked into it. Portaled to <body> it sits after the whole app, so a
   * keyboard user who opened it could not get to a single item. So: focus the first item on
   * open, Arrow keys move between items, Escape closes and hands focus back to the button.
   */
  const menuRef = useRef<HTMLDivElement>(null);
  const menuShown = menuOpen && menuBox !== null;
  useEffect(() => {
    if (menuShown) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuShown]);
  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      onCloseMenu();
      plusRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };
  return (
    <div
      role="tablist"
      aria-label="terminal sessions"
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 2,
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg-surface)",
        // Tabs WRAP rather than scroll. `overflowX: auto` coerces overflow-y to clip, and a
        // clipped strip is the wrong shape for a row of tabs that must all stay reachable.
        // (The launcher menu no longer depends on this: it is portaled to document.body, so
        // the clipper that used to eat it — BottomPanel's scroller — cannot reach it.)
        flexWrap: "wrap",
        flexShrink: 0,
      }}
    >
      {shownSessions.map((sess) => {
        const isActive = sess.id === pane.activeId;
        return (
          <div
            key={sess.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 6px",
              fontSize: "0.74rem",
              whiteSpace: "nowrap",
              cursor: "pointer",
              color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
              borderTop: `2px solid ${isActive ? "var(--accent)" : "transparent"}`,
              background: isActive ? "var(--bg-inset)" : "transparent",
            }}
          >
            {editingId === sess.id ? (
              <input
                // biome-ignore lint/a11y/noAutofocus: a rename box should grab focus immediately
                autoFocus
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
                onBlur={onCommitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommitRename();
                  else if (e.key === "Escape") onCancelRename();
                }}
                aria-label="rename terminal"
                style={{
                  width: 90,
                  background: "var(--bg-surface-2)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 3,
                  font: "inherit",
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => onActivate(sess.id)}
                onDoubleClick={() => onStartRename(sess.id, sess.title)}
                title="Click to switch · double-click to rename"
                style={tabBtn()}
              >
                {sess.title}
              </button>
            )}
            <button
              type="button"
              aria-label={`tear out ${sess.title}`}
              title="Tear out into a floating window"
              disabled={!ptyIds[sess.id]}
              onClick={() => onTearOut(sess)}
              style={{ ...tabBtn(), opacity: ptyIds[sess.id] ? 1 : 0.4 }}
            >
              ⧉
            </button>
            <button
              type="button"
              aria-label={`close ${sess.title}`}
              onClick={() => onCloseTab(sess.id)}
              style={tabBtn()}
            >
              ×
            </button>
          </div>
        );
      })}
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 2 }}>
        <button
          ref={plusRef}
          type="button"
          aria-label="new terminal"
          title="New terminal — shell or AI CLI"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={onToggleMenu}
          style={{ ...tabBtn(), padding: "3px 8px", color: "var(--text-secondary)" }}
        >
          + ▾
        </button>
        <button
          type="button"
          aria-label="split right"
          title="Split right"
          onClick={onSplitRight}
          style={{ ...tabBtn(), padding: "3px 4px", color: "var(--text-secondary)" }}
        >
          ⬌
        </button>
        <button
          type="button"
          aria-label="split down"
          title="Split down"
          onClick={onSplitDown}
          style={{ ...tabBtn(), padding: "3px 4px", color: "var(--text-secondary)" }}
        >
          ⬍
        </button>
        {canClosePane && (
          <button
            type="button"
            aria-label="close pane"
            title="Close pane"
            onClick={onClosePane}
            style={{ ...tabBtn(), padding: "3px 4px", color: "var(--text-secondary)" }}
          >
            ⊗
          </button>
        )}
        {menuOpen &&
          menuBox &&
          createPortal(
            <>
              <button
                type="button"
                aria-label="close menu"
                onClick={onCloseMenu}
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "transparent",
                  border: "none",
                  cursor: "default",
                  // Z.dropdown, not Z.raise: the menu it dismisses is a dropdown, and a
                  // backdrop one rung BELOW its own menu leaves everything between the two
                  // rungs clickable through it.
                  zIndex: Z.dropdown,
                }}
              />
              <div
                ref={menuRef}
                role="menu"
                aria-label="new terminal"
                onKeyDown={onMenuKeyDown}
                style={{
                  // fixed + measured, so no ancestor's overflow can clip it. `useAnchoredLayer`
                  // clamps into the viewport, which also replaces the old right:0 hack.
                  position: "fixed",
                  left: menuBox.left,
                  top: menuBox.top,
                  width: menuBox.width,
                  minWidth: 230,
                  background: "var(--bg-surface-2)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-md, 6px)",
                  boxShadow: "var(--elevation-e3)",
                  padding: 4,
                  zIndex: Z.dropdown,
                  maxHeight: 240,
                  overflowY: "auto",
                  fontSize: "0.78rem",
                }}
              >
                {(["shell", "ai-preset", "env"] as const).map((group) => {
                  const groupItems = menu.filter((m) => m.kind === group);
                  if (!groupItems.length) return null;
                  const label =
                    group === "shell"
                      ? "Shells"
                      : group === "ai-preset"
                        ? "AI CLIs"
                        : "Environments";
                  const glyph = group === "shell" ? "$" : group === "ai-preset" ? "◆" : "⬢";
                  return (
                    <div key={group}>
                      <div
                        style={{
                          height: 1,
                          background: "var(--border-subtle)",
                          margin: "4px 2px",
                        }}
                      />
                      <div
                        style={{
                          padding: "2px 8px",
                          color: "var(--text-secondary)",
                          fontSize: "0.7rem",
                        }}
                      >
                        {label}
                      </div>
                      {groupItems.map((item) => {
                        const ok = !item.detectBin || installed[item.detectBin];
                        const canInstall = !!item.install;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            role="menuitem"
                            title={
                              ok || !canInstall
                                ? item.title
                                : `Not installed — opens a terminal primed with: ${item.install}`
                            }
                            onClick={() => onLaunch(item)}
                            style={menuItem()}
                          >
                            <span aria-hidden="true">{glyph}</span> {item.title}
                            {item.kind === "ai-preset" && item.detectBin ? (
                              ok ? (
                                <span style={{ marginLeft: "auto", color: "var(--ok)" }}>
                                  installed
                                </span>
                              ) : canInstall ? (
                                <span style={{ marginLeft: "auto", color: "var(--warn)" }}>
                                  install
                                </span>
                              ) : null
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </>,
            document.body,
          )}
      </div>
    </div>
  );
}

function tabBtn(): CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
    padding: 0,
    lineHeight: 1.4,
  };
}

function menuItem(): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    textAlign: "left",
    background: "transparent",
    border: "none",
    color: "var(--text-primary)",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "var(--radius-sm, 4px)",
    font: "inherit",
  };
}

export default TerminalPanel;
