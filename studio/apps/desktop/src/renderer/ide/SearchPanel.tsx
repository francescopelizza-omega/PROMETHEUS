// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/SearchPanel.tsx — project-wide search/replace-in-path (file 07 §6.3, APP-024).
 *
 * Search results + a replace PREVIEW TREE (per-file → per-match toggles) shown BEFORE
 * any write — the same accept/reject discipline as AI edits (§7.4). The match + replace
 * MATH is the PURE search-preview module (node:test-ed). Candidate discovery runs in
 * MAIN over `ide:search` (bounded, gitignore-aware, include/exclude-glob scoped) — the
 * renderer reads ONLY the hit files and previews them in the pure layer; regex queries
 * pre-filter by their `requiredLiteral` (or fall back to the bounded path enumeration).
 * Writes go through window.prometheus.ide.fsWrite (path-guarded MAIN fs, C5), always
 * stale-guarded (`applyToFreshText`) and — for bulk — behind an explicit confirm step.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the pure search math + the stores +
 * window.prometheus only.
 */

import { Button, Panel } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useCallback, useMemo, useState } from "react";

import type { IdeStructMatch } from "../../shared/ipc-contract.js";
import { detectLanguage } from "./state/lang-detect.js";
import { applyReplacements } from "./state/replace-apply.js";
import {
  type FileMatches,
  type SearchQuery,
  allMatchIds,
  applyToFreshText,
  countMatches,
  matchFile,
  requiredLiteral,
  toggleMatch,
} from "./state/search-preview.js";
import { useTabsStore } from "./state/stores.js";
import { structMatchesToLineMatches } from "./state/structsearch-map.js";
import { useUsagesStore } from "./state/usages-store.js";
import {
  type Usage,
  type UsageScope,
  countUsages,
  filterScope,
  groupByFile,
} from "./state/usages.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

const MAX_FILES = 500; // cap on hit files the renderer will read for previewing.

/** Split a comma-separated glob field into trimmed non-empty patterns. */
function parseGlobs(field: string): string[] {
  return field
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g !== "");
}

export function SearchPanel({ root }: { root: string }): ReactElement {
  // APP-023: the same tool window doubles as the Find-Usages view — when a fan-in has run
  // (useUsagesStore.active) the panel shows the grouped usages tree instead of search.
  const usagesActive = useUsagesStore((s) => s.active);
  if (usagesActive) return <UsagesView root={root} />;
  return <SearchView root={root} />;
}

/** The bulk-apply plan shown by the explicit confirm step (computed AFTER stale-skips). */
interface BulkPlan {
  files: number;
  matches: number;
  staleFiles: number;
}

function SearchView({ root }: { root: string }): ReactElement {
  const [pattern, setPattern] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  // APP-076: structural (AST) search mode — routes the query to the structsearch.py sidecar.
  const [isStructural, setIsStructural] = useState(false);
  const [includeField, setIncludeField] = useState("");
  const [excludeField, setExcludeField] = useState("");
  const [scopeDir, setScopeDir] = useState("");
  const [results, setResults] = useState<FileMatches[]>([]);
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [confirmPlan, setConfirmPlan] = useState<BulkPlan | null>(null);
  const [notice, setNotice] = useState("");
  // the query the CURRENT results were produced with (state may drift before re-search).
  const [ranQuery, setRanQuery] = useState<{ q: SearchQuery; replaceWith: string } | null>(null);
  const open = useTabsStore((s) => s.open);

  const search = useCallback(async () => {
    if (!pattern.trim() || busy) return;
    setBusy(true);
    setConfirmPlan(null);
    setNotice("");
    const query: SearchQuery = { pattern, isRegex, matchCase, wholeWord };
    try {
      const api = ide();
      // APP-076: STRUCTURAL mode — the structsearch.py sidecar walks the tree in MAIN (AST
      // match, `$X` metavars) and returns matches; map them into the SAME preview tree so
      // per-match accept/reject + fsWrite replace reuse the existing apply path.
      if (isStructural) {
        const scope0 = scopeDir.trim();
        const structRoot =
          scope0 === "" ? root : scope0.startsWith("/") ? scope0 : `${root}/${scope0}`;
        const sr = await api?.structSearch(structRoot, pattern);
        if (sr && !sr.ok && sr.error) setNotice(sr.error);
        const byFile = new Map<string, IdeStructMatch[]>();
        for (const m of sr?.ok ? sr.matches : []) {
          const uri = m.file.startsWith("file://") ? m.file : `file://${m.file}`;
          const arr = byFile.get(uri);
          if (arr) arr.push(m);
          else byFile.set(uri, [m]);
        }
        const out: FileMatches[] = [];
        const sel: Record<string, string[]> = {};
        for (const [uri, ms] of byFile) {
          const read = await api?.fsRead(uri);
          if (!read?.ok || read.text === undefined || read.large) continue;
          const matches = structMatchesToLineMatches(ms, replaceWith);
          if (matches.length === 0) continue;
          const fm: FileMatches = { uri, lines: read.text.split("\n"), matches };
          out.push(fm);
          sel[uri] = matches.map((x) => x.id);
        }
        setResults(out);
        setSelection(sel);
        setRanQuery({ q: query, replaceWith });
        setSearched(true);
        return;
      }
      // Discovery runs in MAIN (`ide:search`: bounded gitignore-aware walk, glob-scoped,
      // path-guarded root) — the renderer reads ONLY the hit files (APP-024). Non-regex
      // queries grep directly; regex queries grep their provably-required literal, or —
      // when none exists — fall back to the bounded path enumeration ("/" is in every
      // absolute path) and let the pure matcher decide.
      const scope = scopeDir.trim();
      const effectiveRoot =
        scope === "" ? root : scope.startsWith("/") ? scope : `${root}/${scope}`;
      const include = parseGlobs(includeField);
      const exclude = parseGlobs(excludeField);
      const base = {
        root: effectiveRoot,
        caseSensitive: matchCase,
        maxResults: 1000,
        ...(include.length > 0 ? { include } : {}),
        ...(exclude.length > 0 ? { exclude } : {}),
      };
      const literal = isRegex ? requiredLiteral(pattern) : pattern;
      const res = await api?.search(
        literal !== null
          ? { ...base, query: literal, mode: "content" }
          : { ...base, query: "/", mode: "path" },
      );
      if (res && !res.ok && res.error) setNotice(res.error);
      const paths = res?.ok ? res.matches.map((m) => m.path).slice(0, MAX_FILES) : [];
      const out: FileMatches[] = [];
      const sel: Record<string, string[]> = {};
      for (const p of paths) {
        const uri = p.startsWith("file://") ? p : `file://${p}`;
        const read = await api?.fsRead(uri);
        if (!read?.ok || read.text === undefined || read.large) continue;
        const fm = matchFile(uri, read.text, query, replaceWith);
        if (fm && fm.matches.length > 0) {
          out.push(fm);
          sel[uri] = allMatchIds(fm); // default: accept all (review-then-trim, §7.4)
        }
      }
      setResults(out);
      setSelection(sel);
      setRanQuery({ q: query, replaceWith });
      setSearched(true);
    } finally {
      setBusy(false);
    }
  }, [
    pattern,
    busy,
    root,
    isRegex,
    matchCase,
    wholeWord,
    isStructural,
    replaceWith,
    includeField,
    excludeField,
    scopeDir,
  ]);

  /** Per-match apply: re-reads the file, stale-guards THE one span, writes, re-previews. */
  const applyOne = useCallback(
    async (fm: FileMatches, id: string) => {
      const api = ide();
      if (!api || busy) return;
      const read = await api.fsRead(fm.uri);
      if (!read?.ok || read.text === undefined) {
        setNotice("replace failed: could not re-read the file");
        return;
      }
      const r = applyToFreshText(fm, [id], read.text);
      if (!r.ok) {
        setNotice("skipped: the file changed since this preview — re-run the search");
        return;
      }
      // A discarded write result reported "replaced 1 match" over a file that never changed —
      // and then re-previewed from the text it BELIEVED it had written, so the match vanished
      // from the tree too. Surface the refusal instead.
      const wrote = await api.fsWrite(fm.uri, r.text).catch(() => null);
      if (!wrote?.ok) {
        setNotice(`not replaced: ${wrote?.error ?? "write failed"}`);
        return;
      }
      setConfirmPlan(null); // results changed under a staged confirm — restage it
      // re-preview the file from the written text so remaining offsets stay honest.
      const fresh = ranQuery ? matchFile(fm.uri, r.text, ranQuery.q, ranQuery.replaceWith) : null;
      setResults((rs) => {
        const next = rs.filter((f) => f.uri !== fm.uri);
        if (fresh && fresh.matches.length > 0) {
          const at = rs.findIndex((f) => f.uri === fm.uri);
          next.splice(at === -1 ? next.length : at, 0, fresh);
        }
        return next;
      });
      setSelection((s) => {
        const { [fm.uri]: _gone, ...rest } = s;
        return fresh && fresh.matches.length > 0 ? { ...rest, [fm.uri]: allMatchIds(fresh) } : rest;
      });
      setNotice("replaced 1 match");
    },
    [busy, ranQuery],
  );

  /** Stage bulk apply: dry-run the stale guard over every accepted file so the confirm
   *  step shows the LIVE files-touched + match count, not the possibly-stale preview's. */
  const planBulk = useCallback(async () => {
    const api = ide();
    if (!api || busy) return;
    setBusy(true);
    try {
      let files = 0;
      let matches = 0;
      let staleFiles = 0;
      for (const fm of results) {
        const accepted = selection[fm.uri] ?? [];
        if (accepted.length === 0) continue;
        const read = await api.fsRead(fm.uri);
        if (!read?.ok || read.text === undefined) {
          staleFiles += 1;
          continue;
        }
        const r = applyToFreshText(fm, accepted, read.text);
        if (!r.ok) {
          staleFiles += 1;
          continue;
        }
        if (r.applied > 0) {
          files += 1;
          matches += r.applied;
        }
      }
      setConfirmPlan({ files, matches, staleFiles });
    } finally {
      setBusy(false);
    }
  }, [busy, results, selection]);

  /** The gated write: re-reads EVERY file again at write time, skips newly-stale ones. */
  const confirmBulk = useCallback(async () => {
    const api = ide();
    if (!api || busy) return;
    setBusy(true);
    try {
      // The loop and its counting rule live in `state/replace-apply.ts` so they can be tested
      // without a renderer — the panel is a .tsx the node:test harness cannot load.
      const { files, matches, skipped, failed } = await applyReplacements(
        { read: (uri) => api.fsRead(uri), write: (uri, text) => api.fsWrite(uri, text) },
        results,
        (fm) => selection[fm.uri] ?? [],
        (fm, ids, text) => applyToFreshText(fm, ids as string[], text),
      );
      setConfirmPlan(null);
      setResults([]);
      setSelection({});
      setNotice(
        `replaced ${matches} match${matches === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}${
          skipped > 0
            ? `; ${skipped} file${skipped === 1 ? "" : "s"} skipped (changed since preview)`
            : ""
        }${
          failed.length > 0
            ? `; ${failed.length} NOT written (${failed[0]?.error ?? "write failed"})`
            : ""
        }`,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, results, selection]);

  const { matches, files } = countMatches(results);

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 8, fontSize: "0.8rem" }}
      aria-label="search"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 4 }}
      >
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="search"
          aria-label="search pattern"
          style={inputStyle}
        />
        <input
          value={replaceWith}
          onChange={(e) => setReplaceWith(e.target.value)}
          placeholder="replace (preview before write)"
          aria-label="replace with"
          style={inputStyle}
        />
        <input
          value={scopeDir}
          onChange={(e) => setScopeDir(e.target.value)}
          placeholder="scope directory (relative to workspace, empty = root)"
          aria-label="scope directory"
          style={inputStyle}
        />
        <input
          value={includeField}
          onChange={(e) => setIncludeField(e.target.value)}
          placeholder="include globs, comma-sep (e.g. src/**/*.ts)"
          aria-label="include globs"
          style={inputStyle}
        />
        <input
          value={excludeField}
          onChange={(e) => setExcludeField(e.target.value)}
          placeholder="exclude globs, comma-sep (e.g. **/*.test.ts, vendor/**)"
          aria-label="exclude globs"
          style={inputStyle}
        />
        <div
          style={{
            display: "flex",
            gap: 8,
            fontSize: "0.72rem",
            color: "var(--text-secondary)",
          }}
        >
          <Toggle label=".*" on={isRegex} onChange={setIsRegex} />
          <Toggle label="Aa" on={matchCase} onChange={setMatchCase} />
          <Toggle label="\\b" on={wholeWord} onChange={setWholeWord} />
          {/* APP-076: Structural (AST) mode — the query is a `$X`-metavar code pattern. */}
          <Toggle label="AST" on={isStructural} onChange={setIsStructural} />
          <Button type="submit" size="sm" variant="primary" disabled={!pattern.trim() || busy}>
            {busy ? "…" : "Search"}
          </Button>
        </div>
      </form>

      {notice !== "" && (
        <output
          style={{
            display: "block",
            color: "var(--text-secondary)",
            fontSize: "0.72rem",
          }}
        >
          {notice}
        </output>
      )}
      {results.length > 0 && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
          {matches} result{matches === 1 ? "" : "s"} in {files} file{files === 1 ? "" : "s"}
        </p>
      )}
      {searched && !busy && results.length === 0 && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>No results.</p>
      )}

      {results.map((fm) => (
        <Panel key={fm.uri} title={fm.uri.replace(/^file:\/\//, "")} elevation="e1">
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {fm.matches.map((m) => {
              const on = (selection[fm.uri] ?? []).includes(m.id);
              return (
                <li key={m.id} style={{ display: "flex", gap: 6, opacity: on ? 1 : 0.5 }}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      // a selection change invalidates a staged confirm — its counts
                      // would no longer describe what confirmBulk writes (APP-024).
                      setConfirmPlan(null);
                      setSelection((s) => ({ ...s, [fm.uri]: toggleMatch(s[fm.uri] ?? [], m.id) }));
                    }}
                    aria-label={`match ${m.id}`}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      open(fm.uri, {
                        name: fm.uri.split("/").pop() ?? fm.uri,
                        languageId: detectLanguage(fm.uri),
                        preview: true,
                      })
                    }
                    style={{
                      fontSize: "0.72rem",
                      cursor: "pointer",
                      background: "transparent",
                      border: "none",
                      color: "inherit",
                      fontFamily: "var(--font-mono, monospace)",
                      padding: 0,
                      textAlign: "left",
                    }}
                  >
                    L{m.line + 1}: {fm.lines[m.line]?.slice(0, 80)}
                    {replaceWith ? ` → ${m.replacement}` : ""}
                  </button>
                  {ranQuery !== null && ranQuery.replaceWith !== "" && (
                    <button
                      type="button"
                      onClick={() => void applyOne(fm, m.id)}
                      aria-label={`replace match ${m.id}`}
                      title="replace this one occurrence"
                      style={rowApplyBtn}
                      disabled={busy}
                    >
                      replace
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      ))}

      {confirmPlan !== null && (
        <Panel title="Confirm replace" elevation="e1">
          <p role="alert" style={{ fontSize: "0.75rem", margin: "4px 0" }}>
            Replace {confirmPlan.matches} match{confirmPlan.matches === 1 ? "" : "es"} in{" "}
            {confirmPlan.files} file{confirmPlan.files === 1 ? "" : "s"}?
            {confirmPlan.staleFiles > 0 &&
              ` ${confirmPlan.staleFiles} file${confirmPlan.staleFiles === 1 ? "" : "s"} changed since preview and will be skipped.`}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void confirmBulk()}
              disabled={busy || confirmPlan.matches === 0}
              aria-label="confirm replace all"
            >
              Replace {confirmPlan.matches}
            </Button>
            <Button size="sm" onClick={() => setConfirmPlan(null)} aria-label="cancel replace">
              Cancel
            </Button>
          </div>
        </Panel>
      )}

      {results.length > 0 && replaceWith !== "" && confirmPlan === null && (
        <Button
          variant="primary"
          onClick={() => void planBulk()}
          style={{ marginTop: 8 }}
          disabled={busy}
        >
          Replace accepted…
        </Button>
      )}
    </div>
  );
}

const rowApplyBtn: CSSProperties = {
  flexShrink: 0,
  fontSize: "0.62rem",
  cursor: "pointer",
  background: "transparent",
  border: "1px solid var(--border-subtle)",
  borderRadius: 4,
  color: "var(--text-secondary)",
  padding: "0 4px",
};

const inputStyle: React.CSSProperties = {
  padding: "5px 7px",
  borderRadius: 4,
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-surface-2)",
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "0.75rem",
};

const SCOPE_LABEL: Record<UsageScope, string> = {
  all: "All places",
  file: "This file",
  directory: "This directory",
};

/** The Find-Usages tool window (APP-023): a grouped file → usage-rows tree with per-file
 *  counts, collapse/expand, a source badge (lsp / grep) per row, and a scope filter that
 *  re-narrows the ALREADY-FETCHED result set purely (no re-query). Row click opens the file
 *  at the exact 1-based line/column (recording a nav-history entry via the reveal echo). */
function UsagesView({ root }: { root: string }): ReactElement {
  const symbol = useUsagesStore((s) => s.symbol);
  const originUri = useUsagesStore((s) => s.originUri);
  const results = useUsagesStore((s) => s.results);
  const scope = useUsagesStore((s) => s.scope);
  const loading = useUsagesStore((s) => s.loading);
  const setScope = useUsagesStore((s) => s.setScope);
  const clear = useUsagesStore((s) => s.clear);
  const open = useTabsStore((s) => s.open);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // scope filter is PURE + re-runs without a re-query (deliverable 4).
  const filtered = useMemo(
    () => filterScope(results, scope, originUri),
    [results, scope, originUri],
  );
  const groups = useMemo(() => groupByFile(filtered), [filtered]);
  const { usages, files } = countUsages(filtered);

  const rel = (uri: string): string => uri.replace(/^file:\/\//, "").replace(`${root}/`, "");
  const jump = (u: Usage): void => {
    open(u.uri, {
      name: u.uri.split("/").pop() ?? u.uri,
      languageId: detectLanguage(u.uri),
      preview: true,
    });
    // reveal after the model swaps in; the caret echo records a nav-history entry (APP-022).
    setTimeout(
      () =>
        window.dispatchEvent(
          new CustomEvent("ide:reveal-position", { detail: { line: u.line, column: u.column } }),
        ),
      160,
    );
  };
  const toggleFile = (uri: string): void =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 8, fontSize: "0.8rem" }}
      aria-label="find usages"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ flex: 1, minWidth: 0, color: "var(--text-primary)" }}>
          Usages of <code style={{ fontFamily: "var(--font-mono, monospace)" }}>{symbol}</code>
          {!loading && (
            <span style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>
              {" "}
              — {usages} in {files} file{files === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <select
          value={scope}
          onChange={(e) => setScope(e.currentTarget.value as UsageScope)}
          aria-label="usage scope"
          style={{ ...inputStyle, fontFamily: "var(--font-ui)" }}
        >
          {(Object.keys(SCOPE_LABEL) as UsageScope[]).map((s) => (
            <option key={s} value={s}>
              {SCOPE_LABEL[s]}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => clear()} aria-label="close usages" style={closeBtn}>
          ✕
        </button>
      </div>

      {loading && <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>Searching…</p>}
      {!loading && groups.length === 0 && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>No usages found.</p>
      )}

      {groups.map((g) => {
        const isCollapsed = collapsed.has(g.uri);
        return (
          <Panel key={g.uri} title={`${rel(g.uri)}  (${g.rows.length})`} elevation="e1">
            <button
              type="button"
              onClick={() => toggleFile(g.uri)}
              aria-expanded={!isCollapsed}
              style={fileToggle}
            >
              {isCollapsed ? "▸" : "▾"} {g.rows.length} usage{g.rows.length === 1 ? "" : "s"}
            </button>
            {!isCollapsed && (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {g.rows.map((u) => (
                  <li
                    key={`${u.line}:${u.column}`}
                    style={{ display: "flex", gap: 6, alignItems: "baseline" }}
                  >
                    <span style={badge(u.source)}>{u.source}</span>
                    <button
                      type="button"
                      onClick={() => jump(u)}
                      style={rowBtn}
                      title={`${rel(u.uri)}:${u.line}:${u.column}`}
                    >
                      <span style={{ color: "var(--text-secondary)" }}>L{u.line}</span>{" "}
                      {(u.excerpt ?? "").trim().slice(0, 100)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

const closeBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontSize: "0.85rem",
  padding: "0 4px",
};

const fileToggle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontSize: "0.68rem",
  padding: "0 0 2px",
  textAlign: "left",
  fontFamily: "var(--font-ui)",
};

const rowBtn: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: "0.72rem",
  cursor: "pointer",
  background: "transparent",
  border: "none",
  color: "inherit",
  fontFamily: "var(--font-mono, monospace)",
  padding: 0,
  textAlign: "left",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function badge(source: Usage["source"]): CSSProperties {
  return {
    fontSize: "0.58rem",
    textTransform: "uppercase",
    fontFamily: "var(--font-mono, monospace)",
    padding: "0 3px",
    borderRadius: "var(--radius-sm, 4px)",
    border: "1px solid var(--border-subtle)",
    color: source === "lsp" ? "var(--accent)" : "var(--text-secondary)",
    flexShrink: 0,
  };
}

function Toggle({
  label,
  on,
  onChange,
}: { label: string; on: boolean; onChange(v: boolean): void }): ReactElement {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      aria-pressed={on}
      style={{
        background: on ? "var(--accent)" : "transparent",
        // `--on-accent` is the computed label colour for the `--accent` FILL (tokens/contrast.ts `onFill`).
        // The old `--brand-fg` here was WHITE on the dark scheme over a saturated light fill (~2:1),
        // and a plain `--bg-app` would be near-white over the same fill on the LIGHT scheme.
        color: on ? "var(--on-accent)" : "var(--text-secondary)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
        padding: "1px 5px",
        cursor: "pointer",
        fontFamily: "var(--font-mono, monospace)",
      }}
    >
      {label}
    </button>
  );
}

export default SearchPanel;
