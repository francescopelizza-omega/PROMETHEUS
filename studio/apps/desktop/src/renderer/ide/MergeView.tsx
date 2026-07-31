/**
 * ide/MergeView.tsx — the 3-way merge editor for a conflicted file (APP-039).
 *
 * Reads base/ours/theirs (git index stages) + the working copy via the validated
 * `gitConflictVersions` IPC, parses the working file's conflict markers with the pure
 * merge-conflict model, and renders three read-only reference panes (base/ours/theirs)
 * above an EDITABLE result: each conflict block has accept ours/theirs/both buttons
 * and an editable text box (editing flips the block to "manual"); common text is
 * shown read-only. Mark Resolved — enabled only when EVERY block is decided — writes
 * the merged file via the path-guarded fs IPC, stages it, and closes.
 *
 * A binary file (a NUL in any version) falls back to the quick ours/theirs buttons —
 * a 3-way TEXT merge of binary is meaningless. Composed from plain panes + text boxes
 * (no new merge library, no Monaco 3-way widget — which the bundled monaco lacks).
 *
 * Renderer-SANDBOXED (C5): react + @prometheus/ui + the pure model + window.prometheus.
 */

import { Button } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useCallback, useEffect, useState } from "react";

import {
  type ParsedMerge,
  acceptBoth,
  acceptOurs,
  acceptTheirs,
  blockText,
  buildResult,
  parseConflicts,
  setManual,
  unresolvedCount,
} from "./state/merge-conflict.js";

function ide(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

export interface MergeViewProps {
  root: string;
  /** repo-relative conflicted file. */
  file: string;
  /** called after the merged file is written + staged (leaves the conflicted set). */
  onResolved: () => void;
  onClose: () => void;
}

const PANE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  maxHeight: 180,
  overflow: "auto",
  margin: 0,
  padding: 6,
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "0.7rem",
  whiteSpace: "pre",
  background: "var(--bg-inset, #0b0b0f)",
  border: "1px solid var(--border-subtle, #2a2a33)",
  borderRadius: "var(--radius-sm, 3px)",
};

export function MergeView({ root, file, onResolved, onClose }: MergeViewProps): ReactElement {
  const [versions, setVersions] = useState<{ base: string; ours: string; theirs: string } | null>(
    null,
  );
  const [merge, setMerge] = useState<ParsedMerge | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "binary" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const api = ide();
      if (!api) {
        setPhase("error");
        setError("no ide bridge");
        return;
      }
      const cv = await api.gitConflictVersions(root, file).catch(() => null);
      if (!alive) return;
      if (!cv || !cv.ok) {
        setPhase("error");
        setError(cv?.error ?? "could not read the conflict versions");
        return;
      }
      if (cv.binary) {
        setPhase("binary");
        return;
      }
      setVersions({ base: cv.base, ours: cv.ours, theirs: cv.theirs });
      setMerge(parseConflicts(cv.working));
      setPhase("ready");
    })();
    return () => {
      alive = false;
    };
  }, [root, file]);

  const unresolved = merge ? unresolvedCount(merge) : 0;

  const markResolved = useCallback(async () => {
    if (!merge) return;
    const api = ide();
    if (!api) return;
    setBusy(true);
    setError(null);
    const text = buildResult(merge);
    const w = await api.fsWrite(`file://${root}/${file}`, text).catch(() => null);
    if (!w?.ok) {
      setBusy(false);
      setError("could not write the merged file");
      return;
    }
    const st = await api.gitStage(root, [file]).catch(() => null);
    setBusy(false);
    if (!st?.ok) {
      setError(st?.error ?? "could not stage the resolved file");
      return;
    }
    onResolved();
  }, [merge, root, file, onResolved]);

  let conflictIndex = -1;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: "var(--bg-app, #0b0d10)",
        display: "flex",
        flexDirection: "column",
        padding: 10,
      }}
      aria-label={`merge ${file}`}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: "0.8rem", color: "var(--text-primary, #e7e7ea)" }}>
          Merge · {file}
        </strong>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: "0.72rem", color: "var(--text-secondary, #9a9aa3)" }}>
          {unresolved > 0 ? `${unresolved} unresolved` : "all resolved"}
        </span>
        <Button
          size="sm"
          disabled={busy || unresolved > 0 || phase !== "ready"}
          onClick={() => void markResolved()}
        >
          ✓ Mark Resolved
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          ✕ Close
        </Button>
      </div>

      {error && (
        <p style={{ color: "var(--danger, #e5534b)", fontSize: "0.74rem", margin: "0 0 6px" }}>
          {error}
        </p>
      )}

      {phase === "loading" && (
        <p style={{ color: "var(--text-secondary, #9a9aa3)" }}>loading conflict versions…</p>
      )}

      {phase === "binary" && (
        <p style={{ color: "var(--text-secondary, #9a9aa3)", fontSize: "0.78rem" }}>
          This is a binary file — a 3-way text merge is meaningless. Close this and use the quick
          "ours"/"theirs" buttons in the Git panel.
        </p>
      )}

      {phase === "ready" && versions && merge && (
        <div style={{ overflow: "auto", flex: 1 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={LABEL}>base</div>
              <pre style={PANE}>{versions.base || "(no common ancestor)"}</pre>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={LABEL}>ours (HEAD)</div>
              <pre style={PANE}>{versions.ours || "(absent)"}</pre>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={LABEL}>theirs (incoming)</div>
              <pre style={PANE}>{versions.theirs || "(absent)"}</pre>
            </div>
          </div>

          <div style={LABEL}>result</div>
          <div
            style={{
              border: "1px solid var(--border-subtle, #2a2a33)",
              borderRadius: "var(--radius-sm, 3px)",
            }}
          >
            {merge.segments.map((seg, si) => {
              if (seg.kind === "common") {
                return (
                  <pre
                    // biome-ignore lint/suspicious/noArrayIndexKey: segments are positionally stable
                    key={`c${si}`}
                    style={{
                      margin: 0,
                      padding: "2px 6px",
                      fontFamily: "var(--font-mono, monospace)",
                      fontSize: "0.72rem",
                      whiteSpace: "pre-wrap",
                      color: "var(--text-secondary, #9a9aa3)",
                    }}
                  >
                    {seg.lines.join("\n")}
                  </pre>
                );
              }
              conflictIndex++;
              const idx = conflictIndex;
              const active = seg.resolution;
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments are positionally stable
                  key={`x${si}`}
                  style={{
                    borderTop: "1px solid var(--border-subtle, #2a2a33)",
                    borderBottom: "1px solid var(--border-subtle, #2a2a33)",
                    padding: 4,
                    background: "var(--bg-surface-2, #16161b)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                    <span style={{ fontSize: "0.68rem", color: "var(--text-secondary, #9a9aa3)" }}>
                      conflict {idx + 1}
                      {active !== "unresolved" ? ` · ${active}` : ""}
                    </span>
                    <span style={{ flex: 1 }} />
                    <Button
                      size="sm"
                      variant={active === "ours" ? "primary" : "ghost"}
                      onClick={() => setMerge((m) => (m ? acceptOurs(m, idx) : m))}
                    >
                      ours
                    </Button>
                    <Button
                      size="sm"
                      variant={active === "theirs" ? "primary" : "ghost"}
                      onClick={() => setMerge((m) => (m ? acceptTheirs(m, idx) : m))}
                    >
                      theirs
                    </Button>
                    <Button
                      size="sm"
                      variant={active === "both" ? "primary" : "ghost"}
                      onClick={() => setMerge((m) => (m ? acceptBoth(m, idx) : m))}
                    >
                      both
                    </Button>
                  </div>
                  <textarea
                    value={blockText(seg)}
                    aria-label={`resolved text for conflict ${idx + 1}`}
                    spellCheck={false}
                    onChange={(e) => setMerge((m) => (m ? setManual(m, idx, e.target.value) : m))}
                    style={{
                      width: "100%",
                      minHeight: 48,
                      resize: "vertical",
                      background: "var(--bg-inset, #0b0b0f)",
                      color: "var(--text-primary, #e7e7ea)",
                      border:
                        active === "unresolved"
                          ? "1px solid var(--danger, #e5534b)"
                          : "1px solid var(--border-subtle, #2a2a33)",
                      borderRadius: "var(--radius-sm, 3px)",
                      fontFamily: "var(--font-mono, monospace)",
                      fontSize: "0.72rem",
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const LABEL: CSSProperties = {
  fontSize: "0.66rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-secondary, #9a9aa3)",
  marginBottom: 2,
};

export default MergeView;
