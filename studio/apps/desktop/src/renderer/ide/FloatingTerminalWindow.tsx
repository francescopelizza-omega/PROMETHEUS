/**
 * FloatingTerminalWindow.tsx — the ⧉ tear-off terminal window content (file 13 §1.2/§3.5).
 *
 * The renderer content mounted in a borderless secondary BrowserWindow that hosts ONE
 * terminal on a second monitor (e.g. a parked `prom chat`). It carries its OWN
 * `data-theme` (per-window theming, §3.5) — applied via @prometheus/ui's `themes` to
 * THIS window's root only. It drives the SAME `window.prometheus.ide.*` PTY host as the
 * main window (the host is window-agnostic).
 *
 * NOTE (documented seam, not file-13 scope): creating the secondary BrowserWindow is a
 * MAIN-process job (main/index.ts currently makes one window). Wiring
 * `window.prometheus.ide.floatingTerminal.create(...)` + a `floating-terminal.html`
 * entry is a follow-up; THIS component is the content that window loads. No raw hex.
 */
import { type ColorScheme, themes } from "@prometheus/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";

import { appendScrollback } from "./terminal-view.js";

export interface FloatingTerminalWindowProps {
  /** the existing PTY this window attaches to (spawned by the main window). */
  ptyId: string;
  title: string;
  /** the per-window scheme (§3.5); defaults to follow-global if omitted. */
  scheme?: ColorScheme;
}

/** The tear-off terminal window content (§1.2/§3.5). */
export function FloatingTerminalWindow({
  ptyId,
  title,
  scheme,
}: FloatingTerminalWindowProps): ReactElement {
  const [scrollback, setScrollback] = useState("");
  const [input, setInput] = useState("");
  const [alive, setAlive] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  // Per-window theme: apply the scheme's CSS vars to THIS window's root only (§3.5).
  useEffect(() => {
    if (scheme && rootRef.current) themes.applySchemeToRoot(scheme, rootRef.current);
  }, [scheme]);

  // Stream this PTY's output (the host broadcasts to all windows; filter by ptyId).
  useEffect(() => {
    const bridge = window.prometheus?.ide;
    if (!bridge?.onEvent) return;
    return bridge.onEvent((ev) => {
      if (ev.channel === "pty.data" && ev.ptyId === ptyId) {
        setScrollback((sb) => appendScrollback(sb, ev.data));
      } else if (ev.channel === "pty.exit" && ev.ptyId === ptyId) {
        setAlive(false);
      }
    });
  }, [ptyId]);

  const send = (): void => {
    if (!input) return;
    window.prometheus?.ide?.ptyWrite(ptyId, `${input}\r`);
    setInput("");
  };

  return (
    <div
      ref={rootRef}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--bg-app)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2, 4px)",
          padding: "var(--space-2, 4px) var(--space-3, 6px)",
          borderBottom: "1px solid var(--border-subtle)",
          fontSize: "var(--text-small-size, 0.8125rem)",
        }}
      >
        <span aria-hidden="true">⧉</span>
        <span style={{ flex: 1, minWidth: 0 }}>{title}</span>
        <span style={{ color: alive ? "var(--ok)" : "var(--text-disabled)" }}>
          {alive ? "● live" : "○ exited"}
        </span>
        {/* Re-dock: close THIS window; MAIN emits `floatingTerminal.returned` so the main
            window re-shows the session tab. Never kills the PTY (it outlives the window). */}
        <button
          type="button"
          title="Return this terminal to the main window"
          aria-label="return to dock"
          onClick={() => void window.prometheus?.ide?.floatingTerminal?.close(ptyId)}
          style={{
            background: "transparent",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm, 4px)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            font: "inherit",
            padding: "0 var(--space-2, 4px)",
          }}
        >
          ⭰ dock
        </button>
      </header>
      <pre
        aria-label="floating terminal output"
        style={{
          flex: 1,
          margin: 0,
          overflow: "auto",
          padding: "var(--space-3, 6px)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-code-size, 0.875rem)",
          whiteSpace: "pre-wrap",
        }}
      >
        {scrollback}
      </pre>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        style={{
          display: "flex",
          gap: "var(--space-2, 4px)",
          padding: "var(--space-2, 4px) var(--space-3, 6px)",
          borderTop: "1px solid var(--border-subtle)",
        }}
      >
        <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>›</span>
        <input
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          disabled={!alive}
          aria-label="floating terminal input"
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
  );
}

export default FloatingTerminalWindow;
