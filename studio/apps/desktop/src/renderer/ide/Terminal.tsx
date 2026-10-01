// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/Terminal.tsx — the integrated terminal (file 07 §6.1).
 *
 * An xterm.js view bound to the MAIN-process PTY host over window.prometheus.ide.pty*
 * — the renderer never spawns a child (C5); pty-host (node-pty) lives in MAIN. The
 * terminal inherits the active venv (cwd / PATH prepend / VIRTUAL_ENV) which MAIN
 * resolves (§6.1); the renderer passes the venv hint from the git/venv store.
 *
 * DEGRADES GRACEFULLY (§6.1): xterm.js is loaded lazily and node-pty may be absent in
 * this env — when either is unavailable the pane shows an honest "no terminal backend"
 * notice. We NEVER fake a terminal session that did not run.
 *
 * Renderer-SANDBOXED (C5): react + xterm (lazy) + window.prometheus only.
 */

import { Z, xtermThemeFromSemantic } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import type { IdeEvent } from "../../shared/ipc-contract.js";
import { useTheme } from "../shell/ThemeProvider.js";
import { familyHasLigatures, resolveFontStack } from "./fonts/registry.js";
import { type FontConfig, useFontStore } from "./fonts/store.js";
import { useGitStore } from "./state/stores.js";
import {
  type BufferRow,
  type CommandBlock,
  adjacentBlockLine,
  joinWrappedRows,
  matchReadout,
  parseOsc133,
  reduceBlocks,
  searchLines,
  stepMatch,
} from "./terminal-view.js";
import {
  loadClipboardAddon,
  loadLigaturesAddon,
  loadSearchAddon,
  loadXterm,
} from "./xterm-loader.js";

type XTerm = import("@xterm/xterm").Terminal;
type FitAddon = import("@xterm/addon-fit").FitAddon;
type DisposableAddon = { dispose(): void };

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/**
 * The concrete font-family stack to hand xterm for a terminal font config. xterm
 * renders glyphs into a canvas and sets `ctx.font` from this string — a raw CSS
 * `var(--font-mono)` is NOT resolved there (canvas has no custom-property cascade),
 * so we pass the resolved literal stack from the registry (the user's chosen
 * PyCharm-style family + fallbacks).
 */
function terminalFontFamily(cfg: FontConfig): string {
  return resolveFontStack(cfg.familyId);
}

/**
 * Enable/disable xterm programming ligatures to match the config (PyCharm's
 * terminal ligature toggle). Best-effort: the addon may be absent or unable to run
 * in this sandbox — then the terminal simply renders unligated (never faked). The
 * addon instance is held in `ref` so a later toggle-off can dispose it.
 */
async function applyLigatures(
  term: XTerm,
  cfg: FontConfig,
  ref: { current: DisposableAddon | null },
): Promise<void> {
  const want = cfg.ligatures && familyHasLigatures(cfg.familyId);
  if (want && !ref.current) {
    const Ligatures = await loadLigaturesAddon();
    if (!Ligatures) return;
    try {
      const addon = new Ligatures() as unknown as DisposableAddon;
      term.loadAddon(addon as never);
      ref.current = addon;
    } catch {
      ref.current = null;
    }
  } else if (!want && ref.current) {
    try {
      ref.current.dispose();
    } catch {
      /* already disposed */
    }
    ref.current = null;
  }
}

/** Convert a `#rrggbb`/`#rgb` token to an `rgba()` string with the given alpha. Used to
 *  make the terminal SELECTION translucent so selected text stays readable (an opaque
 *  selection bg over the glyph made it hard to read). Non-hex input is returned as-is. */
function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const six = /^#([0-9a-fA-F]{6})$/.exec(c)?.[1];
  if (six) {
    const n = Number.parseInt(six, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(c);
  const r1 = m?.[1];
  const g1 = m?.[2];
  const b1 = m?.[3];
  if (r1 && g1 && b1) {
    const r = Number.parseInt(r1 + r1, 16);
    const g = Number.parseInt(g1 + g1, 16);
    const b = Number.parseInt(b1 + b1, 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

/** The xterm theme from the active tokens, but with a TRANSLUCENT selection so the
 *  highlighted text remains legible (the token selection color is opaque). */
function xtermTheme(
  colors: Parameters<typeof xtermThemeFromSemantic>[0],
): ReturnType<typeof xtermThemeFromSemantic> & { selectionInactiveBackground: string } {
  const base = xtermThemeFromSemantic(colors);
  return {
    ...base,
    selectionBackground: withAlpha(base.selectionBackground, 0.4),
    selectionInactiveBackground: withAlpha(base.selectionBackground, 0.22),
  };
}

export function Terminal({
  cwd,
  onTitle,
  onSpawn,
  launch,
  prime,
  venv: venvOverride,
  shell,
}: {
  cwd: string;
  /** the shell's OSC title (running program / cwd) → the tab title (native behaviour). */
  onTitle?: (title: string) => void;
  /** APP-090: the MAIN-spawned ptyId, surfaced to the parent so a session can be torn out
   *  into a floating window (which ATTACHES to this same pty; the parent never re-spawns). */
  onSpawn?: (ptyId: string) => void;
  /** a command to auto-run once the shell is live (e.g. `claude`) — how a CLI is launched. */
  launch?: string;
  /** type `launch` without executing it (no trailing enter) — for install commands. */
  prime?: boolean;
  /** a profile-resolved venv (APP-048) — overrides the active workspace venv when given
   *  (undefined = inherit the workspace venv; null = an explicit bare shell). */
  venv?: import("../../shared/ipc-contract.js").IdeActiveVenv | null;
  /** a profile-resolved shell path (APP-048); undefined = the OS default shell. */
  shell?: string;
}): ReactElement {
  const storeVenv = useGitStore((s) => s.venv);
  // a profile venv (env profile) wins; else inherit the workspace's active venv.
  const venv = venvOverride !== undefined ? venvOverride : storeVenv;
  const { colors } = useTheme();
  const termFont = useFontStore((s) => s.terminal);
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const onSpawnRef = useRef(onSpawn);
  onSpawnRef.current = onSpawn;
  // launch/prime are fixed for a session's lifetime; capture via refs so the spawn
  // effect (deps cwd/venv) reads the latest without re-subscribing.
  const launchRef = useRef(launch);
  launchRef.current = launch;
  const primeRef = useRef(prime);
  primeRef.current = prime;
  // Read the active tokens + font via refs so the pty-spawn effect (deps: cwd/venv)
  // does not re-run on a theme/font change; separate effects re-theme / re-font the
  // live terminal (08 §6) without respawning the shell.
  const colorsRef = useRef(colors);
  colorsRef.current = colors;
  const termFontRef = useRef(termFont);
  termFontRef.current = termFont;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ligAddonRef = useRef<DisposableAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  // APP-091: find-box + OSC-133 command blocks.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [matchInfo, setMatchInfo] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  });
  const findInputRef = useRef<HTMLInputElement | null>(null);
  // the optional @xterm/addon-search instance (null → the pure buffer-walk fallback runs).
  const searchAddonRef = useRef<{
    findNext(t: string, o?: unknown): boolean;
    findPrevious(t: string, o?: unknown): boolean;
    onDidChangeResults?(cb: (r: { resultIndex: number; resultCount: number }) => void): void;
    clearDecorations?(): void;
  } | null>(null);
  // OSC-133 command blocks (a ref — the parser handler mutates it outside React).
  const blocksRef = useRef<CommandBlock[]>([]);
  // buffer-walk fallback: the buffer rows of the current matches (for next/prev scrollTo).
  const matchRowsRef = useRef<number[]>([]);

  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | undefined;

    void (async () => {
      const { xterm, fit } = await loadXterm();
      if (disposed) return;
      const api = ide();
      if (!xterm || !api || !hostRef.current) {
        setStatus("unavailable");
        return;
      }
      const initFont = termFontRef.current;
      const term = new xterm.Terminal({
        fontFamily: terminalFontFamily(initFont),
        fontSize: initFont.size,
        lineHeight: initFont.lineHeight,
        cursorBlink: true,
        theme: xtermTheme(colorsRef.current),
      });
      termRef.current = term;
      if (fit) {
        const fitAddon = new fit.FitAddon();
        fitRef.current = fitAddon;
        term.loadAddon(fitAddon);
      }
      // optional OSC-52 clipboard addon (native copy/paste) — degrades if absent.
      const ClipboardAddon = await loadClipboardAddon();
      if (!disposed && ClipboardAddon) {
        try {
          term.loadAddon(new ClipboardAddon() as never);
        } catch {
          /* incompatible/absent addon — the terminal still works without it */
        }
      }
      // APP-091: optional search addon for the find-box — degrades to a pure buffer-walk when
      // absent (@xterm/addon-search is not a dep; no new dep this task).
      const SearchAddon = await loadSearchAddon();
      if (!disposed && SearchAddon) {
        try {
          const addon = new SearchAddon() as unknown as NonNullable<typeof searchAddonRef.current>;
          term.loadAddon(addon as never);
          searchAddonRef.current = addon;
          addon.onDidChangeResults?.(({ resultIndex, resultCount }) =>
            setMatchInfo({ index: resultIndex, count: resultCount }),
          );
        } catch {
          searchAddonRef.current = null;
        }
      }
      // APP-091: OSC-133 shell-integration → command blocks. The handler MUST return true or
      // xterm treats the sequence unhandled and prints the escape to the screen (the gotcha).
      // A shell with no OSC-133 integration emits none → blocksRef stays empty (AC5).
      try {
        term.parser.registerOscHandler(133, (payload: string) => {
          const parsed = parseOsc133(payload);
          if (parsed) {
            const line = term.buffer.active.baseY + term.buffer.active.cursorY;
            blocksRef.current = reduceBlocks(blocksRef.current, {
              kind: parsed.kind,
              line,
              ...(parsed.exitCode !== undefined ? { exitCode: parsed.exitCode } : {}),
            });
          }
          return true; // consume the sequence even for junk payloads (never leak to the screen)
        });
      } catch {
        /* older xterm without registerOscHandler — blocks just stay empty */
      }
      // APP-091: catch the find/nav chords at the terminal BEFORE xterm forwards them to the
      // pty (return false swallows the key so it never leaks as ^F/^N to the shell).
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== "keydown") return true;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && (e.key === "f" || e.key === "F")) {
          chordRef.current.openFind();
          return false;
        }
        if (mod && e.key === "ArrowUp") {
          chordRef.current.jumpBlock(-1);
          return false;
        }
        if (mod && e.key === "ArrowDown") {
          chordRef.current.jumpBlock(1);
          return false;
        }
        return true;
      });
      term.open(hostRef.current);
      // WAIT for the webfont BEFORE the first fit + the pty spawn. xterm measures its
      // glyph cell from the font at this moment; if the bundled font is still loading it
      // caches FALLBACK metrics (the "odd, hard-to-read" grid) and re-applying the same
      // family later is a no-op. Worse, a fit/resize AFTER the shell already drew its
      // prompt makes the shell REPRINT it (the duplicate first line + blank line). So we
      // settle the font, fit ONCE, THEN spawn at the final size — one clean prompt.
      if (typeof document !== "undefined" && document.fonts?.ready) {
        await Promise.race([
          document.fonts.ready,
          new Promise((r) => setTimeout(r, 1500)), // don't hang if the font never resolves
        ]);
        if (disposed) {
          term.dispose();
          termRef.current = null;
          return;
        }
        term.options.fontFamily = terminalFontFamily(termFontRef.current);
      }
      fitRef.current?.fit();
      // apply ligatures for the current family (best-effort, PyCharm parity).
      void applyLigatures(term, initFont, ligAddonRef);
      // the shell's title (OSC 0/2) → the tab title, like a native terminal.
      term.onTitleChange((title: string) => onTitleRef.current?.(title));
      // refit on host-element layout changes (panel/window resize) — xterm's own
      // onResize only fires from its viewport metric, so without this the PTY stays
      // stuck at the initial cols/rows and full-screen TUIs (vim/htop) wrap wrong.
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => {
          if (!disposed) fitRef.current?.fit();
        });
        ro.observe(hostRef.current);
        resizeObsRef.current = ro;
      }

      // spawn the PTY in MAIN, inheriting the active venv (§6.1). cols/rows are now final
      // (font settled + fitted), so the shell draws its prompt once at the right width.
      const spawned = await api.ptySpawn({
        cwd,
        cols: term.cols,
        rows: term.rows,
        venv: venv ?? null,
        ...(shell ? { shell } : {}),
      });
      if (disposed) {
        term.dispose();
        return;
      }
      if (!spawned.ok || !spawned.ptyId) {
        // no node-pty backend in this env → graceful notice, no fake session.
        setStatus("unavailable");
        term.dispose();
        termRef.current = null;
        return;
      }
      const ptyId = spawned.ptyId;
      ptyIdRef.current = ptyId;
      // APP-090: surface the ptyId so the panel can tear this session into a float.
      onSpawnRef.current?.(ptyId);

      // auto-run the launch command (AI CLI) once the shell is live. `prime` TYPES it
      // without executing (install commands the user should review first); otherwise
      // run it with a trailing enter.
      if (launchRef.current) {
        api.ptyWrite(ptyId, primeRef.current ? launchRef.current : `${launchRef.current}\r`);
      }

      // keystrokes → MAIN pty; pty output (over the ide:event feed) → xterm.
      term.onData((data: string) => api.ptyWrite(ptyId, data));
      term.onResize(({ cols, rows }: { cols: number; rows: number }) =>
        api.ptyResize(ptyId, cols, rows),
      );
      unsub = api.onEvent((ev: IdeEvent) => {
        if (ev.channel === "pty.data" && ev.ptyId === ptyId) term.write(ev.data);
        else if (ev.channel === "pty.exit" && ev.ptyId === ptyId) {
          term.writeln(`\r\n[process exited ${ev.exitCode}]`);
        }
      });
      setStatus("ready");
    })();

    return () => {
      disposed = true;
      unsub?.();
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      if (ptyIdRef.current) ide()?.ptyKill(ptyIdRef.current);
      termRef.current?.dispose(); // disposes loaded addons (incl. ligatures + search) too
      termRef.current = null;
      ligAddonRef.current = null;
      searchAddonRef.current = null;
      blocksRef.current = [];
      matchRowsRef.current = [];
    };
  }, [cwd, venv, shell]);

  // Re-theme the live terminal from the active tokens whenever the theme changes (08 §6
  // "Monaco + xterm themes are generated from the active token map").
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(colors);
  }, [colors]);

  // Live-apply the terminal font whenever the user changes it (Settings → Fonts).
  // No respawn — we mutate the live xterm options, toggle ligatures, then refit +
  // repaint so the grid reflows to the new metrics (PyCharm applies font changes live).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = terminalFontFamily(termFont);
    term.options.fontSize = termFont.size;
    term.options.lineHeight = termFont.lineHeight;
    void applyLigatures(term, termFont, ligAddonRef);
    fitRef.current?.fit();
    term.refresh(0, term.rows - 1);
  }, [termFont]);

  /** Read a resolved token color (xterm/addon-search can't consume `var(--x)`; it needs the
   *  concrete computed value). Returns "" when unresolved — NO hex literal ever in source, so
   *  the raw-hex guard stays satisfied (the refinement's requirement). */
  const resolveColor = useCallback((name: string): string => {
    if (typeof document === "undefined") return "";
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }, []);

  /** The addon-search decoration colors from the active tokens (warn=match, accent=active).
   *  Only non-empty keys are included so the addon uses its own default for an unresolved var. */
  const searchDecorations = useCallback((): Record<string, string> => {
    const warn = resolveColor("--warn");
    const accent = resolveColor("--accent");
    return {
      ...(warn ? { matchBackground: warn, matchOverviewRuler: warn } : {}),
      ...(accent ? { activeMatchBackground: accent, activeMatchColorOverviewRuler: accent } : {}),
    };
  }, [resolveColor]);

  /** Reconstruct the full scrollback as LOGICAL lines (wrapped rows joined) + the buffer row
   *  each starts on — the pure buffer-walk input when the search addon is absent. */
  const readLogicalLines = useCallback((term: XTerm) => {
    const buf = term.buffer.active;
    const total = buf.baseY + term.rows;
    const rows: BufferRow[] = [];
    for (let y = 0; y < total; y += 1) {
      const line = buf.getLine(y);
      rows.push({ text: line?.translateToString(true) ?? "", wrapped: line?.isWrapped ?? false });
    }
    return joinWrappedRows(rows);
  }, []);

  /** Run/refresh the search for `query`. Uses the addon (highlights all matches + count) when
   *  present; else the pure buffer-walk (nav + count + scrollTo, no per-cell highlight). */
  const runSearch = useCallback(
    (query: string) => {
      const term = termRef.current;
      if (!term) return;
      const addon = searchAddonRef.current;
      if (addon) {
        if (!query) {
          addon.clearDecorations?.();
          setMatchInfo({ index: -1, count: 0 });
          return;
        }
        addon.findNext(query, { decorations: searchDecorations(), incremental: true });
        return;
      }
      // fallback: compute match rows + count from the logical buffer.
      if (!query) {
        matchRowsRef.current = [];
        setMatchInfo({ index: -1, count: 0 });
        return;
      }
      const logical = readLogicalLines(term);
      const cols = Math.max(1, term.cols);
      const rows = searchLines(
        logical.map((l) => l.text),
        query,
      ).map((m) => (logical[m.line]?.startRow ?? 0) + Math.floor(m.start / cols));
      matchRowsRef.current = rows;
      if (rows.length > 0) {
        term.scrollToLine(rows[0]!);
        setMatchInfo({ index: 0, count: rows.length });
      } else {
        setMatchInfo({ index: -1, count: 0 });
      }
    },
    [searchDecorations, readLogicalLines],
  );

  /** Move the active match next (+1) / prev (−1). */
  const stepFind = useCallback(
    (dir: 1 | -1) => {
      const term = termRef.current;
      if (!term) return;
      const addon = searchAddonRef.current;
      if (addon) {
        if (!findQuery) return;
        const decorations = searchDecorations();
        if (dir === 1) addon.findNext(findQuery, { decorations });
        else addon.findPrevious(findQuery, { decorations });
        return;
      }
      const rows = matchRowsRef.current;
      if (rows.length === 0) return;
      setMatchInfo((info) => {
        const idx = stepMatch(rows.length, info.index, dir);
        if (idx >= 0) term.scrollToLine(rows[idx]!);
        return { index: idx, count: rows.length };
      });
    },
    [findQuery, searchDecorations],
  );

  /** Jump the viewport to the prev/next OSC-133 prompt block (Cmd/Ctrl-Up/Down). No-op when
   *  the shell emits no shell-integration markers (block list empty) — never an error (AC5). */
  const jumpBlock = useCallback((dir: 1 | -1) => {
    const term = termRef.current;
    if (!term) return;
    const target = adjacentBlockLine(blocksRef.current, term.buffer.active.viewportY, dir);
    if (target !== null) term.scrollToLine(target);
  }, []);

  const openFind = useCallback(() => {
    setFindOpen(true);
    // focus the input on the next paint (after the overlay mounts).
    setTimeout(() => findInputRef.current?.select(), 0);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    searchAddonRef.current?.clearDecorations?.();
    matchRowsRef.current = [];
    setMatchInfo({ index: -1, count: 0 });
    termRef.current?.focus();
  }, []);

  // keep the latest handlers reachable from the once-registered xterm key handler (below).
  const chordRef = useRef({ openFind, jumpBlock });
  chordRef.current = { openFind, jumpBlock };

  return (
    <div
      style={{ position: "relative", height: "100%", minHeight: 0, background: "var(--bg-inset)" }}
    >
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} aria-label="terminal" />
      {findOpen && (
        <div
          role="search"
          aria-label="terminal find"
          style={{
            position: "absolute",
            top: "var(--space-2, 4px)",
            right: "var(--space-2, 4px)",
            zIndex: Z.raise,
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2, 4px)",
            padding: "var(--space-1, 2px) var(--space-2, 4px)",
            background: "var(--bg-surface-2)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-md, 6px)",
            boxShadow: "var(--elevation-e3)",
            fontSize: "var(--text-small-size, 0.8125rem)",
          }}
        >
          <input
            ref={findInputRef}
            value={findQuery}
            // biome-ignore lint/a11y/noAutofocus: a find-box should grab focus when opened (Cmd-F)
            autoFocus
            aria-label="find in terminal"
            placeholder="Find"
            onChange={(e) => {
              const q = e.currentTarget.value;
              setFindQuery(q);
              runSearch(q);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              } else if (e.key === "Enter") {
                e.preventDefault();
                stepFind(e.shiftKey ? -1 : 1);
              }
            }}
            style={{
              width: 160,
              background: "var(--bg-app)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm, 4px)",
              padding: "2px 6px",
              font: "inherit",
              outline: "none",
            }}
          />
          <span
            aria-label="match count"
            style={{
              minWidth: 34,
              textAlign: "center",
              fontVariantNumeric: "tabular-nums",
              color: findQuery && matchInfo.count === 0 ? "var(--warn)" : "var(--text-secondary)",
            }}
          >
            {matchReadout(matchInfo.index, matchInfo.count)}
          </span>
          <button
            type="button"
            aria-label="previous match"
            title="Previous match (Shift-Enter)"
            onClick={() => stepFind(-1)}
            style={findBtn()}
          >
            ▲
          </button>
          <button
            type="button"
            aria-label="next match"
            title="Next match (Enter)"
            onClick={() => stepFind(1)}
            style={findBtn()}
          >
            ▼
          </button>
          <button
            type="button"
            aria-label="close find"
            title="Close (Esc)"
            onClick={closeFind}
            style={findBtn()}
          >
            ×
          </button>
        </div>
      )}
      {status !== "ready" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-secondary)",
            fontSize: "0.8rem",
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
            padding: 16,
            textAlign: "center",
          }}
        >
          {status === "loading"
            ? "Starting terminal…"
            : "No terminal backend (node-pty/xterm) in this build."}
        </div>
      )}
    </div>
  );
}

/** A borderless icon button for the find-box controls (matches the tab-strip button style). */
function findBtn(): import("react").CSSProperties {
  return {
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    font: "inherit",
    padding: "0 2px",
    lineHeight: 1.2,
  };
}

export default Terminal;
