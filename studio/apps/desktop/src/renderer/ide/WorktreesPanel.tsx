// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/WorktreesPanel.tsx — git worktree isolation for parallel sessions (Task #5, desktop
 * parity with the CLI's `/worktree` slash, CLI-054).
 *
 * List / create / switch / remove, all over `window.prometheus.ide.worktree*` — which route
 * to the SAME `@prometheus/core/git-worktree` functions the CLI calls (main/ide/worktree-host.ts
 * is a thin wrapper, not a reimplementation). "switch" has no IPC of its own: it repoints the
 * workspace root client-side (`useTabsStore.setWorkspaceRoot`), mirroring the CLI's
 * `ctx.setCwd`. "remove" asks a typed confirmation (retype the branch/path) before calling the
 * IPC, mirroring the CLI's `ctx.ask` — but the REAL refusal (locked/dirty, never `--force`) is
 * re-checked server-side regardless (see worktree-host.ts), so a UI bug here can't bypass it.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + window.prometheus only.
 */
import { Button, Panel } from "@prometheus/ui";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import type { IdeWorktreeEntry } from "../../shared/ipc-contract.js";
import { useTabsStore } from "./state/stores.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

export interface WorktreesPanelProps {
  root: string;
}

export function WorktreesPanel({ root }: WorktreesPanelProps): ReactElement {
  const setWorkspaceRoot = useTabsStore((s) => s.setWorkspaceRoot);
  const [worktrees, setWorktrees] = useState<IdeWorktreeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [confirmTyped, setConfirmTyped] = useState("");

  const refresh = useCallback(async () => {
    const r = await ide()?.worktreeList(root);
    if (!r) return;
    if (r.ok) {
      setWorktrees(r.worktrees);
      setError(null);
    } else {
      setWorktrees([]);
      setError(r.error ?? "failed to list worktrees");
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async () => {
    const branch = newBranch.trim();
    if (!branch) return;
    setBusy(true);
    try {
      const r = await ide()?.worktreeCreate(root, branch);
      if (r?.ok) {
        setNewBranch("");
        setError(null);
      } else {
        setError(r?.message ?? "create failed");
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [root, newBranch, refresh]);

  const switchTo = useCallback(
    (w: IdeWorktreeEntry) => {
      setWorkspaceRoot(w.path);
    },
    [setWorkspaceRoot],
  );

  const remove = useCallback(
    async (w: IdeWorktreeEntry) => {
      const label = w.branch ?? w.path;
      if (confirmTyped.trim() !== label) return;
      setBusy(true);
      try {
        const r = await ide()?.worktreeRemove(root, w.path);
        if (!r?.ok) setError(r?.message ?? "remove failed");
        setConfirmPath(null);
        setConfirmTyped("");
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [root, confirmTyped, refresh],
  );

  return (
    <Panel title="Worktrees">
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
        <input
          aria-label="new worktree branch"
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          placeholder="branch name"
          style={{
            flex: 1,
            fontSize: "0.75rem",
            padding: "2px 6px",
            background: "var(--bg-inset)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-strong)",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !newBranch.trim()}
          onClick={() => void create()}
        >
          + create
        </Button>
      </div>

      {error && (
        <div style={{ color: "var(--danger)", fontSize: "0.7rem", marginBottom: 6 }}>{error}</div>
      )}

      {worktrees.length === 0 ? (
        <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem" }}>no worktrees</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {worktrees.map((w) => {
            const here = w.path === root;
            const ref = w.bare
              ? "(bare)"
              : w.detached
                ? `(detached ${w.head.slice(0, 7)})`
                : (w.branch ?? "?");
            return (
              <li
                key={w.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 6,
                  padding: "3px 0",
                  fontSize: "0.75rem",
                  minWidth: 0,
                }}
              >
                <span
                  title={w.path}
                  style={{
                    color: here ? "var(--accent)" : "var(--text-primary)",
                    flex: "1 1 120px",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {here ? "● " : "  "}
                  {w.path}
                </span>
                <span
                  style={{ color: "var(--text-secondary)", whiteSpace: "nowrap", flexShrink: 0 }}
                >
                  {ref}
                </span>
                {w.locked && (
                  <span style={{ color: "var(--warn)", whiteSpace: "nowrap", flexShrink: 0 }}>
                    locked
                  </span>
                )}
                {w.prunable && (
                  <span style={{ color: "var(--warn)", whiteSpace: "nowrap", flexShrink: 0 }}>
                    prunable
                  </span>
                )}
                {!here && (
                  <Button size="sm" variant="ghost" onClick={() => switchTo(w)}>
                    switch
                  </Button>
                )}
                {confirmPath === w.path ? (
                  <>
                    <input
                      aria-label={`confirm removal of ${w.path}`}
                      value={confirmTyped}
                      onChange={(e) => setConfirmTyped(e.target.value)}
                      placeholder={`type "${w.branch ?? w.path}"`}
                      style={{
                        fontSize: "0.7rem",
                        padding: "1px 4px",
                        background: "var(--bg-inset)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-strong)",
                        width: 140,
                        flexShrink: 0,
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || confirmTyped.trim() !== (w.branch ?? w.path)}
                      onClick={() => void remove(w)}
                    >
                      confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setConfirmPath(null);
                        setConfirmTyped("");
                      }}
                    >
                      cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setConfirmPath(w.path);
                      setConfirmTyped("");
                    }}
                  >
                    remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
