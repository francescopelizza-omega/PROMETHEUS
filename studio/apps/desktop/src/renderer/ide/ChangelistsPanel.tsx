/**
 * ide/ChangelistsPanel.tsx — JetBrains-style changelists in the Git panel (APP-038).
 *
 * Groups the workspace's changed files into named lists (a Default sink catches new
 * changes), lets the user create/rename/delete lists and move files between them,
 * and commit ONE list at a time. Membership persists per-workspace via
 * changelist-store; the pure grouping/reconcile math is the tested core (mirrored in
 * state/changelists.ts). The git staging choreography for a per-list commit lives in
 * GitPanel (it owns the message + status); this panel calls back with the list's
 * files.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the changelist store only.
 */

import { Button } from "@prometheus/ui";
import { type ReactElement, useEffect, useState } from "react";

import { useChangelistStore } from "./state/changelist-store.js";

export interface ChangelistsPanelProps {
  root: string;
  /** all currently-changed repo-relative paths (staged+unstaged+untracked, not conflicted). */
  changedFiles: string[];
  /** commit exactly these files (the git staging choreography lives in GitPanel). */
  onCommitList: (files: string[]) => void;
  /** true while a commit is running (disables the per-list commit buttons). */
  busy: boolean;
}

export function ChangelistsPanel({
  root,
  changedFiles,
  onCommitList,
  busy,
}: ChangelistsPanelProps): ReactElement {
  const lists = useChangelistStore((s) => s.byRoot[root]) ?? [];
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  // reconcile membership with git status whenever the changed-file set changes:
  // sink new changes to Default, drop files that vanished (committed/reverted).
  const changedKey = changedFiles.join("\n");
  useEffect(() => {
    const files = changedKey ? changedKey.split("\n") : [];
    useChangelistStore.getState().syncFiles(root, files);
  }, [root, changedKey]);

  const toggleCollapse = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const store = useChangelistStore.getState();

  return (
    <div
      style={{
        marginBottom: 8,
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-sm, 3px)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "3px 6px",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <span style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>Changelists</span>
        {creating === null ? (
          <Button size="sm" variant="ghost" onClick={() => setCreating("")}>
            + new list
          </Button>
        ) : (
          <span style={{ display: "flex", gap: 4 }}>
            <input
              value={creating}
              placeholder="list name"
              aria-label="new changelist name"
              onChange={(e) => setCreating(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && creating.trim()) {
                  store.addList(root, creating);
                  setCreating(null);
                } else if (e.key === "Escape") {
                  setCreating(null);
                }
              }}
              style={{
                background: "var(--bg-inset)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm, 3px)",
                fontSize: "0.72rem",
                padding: "1px 4px",
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={!creating.trim()}
              onClick={() => {
                store.addList(root, creating);
                setCreating(null);
              }}
            >
              add
            </Button>
          </span>
        )}
      </div>

      {lists.map((list) => {
        const isCollapsed = collapsed.has(list.id);
        const files = list.files;
        return (
          <div key={list.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 6px" }}>
              <button
                type="button"
                aria-label={isCollapsed ? "expand list" : "collapse list"}
                onClick={() => toggleCollapse(list.id)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontSize: "0.7rem",
                  width: 14,
                }}
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
              {editing?.id === list.id ? (
                <input
                  value={editing.value}
                  aria-label="rename changelist"
                  onChange={(e) => setEditing({ id: list.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      store.rename(root, list.id, editing.value);
                      setEditing(null);
                    } else if (e.key === "Escape") {
                      setEditing(null);
                    }
                  }}
                  onBlur={() => {
                    store.rename(root, list.id, editing.value);
                    setEditing(null);
                  }}
                  style={{
                    flex: 1,
                    background: "var(--bg-inset)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm, 3px)",
                    fontSize: "0.72rem",
                    padding: "1px 4px",
                  }}
                />
              ) : (
                <span style={{ flex: 1, fontSize: "0.72rem", color: "var(--text-primary)" }}>
                  {list.name}
                  <span style={{ color: "var(--text-secondary)" }}> ({files.length})</span>
                  {list.isDefault && (
                    <span style={{ color: "var(--text-secondary)" }}> · default</span>
                  )}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || files.length === 0}
                title="Commit only this list's files"
                onClick={() => onCommitList(files)}
              >
                commit
              </Button>
              {!list.isDefault && editing?.id !== list.id && (
                <>
                  <button
                    type="button"
                    aria-label="rename list"
                    onClick={() => setEditing({ id: list.id, value: list.name })}
                    style={ICON_BTN}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    aria-label="delete list"
                    onClick={() => store.remove(root, list.id)}
                    style={ICON_BTN}
                  >
                    🗑
                  </button>
                </>
              )}
            </div>
            {!isCollapsed &&
              files.map((file) => (
                <div
                  key={file}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "1px 6px 1px 24px",
                    fontSize: "0.7rem",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--text-primary)",
                      fontFamily: "var(--font-mono, monospace)",
                    }}
                    title={file}
                  >
                    {file}
                  </span>
                  {lists.length > 1 && (
                    <select
                      value={list.id}
                      aria-label={`move ${file} to list`}
                      title="move to list"
                      onChange={(e) => store.move(root, e.target.value, [file])}
                      style={{
                        background: "var(--bg-inset)",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--radius-sm, 3px)",
                        fontSize: "0.66rem",
                        maxWidth: 110,
                      }}
                    >
                      {lists.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.id === list.id ? "move to…" : l.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            {!isCollapsed && files.length === 0 && (
              <p
                style={{
                  margin: 0,
                  padding: "1px 6px 3px 24px",
                  fontSize: "0.68rem",
                  color: "var(--text-secondary)",
                }}
              >
                (empty)
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

const ICON_BTN = {
  background: "transparent",
  border: "none",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontSize: "0.7rem",
} as const;

export default ChangelistsPanel;
