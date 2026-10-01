// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * renderer/sidebar-bodies.tsx — the shell Sidebar body registry (APP-002).
 *
 * One body per SIDEBAR_BODY_ACTIVITIES entry (shell/sidebar-view.ts is the single
 * source for WHICH activities have one — the Record type here enforces the match):
 *   home   → the workspace file explorer (reuses ide/FileTree verbatim);
 *   workspace → a compact git working-tree summary (thin `ide.gitStatus` view — the
 *            full GitPanel is an editor tool-window and far too heavy here);
 *   editor → the OPEN EDITORS list. Deliberately NOT a second file tree: the
 *            editor route owns its own explorer/search/git tool-windows, and a
 *            duplicate tree means two fs-watch subscriptions fighting.
 *
 * Lives at the renderer root (like App.tsx) because it composes shell + ide —
 * shell/* components themselves stay react + @prometheus/ui only.
 */

import type { ActivityId } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, type ReactNode, useEffect, useState } from "react";

import { FileTree } from "./ide/FileTree.js";
import { useTabsStore } from "./ide/state/stores.js";
import {
  type GitSidebarSummary,
  type SidebarBodyActivity,
  summarizeGitStatus,
} from "./shell/sidebar-view.js";

/* ── shared bits ────────────────────────────────────────────────────────────*/

function Hint({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      style={{
        padding: "var(--space-8, 16px)",
        color: "var(--text-secondary)",
        fontSize: "0.8125rem",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

const groupLabelStyle: CSSProperties = {
  padding: "var(--space-4, 8px) var(--space-6, 12px) var(--space-2, 4px)",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-secondary)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3, 6px)",
  width: "100%",
  padding: "2px var(--space-6, 12px)",
  background: "transparent",
  border: "none",
  color: "var(--text-primary)",
  fontSize: "0.8125rem",
  textAlign: "left",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
};

/* ── home: workspace explorer ───────────────────────────────────────────────*/

function ExplorerBody(): ReactElement {
  const root = useTabsStore((s) => s.workspaceRoot);
  if (!root)
    return <Hint>No folder open — open one from the Editor to browse the workspace here.</Hint>;
  return <FileTree root={root} />;
}

/* ── editor: open editors (NOT a second file tree — see module doc) ─────────*/

function OpenEditorsBody(): ReactElement {
  const tabs = useTabsStore((s) => s.tabs);
  const activate = useTabsStore((s) => s.activate);
  const docs = Array.isArray(tabs?.docs) ? tabs.docs : [];
  if (docs.length === 0) return <Hint>No open editors.</Hint>;
  return (
    <div style={{ paddingBlock: "var(--space-2, 4px)" }}>
      <div style={groupLabelStyle}>Open editors — {docs.length}</div>
      {docs.map((d) => (
        <button
          key={d.uri}
          type="button"
          title={d.uri}
          onClick={() => activate(d.uri)}
          style={{ ...rowStyle, fontStyle: d.preview ? "italic" : "normal" }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {d.name}
          </span>
          {d.dirty ? <span style={{ color: "var(--accent)" }}>●</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ── workspace: compact git working-tree summary ────────────────────────────*/

function VcsBody(): ReactElement {
  const root = useTabsStore((s) => s.workspaceRoot);
  const [summary, setSummary] = useState<GitSidebarSummary | null>(null);
  useEffect(() => {
    if (!root) {
      setSummary(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const s = await window.prometheus?.ide?.gitStatus(root);
        if (alive) setSummary(summarizeGitStatus(s));
      } catch (e) {
        if (alive) setSummary(summarizeGitStatus({ ok: false, error: String(e) } as never));
      }
    })();
    return () => {
      alive = false;
    };
  }, [root]);

  if (!root) return <Hint>No folder open — git status follows the Editor workspace.</Hint>;
  if (summary === null) return <Hint>Reading git status…</Hint>;
  if (!summary.ok) return <Hint>{summary.error ?? "git status unavailable"}</Hint>;
  return (
    <div style={{ paddingBlock: "var(--space-2, 4px)" }}>
      <div
        style={{
          ...groupLabelStyle,
          textTransform: "none",
          letterSpacing: "normal",
          fontSize: "0.8125rem",
          color: "var(--text-primary)",
        }}
      >
        ⎇ {summary.branch ?? "(no branch)"}
        {summary.ahead > 0 ? ` ↑${summary.ahead}` : ""}
        {summary.behind > 0 ? ` ↓${summary.behind}` : ""}
      </div>
      {summary.totalChanges === 0 ? (
        <Hint>Working tree clean.</Hint>
      ) : (
        summary.groups.map((g) => (
          <div key={g.label}>
            <div style={groupLabelStyle}>
              {g.label} — {g.count}
            </div>
            {g.rows.map((r) => (
              <div
                key={r.path}
                title={`${r.kind}: ${r.path}`}
                style={{ ...rowStyle, cursor: "default" }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                  {r.path}
                </span>
                <span style={{ color: "var(--text-secondary)", fontSize: "0.7rem" }}>
                  {r.kind.slice(0, 1).toUpperCase()}
                </span>
              </div>
            ))}
            {g.count > g.rows.length ? (
              <div style={{ ...groupLabelStyle, fontWeight: 400, textTransform: "none" }}>
                … {g.count - g.rows.length} more
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

/* ── registry ───────────────────────────────────────────────────────────────*/

// Record over the exact SidebarBodyActivity tuple: adding an activity to
// SIDEBAR_BODY_ACTIVITIES without a body here (or vice versa) is a type error.
const SIDEBAR_BODIES: Readonly<Record<SidebarBodyActivity, () => ReactNode>> = {
  home: () => <ExplorerBody />,
  editor: () => <OpenEditorsBody />,
  workspace: () => <VcsBody />,
};

/** The registered body for an activity, or null (Sidebar then shows its fallback). */
export function sidebarBodyFor(activity: ActivityId): ReactNode {
  const make = (SIDEBAR_BODIES as Partial<Record<ActivityId, () => ReactNode>>)[activity];
  return make ? make() : null;
}
