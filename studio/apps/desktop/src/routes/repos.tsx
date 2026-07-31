/**
 * routes/repos.tsx — the GitHub Repo Manager tab (file 06 §3, FEATURE #5a).
 *
 * The renderer-side glue that wires `window.prometheus.repo.*` (the contextBridge
 * seam) → TanStack Query (the repo list READ) → the §3.3 repo panel (clone / list /
 * update / pin / branch / rescan / remove), reusing the shared file-03
 * <VerdictSheet/> for the clone/rescan gate flow.
 *
 * RENDERER-SANDBOXED (C5): it imports ONLY react + @tanstack/react-query +
 * @prometheus/ui (presentational) + the PLAIN-DATA contract types. It NEVER
 * imports node:* / electron / the engine-bridge runtime — every byte crosses the
 * contextBridge.
 *
 * THE GOLDEN RULE (C5/the SPINE): the clone path STAGES with _GIT_SAFE_FLAGS, runs
 * the REAL nemesis on the staged tree, and promotes | quarantines on the verdict —
 * all inside the repo.py sidecar (the ONLY arbitrary-URL clone path, 00-INDEX C6).
 * A BLOCK arrives as `ok:false, blocked, quarantined`, never promoted; we render
 * the verdict in the <VerdictSheet/>; the user may force (re-run with
 * force:true + confirmForce:true — the deep-red typed-confirm). A force-promoted
 * BLOCK surfaces a PERSISTENT deep-red banner from `forcedDanger`. JS never decides
 * "safe".
 *
 * ENV LIMIT (file 06 HONEST ENV LIMITS): a REAL `git clone` of a remote URL needs
 * network; the sidecar's gate decision is exercised deterministically via the
 * `--staged` planted-dir path in tests. The UI drives the real clone path here.
 */

import { Button, Panel, VerdictSheet, gateToVerdict } from "@prometheus/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useCallback, useState } from "react";

import { openExternally, openFolderInWorkspace } from "../renderer/open-resource.js";

import type {
  RepoCloneResult,
  RepoGateSummary,
  RepoListResult,
  RepoRow,
} from "../shared/ipc-contract.js";

/** The `window.prometheus.repo` surface (typed via the contract). */
function repoApi(): Window["prometheus"]["repo"] {
  return window.prometheus.repo;
}

const RK = ["repos"] as const;

/* ── the status glyph + verdict tint (§3.3 legend) ──────────────────────────*/

function statusGlyph(
  status: RepoRow["status"],
  verdict?: string,
): { glyph: string; color: string } {
  if (status === "blocked") return { glyph: "✕", color: "var(--danger, #b3261e)" };
  if (verdict === "warn") return { glyph: "◐", color: "var(--warn, #e0a458)" };
  if (status === "stale") return { glyph: "◌", color: "var(--text-secondary, #9a9aa3)" };
  if (status === "missing") return { glyph: "?", color: "var(--text-secondary, #9a9aa3)" };
  return { glyph: "●", color: "var(--ok, #5fd38d)" };
}

/* ── the route ───────────────────────────────────────────────────────────────*/

interface PendingGate {
  gate: RepoGateSummary;
  /** the id (rescan) or url (clone) we are confirming. */
  id?: string;
  url?: string;
  branch?: string;
  /** which operation raised this gate, so Proceed/Force re-runs the RIGHT one (a
   *  rescan gate must re-rescan, not run an update). */
  kind: "clone" | "update" | "rescan";
}

export function ReposRoute(): ReactElement {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [pendingGate, setPendingGate] = useState<PendingGate | null>(null);
  const [banner, setBanner] = useState<{ id: string; reasons: string[] } | null>(null);

  const reposQ = useQuery({
    queryKey: RK,
    queryFn: (): Promise<RepoListResult> => repoApi().list(),
  });
  // guard: an ok envelope can still carry `repos` undefined (empty / partial sidecar) →
  // the .map below would crash the panel ("reading 'filter'/'map'" class). Coalesce.
  const repos = reposQ.data?.ok && Array.isArray(reposQ.data.repos) ? reposQ.data.repos : [];

  const refetch = useCallback(() => void qc.invalidateQueries({ queryKey: RK }), [qc]);

  /** Route a clone/update/pin/branch outcome (file 06 §3.1). `kind` records which
   *  operation produced it so the verdict sheet re-runs the correct mutation. */
  const onResult = useCallback(
    (res: RepoCloneResult, kind: PendingGate["kind"]): void => {
      if (res.forcedDanger) {
        setBanner({
          id: res.id ?? res.url ?? "repo",
          reasons: res.forcedDanger.blockingReasons ?? [],
        });
        refetch();
        return;
      }
      if (res.promoted) {
        setPendingGate(null);
        refetch();
        return;
      }
      // blocked / warn → render the verdict in the shared sheet (the engine decided).
      if (res.gate && res.gate.verdict !== "allow") {
        setPendingGate({
          gate: res.gate,
          kind,
          ...(res.id ? { id: res.id } : {}),
          ...(res.url ? { url: res.url } : {}),
          // carry the typed branch so Proceed re-clones the SAME branch (was dropped).
          ...(kind === "clone" && branch ? { branch } : {}),
        });
      }
      refetch();
    },
    [refetch, branch],
  );

  const clone = useMutation({
    mutationFn: (vars: { url: string; branch?: string; force: boolean }) =>
      repoApi().clone({
        url: vars.url,
        ...(vars.branch ? { branch: vars.branch } : {}),
        force: vars.force,
        confirmForce: vars.force,
      }),
    onSuccess: (res, vars) => {
      // clear the inputs whenever the clone SUCCEEDED without opening a pending gate
      // (promoted, or a clean allow) — not only on `promoted`, else a clean clone that
      // didn't auto-promote leaves the form filled looking like nothing happened.
      const opensGate = !!res.gate && res.gate.verdict !== "allow" && !res.forcedDanger;
      if (res.ok && !opensGate) {
        setUrl("");
        setBranch("");
      }
      onResult({ ...res, url: res.url ?? vars.url }, "clone");
    },
  });

  const update = useMutation({
    mutationFn: (vars: { id: string; force: boolean }) =>
      repoApi().update(vars.id, { force: vars.force, confirmForce: vars.force }),
    onSuccess: (res, vars) => onResult({ ...res, id: res.id ?? vars.id }, "update"),
  });

  const rescan = useMutation({
    mutationFn: (id: string) => repoApi().rescan(id),
    onSuccess: (res, id) => {
      if (res.gate && res.gate.verdict !== "allow") {
        setPendingGate({ gate: res.gate, id, kind: "rescan" });
      }
      refetch();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => repoApi().remove(id),
    onSuccess: () => refetch(),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-8, 16px)" }}>
      {banner && (
        <div
          role="alert"
          style={{
            border: "1px solid var(--danger)",
            background: "color-mix(in srgb, var(--danger) 14%, transparent)",
            color: "var(--danger)",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: "0.85rem",
          }}
        >
          <strong>Force-promoted over a nemesis BLOCK: {banner.id}</strong>
          {banner.reasons.length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {banner.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 6 }}>
            <Button variant="ghost" onClick={() => setBanner(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <Panel title="Clone a GitHub repo (staged + nemesis-gated)" elevation="e1">
        <p style={{ marginTop: 0, color: "var(--text-secondary, #9a9aa3)", fontSize: "0.82rem" }}>
          The ONLY arbitrary-URL clone path: staged with safe git flags, then scanned by the REAL
          nemesis before anything lands. A block is quarantined, never promoted (C5/C6).
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const u = url.trim();
            if (!u || clone.isPending) return;
            clone.mutate({ url: u, branch: branch.trim() || undefined, force: false });
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <input
            placeholder="https://github.com/owner/repo.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{
              flex: "1 1 320px",
              background: "var(--bg-surface-2, #16161c)",
              border: "1px solid var(--border-subtle, #2a2a33)",
              borderRadius: 6,
              color: "var(--text-primary, #e7e7ea)",
              padding: "6px 10px",
            }}
          />
          <input
            placeholder="branch (optional)"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            style={{
              flex: "0 1 160px",
              background: "var(--bg-surface-2, #16161c)",
              border: "1px solid var(--border-subtle, #2a2a33)",
              borderRadius: 6,
              color: "var(--text-primary, #e7e7ea)",
              padding: "6px 10px",
            }}
          />
          <Button variant="primary" type="submit" disabled={clone.isPending}>
            {clone.isPending ? "staging + scanning…" : "+ Clone"}
          </Button>
        </form>
      </Panel>

      <Panel title="Repos" elevation="e1">
        <p style={{ marginTop: 0, color: "var(--text-secondary, #9a9aa3)", fontSize: "0.78rem" }}>
          ● clean · ◐ warn · ✕ blocked · ◌ stale · Force… = deep-red override (typed confirm)
        </p>
        {reposQ.isPending ? (
          <p style={{ color: "var(--text-secondary, #9a9aa3)" }}>loading repos…</p>
        ) : repos.length === 0 ? (
          <p style={{ color: "var(--text-secondary, #9a9aa3)" }}>no repos cloned yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-secondary, #9a9aa3)" }}>
                <th style={{ padding: "4px 8px" }} />
                <th style={{ padding: "4px 8px" }}>repo</th>
                <th style={{ padding: "4px 8px" }}>branch @ commit</th>
                <th style={{ padding: "4px 8px" }}>verdict</th>
                <th style={{ padding: "4px 8px" }}>status</th>
                <th style={{ padding: "4px 8px" }}>actions</th>
              </tr>
            </thead>
            <tbody>
              {repos.map((r) => {
                const g = statusGlyph(r.status, r.lastVerdict?.verdict);
                return (
                  <tr
                    key={r.id}
                    title="Double-click to open this repo's folder in the editor"
                    onDoubleClick={() => r.localPath && openFolderInWorkspace(r.localPath)}
                    style={{
                      borderTop: "1px solid var(--border-subtle, #2a2a33)",
                      cursor: r.localPath ? "pointer" : "default",
                    }}
                  >
                    <td style={{ padding: "4px 8px", color: g.color, fontWeight: 700 }}>
                      {g.glyph}
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      {r.owner}/{r.name}
                    </td>
                    <td style={{ padding: "4px 8px", color: "var(--text-secondary, #9a9aa3)" }}>
                      {r.branch}
                      {r.pinnedCommit ? " @ pinned" : r.commit ? ` @ ${r.commit.slice(0, 7)}` : ""}
                    </td>
                    <td style={{ padding: "4px 8px" }}>{r.lastVerdict?.verdict ?? "—"}</td>
                    <td style={{ padding: "4px 8px" }}>{r.status}</td>
                    <td style={{ padding: "4px 8px", display: "flex", gap: 6 }}>
                      <Button
                        variant="ghost"
                        onClick={() => r.localPath && openFolderInWorkspace(r.localPath)}
                        disabled={!r.localPath}
                        title="Open the repo folder in the editor"
                      >
                        Open
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => r.localPath && openExternally(r.localPath)}
                        disabled={!r.localPath}
                        title="Reveal the repo folder in Finder/Explorer"
                      >
                        ↗
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => update.mutate({ id: r.id, force: false })}
                        disabled={update.isPending}
                      >
                        Update
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => rescan.mutate(r.id)}
                        disabled={rescan.isPending}
                      >
                        Rescan
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          // destructive: drops the clone dir + index entry — confirm first.
                          if (
                            window.confirm(
                              `Remove repo "${r.id}"? This deletes its clone directory and index entry. This cannot be undone.`,
                            )
                          ) {
                            remove.mutate(r.id);
                          }
                        }}
                        disabled={remove.isPending}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {pendingGate && (
        <VerdictSheet
          verdict={gateToVerdict(pendingGate.gate, pendingGate.id ?? pendingGate.url ?? "repo")}
          onProceed={() => {
            // proceed = a warn the user accepts → re-run the SAME operation (engine re-gates).
            if (pendingGate.kind === "clone" && pendingGate.url) {
              clone.mutate({ url: pendingGate.url, branch: pendingGate.branch, force: false });
            } else if (pendingGate.kind === "rescan" && pendingGate.id) {
              rescan.mutate(pendingGate.id);
            } else if (pendingGate.kind === "update" && pendingGate.id) {
              update.mutate({ id: pendingGate.id, force: false });
            }
            setPendingGate(null);
          }}
          onCancel={() => setPendingGate(null)}
          onRequestForce={() => {
            // the deep-red override re-runs with force + confirm (§8). A rescan has no
            // force path — re-running the rescan is the strongest action available.
            if (pendingGate.kind === "clone" && pendingGate.url) {
              clone.mutate({ url: pendingGate.url, branch: pendingGate.branch, force: true });
            } else if (pendingGate.kind === "rescan" && pendingGate.id) {
              rescan.mutate(pendingGate.id);
            } else if (pendingGate.kind === "update" && pendingGate.id) {
              update.mutate({ id: pendingGate.id, force: true });
            }
            setPendingGate(null);
          }}
        />
      )}
    </div>
  );
}

export default ReposRoute;
