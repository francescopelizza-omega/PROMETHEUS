/**
 * ide/BlameView.tsx — the Git Blame / line-annotations tool window (PyCharm Annotate ·
 * GitLens parity).
 *
 * Shows per-line blame for the ACTIVE editor file — who last changed each line, when,
 * and the commit summary — with jump-to-line. Backed by `git blame --porcelain` in MAIN
 * (GitHost.blame), surfaced over the `ide:git.blame` seam; the renderer never spawns git
 * (C5). Clicking a line dispatches `ide:reveal-position`, revealed by the focused editor.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the stores + window.prometheus only.
 */

import { Button } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import type { IdeGitBlameEntry, IdeGitShowResult } from "../../shared/ipc-contract.js";
import { useInlineBlameStore } from "./state/inline-blame-store.js";
import { useTabsStore } from "./state/stores.js";
import { activeDoc } from "./state/tabs-reducer.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** Reveal a 1-based line in the focused editor. */
function jump(line: number): void {
  window.dispatchEvent(new CustomEvent("ide:reveal-position", { detail: { line, column: 1 } }));
}

export function BlameView({ root }: { root: string }): ReactElement {
  const tabs = useTabsStore((s) => s.tabs);
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const active = activeDoc(tabs, tabs.focusedGroup);
  const uri = active?.uri;

  const [entries, setEntries] = useState<IdeGitBlameEntry[]>([]);
  const [status, setStatus] = useState<"none" | "loading" | "empty" | "ready">("none");
  // APP-083: the inline-blame opt-in (shared with the EditorPane annotation) + the
  // commit-detail pane opened by clicking a row or the inline annotation.
  const inlineEnabled = useInlineBlameStore((s) => s.enabled);
  const toggleInline = useInlineBlameStore((s) => s.toggle);
  const [detail, setDetail] = useState<IdeGitShowResult | null>(null);

  const showCommit = useCallback(
    async (sha: string) => {
      const api = ide();
      const wsRoot = workspaceRoot ?? root;
      if (!api || !sha) return;
      const r = await api.gitShow(wsRoot, sha).catch(() => undefined);
      if (r?.ok) setDetail(r);
    },
    [workspaceRoot, root],
  );

  // the EditorPane inline annotation click dispatches ide:show-commit → open the detail.
  useEffect(() => {
    const onShowCommit = (e: Event): void => {
      const sha = (e as CustomEvent<{ sha?: string }>).detail?.sha;
      if (typeof sha === "string") void showCommit(sha);
    };
    window.addEventListener("ide:show-commit", onShowCommit);
    return () => window.removeEventListener("ide:show-commit", onShowCommit);
  }, [showCommit]);

  const load = useCallback(async () => {
    const api = ide();
    const wsRoot = workspaceRoot ?? root;
    if (!api || !uri || !uri.startsWith("file://")) {
      setEntries([]);
      setStatus("none");
      return;
    }
    // path relative to the workspace root (git runs with cwd = root).
    const abs = uri.slice("file://".length);
    const rel = abs.startsWith(`${wsRoot}/`) ? abs.slice(wsRoot.length + 1) : abs;
    setStatus("loading");
    const r = await api.gitBlame(wsRoot, rel).catch(() => undefined);
    const rows = r?.ok ? r.entries : [];
    setEntries(rows);
    setStatus(rows.length > 0 ? "ready" : "empty");
  }, [uri, workspaceRoot, root]);

  useEffect(() => {
    void load();
  }, [load]);

  const fileName = uri ? (uri.split("/").pop() ?? uri) : "";

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 8, fontSize: "0.8rem" }}
      aria-label="blame"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span
          style={{
            flex: 1,
            color: "var(--text-secondary, #9a9aa3)",
            fontFamily: "var(--font-mono, monospace)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {fileName || "no file"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={inlineEnabled}
          title="Show blame inline in the editor (current line)"
          onClick={() => toggleInline()}
        >
          {inlineEnabled ? "inline ✓" : "inline"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          disabled={status === "loading"}
        >
          {status === "loading" ? "…" : "⟳"}
        </Button>
      </div>

      {detail && (
        <div
          style={{
            marginBottom: 6,
            padding: 8,
            background: "var(--bg-surface-2, #16161b)",
            border: "1px solid var(--border-subtle, #2a2a33)",
            borderRadius: 4,
            fontSize: "0.72rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{ color: "var(--accent, #22d3ee)", fontFamily: "var(--font-mono, monospace)" }}
            >
              {detail.sha.slice(0, 8)}
            </span>
            <span style={{ flex: 1, color: "var(--text-primary, #e7e7ea)" }}>{detail.summary}</span>
            <button
              type="button"
              aria-label="close commit detail"
              onClick={() => setDetail(null)}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-secondary, #9a9aa3)",
                cursor: "pointer",
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ color: "var(--text-secondary, #9a9aa3)", marginTop: 2 }}>
            {detail.author} {detail.email ? `<${detail.email}>` : ""} · {detail.date}
          </div>
          {detail.body && (
            <pre
              style={{
                margin: "4px 0 0",
                maxHeight: 120,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                fontFamily: "var(--font-mono, monospace)",
                color: "var(--text-secondary, #9a9aa3)",
              }}
            >
              {detail.body}
            </pre>
          )}
        </div>
      )}

      {status === "none" && (
        <p style={{ color: "var(--text-secondary, #9a9aa3)", fontSize: "0.72rem" }}>
          Open a tracked file to see its blame.
        </p>
      )}
      {status === "empty" && (
        <p style={{ color: "var(--text-secondary, #9a9aa3)", fontSize: "0.72rem" }}>
          No blame (untracked, outside the repo, or not committed).
        </p>
      )}

      {entries.map((e, i) => {
        // collapse the author/date label when it repeats the previous line's commit.
        const prev = entries[i - 1];
        const sameCommit = prev && prev.hash === e.hash;
        return (
          <button
            key={`${e.line}`}
            type="button"
            title="Jump to line + show commit detail"
            onClick={() => {
              jump(e.line);
              void showCommit(e.hash);
            }}
            style={{
              display: "flex",
              gap: 6,
              width: "100%",
              textAlign: "left",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              padding: "1px 0",
              fontSize: "0.7rem",
              fontFamily: "var(--font-mono, monospace)",
              color: "var(--text-primary, #e7e7ea)",
            }}
          >
            <span
              style={{ color: "var(--text-secondary, #9a9aa3)", width: 40, textAlign: "right" }}
            >
              L{e.line}
            </span>
            <span
              style={{
                width: 150,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: sameCommit ? "transparent" : "var(--accent, #22d3ee)",
              }}
            >
              {sameCommit ? "" : `${e.author} · ${e.date}`}
            </span>
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--text-secondary, #9a9aa3)",
              }}
            >
              {sameCommit ? "" : e.summary}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default BlameView;
