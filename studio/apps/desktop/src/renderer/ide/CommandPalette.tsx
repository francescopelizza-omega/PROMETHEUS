/**
 * ide/CommandPalette.tsx — the fused tabbed "Search Everywhere" popup (file 07 §8 · MDS
 * parity plan 05 · APP-021).
 *
 * ONE popup, six tabs — All · Actions · Files · Symbols · Text · Git — with a right-pane
 * file preview of the selected result (JetBrains double-⇧ parity). The four legacy
 * single-source keybindings (Cmd-Shift-P commands, Cmd-P files, Cmd-T symbols, Cmd-F12
 * structure) still open the popup, now on the equivalent TAB (`tabForMode`), and the query
 * survives tab switches. The All tab queries every source concurrently and interleaves them
 * with the PURE `fuseResults` ranker (per-source min-max normalization + caps + round-robin
 * so no source floods). Each async source is stale-guarded (a per-effect `alive` flag tears
 * down with the query, so a slow `workspace/symbol` can't clobber a newer `ide:search`).
 *
 * The command surface MIRRORS the core editor command registry (ids match `prometheus`'s parity
 * surface, §8/§10) via the pure `PALETTE_COMMANDS`. Ranking is the pure fuzzy matcher; the
 * fuse/tab math is the pure `search-preview` module. All IPC lives here (C5: the pure
 * modules never touch window.prometheus / monaco).
 *
 * Renderer-SANDBOXED (C5): react + the pure matchers + the stores + window.prometheus +
 * lazy monaco (for the preview's static colorize only — never a full editor instance).
 */

import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { IdeGitLogEntry, IdeSearchMatch, IdeTreeNode } from "../../shared/ipc-contract.js";
import { activeDescendantProps, optionProps, useFocusTrap } from "../shell/a11y.js";
import { loadMonaco } from "./monaco-loader.js";
import { useCodeIndexStore } from "./state/code-index-store.js";
import { searchSymbols } from "./state/code-index.js";
import { fuzzyRank, fuzzyScore, highlightSegments } from "./state/fuzzy.js";
import { detectLanguage, hasKnownLsp } from "./state/lang-detect.js";
import { type NormalizedSymbol, normalizeSymbols } from "./state/lsp-convert.js";
import { PALETTE_COMMANDS } from "./state/palette-commands.js";
import { type RunConfig, type RunPickerRow, buildRunPickerRows } from "./state/run-config.js";
import {
  type Ranked,
  SEARCH_TABS,
  type SearchSource,
  type SearchTab,
  clipLineForDisplay,
  cycleTab,
  fuseResults,
  matchFile,
  tabForMode,
} from "./state/search-preview.js";
import { useTabsStore } from "./state/stores.js";
import { mergeFederatedSymbols } from "./state/symbol-federation.js";
import { activeDoc } from "./state/tabs-reducer.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

// Re-exported so existing importers keep working (the surface + its exhaustiveness contract
// live in the PURE state/palette-commands.ts; node:test pins every id to a dispatcher).
export { PALETTE_COMMANDS };
export type { PaletteCommand } from "./state/palette-commands.js";

export interface CommandPaletteProps {
  /**
   * Which TAB to open on. Accepts the new tab ids ("all"|"actions"|"files"|"symbols"|
   * "text"|"git") AND the legacy single-source strings ("commands"|"files"|"symbols"|
   * "structure") the existing keybindings pass — both are folded through `tabForMode`.
   */
  mode: SearchTab | "commands" | "structure" | "run";
  /** the workspace root for the file walk / grep / git sources. */
  root: string;
  /** dispatch a chosen command id to the shell (which wires the body). */
  onRunCommand(id: string): void;
  onClose(): void;
  /** run-picker mode (⌘⇧R, APP-034): the named configs to list. */
  runConfigs?: RunConfig[];
  /** run-picker mode: dispatch the chosen row (named config or freeform argv). */
  onRunPick?(row: RunPickerRow): void;
}

/** How many context lines each side of the target line the preview shows. */
const PREVIEW_CONTEXT = 6;
/** Cap the workspace file walk (quick-open) + symbol/grep result sizes. */
const MAX_FILES = 2000;

/** One ranked palette row — the pure `Ranked` shape plus the UI payload the list renders
 *  and `choose` acts on. `line`/`character` are 0-based (LSP convention); reveal adds 1. */
interface Row extends Ranked {
  key: string;
  source: SearchSource;
  score: number;
  label: string;
  sub: string;
  positions: number[];
  /** a file/symbol/text row's jump target. */
  uri?: string;
  line?: number;
  character?: number;
  /** an Actions row's command id (executed via onRunCommand). */
  commandId?: string;
  /** a Git row (commit subject/hash or branch) → opens the Source Control surface. */
  git?: boolean;
  /** a Text row → the preview highlights the query match on the target line. */
  textQuery?: string;
  /** a run-picker row (mode "run"): named config or the freeform argv line. */
  runRow?: RunPickerRow;
}

const SOURCE_LABEL: Record<SearchSource, string> = {
  actions: "action",
  files: "file",
  symbols: "symbol",
  text: "text",
  git: "git",
};

/** A workspace/symbol result mapped to a jump target (tolerates a rangeless WorkspaceSymbol
 *  — LSP 3.17 defers to workspaceSymbol/resolve; line defaults to 0 and the preview must not
 *  assume a valid line before resolve). */
interface WsSymbol {
  name: string;
  container: string;
  uri: string;
  line: number;
  character: number;
  /** APP-077: the owning LSP server's language (row badge); "" for code-index/local rows. */
  lang: string;
}
function normalizeWsSymbols(result: unknown): WsSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: WsSymbol[] = [];
  for (const s of result) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const loc = o.location as
      | { uri?: unknown; range?: { start?: { line?: unknown; character?: unknown } } }
      | undefined;
    const uri = typeof loc?.uri === "string" ? loc.uri : "";
    if (!uri || typeof o.name !== "string") continue;
    out.push({
      name: o.name,
      container: typeof o.containerName === "string" ? o.containerName : "",
      uri,
      line: typeof loc?.range?.start?.line === "number" ? loc.range.start.line : 0,
      character: typeof loc?.range?.start?.character === "number" ? loc.range.start.character : 0,
      lang: "", // set per-server by the federation merge
    });
  }
  return out;
}

/** A flattened document symbol (File Structure / ⌘F12) → a jump target + container path. */
interface FlatSym {
  name: string;
  detail: string;
  container: string;
  uri: string;
  line: number;
  character: number;
}
function flattenSymbols(syms: NormalizedSymbol[], uri: string, parent: string): FlatSym[] {
  const out: FlatSym[] = [];
  for (const s of syms) {
    out.push({
      name: s.name || "?",
      detail: s.detail ?? "",
      container: parent,
      uri,
      line: s.selectionRange.start.line,
      character: s.selectionRange.start.character,
    });
    if (s.children.length > 0) {
      out.push(...flattenSymbols(s.children, uri, parent ? `${parent}.${s.name}` : s.name));
    }
  }
  return out;
}

async function collectFiles(dir: string, acc: string[]): Promise<void> {
  if (acc.length >= MAX_FILES) return;
  const nodes = (await ide()?.fsTree(dir)) ?? [];
  for (const n of nodes as IdeTreeNode[]) {
    if (acc.length >= MAX_FILES) return;
    if (n.kind === "dir") await collectFiles(n.path, acc);
    else acc.push(n.path);
  }
}

/** Bold the fuzzy-matched runs of a label. */
function Highlighted({ text, positions }: { text: string; positions: number[] }): ReactElement {
  return (
    <>
      {highlightSegments(text, positions).map((seg, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positionally derived + stable
          key={i}
          style={seg.matched ? { color: "var(--accent, #6d5ef0)", fontWeight: 700 } : undefined}
        >
          {seg.text}
        </span>
      ))}
    </>
  );
}

const relOf = (uri: string, root: string): string =>
  uri.replace(/^file:\/\//, "").replace(`${root}/`, "");

export function CommandPalette(props: CommandPaletteProps): ReactElement {
  const { mode, root, onRunCommand, onClose } = props;
  // run-picker mode (APP-034): one flat list (configs + the always-last freeform
  // row); the search-source machinery below stays idle.
  const runMode = mode === "run";
  const [tab, setTab] = useState<SearchTab>(() => tabForMode(runMode ? "all" : mode));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const open = useTabsStore((s) => s.open);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // APP-100: trap Tab inside the dialog + restore focus to the opener on close (all close
  // paths unmount the palette, so the trap's cleanup fires for Esc AND execute uniformly).
  useFocusTrap(dialogRef, true);
  const LISTBOX_ID = "cmdp-listbox";

  // cached (open-once) sources: file walk, doc symbols, git log + branches.
  const [files, setFiles] = useState<string[]>([]);
  const [docSymbols, setDocSymbols] = useState<FlatSym[]>([]);
  const [gitCommits, setGitCommits] = useState<IdeGitLogEntry[]>([]);
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  // debounced query-driven sources: workspace/symbol + grep.
  const [wsSymbols, setWsSymbols] = useState<WsSymbol[]>([]);
  const [textHits, setTextHits] = useState<IdeSearchMatch[]>([]);

  // re-sync the active tab when a legacy keybinding re-opens on a different mode.
  useEffect(() => {
    if (mode !== "run") setTab(tabForMode(mode));
  }, [mode]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ── cached sources: load once on open (cheap or one-shot; filtered client-side) ──
  useEffect(() => {
    if (runMode) return;
    let alive = true;
    void (async () => {
      const acc: string[] = [];
      await collectFiles(root, acc);
      if (alive) setFiles(acc);
    })();
    return () => {
      alive = false;
    };
  }, [root, runMode]);

  useEffect(() => {
    if (runMode) return;
    let alive = true;
    void (async () => {
      const api = ide();
      if (!api) return;
      const [log, br] = await Promise.all([
        api.gitLog(root, 300).catch(() => undefined),
        api.gitBranches(root).catch(() => undefined),
      ]);
      if (!alive) return;
      setGitCommits(log?.ok ? log.entries : []);
      setGitBranches(br?.ok ? br.branches : []);
    })();
    return () => {
      alive = false;
    };
  }, [root, runMode]);

  // File Structure (⌘F12): the ACTIVE file's documentSymbol, flattened, loaded once.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const api = ide();
      const tabs = useTabsStore.getState().tabs;
      const doc = activeDoc(tabs, tabs.focusedGroup);
      if (!api || !doc || !hasKnownLsp(doc.languageId) || doc.uri.startsWith("scratch:")) {
        if (alive) setDocSymbols([]);
        return;
      }
      const ens = await api.lspEnsure(doc.languageId, root).catch(() => undefined);
      if (!ens?.ok || !ens.serverId) {
        if (alive) setDocSymbols([]);
        return;
      }
      const r = await api
        .lspRequest(ens.serverId, root, "textDocument/documentSymbol", {
          textDocument: { uri: doc.uri },
        })
        .catch(() => undefined);
      if (alive)
        setDocSymbols(r?.ok ? flattenSymbols(normalizeSymbols(r.result), doc.uri, "") : []);
    })();
    return () => {
      alive = false;
    };
  }, [root]);

  // ── query-driven: workspace/symbol (200ms; runs for the symbols + all tabs). The
  //    per-effect `alive` flag IS the stale-response guard — when the query changes, the
  //    prior closure's `alive` is already false, so a slow LSP resolve can't clobber. ──
  useEffect(() => {
    if (tab !== "symbols" && tab !== "all") return;
    let alive = true;
    const local = (): WsSymbol[] =>
      searchSymbols(useCodeIndexStore.getState().index, query.trim(), 200).map((s) => ({
        name: s.name,
        container: s.container,
        uri: s.uri,
        line: s.line,
        character: 0,
        lang: "",
      }));
    const t = setTimeout(async () => {
      const q = query.trim();
      const api = ide();
      const tabs = useTabsStore.getState().tabs;
      const doc = activeDoc(tabs, tabs.focusedGroup);
      // spawn the ACTIVE file's server (the only place we spawn — never spawn just to search).
      if (api && doc && hasKnownLsp(doc.languageId) && !doc.uri.startsWith("scratch:")) {
        await api.lspEnsure(doc.languageId, root).catch(() => undefined);
      }
      // APP-077: FEDERATE — fan workspace/symbol to EVERY running server for THIS root.
      const listed = api ? await api.lspList().catch(() => undefined) : undefined;
      const servers = (listed?.ok ? listed.servers : []).filter(
        (s) => s.workspaceRoot === root && (s.state === "running" || s.state === "starting"),
      );
      if (!api || servers.length === 0) {
        if (alive) setWsSymbols(local());
        return;
      }
      // per-request 800ms cap so one hanging server doesn't stall the whole merged render.
      const withTimeout = <T,>(p: Promise<T>): Promise<T | undefined> =>
        Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), 800))]);
      const settled = await Promise.allSettled(
        servers.map(async (s) => {
          const r = await withTimeout(
            api
              .lspRequest(s.serverId, root, "workspace/symbol", { query: q })
              .catch(() => undefined),
          );
          return { lang: s.languageId, symbols: r?.ok ? normalizeWsSymbols(r.result) : [] };
        }),
      );
      if (!alive) return; // a newer keystroke won — drop this (allSettled waits for the slowest)
      const batches = settled.flatMap((b) =>
        b.status === "fulfilled" && b.value ? [b.value] : [],
      );
      const merged = mergeFederatedSymbols(batches).slice(0, 200);
      setWsSymbols(merged.length > 0 ? merged : local());
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [tab, query, root]);

  // ── query-driven: grep (150ms; runs for the text + all tabs). Empty query → NO grep
  //    (an empty query must not trigger a full-tree walk). Bounded + stale-guarded. ──
  useEffect(() => {
    if (tab !== "text" && tab !== "all") return;
    const q = query.trim();
    if (q === "") {
      setTextHits([]);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      const r = await ide()
        ?.search({ root, query: q, mode: "content", maxResults: 200 })
        .catch(() => undefined);
      if (alive) setTextHits(r?.ok ? r.matches : []);
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [tab, query, root]);

  // ── per-source ranked rows (pure, memoized) ──────────────────────────────────
  const actionRows = useMemo<Row[]>(
    () =>
      fuzzyRank(query, PALETTE_COMMANDS, (c) => `${c.category} ${c.title}`).map((m) => ({
        key: `action:${m.item.id}`,
        source: "actions",
        score: m.score,
        label: m.item.title,
        sub: m.item.category,
        positions: m.positions,
        commandId: m.item.id,
      })),
    [query],
  );

  const fileRows = useMemo<Row[]>(
    () =>
      fuzzyRank(query, files, (f) => f).map((m) => ({
        key: `file:${m.item}`,
        source: "files",
        score: m.score,
        label: m.item.replace(/^.*[\\/]/, ""),
        sub: relOf(`file://${m.item}`, root),
        positions: m.positions,
        uri: m.item.startsWith("file://") ? m.item : `file://${m.item}`,
        line: 0, // a plain file row previews the file head (no specific target line)
        character: 0,
      })),
    [query, files, root],
  );

  const symbolRows = useMemo<Row[]>(() => {
    // merge workspace symbols with the active file's structure (deduped), then rank by name.
    const merged: WsSymbol[] = [
      ...wsSymbols,
      ...docSymbols.map((d) => ({
        name: d.name,
        container: d.container || d.detail,
        uri: d.uri,
        line: d.line,
        character: d.character,
        lang: "",
      })),
    ];
    const seen = new Set<string>();
    const uniq = merged.filter((s) => {
      const k = `${s.uri}:${s.line}:${s.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return fuzzyRank(query, uniq, (s) => s.name).map((m, i) => ({
      key: `sym:${m.item.uri}:${m.item.line}:${m.item.character}:${i}`,
      source: "symbols",
      score: m.score,
      label: m.item.name,
      sub: `${m.item.lang ? `[${m.item.lang}] ` : ""}${m.item.container ? `${m.item.container} · ` : ""}${relOf(m.item.uri, root)}`,
      positions: m.positions,
      uri: m.item.uri,
      line: m.item.line,
      character: m.item.character,
    }));
  }, [wsSymbols, docSymbols, query, root]);

  const textRows = useMemo<Row[]>(() => {
    const q = query.trim();
    return textHits.map((m, i) => ({
      key: `text:${m.path}:${m.line ?? 0}:${i}`,
      source: "text",
      // backend walk order = relevance; descending score so earlier hits rank higher.
      score: textHits.length - i,
      label: m.rel,
      sub: m.line !== undefined ? `:${m.line}` : "",
      positions: [],
      uri: m.path.startsWith("file://") ? m.path : `file://${m.path}`,
      line: m.line !== undefined ? Math.max(0, m.line - 1) : 0,
      character: 0,
      textQuery: q,
    }));
  }, [textHits, query]);

  const gitRows = useMemo<Row[]>(() => {
    const q = query.trim();
    const out: Row[] = [];
    gitBranches.forEach((b, i) => {
      const r = q === "" ? { score: gitBranches.length - i } : fuzzyScore(q, b);
      if (r) {
        out.push({
          key: `git:branch:${b}`,
          source: "git",
          score: r.score,
          label: b,
          sub: "branch",
          positions: [],
          git: true,
        });
      }
    });
    gitCommits.forEach((c, i) => {
      const short = c.hash.slice(0, 8);
      const r =
        q === "" ? { score: gitCommits.length - i } : fuzzyScore(q, `${short} ${c.subject}`);
      if (r) {
        out.push({
          key: `git:commit:${c.hash}`,
          source: "git",
          score: r.score,
          label: c.subject,
          sub: `${short}${c.author ? ` · ${c.author}` : ""}`,
          positions: [],
          git: true,
        });
      }
    });
    return out.sort((a, b) => b.score - a.score);
  }, [gitCommits, gitBranches, query]);

  const runRows = useMemo<Row[]>(() => {
    if (!runMode) return [];
    return buildRunPickerRows(query, props.runConfigs ?? [], fuzzyScore).map((r) => ({
      key: r.kind === "freeform" ? "run:freeform" : `run:${r.label}`,
      source: "actions",
      score: r.score,
      label: r.kind === "freeform" ? (r.label === "" ? "Run Anything…" : r.label) : r.label,
      sub:
        r.kind === "freeform"
          ? r.argv.length > 0
            ? `run anything → ${JSON.stringify(r.argv)}`
            : "type a command line — argv, no shell"
          : r.compound
            ? "compound configuration"
            : "run configuration",
      positions: r.positions,
      runRow: r,
    })) as Row[];
  }, [runMode, query, props.runConfigs]);

  const rows = useMemo<Row[]>(() => {
    if (runMode) return runRows;
    switch (tab) {
      case "actions":
        return actionRows;
      case "files":
        return fileRows;
      case "symbols":
        return symbolRows;
      case "text":
        return textRows;
      case "git":
        return gitRows;
      default:
        return fuseResults<Row>([actionRows, fileRows, symbolRows, textRows, gitRows], query);
    }
  }, [runMode, runRows, tab, actionRows, fileRows, symbolRows, textRows, gitRows, query]);

  // keep the active index in range as the list changes.
  useEffect(() => {
    // clamp BOTH ends: an empty-result ArrowDown could leave `active` at -1, which then drives
    // aria-activedescendant to a non-existent option id and makes Enter (choose(-1)) a no-op.
    setActive((a) => Math.max(0, Math.min(a, rows.length - 1)));
  }, [rows.length]);

  const selected = rows[active];

  const choose = useCallback(
    (index: number) => {
      const item = rows[index];
      if (!item) return;
      if (item.runRow) {
        // an empty freeform argv is refused (nothing spawnable) — keep the picker open.
        if (item.runRow.kind === "freeform" && item.runRow.argv.length === 0) return;
        props.onRunPick?.(item.runRow);
        onClose();
        return;
      }
      if (item.commandId) {
        onRunCommand(item.commandId);
      } else if (item.git) {
        // open the Source Control surface (branch graph + commit log, APP-036).
        onRunCommand("git.commit");
      } else if (item.uri) {
        open(item.uri, {
          name: item.uri.split("/").pop() ?? item.uri,
          languageId: detectLanguage(item.uri),
          preview: true,
        });
        const line = (item.line ?? 0) + 1;
        const column = (item.character ?? 0) + 1;
        setTimeout(
          () =>
            window.dispatchEvent(
              new CustomEvent("ide:reveal-position", { detail: { line, column } }),
            ),
          160,
        );
      }
      onClose();
    },
    [rows, onRunCommand, open, onClose, props.onRunPick],
  );

  const switchTab = useCallback((next: SearchTab) => {
    setTab(next);
    setActive(0);
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
        background: "rgba(0,0,0,0.4)",
        zIndex: 1100,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: 60,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="search everywhere"
        style={{
          width: "min(880px, 94vw)",
          maxHeight: "76vh",
          background: "var(--bg-surface-2, #16161b)",
          border: "1px solid var(--border-subtle, #232329)",
          borderRadius: "var(--radius-md, 8px)",
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* tab strip (hidden in the run picker — one flat list) */}
        {!runMode && (
          <div
            aria-label="search sources"
            style={{
              display: "flex",
              gap: 2,
              padding: "6px 8px 0",
              borderBottom: "1px solid var(--border-subtle, #232329)",
            }}
          >
            {SEARCH_TABS.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={tab === t}
                onClick={() => switchTab(t)}
                style={{
                  padding: "5px 12px",
                  border: "none",
                  borderBottom:
                    tab === t ? "2px solid var(--accent, #6d5ef0)" : "2px solid transparent",
                  background: "transparent",
                  color:
                    tab === t ? "var(--text-primary, #e7e7ea)" : "var(--text-secondary, #9a9aa3)",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                  textTransform: "capitalize",
                  font: "inherit",
                }}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.max(0, Math.min(a + 1, rows.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Tab") {
              // Tab / Shift-Tab cycle the source tabs (query preserved).
              e.preventDefault();
              switchTab(cycleTab(tab, e.shiftKey ? -1 : 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(active);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder={
            runMode
              ? "Run a configuration — or type any command line (argv, no shell)…"
              : "Search everywhere — actions, files, symbols, text, git…"
          }
          aria-label="palette query"
          {...activeDescendantProps(LISTBOX_ID, active, rows.length)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--border-subtle, #232329)",
            color: "var(--text-primary, #e7e7ea)",
            fontSize: "0.9rem",
            outline: "none",
          }}
        />

        {/* results + preview */}
        <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
          <div
            style={{
              width: "44%",
              minWidth: 260,
              overflow: "auto",
              borderRight: "1px solid var(--border-subtle, #232329)",
            }}
          >
            {rows.length === 0 && (
              <p
                style={{
                  padding: 12,
                  color: "var(--text-secondary, #9a9aa3)",
                  fontSize: "0.82rem",
                }}
              >
                No matches.
              </p>
            )}
            {/* biome-ignore lint/a11y/useFocusableInteractive: options are driven by aria-activedescendant on the combobox input (APG combobox pattern) — DOM focus stays on the input, not the options. */}
            {/* biome-ignore lint/a11y/useSemanticElements: a role="listbox" of <button> options is the APG combobox listbox; a native <select> can't host the rich two-line option rows + preview. */}
            <div role="listbox" id={LISTBOX_ID} aria-label="results">
              {rows.map((item, i) => (
                <button
                  key={item.key}
                  type="button"
                  {...optionProps(LISTBOX_ID, i, i === active)}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    padding: "6px 12px",
                    cursor: "pointer",
                    background: i === active ? "var(--bg-surface-3, #1d1d24)" : "transparent",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    font: "inherit",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span
                      style={{
                        fontSize: "0.85rem",
                        color: "var(--text-primary, #e7e7ea)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <Highlighted text={item.label} positions={item.positions} />
                    </span>
                    <span
                      style={{
                        fontSize: "0.72rem",
                        color: "var(--text-secondary, #9a9aa3)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.sub}
                    </span>
                  </span>
                  {tab === "all" && (
                    <span
                      style={{
                        fontSize: "0.6rem",
                        textTransform: "uppercase",
                        color: "var(--text-secondary, #9a9aa3)",
                        border: "1px solid var(--border-subtle, #232329)",
                        borderRadius: "var(--radius-sm, 4px)",
                        padding: "0 4px",
                        flexShrink: 0,
                      }}
                    >
                      {SOURCE_LABEL[item.source]}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <Preview row={selected} root={root} />
        </div>
      </div>
    </div>
  );
}

/** The right-pane preview of the selected row. A file/symbol/text row loads the file via the
 *  path-guarded fs IPC and shows a syntax-lit excerpt centered on the target line (context
 *  colorized via monaco's STATIC colorize — never a full editor instance, so ↑/↓ doesn't
 *  leak web workers). A Text row also highlights the query match on the target line. Command
 *  rows show the id/category instead. */
function Preview({ row, root }: { row: Row | undefined; root: string }): ReactElement {
  const [text, setText] = useState<string | null>(null);
  const [colorized, setColorized] = useState<string[] | null>(null);

  const uri = row?.uri;
  const line = row?.line;

  useEffect(() => {
    if (!uri) {
      setText(null);
      setColorized(null);
      return;
    }
    let alive = true;
    void (async () => {
      const r = await ide()
        ?.fsRead(uri)
        .catch(() => undefined);
      if (!alive) return;
      setText(r?.ok && typeof r.text === "string" ? r.text : null);
      setColorized(null);
    })();
    return () => {
      alive = false;
    };
  }, [uri]);

  const excerpt = useMemo(() => {
    if (text === null || line === undefined) return null;
    const lines = text.split("\n");
    const target = Math.max(0, Math.min(line, lines.length - 1));
    const from = Math.max(0, target - PREVIEW_CONTEXT);
    const to = Math.min(lines.length, target + PREVIEW_CONTEXT + 1);
    return { lines: lines.slice(from, to), from, target };
  }, [text, line]);

  // static-colorize the context lines (skip the target line — it may need a match overlay).
  useEffect(() => {
    if (!excerpt || !uri) {
      setColorized(null);
      return;
    }
    let alive = true;
    void (async () => {
      const monaco = await loadMonaco();
      if (!monaco || !alive) return;
      const lang = detectLanguage(uri);
      const html = await Promise.all(
        excerpt.lines.map((l) => monaco.editor.colorize(l.length ? l : " ", lang, {})),
      );
      if (alive) setColorized(html);
    })();
    return () => {
      alive = false;
    };
  }, [excerpt, uri]);

  const wrap = (children: ReactElement | ReactElement[] | string): ReactElement => (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        overflow: "auto",
        padding: "8px 4px",
        fontFamily: "var(--font-mono, monospace)",
        fontSize: "0.75rem",
        lineHeight: 1.5,
        color: "var(--text-primary, #e7e7ea)",
        background: "var(--bg-surface-1, #101014)",
      }}
    >
      {children}
    </div>
  );

  if (!row) {
    return wrap(
      <span style={{ color: "var(--text-secondary, #9a9aa3)" }}>Select a result to preview.</span>,
    );
  }
  // command / git rows have no file → show the id/category instead of an excerpt.
  if (!uri) {
    return wrap(
      <div style={{ padding: 4 }}>
        <div style={{ color: "var(--text-primary, #e7e7ea)", fontSize: "0.85rem" }}>
          {row.label}
        </div>
        <div style={{ color: "var(--text-secondary, #9a9aa3)", marginTop: 4 }}>
          {row.runRow?.kind === "freeform" && row.runRow.argv.length > 0
            ? `argv: ${JSON.stringify(row.runRow.argv)}`
            : row.commandId
              ? `command · ${row.commandId}`
              : row.sub}
        </div>
      </div>,
    );
  }
  if (text === null) {
    return wrap(<span style={{ color: "var(--text-secondary, #9a9aa3)" }}>Loading…</span>);
  }
  if (!excerpt) {
    return wrap(
      <span style={{ color: "var(--text-secondary, #9a9aa3)" }}>{relOf(uri, root)}</span>,
    );
  }

  return wrap(
    <>
      <div
        style={{
          color: "var(--text-secondary, #9a9aa3)",
          padding: "0 8px 6px",
          borderBottom: "1px solid var(--border-subtle, #232329)",
          marginBottom: 4,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {relOf(uri, root)}
      </div>
      {excerpt.lines.map((lineText, i) => {
        const lineNo = excerpt.from + i;
        const isTarget = lineNo === excerpt.target;
        return (
          <div
            key={lineNo}
            style={{
              display: "flex",
              gap: 8,
              padding: "0 8px",
              background: isTarget ? "var(--bg-inset, #0c0c10)" : "transparent",
              borderLeft: isTarget ? "2px solid var(--accent, #6d5ef0)" : "2px solid transparent",
            }}
          >
            <span
              style={{
                color: "var(--text-tertiary, #6a6a73)",
                width: 34,
                textAlign: "right",
                flexShrink: 0,
                userSelect: "none",
              }}
            >
              {lineNo + 1}
            </span>
            <PreviewLine
              text={lineText}
              html={colorized?.[i]}
              highlight={isTarget && row.textQuery ? row.textQuery : undefined}
            />
          </div>
        );
      })}
    </>,
  );
}

/** One preview line: plain text with a match highlight when this is a Text-tab target line
 *  (search-preview `matchFile` on the single line → offsets, clipped for long lines);
 *  otherwise the monaco static-colorized HTML (falls back to escaped plain text). */
function PreviewLine({
  text,
  html,
  highlight,
}: {
  text: string;
  html?: string;
  highlight?: string;
}): ReactElement {
  const cell = { flex: 1, minWidth: 0, whiteSpace: "pre" as const, overflow: "hidden" };
  if (highlight) {
    const fm = matchFile("file:///x", text, { pattern: highlight }, "");
    const first = fm?.matches[0];
    if (first) {
      const clip = clipLineForDisplay(text, first.start, first.end);
      return (
        <span style={cell}>
          {clip.clippedLeft ? "…" : ""}
          {clip.text.slice(0, clip.start)}
          <span
            style={{
              background: "var(--accent-muted, rgba(109,94,240,0.35))",
              color: "var(--text-primary, #e7e7ea)",
            }}
          >
            {clip.text.slice(clip.start, clip.end)}
          </span>
          {clip.text.slice(clip.end)}
          {clip.clippedRight ? "…" : ""}
        </span>
      );
    }
  }
  if (html !== undefined) {
    // colorize output is trusted monaco token markup (no user HTML) — see loadMonaco.
    // biome-ignore lint/security/noDangerouslySetInnerHtml: monaco static colorize markup only
    return <span style={cell} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <span style={cell}>{text}</span>;
}

export default CommandPalette;
