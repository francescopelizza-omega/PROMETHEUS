// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/TodoView.tsx — the aggregated, CONFIGURABLE TODO / FIXME tool window (PyCharm TODO ·
 * VS Code Todo-Tree parity; JetBrains parity item 31, APP-096).
 *
 * Scans the workspace for user-configurable marker patterns (defaults: TODO/FIXME/HACK/XXX)
 * and lists them grouped by file with jump-to-source, a scope filter (project / containing
 * dir / current file) and per-marker filter chips. Reuses the SAME search infra SearchPanel
 * uses (the MAIN ripgrep backend prefilters files by content — needles derived from every
 * pattern's literal stem, so a file with ONLY HACK/XXX now surfaces; the renderer reads only
 * the hits and scans lines in the pure `todo-model` layer, C5).
 *
 * Patterns persist through the APP-017 keyed-settings surface (`todoPatterns`, global layer).
 * If that surface is unavailable at runtime, the panel falls back fail-soft to the builtin
 * four with a read-only editor + notice — it never crashes.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the stores + window.prometheus only; all
 * regex/scan/filter logic lives in the react-free/DOM-free `state/todo-model.ts`.
 */

import { Button, Panel } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";

import { detectLanguage } from "./state/lang-detect.js";
import { useTabsStore } from "./state/stores.js";
import { activeDoc } from "./state/tabs-reducer.js";
import {
  DEFAULT_TODO_PATTERNS,
  MAX_TODO_ITEMS,
  MAX_TODO_PATTERNS,
  type SkippedPattern,
  type TodoPattern,
  type TodoScanItem,
  type TodoScope,
  compilePatterns,
  filterItems,
  scanLines,
  searchNeedlesFor,
} from "./state/todo-model.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}
function settingsApi(): Window["prometheus"]["settings"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.settings : undefined;
}

/** The settings key the pattern array persists at (a `schemaKey` in tree.ts — the settings
 *  IPC gates get/set on findNodeBySchemaKey, so this must match). */
const TODO_SETTINGS_KEY = "todoPatterns";

type ScopeKind = "project" | "dir" | "file";

/** Friendly, single-line reason for a dropped pattern (drives the inline hint). */
function skipReason(s: SkippedPattern): string {
  switch (s.reason) {
    case "invalid":
      return "invalid regex";
    case "unsafe":
      return "unsafe (nested quantifier)";
    case "no-stem":
      return "no literal text to search";
    case "too-many":
      return `over the ${MAX_TODO_PATTERNS}-pattern limit`;
    default:
      return "empty";
  }
}

/** The containing-dir prefix of a file uri (`file:///a/b/c.ts` → `file:///a/b/`). */
function dirPrefixOf(uri: string): string {
  const i = uri.lastIndexOf("/");
  return i >= 0 ? uri.slice(0, i + 1) : uri;
}

export function TodoView({ root }: { root: string }): ReactElement {
  const [patterns, setPatterns] = useState<TodoPattern[]>(DEFAULT_TODO_PATTERNS);
  const [editable, setEditable] = useState(true);
  const [items, setItems] = useState<TodoScanItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [scopeKind, setScopeKind] = useState<ScopeKind>("project");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const open = useTabsStore((s) => s.open);
  const activeUri = useTabsStore((s) => activeDoc(s.tabs, s.tabs.focusedGroup)?.uri);

  // compile the patterns fail-soft; the panel scans/filters with `compiled`, and surfaces
  // `skipped` (invalid/unsafe/…) as an inline hint — never throws, never crashes the panel.
  const { compiled, skipped } = useMemo(() => compilePatterns(patterns), [patterns]);

  // hydrate persisted patterns from the keyed-settings surface (fail-soft to the builtins).
  useEffect(() => {
    const api = settingsApi();
    if (!api) {
      setEditable(false); // no settings IPC ⇒ read-only editor + notice, builtin four
      return;
    }
    let alive = true;
    void api
      .get(TODO_SETTINGS_KEY, root)
      .then((r) => {
        if (!alive) return;
        const v = r?.ok ? r.value : undefined;
        if (Array.isArray(v) && v.length > 0) setPatterns(v as TodoPattern[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [root]);

  const persist = useCallback(
    (next: TodoPattern[]) => {
      setPatterns(next);
      void settingsApi()
        ?.set(TODO_SETTINGS_KEY, next, "global", root)
        .catch(() => {});
    },
    [root],
  );

  const scan = useCallback(async () => {
    setBusy(true);
    try {
      const api = ide();
      if (!api) return;
      const needles = searchNeedlesFor(compiled);
      // prefilter to files whose CONTENT contains any marker stem (gitignore-aware, in main),
      // so we only re-read the hits — the union of every pattern's literal stem.
      const paths = new Set<string>();
      for (const needle of needles) {
        const res = await api.search({ root, query: needle, mode: "content", maxResults: 1000 });
        if (res?.ok) for (const m of res.matches) paths.add(m.path);
      }
      const out: TodoScanItem[] = [];
      for (const p of paths) {
        const uri = p.startsWith("file://") ? p : `file://${p}`;
        const read = await api.fsRead(uri);
        if (!read?.ok || read.text === undefined || read.large) continue;
        // scanLines accumulates across files against the shared MAX; true ⇒ ceiling hit.
        if (scanLines(uri, read.text.split("\n"), compiled, out, MAX_TODO_ITEMS)) break;
      }
      setItems(out);
      setScanned(true);
    } finally {
      setBusy(false);
    }
  }, [root, compiled]);

  // scan on mount + whenever the workspace root or compiled patterns change.
  useEffect(() => {
    void scan();
  }, [scan]);

  // the active scope, derived from the tabs-store active doc (project unless a doc is open).
  const scope: TodoScope = useMemo(() => {
    if (scopeKind === "file" && activeUri) return { kind: "file", uri: activeUri };
    if (scopeKind === "dir" && activeUri) return { kind: "dir", prefix: dirPrefixOf(activeUri) };
    return { kind: "project" };
  }, [scopeKind, activeUri]);

  // per-marker filter chips: every compiled pattern name, minus the hidden ones.
  const markerNames = useMemo(() => {
    const seen: string[] = [];
    for (const c of compiled) if (!seen.includes(c.name)) seen.push(c.name);
    return seen;
  }, [compiled]);

  const visible = useMemo(
    () =>
      filterItems(items, {
        scope,
        markers: hidden.size > 0 ? new Set(markerNames.filter((n) => !hidden.has(n))) : null,
      }),
    [items, scope, hidden, markerNames],
  );

  const byFile = new Map<string, TodoScanItem[]>();
  for (const it of visible) {
    const arr = byFile.get(it.uri);
    if (arr) arr.push(it);
    else byFile.set(it.uri, [it]);
  }

  const toggleMarker = (name: string): void =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 8, fontSize: "0.8rem" }}
      aria-label="todo"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ color: "var(--text-secondary)" }}>
          {visible.length} marker{visible.length === 1 ? "" : "s"}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void scan()} disabled={busy}>
          {busy ? "…" : "⟳ rescan"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setEditorOpen((o) => !o)}
          aria-label="edit patterns"
        >
          {editorOpen ? "▾ patterns" : "▸ patterns"}
        </Button>
        <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ color: "var(--text-secondary)", fontSize: "0.7rem" }}>scope</span>
          <select
            aria-label="todo scope"
            value={scopeKind}
            onChange={(e) => setScopeKind(e.target.value as ScopeKind)}
            style={{
              fontSize: "0.7rem",
              background: "var(--bg-surface-2)",
              color: "inherit",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
            }}
          >
            <option value="project">project</option>
            <option value="dir" disabled={!activeUri}>
              containing dir
            </option>
            <option value="file" disabled={!activeUri}>
              current file
            </option>
          </select>
        </label>
      </div>

      {editorOpen && (
        <PatternEditor
          patterns={patterns}
          skipped={skipped}
          editable={editable}
          onChange={persist}
        />
      )}

      {markerNames.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "4px 0 8px" }}>
          {markerNames.map((name) => {
            const on = !hidden.has(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggleMarker(name)}
                aria-pressed={on}
                style={{
                  fontSize: "0.66rem",
                  fontWeight: 600,
                  padding: "1px 7px",
                  borderRadius: 10,
                  cursor: "pointer",
                  border: "1px solid var(--border-subtle)",
                  background: on ? "var(--bg-elevated)" : "transparent",
                  color: on ? "inherit" : "var(--text-secondary)",
                  opacity: on ? 1 : 0.55,
                }}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}

      {scanned && !busy && visible.length === 0 && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          No markers found in this scope.
        </p>
      )}

      {[...byFile.entries()].map(([uri, its]) => (
        <Panel
          key={uri}
          title={uri.replace(/^file:\/\//, "").replace(`${root}/`, "")}
          elevation="e1"
        >
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {its.map((it) => (
              <li
                key={`${uri}:${it.line}`}
                style={{ display: "flex", gap: 6, alignItems: "baseline" }}
              >
                <span
                  style={{
                    color:
                      it.marker === "FIXME" || it.marker === "XXX"
                        ? "var(--danger)"
                        : "var(--warn)",
                    fontWeight: 600,
                    fontSize: "0.68rem",
                  }}
                >
                  {it.marker}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    open(uri, {
                      name: uri.split("/").pop() ?? uri,
                      languageId: detectLanguage(uri),
                      preview: true,
                    })
                  }
                  style={{
                    flex: 1,
                    textAlign: "left",
                    fontSize: "0.72rem",
                    cursor: "pointer",
                    background: "transparent",
                    border: "none",
                    color: "inherit",
                    fontFamily: "var(--font-mono, monospace)",
                    padding: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                    whiteSpace: "nowrap",
                  }}
                >
                  L{it.line + 1}: {it.text || "(no text)"}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

/** The inline pattern editor: add/remove/edit marker rows with a live invalid-regex hint.
 *  Writes through `onChange` (persisted by the parent); read-only when the settings surface
 *  is unavailable (fail-soft notice). */
function PatternEditor({
  patterns,
  skipped,
  editable,
  onChange,
}: {
  patterns: TodoPattern[];
  skipped: SkippedPattern[];
  editable: boolean;
  onChange(next: TodoPattern[]): void;
}): ReactElement {
  const edit = (i: number, patch: Partial<TodoPattern>): void =>
    onChange(patterns.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const remove = (i: number): void => onChange(patterns.filter((_, j) => j !== i));
  const add = (): void =>
    onChange([...patterns, { name: `MARK${patterns.length + 1}`, regex: "\\bMARK\\b" }]);

  const fieldStyle = {
    fontSize: "0.7rem",
    background: "var(--bg-surface-2)",
    color: "inherit",
    border: "1px solid var(--border-subtle)",
    borderRadius: 4,
    padding: "1px 4px",
  } as const;

  return (
    <div
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        padding: 8,
        marginBottom: 8,
        background: "var(--bg-surface)",
      }}
    >
      {!editable && (
        <p style={{ color: "var(--warn)", fontSize: "0.68rem", margin: "0 0 6px" }}>
          Settings unavailable — showing the builtin markers (read-only).
        </p>
      )}
      {patterns.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; no stable id exists.
        <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }}>
          <input
            aria-label={`pattern ${i + 1} name`}
            value={p.name}
            disabled={!editable}
            onChange={(e) => edit(i, { name: e.target.value })}
            style={{ ...fieldStyle, width: 70 }}
          />
          <input
            aria-label={`pattern ${i + 1} regex`}
            value={p.regex}
            disabled={!editable}
            onChange={(e) => edit(i, { regex: e.target.value })}
            style={{
              ...fieldStyle,
              flex: 1,
              minWidth: 0,
              fontFamily: "var(--font-mono, monospace)",
            }}
          />
          <label
            style={{ display: "flex", alignItems: "center", gap: 2, fontSize: "0.64rem" }}
            title="case sensitive"
          >
            <input
              type="checkbox"
              aria-label={`pattern ${i + 1} case sensitive`}
              disabled={!editable}
              checked={p.caseSensitive !== false}
              onChange={(e) => edit(i, { caseSensitive: e.target.checked })}
            />
            Aa
          </label>
          <button
            type="button"
            aria-label={`remove pattern ${i + 1}`}
            disabled={!editable}
            onClick={() => remove(i)}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-secondary)",
              cursor: editable ? "pointer" : "default",
            }}
          >
            ✕
          </button>
        </div>
      ))}
      {editable && patterns.length < MAX_TODO_PATTERNS && (
        <Button size="sm" variant="ghost" onClick={add}>
          + pattern
        </Button>
      )}
      {skipped.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: "6px 0 0",
            padding: 0,
            color: "var(--danger)",
            fontSize: "0.66rem",
          }}
        >
          {skipped.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: transient hint list.
            <li key={i}>
              ⚠ {s.pattern.name || s.pattern.regex}: {skipReason(s)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default TodoView;
