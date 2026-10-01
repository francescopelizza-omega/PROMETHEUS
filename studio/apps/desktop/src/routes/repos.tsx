// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
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
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { openExternally, openFolderInWorkspace } from "../renderer/open-resource.js";

import { DecisionOverlay } from "../renderer/shell/DecisionOverlay.js";
import { ForceGate, useForceGate } from "../renderer/shell/ForceGate.js";
import type {
  RepoCloneResult,
  RepoGateSummary,
  RepoListResult,
  RepoRow,
} from "../shared/ipc-contract.js";
import { WORKSPACE_CLONE_EVENT, cellVar, repoScan, repoSync } from "./workspace-view.js";

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
  if (status === "blocked") return { glyph: "✕", color: "var(--danger)" };
  if (verdict === "warn") return { glyph: "◐", color: "var(--warn)" };
  if (status === "stale") return { glyph: "◌", color: "var(--text-secondary)" };
  if (status === "missing") return { glyph: "?", color: "var(--text-secondary)" };
  return { glyph: "●", color: "var(--ok)" };
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
  // §9: the shared typed-confirm gate for deep-red overrides on this route.
  const force = useForceGate();
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  /**
   * §5's island header carries a "Clone repo…" action, but the clone FORM stays here — it is
   * the one staged-and-gated clone path (00-INDEX C6), and a second entry point would be a
   * second place for that gate to be got wrong. The header therefore navigates and asks; this
   * focuses + scrolls the real form.
   */
  const urlRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onAsk = (): void => {
      urlRef.current?.scrollIntoView({ block: "nearest" });
      urlRef.current?.focus();
    };
    window.addEventListener(WORKSPACE_CLONE_EVENT, onAsk);
    return () => window.removeEventListener(WORKSPACE_CLONE_EVENT, onAsk);
  }, []);
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
        <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.82rem" }}>
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
            ref={urlRef}
            placeholder="https://github.com/owner/repo.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{
              flex: "1 1 320px",
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              color: "var(--text-primary)",
              padding: "6px 10px",
            }}
          />
          <input
            placeholder="branch (optional)"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            style={{
              flex: "0 1 160px",
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              color: "var(--text-primary)",
              padding: "6px 10px",
            }}
          />
          <Button variant="primary" type="submit" disabled={clone.isPending}>
            {clone.isPending ? "staging + scanning…" : "+ Clone"}
          </Button>
        </form>
        {clone.isError && (
          <p role="alert" style={{ color: "var(--danger)", margin: "8px 0 0", fontSize: "0.8rem" }}>
            Clone failed to reach the engine — check the URL and try again.
          </p>
        )}
        {clone.data && !clone.data.ok && !clone.data.gate && !clone.data.forcedDanger && (
          <p role="alert" style={{ color: "var(--danger)", margin: "8px 0 0", fontSize: "0.8rem" }}>
            Clone failed: {clone.data.error ?? "unknown error"}
          </p>
        )}
      </Panel>

      <Panel title="Repos" elevation="e1">
        <p style={{ marginTop: 0, color: "var(--text-secondary)", fontSize: "0.78rem" }}>
          ● clean · ◐ warn · ✕ blocked · ◌ stale · Force… = deep-red override (typed confirm)
        </p>
        {reposQ.isError || (reposQ.data && !reposQ.data.ok) ? (
          // was disguised as "no repos cloned yet." — a sidecar error must not read as empty.
          <p role="alert" style={{ color: "var(--danger)" }}>
            Couldn't load repos:{" "}
            {reposQ.data?.error ?? "the repo sidecar didn't respond — try again."}
          </p>
        ) : reposQ.isPending ? (
          <p style={{ color: "var(--text-secondary)" }}>loading repos…</p>
        ) : repos.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>
            No repos yet — clone a GitHub repo above (staged + nemesis-scanned before anything
            lands).
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {repos.map((r) => {
              const g = statusGlyph(r.status, r.lastVerdict?.verdict);
              const sync = repoSync(r);
              const scan = repoScan(r);
              return (
                <li
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap", // §7 — the action cluster wraps before anything is clipped
                    gap: 8,
                    padding: "6px 4px",
                    borderTop: "1px solid var(--border-subtle)",
                    minWidth: 0, // §7
                  }}
                >
                  {/* §5's glyph chip — the tri-state gate mark, tinted at its own role. */}
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 30,
                      height: 30,
                      flex: "none",
                      borderRadius: "var(--radius-md, 6px)",
                      background: `color-mix(in srgb, ${g.color} 12%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${g.color} 28%, transparent)`,
                      color: g.color,
                      fontWeight: 700,
                    }}
                  >
                    {g.glyph}
                  </span>

                  <button
                    type="button"
                    onClick={() => r.localPath && openFolderInWorkspace(r.localPath)}
                    disabled={!r.localPath}
                    title="Open this repo's folder in the editor"
                    style={{
                      flex: "1 1 200px",
                      minWidth: 0, // §7
                      textAlign: "left",
                      background: "transparent",
                      border: "none",
                      color: "var(--text-primary)",
                      cursor: r.localPath ? "pointer" : "default",
                      padding: 0,
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        fontSize: "0.82rem",
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.owner}/{r.name}
                    </span>
                    <span
                      style={{
                        display: "block",
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.68rem",
                        color: "var(--text-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.localPath || "not on disk"}
                    </span>
                  </button>

                  {/* §5's `⎇ branch` inset pill */}
                  <span
                    style={{
                      flex: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "2px 7px",
                      borderRadius: "var(--radius-sm, 4px)",
                      background: "var(--bg-inset)",
                      border: "1px solid var(--border-chip)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10.5,
                      color: "var(--text-secondary)",
                      whiteSpace: "nowrap", // §7
                    }}
                  >
                    <span aria-hidden="true">⎇</span>
                    {r.branch || "—"}
                  </span>

                  <span
                    style={{
                      flex: "none",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.68rem",
                      color: cellVar(sync.role),
                      whiteSpace: "nowrap", // §7
                    }}
                  >
                    {sync.text}
                  </span>
                  <span
                    style={{
                      flex: "none",
                      fontSize: "0.7rem",
                      fontWeight: 600,
                      color: cellVar(scan.role),
                      whiteSpace: "nowrap", // §7
                    }}
                  >
                    {scan.text}
                  </span>

                  <span style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: "none" }}>
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
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {pendingGate && (
        // §9: a decision surface is NEVER in-flow. Wrapped so the verdict — and the
        // actions under it — cannot scroll below the fold.
        <DecisionOverlay label="Security verdict" onDismiss={() => setPendingGate(null)}>
          <VerdictSheet
            verdict={gateToVerdict(pendingGate.gate, pendingGate.id ?? pendingGate.url ?? "repo")}
            onProceed={() => {
              // proceed = a warn the user accepts → re-run the SAME operation (engine re-gates).
              // force=true: a warn is kept-staged (not promoted); force+confirm is the ONLY
              // renderer lever to admit it. force:false re-gates → identical warn → loop.
              if (pendingGate.kind === "clone" && pendingGate.url) {
                clone.mutate({ url: pendingGate.url, branch: pendingGate.branch, force: true });
              } else if (pendingGate.kind === "rescan" && pendingGate.id) {
                rescan.mutate(pendingGate.id);
              } else if (pendingGate.kind === "update" && pendingGate.id) {
                update.mutate({ id: pendingGate.id, force: true });
              }
              setPendingGate(null);
            }}
            onCancel={() => setPendingGate(null)}
            onRequestForce={() => {
              // §9 (HIGH): the typed confirm gates the override. A rescan carries no force
              // flag, so it runs directly — there is nothing dangerous to confirm.
              const g = pendingGate;
              if (g.kind === "rescan" && g.id) {
                rescan.mutate(g.id);
              } else {
                force.ask({
                  target: g.url ?? g.id ?? "repository",
                  blockingReasons: g.gate.reasons,
                  onConfirm: () => {
                    if (g.kind === "clone" && g.url)
                      clone.mutate({ url: g.url, branch: g.branch, force: true });
                    else if (g.kind === "update" && g.id) update.mutate({ id: g.id, force: true });
                  },
                });
              }
              setPendingGate(null);
            }}
          />
        </DecisionOverlay>
      )}

      {/* §9: the typed confirm that gates every deep-red override on this route. */}
      <ForceGate gate={force} />
    </div>
  );
}

export default ReposRoute;
