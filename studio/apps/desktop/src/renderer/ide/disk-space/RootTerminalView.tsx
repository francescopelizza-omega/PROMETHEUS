// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * RootTerminalView — the content of the root terminal window ("Open as administrator").
 *
 * DISPLAY ONLY. It draws what disk_space.py, running as root, prints; it never sends a key.
 * Main takes this window's keys straight from the keyboard (before-input-event in
 * main/root-terminal-window.ts) and the page never even receives them, so nothing in any page —
 * this one included — can type into the root program. The terminal reports its size (so the
 * program fits the window), and Stop ends the session; that is all this page can ask for.
 */
import { Button, xtermThemeFromSemantic } from "@prometheus/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { useTheme } from "../../shell/ThemeProvider.js";
import { resolveFontStack } from "../fonts/registry.js";
import { useFontStore } from "../fonts/store.js";
import { loadXterm } from "../xterm-loader.js";

export function RootTerminalView(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Starting…");
  const [available, setAvailable] = useState(true);
  const { colors } = useTheme();
  const font = useFontStore((s) => s.terminal);
  const startRef = useRef({ colors, font });

  useEffect(() => {
    let disposed = false;
    const unsubs: (() => void)[] = [];
    let term: import("@xterm/xterm").Terminal | undefined;
    let ro: ResizeObserver | undefined;
    const api = window.prometheus?.diskSpace;
    // subscribe FIRST, buffering until the terminal exists, then tell main we listen: main holds
    // the program's output until then, so its first screen is never lost
    const early: string[] = [];
    let sink: ((chunk: string) => void) | null = null;
    if (api) {
      unsubs.push(api.onAdminStatus((text) => setStatus(text)));
      unsubs.push(api.onAdminData((chunk) => (sink ? sink(chunk) : early.push(chunk))));
      api.adminReady();
    }
    void (async () => {
      const { xterm, fit } = await loadXterm();
      if (disposed) return;
      if (!xterm || !api || !hostRef.current) {
        setAvailable(false);
        return;
      }
      const { colors: c, font: f } = startRef.current;
      term = new xterm.Terminal({
        fontFamily: resolveFontStack(f.familyId),
        fontSize: f.size,
        lineHeight: f.lineHeight,
        theme: xtermThemeFromSemantic(c),
        // keys never come from this page: main reads them from the keyboard
        disableStdin: true,
      });
      const fitAddon = fit ? new fit.FitAddon() : null;
      if (fitAddon) term.loadAddon(fitAddon);
      term.open(hostRef.current);
      const t = term;
      sink = (chunk) => t.write(chunk);
      for (const chunk of early.splice(0)) t.write(chunk);
      t.onResize(({ cols, rows }) => api.adminResize(cols, rows));
      fitAddon?.fit();
      api.adminResize(t.cols, t.rows);
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => {
          if (!disposed) fitAddon?.fit();
        });
        ro.observe(hostRef.current);
      }
    })();
    return () => {
      disposed = true;
      for (const u of unsubs) u();
      ro?.disconnect();
      term?.dispose();
    };
  }, []);

  return (
    <div
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
          gap: "var(--space-4, 8px)",
          padding: "var(--space-4, 8px) var(--space-6, 12px)",
          borderBottom: "1px solid var(--danger)",
          flexShrink: 0,
        }}
      >
        <strong style={{ color: "var(--danger)" }}>Running as administrator (root)</strong>
        <span
          role="status"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            fontSize: "var(--text-small-size, 0.8125rem)",
            color: "var(--text-secondary)",
          }}
        >
          {available
            ? status ||
              "Keys typed here go to disk-space as root · q quits · Ctrl+D or Stop ends it"
            : "The terminal view is not available in this build."}
        </span>
        <Button size="sm" variant="ghost" onClick={() => window.prometheus?.diskSpace?.adminStop()}>
          Stop
        </Button>
      </header>
      <div
        ref={hostRef}
        aria-label="disk-space running as administrator"
        style={{ flex: "1 1 auto", minHeight: 0, background: "var(--bg-inset)" }}
      />
    </div>
  );
}
