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
import { Panel } from "@prometheus/ui";
import { type ReactElement, useEffect, useMemo, useState } from "react";

import { SHELL_COMMANDS } from "../renderer/commands/registry.js";
import { TUTORIALS } from "./docs-tutorials.js";
import { type DocsTab, onDocsTab, searchHelp, takeDocsTab } from "./docs-view.js";

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
                background: tab === t.id ? "var(--bg-surface-3, #32323a)" : "transparent",
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
                      color: "var(--accent, #22d3ee)",
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
