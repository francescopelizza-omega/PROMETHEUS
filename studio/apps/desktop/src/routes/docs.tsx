// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * routes/docs.tsx — the in-app help browser (the GUI help surface, APP-099).
 *
 * Three tabs under ONE live search box: "Engine commands" (the frozen COMMAND_SPECS registry,
 * the GUI twin of `prometheus --docs`), "Cheat-sheet" (every SHELL_COMMANDS shell/editor action
 * with its live key label), and "Tutorials" (short getting-started how-tos whose steps deep-link
 * to palette commands). Pure data (COMMAND_SPECS/SHELL_COMMANDS/TUTORIALS) + the pure docs-view
 * helpers; the only side effect is dispatching a command through the shell executor.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + pure view-models + window event bus.
 */
import { COMMAND_SPECS } from "@prometheus/core/commands";
import { EmptyState, Panel, Skeleton } from "@prometheus/ui";
import { type ReactElement, useEffect, useMemo, useState } from "react";

import { SHELL_COMMANDS } from "../renderer/commands/registry.js";
import { useTabsStore } from "../renderer/ide/state/stores.js";
import { openFileInEditor } from "../renderer/open-resource.js";
import { TUTORIALS } from "./docs-tutorials.js";
import { type DocsTab, onDocsTab, searchHelp, takeDocsTab } from "./docs-view.js";
import { type DocRowView, docRows } from "./workspace-view.js";

/** mac vs other for the key labels (mirrors ChordRecorder's detection). */
function detectPlatform(): "mac" | "other" {
  if (typeof navigator === "undefined") return "other";
  return /mac/i.test(navigator.platform || navigator.userAgent) ? "mac" : "other";
}

/** Run a shell/editor command through the SAME executor the palette uses (App.tsx listens). */
function runCommand(id: string): void {
  window.dispatchEvent(new CustomEvent("ide:run-shell-command", { detail: id }));
}

const TABS: { id: DocsTab; label: string }[] = [
  { id: "engine", label: "Engine commands" },
  { id: "cheatsheet", label: "Cheat-sheet" },
  { id: "tutorials", label: "Tutorials" },
];

export function DocsRoute(): ReactElement {
  const [query, setQuery] = useState("");
  /**
   * §5's Docs segment: the workspace's OWN documents, which the help browser below never
   * covered — it lists engine commands and tutorials, not the README you are working on.
   *
   * The walk is `ide.workspaceIndex` (gitignore-aware, worker-offloaded), filtered to
   * document extensions. It returns paths only, so §5's age column has no source and is
   * omitted rather than approximated.
   */
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const [docs, setDocs] = useState<DocRowView[]>([]);
  const [docsError, setDocsError] = useState<string | null>(null);
  /**
   * §6 separates LOADING from EMPTY, and the difference is the whole point of the state.
   *
   * Without this flag the first paint of a large workspace said "No documents found under
   * this folder" — a definite, wrong answer to a question we had not finished asking. It is
   * the same defect `repos.tsx` was already fixed for.
   */
  const [docsLoading, setDocsLoading] = useState(false);
  useEffect(() => {
    if (!workspaceRoot) {
      setDocs([]);
      setDocsError(null);
      setDocsLoading(false);
      return;
    }
    let live = true;
    setDocsLoading(true);
    void window.prometheus?.ide
      ?.workspaceIndex(workspaceRoot)
      .then((r) => {
        if (!live) return;
        if (!r.ok) {
          setDocsError(r.error ?? "the workspace walk did not answer");
          setDocs([]);
          return;
        }
        setDocsError(null);
        setDocs(docRows(r.files ?? [], workspaceRoot));
      })
      .catch((e: unknown) => {
        if (live) setDocsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setDocsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [workspaceRoot]);
  const [tab, setTab] = useState<DocsTab>(() => takeDocsTab() ?? "engine");
  const platform = useMemo(detectPlatform, []);

  // a `help.*` command may request a tab while this route is already mounted.
  useEffect(() => onDocsTab(setTab), []);

  const results = useMemo(
    () =>
      searchHelp(query, {
        specs: COMMAND_SPECS,
        commands: SHELL_COMMANDS,
        tutorials: TUTORIALS,
        platform,
      }),
    [query, platform],
  );

  const counts: Record<DocsTab, number> = {
    engine: results.engine.count,
    cheatsheet: results.cheatSheet.length,
    tutorials: results.tutorials.length,
  };

  return (
    <div style={{ display: "grid", gap: "var(--space-8, 16px)", alignContent: "start" }}>
      {/* ── §5's Docs rows: the workspace's own documents ───────────────────── */}
      <Panel
        title="Workspace docs"
        elevation="e1"
        actions={
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-muted)",
              whiteSpace: "nowrap", // §7
            }}
          >
            {docs.length}
          </span>
        }
      >
        {!workspaceRoot ? (
          <p style={{ color: "var(--text-secondary)", margin: 0, fontSize: "0.85rem" }}>
            No folder is open. Open one from the Editor to list its documents here.
          </p>
        ) : docsError ? (
          <p role="alert" style={{ color: "var(--danger)", margin: 0, fontSize: "0.85rem" }}>
            Couldn't list documents: {docsError}
          </p>
        ) : docsLoading ? (
          // §6 LOADING: skeleton rows, not an answer we do not have yet
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Skeleton height={14} />
            <Skeleton height={14} width="82%" />
            <Skeleton height={14} width="66%" />
            <Skeleton height={14} width="74%" />
          </div>
        ) : docs.length === 0 ? (
          <EmptyState
            icon="▤"
            title="No documents here"
            hint="Markdown and text files in this folder will appear here."
          />
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {docs.map((d) => (
              <li key={d.path}>
                <button
                  type="button"
                  onClick={() => openFileInEditor(d.path)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 4px",
                    background: "transparent",
                    border: "none",
                    borderRadius: "var(--radius-md, 6px)",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    textAlign: "left",
                    minWidth: 0, // §7
                    flexWrap: "wrap", // §7: the row must wrap, not overflow, at ~900px
                  }}
                >
                  {/* handoff_3 §5: "▤ (accent-purple)". `--accent` is the CYAN accent;
                      the prototype's purple is already a token — `--brand-3`. */}
                  <span aria-hidden="true" style={{ flex: "none", color: "var(--brand-3)" }}>
                    ▤
                  </span>
                  <span
                    style={{
                      flex: "none",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.78rem",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {d.filename}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0, // §7
                      fontSize: "0.68rem",
                      color: "var(--text-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      direction: "rtl", // keep the DEEPEST directory visible when it elides
                      textAlign: "left",
                    }}
                  >
                    {/* a root-level document has no directory worth showing; "." beside the
                        filename reads as a stray character, not as information. */}
                    {d.dir === "." ? "" : d.dir}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Help & documentation" elevation="e1">
        <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.85rem" }}>
          Engine commands, the shell/editor cheat-sheet with live keybindings, and getting-started
          tutorials — all searchable from one box.
        </p>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search everything… (e.g. scan, git, tutorial)"
          aria-label="Search help"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "8px 10px",
            borderRadius: "var(--radius-md, 6px)",
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-surface-2)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.85rem",
          }}
        />

        <div
          role="tablist"
          aria-label="Help sections"
          style={{ display: "flex", gap: 4, margin: "10px 0 6px" }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "4px 10px",
                borderRadius: "var(--radius-md, 6px)",
                border: "1px solid var(--border-subtle)",
                cursor: "pointer",
                fontSize: "0.8rem",
                background: tab === t.id ? "var(--bg-elevated)" : "transparent",
                color: tab === t.id ? "var(--text-primary)" : "var(--text-secondary)",
              }}
            >
              {t.label} ({counts[t.id]})
            </button>
          ))}
        </div>

        {tab === "engine" && (
          <EngineTab groups={results.engine.groups} count={results.engine.count} query={query} />
        )}
        {tab === "cheatsheet" && <CheatSheetTab rows={results.cheatSheet} />}
        {tab === "tutorials" && <TutorialsTab tutorials={results.tutorials} />}
      </Panel>
    </div>
  );
}

function EngineTab({
  groups,
  count,
  query,
}: {
  groups: ReturnType<typeof searchHelp>["engine"]["groups"];
  count: number;
  query: string;
}): ReactElement {
  if (count === 0) {
    return (
      <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: 12 }}>
        no commands match “{query}”
      </p>
    );
  }
  return (
    <div style={{ marginTop: "var(--space-4, 8px)", display: "grid", gap: "var(--space-6, 12px)" }}>
      {groups.map((g) => (
        <div key={g.group}>
          <div
            style={{
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontSize: "0.72rem",
              color: "var(--text-secondary)",
              margin: "0 0 4px",
            }}
          >
            {g.group}
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "4px" }}>
            {g.rows.map((r) => (
              <li
                key={r.id}
                style={{
                  padding: "6px 8px",
                  borderRadius: "var(--radius-md, 6px)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div style={{ fontSize: "0.85rem" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{r.id}</span>
                  {r.signature && (
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        color: "var(--text-secondary)",
                        marginLeft: "8px",
                        fontSize: "0.78rem",
                      }}
                    >
                      {r.signature}
                    </span>
                  )}
                  <span style={{ color: "var(--text-secondary)", marginLeft: "8px" }}>
                    · {r.title}
                  </span>
                </div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.78rem" }}>
                  {r.description}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CheatSheetTab({
  rows,
}: {
  rows: ReturnType<typeof searchHelp>["cheatSheet"];
}): ReactElement {
  if (rows.length === 0) {
    return (
      <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: 12 }}>
        no shortcuts match
      </p>
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 3 }}>
      {rows.map((r) => (
        <li
          key={r.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 8px",
            borderRadius: "var(--radius-md, 6px)",
            border: "1px solid var(--border-subtle)",
            fontSize: "0.82rem",
          }}
        >
          <span style={{ flex: 1 }}>{r.title}</span>
          <span style={{ color: "var(--text-secondary)", fontSize: "0.72rem" }}>{r.category}</span>
          <kbd
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.76rem",
              minWidth: 64,
              textAlign: "right",
              color: r.keys ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            {r.keys || "—"}
          </kbd>
        </li>
      ))}
    </ul>
  );
}

function TutorialsTab({
  tutorials,
}: {
  tutorials: ReturnType<typeof searchHelp>["tutorials"];
}): ReactElement {
  if (tutorials.length === 0) {
    return (
      <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: 12 }}>
        no tutorials match
      </p>
    );
  }
  return (
    <div style={{ marginTop: 8, display: "grid", gap: "var(--space-6, 12px)" }}>
      {tutorials.map((t) => (
        <div
          key={t.id}
          style={{
            padding: "8px 10px",
            borderRadius: "var(--radius-md, 6px)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{t.title}</div>
          <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem", margin: "2px 0 6px" }}>
            {t.summary}
          </div>
          <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
            {t.steps.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional, no stable id.
              <li key={i} style={{ fontSize: "0.82rem" }}>
                <span>{s.text}</span>
                {s.commandId && (
                  <button
                    type="button"
                    onClick={() => runCommand(s.commandId as string)}
                    title={`Run: ${s.commandId}`}
                    style={{
                      marginLeft: 8,
                      padding: "0 7px",
                      borderRadius: 10,
                      border: "1px solid var(--border-subtle)",
                      background: "transparent",
                      color: "var(--accent)",
                      cursor: "pointer",
                      fontSize: "0.68rem",
                    }}
                  >
                    ▸ run
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

export default DocsRoute;
