/**
 * TerminalLauncher.tsx — the in-IDE Terminal Launcher panel (file 13 §1.2).
 *
 * Hosts terminal sessions over 07's PTY host via `window.prometheus.ide.*` (the renderer
 * drives; MAIN owns the child — C5). Left session list (grouped) + an output view fed by
 * the `pty.data` event stream + an input line (`pty.write`) + the toolbar + the
 * "+ New terminal ▾" menu of profiles & AI presets. The profile→spawn resolution is
 * @prometheus/core's `terminal` namespace, surfaced to the renderer via the `resolve`
 * prop (the renderer can't import core — C5). xterm.js (07 §6.1) swaps in for the plain
 * output view later; the data flow is identical. No raw hex.
 */
import { Button, Panel, Z } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import {
  type MenuItemView,
  type SessionView,
  appendScrollback,
  groupSessions,
  statusGlyph,
} from "./terminal-view.js";

/** Resolved spawn params for one menu pick (computed by the container via core §1.5). */
export interface ResolvedLaunch {
  cwd: string;
  shell?: string;
  venv?: { root: string; platform?: "win32" | "posix" } | null;
  /** an AI-preset command to auto-run after the shell starts (§1.4). */
  launch?: string;
  autorun?: boolean;
  group: SessionView["group"];
  title: string;
}

export interface TerminalLauncherProps {
  /** the "+ New terminal ▾" menu (profiles, then AI presets, then env profiles). */
  menu: readonly MenuItemView[];
  /** resolve a menu pick → spawn params (the container calls core's resolveProfile). */
  resolve: (item: MenuItemView) => ResolvedLaunch;
  /** tear a session into a floating window (§1.2; main-process seam). */
  onFloat?: (session: SessionView) => void;
}

interface LiveSession extends SessionView {
  ptyId?: string;
}

/** The §1.2 Terminal Launcher panel. */
export function TerminalLauncher({ menu, resolve, onFloat }: TerminalLauncherProps): ReactElement {
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scrollback, setScrollback] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [broadcast, setBroadcast] = useState(false);
  const counter = useRef(0);
  const spawningRef = useRef(false);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  // Stream PTY output → per-session scrollback; mark exited sessions (§1.2).
  useEffect(() => {
    const bridge = window.prometheus?.ide;
    if (!bridge?.onEvent) return;
    const off = bridge.onEvent((ev) => {
      if (ev.channel === "pty.data") {
        setSessions((prev) => {
          const owner = prev.find((s) => s.ptyId === ev.ptyId);
          if (owner)
            setScrollback((sb) => ({
              ...sb,
              [owner.id]: appendScrollback(sb[owner.id] ?? "", ev.data),
            }));
          return prev;
        });
      } else if (ev.channel === "pty.exit") {
        setSessions((prev) =>
          prev.map((s) => (s.ptyId === ev.ptyId ? { ...s, status: "exited" } : s)),
        );
      }
    });
    return off;
  }, []);

  const spawn = useCallback(
    async (item: MenuItemView) => {
      const bridge = window.prometheus?.ide;
      if (!bridge || item.disabledHint) return;
      // debounce: a double-click must not spawn two terminals for the same action.
      if (spawningRef.current) return;
      spawningRef.current = true;
      const r = resolve(item);
      counter.current += 1;
      const id = `term-${counter.current}`;
      try {
        const res = await bridge.ptySpawn({
          cwd: r.cwd,
          ...(r.shell ? { shell: r.shell } : {}),
          ...(r.venv ? { venv: r.venv } : {}),
          cols: 80,
          rows: 24,
        });
        if (!res.ok || !res.ptyId) {
          setScrollback((sb) => ({
            ...sb,
            [id]: `failed to spawn: ${res.error ?? "unknown error"}`,
          }));
        }
        const session: LiveSession = {
          id,
          title: r.title,
          status: res.ok ? "running" : "exited",
          group: r.group,
          ...(res.ptyId ? { ptyId: res.ptyId } : {}),
        };
        setSessions((prev) => [...prev, session]);
        setActiveId(id);
        setMenuOpen(false);
        if (res.ok && res.ptyId && r.launch && r.autorun !== false) {
          bridge.ptyWrite(res.ptyId, `${r.launch}\r`);
        }
      } catch (e) {
        // a rejected spawn IPC must surface (not an unhandled rejection) — record an
        // exited session with the error in its scrollback.
        setScrollback((sb) => ({
          ...sb,
          [id]: `failed to spawn: ${e instanceof Error ? e.message : String(e)}`,
        }));
        setSessions((prev) => [...prev, { id, title: r.title, status: "exited", group: r.group }]);
        setActiveId(id);
        setMenuOpen(false);
      } finally {
        spawningRef.current = false;
      }
    },
    [resolve],
  );

  const send = (): void => {
    const bridge = window.prometheus?.ide;
    if (!bridge || !active?.ptyId || !input) return;
    const line = `${input}\r`;
    bridge.ptyWrite(active.ptyId, line);
    // broadcast mirrors to same-group siblings (§1.7)
    if (broadcast) {
      for (const s of sessions) {
        if (s.id !== active.id && s.group === active.group && s.ptyId)
          bridge.ptyWrite(s.ptyId, line);
      }
    }
    setInput("");
  };

  const kill = (s: LiveSession): void => {
    if (s.ptyId) window.prometheus?.ide?.ptyKill(s.ptyId);
    setSessions((prev) => prev.filter((x) => x.id !== s.id));
    // also reclaim the dead session's scrollback — otherwise a long-lived launcher
    // that spawns+kills many terminals grows this map unbounded.
    setScrollback(({ [s.id]: _dropped, ...rest }) => rest);
    if (activeId === s.id) setActiveId(null);
  };

  const groups = groupSessions(sessions);

  return (
    <Panel title="Terminal" elevation="e1">
      <div
        style={{
          display: "flex",
          gap: "var(--space-3)",
          // §9: no fixed-px pane height — grows with the window instead of pinning the
          // session list + preview to the same 320px slice on every screen.
          height: "min(42vh, 560px)",
          fontFamily: "var(--font-ui)",
        }}
      >
        {/* session list */}
        <div
          style={{
            flex: "0 0 200px",
            display: "flex",
            flexDirection: "column",
            borderRight: "1px solid var(--border-subtle)",
            paddingRight: "var(--space-2, 4px)",
          }}
        >
          <div style={{ flex: 1, overflowY: "auto" }}>
            {groups.map((g) => (
              <div key={g.group}>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "var(--text-small-size, 0.8125rem)",
                    padding: "var(--space-1, 2px) 0",
                  }}
                >
                  ▾ {g.group}
                </div>
                {g.sessions.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2, 4px)",
                      padding: "var(--space-1, 2px) var(--space-2, 4px)",
                      background: s.id === activeId ? "var(--bg-inset)" : "transparent",
                      borderRadius: "var(--radius-sm, 4px)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveId(s.id)}
                      style={{
                        flex: 1,
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        fontSize: "var(--text-small-size, 0.8125rem)",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          color: s.status === "exited" ? "var(--text-disabled)" : "var(--ok)",
                        }}
                      >
                        {statusGlyph(s)}
                      </span>{" "}
                      {s.title}
                    </button>
                    <button
                      type="button"
                      aria-label={`Kill ${s.title}`}
                      onClick={() => kill(s)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                      }}
                    >
                      ⌫
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div style={{ position: "relative" }}>
            <Button variant="secondary" onClick={() => setMenuOpen((o) => !o)}>
              + New terminal ▾
            </Button>
            {menuOpen && (
              <div
                role="menu"
                style={{
                  position: "absolute",
                  bottom: "100%",
                  left: 0,
                  minWidth: 220,
                  background: "var(--bg-surface-2)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-md, 6px)",
                  boxShadow: "var(--elevation-e3)",
                  padding: "var(--space-2, 4px)",
                  zIndex: Z.raise,
                }}
              >
                {menu.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    disabled={Boolean(item.disabledHint)}
                    onClick={() => spawn(item)}
                    title={item.disabledHint}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      color: item.disabledHint ? "var(--text-disabled)" : "var(--text-primary)",
                      cursor: item.disabledHint ? "not-allowed" : "pointer",
                      padding: "var(--space-1, 2px) var(--space-2, 4px)",
                      fontSize: "var(--text-small-size, 0.8125rem)",
                    }}
                  >
                    {item.kind === "ai-preset" ? "◆" : item.kind === "env" ? "⬢" : "$"} {item.title}
                    {item.subtitle && (
                      <span style={{ color: "var(--text-secondary)" }}> · {item.subtitle}</span>
                    )}
                    {item.disabledHint && (
                      <span style={{ color: "var(--warn)" }}> — {item.disabledHint}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* active terminal view */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              gap: "var(--space-2, 4px)",
              marginBottom: "var(--space-2, 4px)",
            }}
          >
            <Button variant="ghost" onClick={() => active && onFloat?.(active)} disabled={!active}>
              ⧉ float
            </Button>
            <Button
              variant={broadcast ? "primary" : "ghost"}
              onClick={() => setBroadcast((b) => !b)}
            >
              📡 broadcast
            </Button>
            <Button variant="ghost" onClick={() => active && kill(active)} disabled={!active}>
              🗑 kill
            </Button>
          </div>
          {broadcast && (
            <div
              style={{
                background: "var(--warn)",
                color: "var(--bg-app)",
                textAlign: "center",
                fontSize: "var(--text-small-size, 0.8125rem)",
                borderRadius: "var(--radius-sm, 4px)",
              }}
            >
              broadcast mode — Esc exits
            </div>
          )}
          <pre
            aria-label="terminal output"
            style={{
              flex: 1,
              margin: 0,
              overflow: "auto",
              background: "var(--bg-app)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md, 6px)",
              padding: "var(--space-3, 6px)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-code-size, 0.875rem)",
              whiteSpace: "pre-wrap",
            }}
          >
            {active
              ? (scrollback[active.id] ?? "")
              : "no terminal — pick one from + New terminal ▾"}
          </pre>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            style={{
              display: "flex",
              gap: "var(--space-2, 4px)",
              marginTop: "var(--space-2, 4px)",
            }}
          >
            <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>›</span>
            <input
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              disabled={!active?.ptyId}
              aria-label="terminal input"
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono)",
                outline: "none",
              }}
            />
          </form>
        </div>
      </div>
    </Panel>
  );
}

export default TerminalLauncher;
