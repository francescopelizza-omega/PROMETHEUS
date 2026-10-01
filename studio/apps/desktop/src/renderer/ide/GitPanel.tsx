// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * ide/GitPanel.tsx — the git panel (file 07 §6.2).
 *
 * Status (staged / unstaged / untracked, grouped), per-file diff (rendered in a
 * Monaco diff editor when Monaco is available, else a unified-diff fallback), inline
 * stage/unstage, and commit with a "generate commit message" button that streams the
 * AI client over the staged diff (§6.2/§7). All git runs LIVE over
 * window.prometheus.ide.git* — RAW git in MAIN (§6.2); the renderer never spawns it (C5).
 * push is a plain network action (not gated); the remote a clone came from is gated at
 * clone time by file 06 — not here.
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + monaco (lazy, diff editor) + the
 * stores + ai-client + window.prometheus only.
 */

import { Button, Panel, Z, clampToViewport, useFocusTrap } from "@prometheus/ui";
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  IdeGitChange,
  IdeGitLogEntry,
  IdeGitRebaseState,
  IdeGitStashEntry,
  IdePrDetail,
  IdePrStatus,
  IdePrSummary,
} from "../../shared/ipc-contract.js";
import { ChangelistsPanel } from "./ChangelistsPanel.js";
import { EDITOR_THEME } from "./EditorPane.js";
import { MergeView } from "./MergeView.js";
import { WorktreesPanel } from "./WorktreesPanel.js";
import type { RendererEndpoint } from "./ai/ai-client.js";
import { StreamPausedError, streamChat } from "./ai/ai-client.js";
import { familyHasLigatures, resolveFontStack } from "./fonts/registry.js";
import { useFontStore } from "./fonts/store.js";
import { loadMonaco } from "./monaco-loader.js";
import { commitChangelistFiles } from "./state/changelist-commit.js";
import {
  buildPatch,
  changeLineKeys,
  isChangeLine,
  lineKey,
  parseUnifiedDiff,
  toggleSelection,
} from "./state/diff-hunks.js";
import { splitUnifiedDiff } from "./state/diff-split.js";
import { type GraphEdge, type GraphRow, assignLanes } from "./state/git-log-graph.js";
import { detectLanguage } from "./state/lang-detect.js";
import {
  type RebaseAction,
  type RebasePlanRow,
  moveRow,
  needsMessage,
  setRowAction,
  setRowMessage,
  validatePlan,
} from "./state/rebase-plan.js";
import { useAiSessionStore, useGitStore, useTabsStore } from "./state/stores.js";

/** Lane colors cycle through EXISTING semantic tokens only (raw hex forbidden, §6) —
 *  there is no dedicated categorical/chart palette in tokens.json today. */
const LANE_COLORS = [
  "var(--accent)",
  "var(--ok)",
  "var(--warn)",
  "var(--danger)",
  "var(--info)",
  "var(--brand)",
] as const;

function colorForLane(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length]!;
}

const GRAPH_ROW_H = 22;
const GRAPH_COL_W = 14;

/** One row's graph cell: the commit dot at its lane, plus edges to the row ABOVE
 *  (top half, from the previous row's own edge list) and to the row BELOW (bottom
 *  half, from this row's own edge list) — stacking rows this way draws continuous
 *  lane lines down the whole graph column. */
function GraphCell({
  row,
  prevEdges,
  laneCount,
}: {
  row: GraphRow;
  prevEdges: GraphEdge[] | undefined;
  laneCount: number;
}): ReactElement {
  const width = Math.max(laneCount, 1) * GRAPH_COL_W;
  const cx = (lane: number): number => lane * GRAPH_COL_W + GRAPH_COL_W / 2;
  return (
    <svg
      width={width}
      height={GRAPH_ROW_H}
      viewBox={`0 0 ${width} ${GRAPH_ROW_H}`}
      style={{ flexShrink: 0, display: "block" }}
      role="img"
      aria-label={`graph lane ${row.lane}`}
    >
      {(prevEdges ?? []).map((e) => (
        <line
          key={`up-${e.fromLane}-${e.toLane}`}
          x1={cx(e.fromLane)}
          y1={0}
          x2={cx(e.toLane)}
          y2={GRAPH_ROW_H / 2}
          stroke={colorForLane(Math.min(e.fromLane, e.toLane))}
          strokeWidth={1.5}
        />
      ))}
      {row.edges.map((e) => (
        <line
          key={`down-${e.fromLane}-${e.toLane}`}
          x1={cx(e.fromLane)}
          y1={GRAPH_ROW_H / 2}
          x2={cx(e.toLane)}
          y2={GRAPH_ROW_H}
          stroke={colorForLane(Math.min(e.fromLane, e.toLane))}
          strokeWidth={1.5}
        />
      ))}
      <circle cx={cx(row.lane)} cy={GRAPH_ROW_H / 2} r={3.5} fill={colorForLane(row.lane)} />
    </svg>
  );
}

/** A ref (branch/tag/HEAD) as a small labeled pill, styled distinctly by kind. */
function RefPill({ label }: { label: string }): ReactElement {
  const isTag = label.startsWith("tag: ");
  const isHead = label === "HEAD";
  const text = isTag ? label.slice(5) : label;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0 4px",
        marginLeft: 4,
        borderRadius: "var(--radius-sm, 3px)",
        fontSize: "0.65rem",
        fontFamily: "var(--font-mono, monospace)",
        // The tag branch paints on solid --warn amber; --text-primary over it measured 1.45:1.
        // --bg-app is what the sibling isHead branch already uses over --accent. The third
        // (--bg-inset) branch keeps --text-primary: that ground is dark, not a role fill.
        // `--on-warn` is the computed label colour for the `--warn` FILL (tokens/contrast.ts `onFill`).
        // The old `--brand-fg` here was WHITE on the dark scheme over a saturated light fill (~2:1),
        // and a plain `--bg-app` would be near-white over the same fill on the LIGHT scheme.
        color: isHead ? "var(--on-accent)" : isTag ? "var(--on-warn)" : "var(--text-primary)",
        background: isHead ? "var(--accent)" : isTag ? "var(--warn)" : "var(--bg-inset)",
        border: isHead || isTag ? "none" : "1px solid var(--border-strong)",
      }}
    >
      {text}
    </span>
  );
}

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

/** A diff viewer: a real Monaco SIDE-BY-SIDE diff editor (original vs modified, split
 *  from the unified diff) when available, unified-diff <pre> fallback otherwise (#10). */
function DiffView({ diff, fileName }: { diff: string; fileName: string }): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [monacoOk, setMonacoOk] = useState<boolean | null>(null);

  useEffect(() => {
    let disposed = false;
    let editor: import("monaco-editor").editor.IStandaloneDiffEditor | null = null;
    // both models are tracked: editor.dispose() does NOT dispose attached models, so
    // without this each `diff` change would leak two Monaco text models.
    let original: import("monaco-editor").editor.ITextModel | null = null;
    let modified: import("monaco-editor").editor.ITextModel | null = null;
    void (async () => {
      const monaco = await loadMonaco();
      if (disposed || !monaco || !hostRef.current) {
        setMonacoOk(false);
        return;
      }
      // reconstruct the two sides from the unified diff (PURE splitUnifiedDiff) so the
      // editor shows true red/green side-by-side, not flat unified text. The file's
      // language drives syntax highlighting on both sides.
      const sides = splitUnifiedDiff(diff);
      const lang = detectLanguage(fileName);
      original = monaco.editor.createModel(sides.original, lang);
      modified = monaco.editor.createModel(sides.modified, lang);
      // follow the user's editor font (Settings → Fonts) — read at open (the panel is
      // recreated per diff, so it always reflects the current choice).
      const ef = useFontStore.getState().editor;
      editor = monaco.editor.createDiffEditor(hostRef.current, {
        readOnly: true,
        automaticLayout: true,
        // the SHARED theme name, not a stock one — a hardcoded "vs-dark" here was the
        // one Monaco surface that ignored the app palette (handoff §1).
        theme: EDITOR_THEME,
        renderSideBySide: true,
        ignoreTrimWhitespace: false,
        minimap: { enabled: false },
        fontFamily: resolveFontStack(ef.familyId),
        fontSize: ef.size,
        lineHeight: ef.lineHeight,
        fontLigatures: ef.ligatures && familyHasLigatures(ef.familyId),
      });
      editor.setModel({ original, modified });
      setMonacoOk(true);
    })();
    return () => {
      disposed = true;
      editor?.dispose();
      original?.dispose(); // dispose AFTER the editor so they're detached first
      modified?.dispose();
    };
  }, [diff, fileName]);

  if (monacoOk === false) {
    return (
      <pre
        style={{
          margin: 0,
          // §9: no fixed-px pane heights. Viewport-relative, not `flex:1` — both call
          // sites mount this inside a <Panel> body that has no definite height, so a
          // flex child would collapse. This grows with the window instead of clipping
          // every diff to the same 280px slice.
          maxHeight: "min(46vh, 640px)",
          overflow: "auto",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "0.72rem",
          whiteSpace: "pre",
        }}
      >
        {diff}
      </pre>
    );
  }
  // §9: viewport-relative instead of a hardcoded 280. Monaco needs a DEFINITE height
  // (automaticLayout measures its host), so this is a height, not a max-height.
  return <div ref={hostRef} style={{ height: "min(46vh, 640px)" }} aria-label="diff" />;
}

/** APP-084: per-hunk / per-line staging over `git apply --cached [-R] -`. Parses the
 *  displayed diff, offers a Stage/Unstage button per hunk (Unstage = reverse-apply the
 *  STAGED diff) and per-line checkboxes for a partial "Stage N lines". `onApplied` bumps
 *  the diffNonce + refreshes status so both diff panes and the file lists update. */
function HunkStager({
  root,
  diff,
  staged,
  onApplied,
}: {
  root: string;
  diff: string;
  staged: boolean;
  onApplied(): void;
}): ReactElement | null {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<number | "lines" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // a fresh diff (file switch / post-apply refetch) drops any stale selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the diff text
  useEffect(() => setSelected(new Set()), [diff]);
  if (parsed.hunks.length === 0) return null; // rename/mode-only → whole-file staging

  const verb = staged ? "Unstage" : "Stage";
  const apply = async (selection: ReadonlySet<string>, tag: number | "lines"): Promise<void> => {
    const patch = buildPatch(parsed.header, parsed.hunks, selection);
    if (!patch) return;
    setBusy(tag);
    setErr(null);
    const r = await ide()
      ?.gitApplyPatch(root, patch, { cached: true, reverse: staged })
      .catch(() => undefined);
    setBusy(null);
    if (!r || r.ok === false) {
      setErr(r?.error ?? "apply failed");
      return;
    }
    setSelected(new Set());
    onApplied();
  };

  return (
    <div aria-label="hunk staging" style={{ marginTop: 6 }}>
      {parsed.hunks.map((h, hIdx) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: hunks have no stable id; index is fine
          key={hIdx}
          style={{
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm, 3px)",
            marginBottom: 4,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 6px",
              background: "var(--bg-surface-2)",
            }}
          >
            <span
              style={{
                flex: 1,
                color: "var(--text-secondary)",
                fontFamily: "var(--font-mono, monospace)",
                fontSize: "0.68rem",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                whiteSpace: "nowrap",
              }}
            >
              {h.header}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void apply(new Set(changeLineKeys(hIdx, h)), hIdx)}
            >
              {busy === hIdx ? "…" : `${verb} hunk`}
            </Button>
          </div>
          <div
            style={{
              margin: 0,
              padding: "2px 0",
              maxHeight: 220,
              overflow: "auto",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "0.7rem",
            }}
          >
            {h.lines.map((ln, lIdx) => {
              const key = lineKey(hIdx, lIdx);
              const isAdd = ln.startsWith("+");
              const isDel = ln.startsWith("-");
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are position-identified
                  key={lIdx}
                  style={{ display: "flex", alignItems: "center", gap: 4, padding: "0 4px" }}
                >
                  {isChangeLine(ln) ? (
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      aria-label={`select line ${key}`}
                      onChange={(e) =>
                        setSelected((p) => toggleSelection(p, key, e.target.checked))
                      }
                      style={{ margin: 0 }}
                    />
                  ) : (
                    <span style={{ width: 13, flex: "0 0 13px" }} />
                  )}
                  <span
                    style={{
                      whiteSpace: "pre",
                      color: isAdd
                        ? "var(--ok)"
                        : isDel
                          ? "var(--danger)"
                          : "var(--text-secondary)",
                    }}
                  >
                    {ln}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {selected.size > 0 && (
        <Button
          size="sm"
          variant="primary"
          disabled={busy !== null}
          onClick={() => void apply(selected, "lines")}
        >
          {busy === "lines"
            ? "…"
            : `${verb} ${selected.size} selected line${selected.size === 1 ? "" : "s"}`}
        </Button>
      )}
      {err && (
        <p role="alert" style={{ margin: "4px 0 0", color: "var(--danger)", fontSize: "0.72rem" }}>
          {err}
        </p>
      )}
    </div>
  );
}

function ChangeRow({
  change,
  staged,
  onToggle,
  onOpen,
}: {
  change: IdeGitChange;
  staged: boolean;
  onToggle(): void;
  onOpen(): void;
}): ReactElement {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: "0.78rem",
        padding: "1px 0",
      }}
    >
      <button
        type="button"
        aria-label={staged ? "unstage" : "stage"}
        onClick={onToggle}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--accent)",
          cursor: "pointer",
        }}
      >
        {staged ? "−" : "+"}
      </button>
      <button
        type="button"
        onClick={onOpen}
        style={{
          cursor: "pointer",
          fontFamily: "var(--font-mono, monospace)",
          background: "transparent",
          border: "none",
          color: "inherit",
          font: "inherit",
          padding: 0,
        }}
      >
        {change.path}
      </button>
    </li>
  );
}

/** One row in the commit context menu (APP-037) — token-styled, disabled while busy. */
function CommitMenuItem({
  label,
  onClick,
  danger,
  disabled,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "4px 8px",
        fontSize: "0.72rem",
        fontFamily: "var(--font-ui)",
        background: "transparent",
        border: "none",
        borderRadius: "var(--radius-sm, 3px)",
        cursor: disabled ? "default" : "pointer",
        color: danger ? "var(--danger)" : "var(--text-primary)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

/** APP-085: the gated PR/MR review surface. Hidden unless the origin remote is a
 *  supported forge (GitHub/GitLab). Every network call runs in MAIN through the L6
 *  safeFetch proxy; the token lives in the keychain (MAIN) and is never seen here. */
function PullRequests({ root }: { root: string }): ReactElement | null {
  const [status, setStatus] = useState<IdePrStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [prs, setPrs] = useState<IdePrSummary[] | null>(null);
  const [detail, setDetail] = useState<IdePrDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [token, setToken] = useState("");

  useEffect(() => {
    setStatus(null);
    setOpen(false);
    setPrs(null);
    setDetail(null);
    void ide()
      ?.gitPrStatus(root)
      .then((s) => setStatus(s ?? null))
      .catch(() => setStatus(null));
  }, [root]);

  const loadList = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const r = await ide()
      ?.gitPrList(root)
      .catch(() => undefined);
    setBusy(false);
    if (!r || r.ok === false) {
      setErr(r?.error ?? "could not list pull requests");
      setPrs([]);
      return;
    }
    setPrs(Array.isArray(r.prs) ? r.prs : []);
  }, [root]);

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && prs === null) void loadList();
  }, [open, prs, loadList]);

  const openPr = useCallback(
    async (number: number) => {
      setBusy(true);
      setErr(null);
      setDetail(null);
      const r = await ide()
        ?.gitPrGet(root, number)
        .catch(() => undefined);
      setBusy(false);
      if (!r || r.ok === false || !r.detail) {
        setErr(r?.error ?? "could not load pull request");
        return;
      }
      setDetail(r.detail);
    },
    [root],
  );

  const post = useCallback(async () => {
    if (!detail || !comment.trim()) return;
    setBusy(true);
    setErr(null);
    const r = await ide()
      ?.gitPrComment(root, detail.number, comment.trim())
      .catch(() => undefined);
    setBusy(false);
    if (!r || r.ok === false) {
      setErr(r?.error ?? "could not post comment");
      return;
    }
    setComment("");
    await openPr(detail.number); // reload so the new comment appears
  }, [root, detail, comment, openPr]);

  const saveToken = useCallback(async () => {
    const t = token.trim();
    if (!t) return;
    setBusy(true);
    setErr(null);
    const r = await ide()
      ?.gitPrSetToken(root, t)
      .catch(() => undefined);
    setBusy(false);
    if (!r || r.ok === false) {
      setErr(r?.error ?? "could not save token");
      return;
    }
    setToken("");
    const s = await ide()?.gitPrStatus(root);
    setStatus(s ?? null);
  }, [root, token]);

  if (!status?.provider) return null; // unknown remote → the section stays hidden

  return (
    <div style={{ marginTop: 6 }} aria-label="pull requests">
      <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0 2px" }}>
        <h4 style={{ margin: 0, color: "var(--text-secondary)" }}>
          {status.provider === "github" ? "PULL REQUESTS" : "MERGE REQUESTS"}
        </h4>
        <span style={{ color: "var(--text-secondary)", fontSize: "0.68rem" }}>{status.slug}</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={toggle}>
          {open ? "hide" : "show"}
        </Button>
      </div>

      {open && (
        <div
          style={{
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm, 3px)",
            padding: 6,
          }}
        >
          {!status.hasToken && (
            <div style={{ marginBottom: 6, fontSize: "0.72rem" }}>
              <p style={{ margin: "0 0 4px", color: "var(--text-secondary)" }}>
                Add a {status.provider === "github" ? "GitHub" : "GitLab"} token to load and
                comment. It is stored encrypted in your OS keychain (Settings), never in this
                window.
              </p>
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="paste token"
                  aria-label="forge token"
                  style={{
                    flex: 1,
                    background: "var(--bg-inset)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 4,
                    padding: "2px 6px",
                    fontSize: "0.72rem",
                  }}
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !token.trim()}
                  onClick={() => void saveToken()}
                >
                  Save
                </Button>
              </div>
            </div>
          )}

          {detail ? (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <Button size="sm" variant="ghost" onClick={() => setDetail(null)}>
                  ← back
                </Button>
                <span style={{ flex: 1, fontWeight: 600, fontSize: "0.78rem" }}>
                  #{detail.number} {detail.title}
                </span>
              </div>
              <div style={{ color: "var(--text-secondary)", fontSize: "0.7rem", marginBottom: 4 }}>
                {detail.author} · {detail.branch} · {detail.state}
              </div>
              {detail.description && (
                <pre
                  style={{
                    margin: "0 0 6px",
                    maxHeight: 120,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    fontSize: "0.72rem",
                    color: "var(--text-primary)",
                  }}
                >
                  {detail.description}
                </pre>
              )}
              {(detail.comments ?? []).map((c, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: comments have no stable id
                  key={i}
                  style={{
                    borderTop: "1px solid var(--border-subtle)",
                    padding: "3px 0",
                    fontSize: "0.72rem",
                  }}
                >
                  <span style={{ color: "var(--accent)" }}>{c.author}</span>{" "}
                  <span style={{ color: "var(--text-secondary)" }}>{c.createdAt}</span>
                  <div style={{ whiteSpace: "pre-wrap", color: "var(--text-primary)" }}>
                    {c.body}
                  </div>
                </div>
              ))}
              {detail.diff && (
                <div style={{ marginTop: 6 }}>
                  <DiffView diff={detail.diff} fileName={`pr-${detail.number}.diff`} />
                </div>
              )}
              {status.hasToken && (
                <div style={{ marginTop: 6 }}>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="leave a review comment…"
                    aria-label="review comment"
                    rows={2}
                    style={{
                      width: "100%",
                      background: "var(--bg-inset)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 4,
                      padding: "4px 6px",
                      fontSize: "0.72rem",
                      resize: "vertical",
                    }}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || !comment.trim()}
                    onClick={() => void post()}
                  >
                    {busy ? "…" : "Post comment"}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <>
              {busy && (
                <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.72rem" }}>
                  loading…
                </p>
              )}
              {prs && prs.length === 0 && !busy && (
                <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: "0.72rem" }}>
                  No open ones.
                </p>
              )}
              {(prs ?? []).map((p) => (
                <button
                  key={p.number}
                  type="button"
                  onClick={() => void openPr(p.number)}
                  style={{
                    display: "flex",
                    gap: 6,
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    padding: "2px 0",
                    fontSize: "0.72rem",
                    color: "inherit",
                  }}
                >
                  <span
                    style={{ color: "var(--accent)", fontFamily: "var(--font-mono, monospace)" }}
                  >
                    #{p.number}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.title}
                  </span>
                  <span style={{ color: "var(--text-secondary)" }}>{p.author}</span>
                </button>
              ))}
            </>
          )}
          {err && (
            <p
              role="alert"
              style={{ margin: "4px 0 0", color: "var(--danger)", fontSize: "0.72rem" }}
            >
              {err}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** One operation-error banner inside the fixed error stack. */
const ERROR_BANNER: CSSProperties = {
  padding: "6px 10px",
  background: "var(--bg-surface-2)",
  border: "1px solid var(--danger)",
  borderRadius: "var(--radius-sm, 3px)",
  color: "var(--danger)",
  fontSize: "0.72rem",
};
const ERROR_DISMISS: CSSProperties = {
  marginLeft: 6,
  background: "transparent",
  border: "none",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

export function GitPanel({ root }: { root: string }): ReactElement {
  const status = useGitStore((s) => s.status);
  const setStatus = useGitStore((s) => s.setStatus);
  const selectedFile = useGitStore((s) => s.selectedFile);
  const diffStaged = useGitStore((s) => s.diffStaged);
  const selectFile = useGitStore((s) => s.selectFile);
  const endpointId = useAiSessionStore((s) => s.endpointId);
  const neverSendToCloud = useAiSessionStore((s) => s.neverSendToCloud);
  const workspaceRoot = useTabsStore((s) => s.workspaceRoot);
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  // Distinct from genError: the idle watchdog paused generation, not a failure — whatever
  // streamed into `message` above is real and usable, so this is a notice, not a red banner.
  const [genPaused, setGenPaused] = useState(false);
  // bumped on every refresh/stage so the open diff REFETCHES after a stage/unstage
  // (otherwise the diff pane keeps the pre-stage state for the still-selected file).
  const [diffNonce, setDiffNonce] = useState(0);
  // branch switcher + commit log + stash — these `git*` IPC verbs existed but had NO UI.
  const [branches, setBranches] = useState<string[]>([]);
  const [log, setLog] = useState<IdeGitLogEntry[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  // the pure branch-graph lane assignment (APP-036) — recomputed only when the log
  // itself changes, never on selection (selecting a row must not re-run the algorithm).
  const graphRows = useMemo(() => assignLanes(log ?? []), [log]);
  const maxLaneCount = useMemo(
    () => graphRows.reduce((m, r) => Math.max(m, r.laneCount), 1),
    [graphRows],
  );
  // create-branch inline input (null = hidden; Electron blocks window.prompt).
  const [newBranch, setNewBranch] = useState<string | null>(null);
  // stash list + its expand toggle.
  const [stashes, setStashes] = useState<IdeGitStashEntry[]>([]);
  const [showStash, setShowStash] = useState(false);
  const [showChangelists, setShowChangelists] = useState(false);
  // Task #5 (desktop parity): worktree isolation, toggled from the "worktrees" button below
  // or the `git.worktrees` command-palette entry (editor.tsx dispatches "ide:open-worktrees").
  const [showWorktrees, setShowWorktrees] = useState(false);
  const [mergeFile, setMergeFile] = useState<string | null>(null); // APP-039 merge editor
  // network ops (push/pull/fetch) — disable the trio + show which is in flight.
  const [netBusy, setNetBusy] = useState<null | "push" | "pull" | "fetch">(null);

  // APP-037: commit context-menu actions (checkout/cherry-pick/revert/reset).
  const [commitMenu, setCommitMenu] = useState<{ hash: string; x: number; y: number } | null>(null);
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<{
    hash: string;
    mode: "soft" | "mixed" | "hard";
  } | null>(null);
  const [resetConfirmText, setResetConfirmText] = useState("");
  // APP-082 interactive rebase: the in-progress banner + the open editor plan.
  const [rebaseState, setRebaseState] = useState<IdeGitRebaseState | null>(null);
  const [rebasePlan, setRebasePlan] = useState<{ base: string; rows: RebasePlanRow[] } | null>(
    null,
  );
  const [rebaseBusy, setRebaseBusy] = useState(false);
  const [rebaseError, setRebaseError] = useState<string | null>(null);
  // §9.2 overlay contract for the two modal dialogs below. Neither had ANY Escape path —
  // not a dead handler, no handler at all — and neither trapped focus, so Tab walked the
  // git panel behind a dialog whose whole job is to gate a destructive `reset --hard` or a
  // history rewrite. The trap supplies Escape (document capture), initial focus and restore.
  const resetDialogRef = useRef<HTMLDivElement | null>(null);
  const rebaseDialogRef = useRef<HTMLDivElement | null>(null);
  const closeReset = useCallback(() => {
    setConfirmReset(null);
    setResetConfirmText("");
  }, []);
  const closeRebase = useCallback(() => {
    setRebasePlan(null);
    setRebaseError(null);
  }, []);
  useFocusTrap(resetDialogRef, confirmReset !== null, closeReset);
  useFocusTrap(rebaseDialogRef, rebasePlan !== null, closeRebase);

  const refresh = useCallback(async () => {
    const s = await ide()?.gitStatus(root);
    if (s) setStatus(s);
    const b = await ide()?.gitBranches(root);
    if (b?.ok) setBranches(b.branches);
    const st = await ide()?.gitStashList(root);
    if (st) setStashes(st.ok ? st.entries : []);
    setDiffNonce((n) => n + 1);
  }, [root, setStatus]);

  /** APP-037: after a commit action, reload status (branch/detached HEAD/conflicts)
   *  AND the log (a reset/checkout moves HEAD, so the pre-op log is stale). */
  const refreshAfterCommitAction = useCallback(async () => {
    await refresh();
    const r = await ide()?.gitLog(root, 25);
    if (r?.ok) setLog(r.entries);
  }, [refresh, root]);

  const runCommitAction = useCallback(
    async (action: "checkout" | "cherry-pick" | "revert", hash: string) => {
      const api = ide();
      if (!api) return;
      setCommitMenu(null);
      setCommitBusy(true);
      setCommitError(null);
      const res =
        action === "checkout"
          ? await api.gitCheckoutCommit(root, hash)
          : action === "cherry-pick"
            ? await api.gitCherryPick(root, hash)
            : await api.gitRevert(root, hash);
      setCommitBusy(false);
      if (!res.ok) {
        // a cherry-pick/revert CONFLICT is not a hard failure — route the user to the
        // conflicted-files (MERGE CHANGES) section rather than reporting an error.
        setCommitError(
          res.conflicted
            ? `${action} left conflicts — resolve them in the MERGE CHANGES section below, then commit.`
            : `${action} failed: ${res.error ?? "unknown error"}`,
        );
      }
      await refreshAfterCommitAction();
    },
    [root, refreshAfterCommitAction],
  );

  const runReset = useCallback(
    async (hash: string, mode: "soft" | "mixed" | "hard") => {
      const api = ide();
      if (!api) return;
      setConfirmReset(null);
      setResetConfirmText("");
      setCommitBusy(true);
      setCommitError(null);
      const res = await api.gitReset(root, hash, mode);
      setCommitBusy(false);
      if (!res.ok) setCommitError(`reset --${mode} failed: ${res.error ?? "unknown error"}`);
      await refreshAfterCommitAction();
    },
    [root, refreshAfterCommitAction],
  );

  const createBranch = useCallback(async () => {
    const name = (newBranch ?? "").trim();
    if (!name) {
      setNewBranch(null);
      return;
    }
    const r = await ide()?.gitBranch(root, name, { create: true });
    if (r && r.ok === false) {
      setGenError(r.error ?? "could not create branch");
      return;
    }
    setNewBranch(null);
    await refresh();
  }, [root, newBranch, refresh]);

  const stashOp = useCallback(
    async (op: "pop" | "apply" | "drop", index: number) => {
      const api = ide();
      if (!api) return;
      const r =
        op === "pop"
          ? await api.gitStashPop(root, index)
          : op === "apply"
            ? await api.gitStashApply(root, index)
            : await api.gitStashDrop(root, index);
      if (r && r.ok === false) {
        setGenError(r.error ?? `stash ${op} failed`);
        return;
      }
      await refresh();
    },
    [root, refresh],
  );

  const switchBranch = useCallback(
    async (name: string) => {
      if (!name) return;
      const r = await ide()?.gitBranch(root, name);
      if (r && r.ok === false) {
        setGenError(r.error ?? "could not switch branch");
        return;
      }
      await refresh();
    },
    [root, refresh],
  );

  const stash = useCallback(async () => {
    const r = await ide()?.gitStash(root);
    if (r && r.ok === false) {
      setGenError(r.error ?? "stash failed");
      return;
    }
    await refresh();
  }, [root, refresh]);

  // conflict resolution: pick a side (checkout --ours/--theirs) then stage it so the
  // file leaves the conflicted set; the user commits the merge via the box below.
  const resolveConflict = useCallback(
    async (file: string, side: "ours" | "theirs") => {
      const api = ide();
      if (!api) return;
      const r = await api.gitCheckoutSide(root, file, side);
      if (r && r.ok === false) {
        setGenError(r.error ?? "resolve failed");
        return;
      }
      // …and the stage that COMMITS the resolution must be checked too — a resolve that
      // silently failed to stage leaves the file looking resolved while the index disagrees.
      const staged = await api.gitStage(root, [file]).catch(() => null);
      if (staged && staged.ok === false) {
        setGenError(staged.error ?? "could not stage the resolved file");
        return;
      }
      await refresh();
    },
    [root, refresh],
  );

  const abortMerge = useCallback(async () => {
    const r = await ide()?.gitMergeAbort(root);
    if (r && r.ok === false) {
      setGenError(r.error ?? "abort failed");
      return;
    }
    await refresh();
  }, [root, refresh]);

  /* ── APP-082 interactive rebase ──────────────────────────────────────────── */

  const refreshRebaseState = useCallback(async () => {
    const s = await ide()?.gitRebaseState(root);
    setRebaseState(s ?? null);
  }, [root]);

  /** Open the rebase editor for the commits AFTER `hash` (base = its first parent,
   *  so `hash` itself and everything newer become editable). */
  const openRebase = useCallback(
    async (hash: string) => {
      setRebaseError(null);
      const base = log?.find((c) => c.hash === hash)?.parents[0];
      if (!base) {
        setRebaseError("cannot interactively rebase from the root commit");
        return;
      }
      const r = await ide()?.gitRebaseTodo(root, base);
      if (!r?.ok) {
        setRebaseError(r?.error ?? "could not read the rebase todo");
        return;
      }
      setRebasePlan({ base: r.base, rows: r.rows.map((row) => ({ ...row })) });
    },
    [root, log],
  );

  const startRebase = useCallback(async () => {
    if (!rebasePlan) return;
    const check = validatePlan(rebasePlan.rows);
    if (!check.ok) {
      setRebaseError(check.error ?? "invalid rebase plan");
      return;
    }
    setRebaseBusy(true);
    setRebaseError(null);
    try {
      const r = await ide()?.gitRebaseRun(root, rebasePlan.base, rebasePlan.rows);
      setRebasePlan(null);
      // a conflict is NOT an error — the in-progress banner drives Continue/Abort.
      if (r && r.ok === false && !r.conflicted) setRebaseError(r.error ?? "rebase failed");
      await refreshAfterCommitAction();
      await refreshRebaseState();
    } finally {
      setRebaseBusy(false);
    }
  }, [root, rebasePlan, refreshAfterCommitAction, refreshRebaseState]);

  const continueRebase = useCallback(async () => {
    setRebaseBusy(true);
    try {
      const r = await ide()?.gitRebaseContinue(root);
      if (r && r.ok === false && !r.conflicted) setRebaseError(r.error ?? "continue failed");
      await refreshAfterCommitAction();
      await refreshRebaseState();
    } finally {
      setRebaseBusy(false);
    }
  }, [root, refreshAfterCommitAction, refreshRebaseState]);

  const abortRebase = useCallback(async () => {
    setRebaseBusy(true);
    try {
      const r = await ide()?.gitRebaseAbort(root);
      if (r && r.ok === false) setRebaseError(r.error ?? "abort failed");
      await refreshAfterCommitAction();
      await refreshRebaseState();
    } finally {
      setRebaseBusy(false);
    }
  }, [root, refreshAfterCommitAction, refreshRebaseState]);

  const patchRebaseRow = useCallback(
    (next: RebasePlanRow[]) => setRebasePlan((p) => (p ? { ...p, rows: next } : p)),
    [],
  );

  // push / pull --rebase / fetch --all (non-interactive in MAIN; fails fast on auth).
  const netOp = useCallback(
    async (op: "push" | "pull" | "fetch") => {
      setGenError(null);
      setNetBusy(op);
      try {
        const api = ide();
        if (!api) return;
        const r =
          op === "push"
            ? await api.gitPush(root)
            : op === "pull"
              ? await api.gitPull(root)
              : await api.gitFetch(root);
        if (r && r.ok === false) setGenError(r.error ?? `${op} failed`);
        else await refresh();
      } finally {
        setNetBusy(null);
      }
    },
    [root, refresh],
  );

  const toggleLog = useCallback(async () => {
    const next = !showLog;
    setShowLog(next);
    if (next && log === null) {
      const r = await ide()?.gitLog(root, 25);
      setLog(r?.ok ? r.entries : []);
    }
  }, [showLog, log, root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // APP-082: surface an in-progress rebase (incl. one started before this launch / a
  // restart mid-rebase) so the Continue/Abort banner is available without any UI action.
  useEffect(() => {
    void refreshRebaseState();
  }, [refreshRebaseState]);

  // Task #5 (desktop parity): the `git.worktrees` command-palette entry routes here (editor.tsx
  // sets activity="git" then fires this) so the panel opens even when the Git activity wasn't
  // already showing worktrees.
  useEffect(() => {
    const onOpen = (): void => setShowWorktrees(true);
    window.addEventListener("ide:open-worktrees", onOpen);
    return () => window.removeEventListener("ide:open-worktrees", onOpen);
  }, []);

  useEffect(() => {
    let alive = true;
    void diffNonce; // intentional refetch trigger: bumped by refresh()/stage() so the
    // open diff updates after a stage/unstage (the same file stays selected).
    void (async () => {
      if (!selectedFile) {
        setDiff("");
        return;
      }
      const d = await ide()?.gitDiff(root, selectedFile, diffStaged);
      if (alive) setDiff(d?.ok ? d.diff : "");
    })();
    return () => {
      alive = false;
    };
  }, [selectedFile, diffStaged, root, diffNonce]);

  const stage = useCallback(
    async (path: string, currentlyStaged: boolean) => {
      const api = ide();
      if (!api) return;
      /**
       * SURFACE the result. This awaited the call and threw the answer away, so a git refusal
       * ("pathspec … did not match any files") produced no error, no toast and no change — the
       * row simply stayed where it was and the click looked like it had done nothing. Every
       * other consumer of gitStage checks `.ok` (MergeView, changelist-commit); these two were
       * the ones that did not.
       */
      const r = currentlyStaged
        ? await api.gitUnstage(root, [path]).catch(() => null)
        : await api.gitStage(root, [path]).catch(() => null);
      if (r && r.ok === false) {
        setGenError(r.error ?? (currentlyStaged ? "unstage failed" : "stage failed"));
        return;
      }
      await refresh();
    },
    [root, refresh],
  );

  const commit = useCallback(async () => {
    if (!message.trim()) return;
    setGenError(null);
    const r = await ide()?.gitCommit(root, message.trim());
    if (r && r.ok === false) {
      // a rejected/empty commit must NOT clear the box as if it succeeded — keep the
      // message and surface the error.
      setGenError(r.error ?? "commit failed");
      return;
    }
    setMessage("");
    await refresh();
  }, [root, message, refresh]);

  /** APP-038: every changed non-conflicted path (staged ∪ unstaged ∪ untracked). */
  const changedFiles = useMemo(() => {
    const paths = new Set<string>();
    for (const c of status?.staged ?? []) paths.add(c.path);
    for (const c of status?.unstaged ?? []) paths.add(c.path);
    for (const c of status?.untracked ?? []) paths.add(c.path);
    return [...paths];
  }, [status]);

  /** APP-038: commit ONE changelist — stage exactly its files, commit with the shared
   *  message box, then re-stage the OTHER lists' previously-staged files. On any
   *  failure, restore the ORIGINAL staged set (transactional-ish) and surface it. */
  const commitChangelist = useCallback(
    async (files: string[]) => {
      const api = ide();
      if (!api) return;
      // the choreography (reset index → stage the list → commit → restore others,
      // rolling back on failure) is the tested pure helper; this owns UI state only.
      const targets = files.filter((f) => changedFiles.includes(f));
      const originalStaged = (status?.staged ?? []).map((c) => c.path);
      setCommitBusy(true);
      setGenError(null);
      const res = await commitChangelistFiles(api, { root, message, targets, originalStaged });
      if (res.ok) {
        setMessage("");
        // A file whose partial (per-hunk) staging could not be replayed was restored by path,
        // which stages the WHOLE file. The index no longer says what the user set it to say, so
        // it has to be said out loud rather than discovered in the next commit.
        if (res.flattened?.length) {
          setGenError(
            `committed — but these files could not keep their partial staging and are now fully staged: ${res.flattened.join(", ")}`,
          );
        }
      } else setGenError(res.error ?? "changelist commit failed");
      setCommitBusy(false);
      await refresh();
    },
    [root, message, status, changedFiles, refresh],
  );

  /** "generate commit message": stream the AI client over the staged diff (§6.2). */
  const generateMessage = useCallback(async () => {
    if (!endpointId || genBusy) return;
    const stagedDiff = (await ide()?.gitDiff(root, ".", true))?.diff ?? "";
    if (!stagedDiff.trim()) {
      setGenError("Nothing staged to summarize.");
      return;
    }
    // resolve the served endpoint's REAL base URL (the panel only holds its id) — the
    // old code hardcoded baseUrl:"" so every generate POSTed to an empty URL and threw.
    const eps = await window.prometheus?.models?.endpoints?.();
    const all = eps?.ok ? [...(eps.local ?? []), ...(eps.openApi ?? [])] : [];
    const match = all.find((e) => e.name === endpointId) ?? all[0];
    if (!match) {
      setGenError("No model endpoint is serving — start one in Model Hub.");
      return;
    }
    const host = (() => {
      try {
        return new URL(match.baseUrl).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    const isLocal =
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
    const endpoint: RendererEndpoint = {
      id: match.name,
      baseUrl: match.baseUrl,
      locality: isLocal ? "local" : "cloud",
    };
    setGenError(null);
    setGenPaused(false);
    setGenBusy(true);
    try {
      let acc = "";
      for await (const delta of streamChat(
        endpoint,
        [
          {
            role: "system",
            content: "Write a concise conventional-commit message for this staged diff.",
          },
          { role: "user", content: stagedDiff.slice(0, 8000) },
        ],
        { neverSendToCloud },
      )) {
        acc += delta;
        setMessage(acc);
      }
    } catch (e) {
      if (e instanceof StreamPausedError) setGenPaused(true);
      else setGenError(e instanceof Error ? e.message : "commit-message generation failed");
    } finally {
      setGenBusy(false);
    }
  }, [endpointId, genBusy, root, neverSendToCloud]);

  const branch = status?.branch ?? "—";

  // APP-082: a rebase must start from a CLEAN tree (git refuses otherwise) — the
  // editor's Start button reflects it.
  const rebaseTreeDirty =
    (status?.staged?.length ?? 0) +
      (status?.unstaged?.length ?? 0) +
      (status?.untracked?.length ?? 0) +
      (status?.conflicted?.length ?? 0) >
    0;

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 8, fontSize: "0.8rem" }}
      aria-label="git"
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}
      >
        <span style={{ color: "var(--text-secondary)" }}>⎇</span>
        {branches.length > 0 ? (
          <select
            value={branch}
            aria-label="switch branch"
            onChange={(e) => void switchBranch(e.target.value)}
            style={{
              background: "var(--bg-surface-2)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              padding: "2px 4px",
              fontSize: "0.78rem",
            }}
          >
            {!branches.includes(branch) && branch !== "—" && (
              <option value={branch}>{branch}</option>
            )}
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ color: "var(--text-secondary)" }}>{branch}</span>
        )}
        {/* create-branch (Electron blocks window.prompt → inline input) */}
        {newBranch === null ? (
          <Button size="sm" variant="ghost" title="Create branch" onClick={() => setNewBranch("")}>
            ＋ branch
          </Button>
        ) : (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input
              // biome-ignore lint/a11y/noAutofocus: reveal-then-type affordance
              autoFocus
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createBranch();
                else if (e.key === "Escape") setNewBranch(null);
              }}
              placeholder="new-branch"
              aria-label="new branch name"
              style={{
                background: "var(--bg-surface-2)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                padding: "2px 4px",
                fontSize: "0.78rem",
                width: 120,
              }}
            />
            <Button size="sm" variant="ghost" onClick={() => void createBranch()}>
              create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setNewBranch(null)}>
              ✕
            </Button>
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          refresh
        </Button>
        {status?.ok && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={netBusy !== null}
              onClick={() => void netOp("pull")}
            >
              {netBusy === "pull" ? "…" : "↓ pull"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={netBusy !== null}
              onClick={() => void netOp("push")}
            >
              {netBusy === "push" ? "…" : "↑ push"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={netBusy !== null}
              onClick={() => void netOp("fetch")}
            >
              {netBusy === "fetch" ? "…" : "⟳ fetch"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void stash()}>
              stash
            </Button>
            {stashes.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setShowStash((v) => !v)}>
                {showStash ? "hide stashes" : `stashes (${stashes.length})`}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void toggleLog()}>
              {showLog ? "hide log" : "log"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowChangelists((v) => !v)}>
              {showChangelists ? "flat view" : "changelists"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowWorktrees((v) => !v)}>
              {showWorktrees ? "hide worktrees" : "worktrees"}
            </Button>
          </>
        )}
      </div>

      {/* APP-082: an in-progress rebase (incl. after an app restart) — Continue / Abort. */}
      {rebaseState?.inProgress && (
        <div
          aria-label="rebase in progress"
          style={{
            marginBottom: 8,
            padding: "6px 8px",
            background: "var(--bg-surface-2)",
            border: "1px solid var(--warn)",
            borderRadius: "var(--radius-sm, 3px)",
            fontSize: "0.74rem",
          }}
        >
          <div style={{ color: "var(--warn)", fontWeight: 600 }}>
            ⚠ Rebase in progress
            {rebaseState.step && rebaseState.total
              ? ` — step ${rebaseState.step}/${rebaseState.total}`
              : ""}
          </div>
          {rebaseState.conflicted.length > 0 && (
            <div style={{ margin: "3px 0", color: "var(--text-secondary)" }}>
              resolve + stage: {rebaseState.conflicted.join(", ")}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <Button
              size="sm"
              variant="primary"
              disabled={rebaseBusy}
              onClick={() => void continueRebase()}
            >
              {rebaseBusy ? "…" : "Continue"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={rebaseBusy}
              onClick={() => void abortRebase()}
            >
              Abort
            </Button>
          </div>
        </div>
      )}

      {showLog && (
        <div
          style={{
            marginBottom: 8,
            maxHeight: "min(220px, 35vh)",
            overflow: "auto",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {log === null ? (
            <p style={{ color: "var(--text-secondary)", margin: 4 }}>loading…</p>
          ) : log.length === 0 ? (
            <p style={{ color: "var(--text-secondary)", margin: 4 }}>no commits.</p>
          ) : (
            log.map((c, i) => {
              const row = graphRows[i];
              if (!row) return null;
              const selected = c.hash === selectedHash;
              return (
                <button
                  key={c.hash}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelectedHash(selected ? null : c.hash)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelectedHash(c.hash);
                    setCommitMenu({ hash: c.hash, x: e.clientX, y: e.clientY });
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    padding: "2px 0",
                    fontSize: "0.72rem",
                    fontFamily: "var(--font-ui)",
                    textAlign: "left",
                    cursor: "pointer",
                    background: selected ? "var(--bg-inset)" : "transparent",
                    border: "none",
                    borderRadius: "var(--radius-sm, 3px)",
                    color: "inherit",
                  }}
                >
                  <GraphCell
                    row={row}
                    prevEdges={graphRows[i - 1]?.edges}
                    laneCount={maxLaneCount}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        color: "var(--accent)",
                        fontFamily: "var(--font-mono, monospace)",
                      }}
                    >
                      {c.hash.slice(0, 7)}
                    </span>{" "}
                    <span style={{ color: "var(--text-primary)" }}>{c.subject}</span>
                    {c.refs.map((r) => (
                      <RefPill key={r} label={r} />
                    ))}
                    <div style={{ color: "var(--text-secondary)" }}>
                      {c.author} · {c.date}
                    </div>
                    {selected && (
                      <div
                        style={{
                          marginTop: 4,
                          padding: 6,
                          background: "var(--bg-surface-2)",
                          borderRadius: "var(--radius-sm, 3px)",
                          fontFamily: "var(--font-mono, monospace)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        <div>hash: {c.hash}</div>
                        <div>
                          parent{c.parents.length === 1 ? "" : "s"}:{" "}
                          {c.parents.length > 0
                            ? c.parents.map((p) => p.slice(0, 7)).join(", ")
                            : "—"}
                        </div>
                        <div>refs: {c.refs.length > 0 ? c.refs.join(", ") : "—"}</div>
                      </div>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}

      {showStash && stashes.length > 0 && (
        <div
          style={{
            marginBottom: 8,
            maxHeight: "min(180px, 30vh)",
            overflow: "auto",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {stashes.map((s) => (
            <div
              key={s.ref}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "2px 0",
                fontSize: "0.72rem",
              }}
            >
              <span
                style={{
                  color: "var(--accent)",
                  fontFamily: "var(--font-mono, monospace)",
                }}
              >
                {s.ref}
              </span>
              <span
                style={{
                  flex: 1,
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                  whiteSpace: "nowrap",
                }}
              >
                {s.message}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void stashOp("pop", s.index)}>
                pop
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void stashOp("apply", s.index)}>
                apply
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void stashOp("drop", s.index)}>
                drop
              </Button>
            </div>
          ))}
        </div>
      )}

      {!status?.ok && (
        <p style={{ color: "var(--text-secondary)" }}>{status?.error ?? "Not a git repo."}</p>
      )}

      {status?.ok && (
        <>
          {/* APP-085: gated PR/MR review (hidden unless origin is GitHub/GitLab). */}
          <PullRequests root={root} />
          {/* Task #5 (desktop parity): worktree isolation, same core functions as the CLI. */}
          {showWorktrees && <WorktreesPanel root={root} />}
          {showChangelists && (
            <ChangelistsPanel
              root={root}
              changedFiles={changedFiles}
              onCommitList={(files) => void commitChangelist(files)}
              busy={commitBusy}
            />
          )}
          <h4 style={{ margin: "6px 0 2px", color: "var(--text-secondary)" }}>STAGED</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {(status.staged ?? []).map((c) => (
              <ChangeRow
                key={`s:${c.path}`}
                change={c}
                staged
                onToggle={() => void stage(c.path, true)}
                onOpen={() => selectFile(c.path, true)}
              />
            ))}
          </ul>
          {status.conflicted && status.conflicted.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0 2px" }}>
                <h4 style={{ margin: 0, color: "var(--danger)" }}>MERGE CHANGES</h4>
                <span style={{ flex: 1 }} />
                <Button size="sm" variant="ghost" onClick={() => void abortMerge()}>
                  ✖ Abort
                </Button>
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {status.conflicted.map((c) => (
                  <li
                    key={`c:${c.path}`}
                    style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.78rem" }}
                  >
                    <button
                      type="button"
                      onClick={() => selectFile(c.path, false)}
                      style={{
                        flex: 1,
                        textAlign: "left",
                        background: "transparent",
                        border: "none",
                        color: "inherit",
                        cursor: "pointer",
                        fontFamily: "var(--font-mono, monospace)",
                        padding: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.path}
                    </button>
                    <Button size="sm" variant="ghost" onClick={() => setMergeFile(c.path)}>
                      merge
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void resolveConflict(c.path, "ours")}
                    >
                      ours
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void resolveConflict(c.path, "theirs")}
                    >
                      theirs
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4 style={{ margin: "6px 0 2px", color: "var(--text-secondary)" }}>CHANGES</h4>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {[...(status.unstaged ?? []), ...(status.untracked ?? [])].map((c) => (
              <ChangeRow
                key={`u:${c.path}`}
                change={c}
                staged={false}
                onToggle={() => void stage(c.path, false)}
                onOpen={() => selectFile(c.path, false)}
              />
            ))}
          </ul>

          <div style={{ marginTop: 8 }}>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="commit message"
              aria-label="commit message"
              rows={3}
              style={{
                width: "100%",
                boxSizing: "border-box",
                background: "var(--bg-surface-2)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                padding: 6,
                fontFamily: "var(--font-mono, monospace)",
                fontSize: "0.75rem",
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <Button
                size="sm"
                variant="primary"
                disabled={!message.trim()}
                onClick={() => void commit()}
              >
                Commit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!endpointId || genBusy}
                onClick={() => void generateMessage()}
              >
                {genBusy ? "…" : "✦ generate message"}
              </Button>
            </div>
            {genError && (
              <p style={{ margin: "4px 0 0", color: "var(--danger)", fontSize: "0.72rem" }}>
                {genError}
              </p>
            )}
            {genPaused && (
              <p style={{ margin: "4px 0 0", color: "var(--warn)", fontSize: "0.72rem" }}>
                ⏸ the model went idle — paused, nothing lost. Edit the draft above, or retry.
              </p>
            )}
          </div>
        </>
      )}

      {selectedFile && diff && (
        <Panel title={`diff · ${selectedFile}${diffStaged ? " (staged)" : ""}`} elevation="e1">
          <DiffView diff={diff} fileName={selectedFile} />
          {/* APP-084: per-hunk / per-line staging of the SAME displayed diff. */}
          <HunkStager
            root={root}
            diff={diff}
            staged={diffStaged}
            onApplied={() => void refresh()}
          />
        </Panel>
      )}

      {/* workspaceRoot is the gate scope; surfaced so a reviewer sees it is bound. */}
      {workspaceRoot && workspaceRoot !== root && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.7rem" }}>
          workspace: {workspaceRoot}
        </p>
      )}

      {/*
        APP-037 / APP-082: operation errors, in ONE fixed stack so they survive log scroll and
        never overlap. They used to be two fixed boxes, the second pinned at top:44 to clear the
        first — which only works while the first is ONE line. Raw git stderr and the conflict
        message routinely wrap to two lines inside maxWidth:480, and the second banner then
        printed over the first. In one column they stack by normal flow, whatever their height.
        Z.toast, not Z.modal: a banner exists to say WHY an operation failed, and it must outrank
        the dialog that failed. Tied at Z.modal, DOM order decided — and the dialogs come later in
        this file, so they painted over the reason.
      */}
      {(commitError || rebaseError) && (
        <div
          style={{
            position: "fixed",
            top: 8,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: Z.toast,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            maxWidth: 480,
            // the gaps between banners must not swallow clicks meant for what is underneath
            pointerEvents: "none",
          }}
        >
          {commitError && (
            <div style={{ ...ERROR_BANNER, pointerEvents: "auto" }}>
              {commitError}{" "}
              <button
                type="button"
                aria-label="dismiss error"
                onClick={() => setCommitError(null)}
                style={ERROR_DISMISS}
              >
                ✕
              </button>
            </div>
          )}
          {rebaseError && (
            <div role="alert" style={{ ...ERROR_BANNER, pointerEvents: "auto" }}>
              {rebaseError}{" "}
              <button
                type="button"
                aria-label="dismiss rebase error"
                onClick={() => setRebaseError(null)}
                style={ERROR_DISMISS}
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      {/* APP-039: the full 3-way merge editor for a conflicted file. */}
      {mergeFile && (
        <MergeView
          root={root}
          file={mergeFile}
          onResolved={() => {
            setMergeFile(null);
            void refresh();
          }}
          onClose={() => setMergeFile(null)}
        />
      )}

      {/* APP-037: right-click commit context menu. */}
      {commitMenu && (
        <>
          <button
            type="button"
            aria-label="close commit menu"
            onClick={() => setCommitMenu(null)}
            style={{
              position: "fixed",
              inset: 0,
              // Z.dropdown: a context menu is the dropdown rung (as FileTree's). At Z.modal this
              // click-away sat ABOVE the ⌘K palette (Z.palette) and swallowed every click on it.
              zIndex: Z.dropdown,
              background: "transparent",
              border: "none",
              cursor: "default",
            }}
          />
          <div
            style={{
              position: "fixed",
              // clamp into the viewport so a right-click low/right doesn't push the menu (and
              // its destructive "Reset (hard)" item) off-window. The shared clamp also holds
              // the TOP-LEFT edge, which the hand-rolled version here did not: a right-click
              // near the origin used to place the menu at a negative offset.
              ...(({ x, y }) => ({ left: x, top: y }))(
                clampToViewport(commitMenu.x, commitMenu.y, 190, 240),
              ),
              zIndex: Z.dropdown,
              minWidth: 180,
              padding: 4,
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm, 3px)",
              boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
          >
            <CommitMenuItem
              label="Checkout (detach HEAD)"
              disabled={commitBusy}
              onClick={() => void runCommitAction("checkout", commitMenu.hash)}
            />
            <CommitMenuItem
              label="Cherry-pick"
              disabled={commitBusy}
              onClick={() => void runCommitAction("cherry-pick", commitMenu.hash)}
            />
            <CommitMenuItem
              label="Revert"
              disabled={commitBusy}
              onClick={() => void runCommitAction("revert", commitMenu.hash)}
            />
            <div style={{ height: 1, margin: "2px 0", background: "var(--border-subtle)" }} />
            <CommitMenuItem
              label="Interactive rebase from here"
              disabled={commitBusy}
              onClick={() => {
                const hash = commitMenu.hash;
                setCommitMenu(null);
                void openRebase(hash);
              }}
            />
            <div style={{ height: 1, margin: "2px 0", background: "var(--border-subtle)" }} />
            <CommitMenuItem
              label="Reset (soft)"
              disabled={commitBusy}
              onClick={() => {
                setConfirmReset({ hash: commitMenu.hash, mode: "soft" });
                setCommitMenu(null);
              }}
            />
            <CommitMenuItem
              label="Reset (mixed)"
              disabled={commitBusy}
              onClick={() => {
                setConfirmReset({ hash: commitMenu.hash, mode: "mixed" });
                setCommitMenu(null);
              }}
            />
            <CommitMenuItem
              label="Reset (hard) — discards changes"
              danger
              disabled={commitBusy}
              onClick={() => {
                setConfirmReset({ hash: commitMenu.hash, mode: "hard" });
                setCommitMenu(null);
              }}
            />
          </div>
        </>
      )}

      {/* APP-037: EVERY reset is confirm-gated; --hard needs a typed confirmation. */}
      {confirmReset && (
        <>
          <button
            type="button"
            aria-label="cancel reset"
            onClick={closeReset}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: Z.modal,
              background: "rgba(0, 0, 0, 0.45)",
              border: "none",
              cursor: "default",
            }}
          />
          <div
            ref={resetDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-label="confirm reset"
            style={{
              position: "fixed",
              top: "30%",
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: Z.modal,
              width: "min(420px, 90vw)",
              // the --hard branch adds a paragraph + a labelled typed-confirm input, which
              // overflowed a short window with no way to scroll to the buttons.
              maxHeight: "70vh",
              overflow: "auto",
              padding: 14,
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm, 3px)",
              boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "0.82rem" }}>
              Reset --{confirmReset.mode} to {confirmReset.hash.slice(0, 7)}?
            </div>
            {confirmReset.mode === "hard" ? (
              <>
                <p style={{ margin: "8px 0", color: "var(--danger)", fontSize: "0.74rem" }}>
                  This DISCARDS every uncommitted change in the index AND working tree. It cannot be
                  undone.
                </p>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.72rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Type <code>reset</code> to confirm:
                  <input
                    value={resetConfirmText}
                    onChange={(e) => setResetConfirmText(e.target.value)}
                    aria-label="type reset to confirm"
                    style={{
                      display: "block",
                      width: "100%",
                      marginTop: 4,
                      padding: "4px 6px",
                      background: "var(--bg-inset)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border-subtle)",
                      borderRadius: "var(--radius-sm, 3px)",
                      fontSize: "0.74rem",
                    }}
                  />
                </label>
              </>
            ) : (
              <p
                style={{
                  margin: "8px 0",
                  color: "var(--text-secondary)",
                  fontSize: "0.74rem",
                }}
              >
                {confirmReset.mode === "soft"
                  ? "Moves HEAD only — the index and working tree are kept."
                  : "Resets the index — the working tree is kept."}
              </p>
            )}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConfirmReset(null);
                  setResetConfirmText("");
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={
                  commitBusy || (confirmReset.mode === "hard" && resetConfirmText !== "reset")
                }
                onClick={() => void runReset(confirmReset.hash, confirmReset.mode)}
              >
                Reset --{confirmReset.mode}
              </Button>
            </div>
          </div>
        </>
      )}

      {/* APP-082: the interactive-rebase editor (todo list, oldest-first). */}
      {rebasePlan && (
        <>
          <button
            type="button"
            aria-label="cancel rebase"
            onClick={closeRebase}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: Z.modal,
              background: "rgba(0, 0, 0, 0.45)",
              border: "none",
              cursor: "default",
            }}
          />
          <div
            ref={rebaseDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="interactive rebase editor"
            style={{
              position: "fixed",
              top: "12%",
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: Z.modal,
              width: "min(560px, 94vw)",
              maxHeight: "76vh",
              overflow: "auto",
              padding: 14,
              background: "var(--bg-surface-2)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm, 3px)",
              boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
            }}
          >
            <div style={{ fontWeight: 600, fontSize: "0.84rem", marginBottom: 2 }}>
              Interactive rebase
            </div>
            <div style={{ color: "var(--text-secondary)", fontSize: "0.72rem", marginBottom: 8 }}>
              onto {rebasePlan.base.slice(0, 7)} · {rebasePlan.rows.length} commit
              {rebasePlan.rows.length === 1 ? "" : "s"} · oldest first
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {rebasePlan.rows.map((r, i) => {
                const fold = r.action === "squash" || r.action === "fixup";
                return (
                  <li
                    key={r.sha}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "2px 0",
                      paddingLeft: fold ? 16 : 0,
                      fontSize: "0.72rem",
                    }}
                  >
                    {fold && (
                      <span aria-hidden="true" style={{ color: "var(--text-secondary)" }}>
                        ↳
                      </span>
                    )}
                    <select
                      value={r.action}
                      aria-label={`action for ${r.sha.slice(0, 7)}`}
                      onChange={(e) =>
                        patchRebaseRow(
                          setRowAction(rebasePlan.rows, i, e.target.value as RebaseAction),
                        )
                      }
                      style={{
                        background: "var(--bg-inset)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: 4,
                        padding: "1px 3px",
                        fontSize: "0.7rem",
                      }}
                    >
                      {(["pick", "reword", "squash", "fixup", "drop"] as const).map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                    <span
                      style={{ color: "var(--accent)", fontFamily: "var(--font-mono, monospace)" }}
                    >
                      {r.sha.slice(0, 7)}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        textDecoration: r.action === "drop" ? "line-through" : "none",
                        color:
                          r.action === "drop" ? "var(--text-secondary)" : "var(--text-primary)",
                      }}
                    >
                      {r.subject}
                    </span>
                    <button
                      type="button"
                      aria-label={`move ${r.sha.slice(0, 7)} up`}
                      disabled={i === 0}
                      onClick={() => patchRebaseRow(moveRow(rebasePlan.rows, i, -1))}
                      style={{
                        background: "transparent",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: 3,
                        color: "var(--text-secondary)",
                        cursor: i === 0 ? "default" : "pointer",
                        fontSize: "0.7rem",
                        padding: "0 4px",
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`move ${r.sha.slice(0, 7)} down`}
                      disabled={i === rebasePlan.rows.length - 1}
                      onClick={() => patchRebaseRow(moveRow(rebasePlan.rows, i, 1))}
                      style={{
                        background: "transparent",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: 3,
                        color: "var(--text-secondary)",
                        cursor: i === rebasePlan.rows.length - 1 ? "default" : "pointer",
                        fontSize: "0.7rem",
                        padding: "0 4px",
                      }}
                    >
                      ↓
                    </button>
                  </li>
                );
              })}
            </ul>
            {rebasePlan.rows.map((r, i) =>
              needsMessage(r.action) ? (
                <input
                  key={`msg:${r.sha}`}
                  value={r.message ?? ""}
                  placeholder={`${r.action} message for ${r.sha.slice(0, 7)} — defaults to "${r.subject}"`}
                  aria-label={`message for ${r.sha.slice(0, 7)}`}
                  onChange={(e) =>
                    patchRebaseRow(setRowMessage(rebasePlan.rows, i, e.target.value))
                  }
                  style={{
                    display: "block",
                    width: "100%",
                    margin: "4px 0",
                    padding: "3px 6px",
                    background: "var(--bg-inset)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-sm, 3px)",
                    fontSize: "0.72rem",
                  }}
                />
              ) : null,
            )}
            {rebaseTreeDirty && (
              <p style={{ margin: "6px 0 0", color: "var(--warn)", fontSize: "0.72rem" }}>
                Commit, stash, or discard your changes first — a rebase needs a clean working tree.
              </p>
            )}
            {!validatePlan(rebasePlan.rows).ok && (
              <p style={{ margin: "6px 0 0", color: "var(--danger)", fontSize: "0.72rem" }}>
                {validatePlan(rebasePlan.rows).error}
              </p>
            )}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRebasePlan(null);
                  setRebaseError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={rebaseBusy || rebaseTreeDirty || !validatePlan(rebasePlan.rows).ok}
                onClick={() => void startRebase()}
              >
                {rebaseBusy ? "Rebasing…" : "Start rebase"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default GitPanel;
