/**
 * ide/HistoryPanel.tsx — the Local History window for the active file (APP-063, file 13 §2.6).
 *
 * A timeline overlay: every save/edit revision (newest → oldest) with its timestamp + line
 * delta; selecting one shows a read-only SIDE-BY-SIDE view (revision ← vs → current on disk)
 * and offers Revert (typed-confirm) + Recover (re-creates a deleted file from its last
 * revision). All IO goes through window.prometheus.ide.history.* / ide.fsRead — the renderer
 * never touches disk directly (C5).
 *
 * Renderer-SANDBOXED (C5): react + window.prometheus only.
 */
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Z, useFocusTrap } from "@prometheus/ui";
import type { IdeHistoryEntry } from "../../shared/ipc-contract.js";

export interface HistoryPanelProps {
  root: string;
  /** the active file uri (a file:// uri or absolute path). */
  uri: string;
  /** display name for the header. */
  name: string;
  /** re-open/refresh the editor after a revert (open the file + optionally reveal). */
  onReverted(uri: string): void;
  onClose(): void;
}

const REVERT_PHRASE = "REVERT";

function ideApi(): Window["prometheus"]["ide"] | undefined {
  return typeof window !== "undefined" ? window.prometheus?.ide : undefined;
}

const paneStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "auto",
  margin: 0,
  padding: "var(--space-3, 6px)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.72rem",
  whiteSpace: "pre-wrap",
  background: "var(--bg-inset)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm, 4px)",
  color: "var(--text-primary)",
};

export function HistoryPanel({
  root,
  uri,
  name,
  onReverted,
  onClose,
}: HistoryPanelProps): ReactElement {
  const [entries, setEntries] = useState<IdeHistoryEntry[]>([]);
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const [revision, setRevision] = useState<string>("");
  const [current, setCurrent] = useState<string>("");
  const [typed, setTyped] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // §9.2 overlay contract: it declares role="dialog" but had no focus trap and no Escape —
  // Tab walked the editor behind it and the ✕ was the only way out.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(rootRef, true, onClose);

  const reload = useCallback(async () => {
    const api = ideApi();
    if (!api) return;
    const r = await api.history.list(root, uri);
    if (r.ok) setEntries(r.entries ?? []);
    else setNotice(r.error ?? "failed to list history");
  }, [root, uri]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = useCallback(
    async (ts: number): Promise<void> => {
      setSelectedTs(ts);
      setTyped("");
      const api = ideApi();
      if (!api) return;
      const [rev, cur] = await Promise.all([
        api.history.read(root, uri, ts),
        api.fsRead(uri).catch(() => ({ ok: false as const })),
      ]);
      setRevision(rev.ok ? (rev.content ?? "") : "");
      setCurrent(cur.ok && "text" in cur ? (cur.text ?? "") : "");
    },
    [root, uri],
  );

  const revert = useCallback(async (): Promise<void> => {
    if (selectedTs === null || typed.trim() !== REVERT_PHRASE) return;
    const api = ideApi();
    if (!api) return;
    const r = await api.history.revert(root, uri, selectedTs);
    if (r.ok) {
      onReverted(uri);
      await reload();
      setNotice("reverted");
    } else {
      setNotice(`⚠ ${r.error ?? "revert failed"}`);
    }
  }, [root, uri, selectedTs, typed, onReverted, reload]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Local history: ${name}`}
      style={{
        // `fixed`, not `absolute` (§9.2): as `absolute` this resolved against whatever
        // ancestor happened to be positioned — the editor route root is not — so the panel's
        // "10% from the top, centred" was measured against an arbitrary box and moved when
        // the layout around it changed. Fixed means the viewport, which is what the numbers
        // below have always described.
        position: "fixed",
        top: "8%",
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(880px, 92vw)",
        maxHeight: "80vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-md, 6px)",
        boxShadow: "var(--elevation-e3, 0 10px 40px rgba(0,0,0,0.4))",
        // Z.modal: it declares role="dialog" and is the only thing the user can interact
        // with while it is up. On the `dropdown` rung (500) any menu opened behind it would
        // have painted over it.
        zIndex: Z.modal,
        fontFamily: "var(--font-ui)",
        color: "var(--text-primary)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-3, 6px) var(--space-4, 8px)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <strong>Local History · {name}</strong>
        <button
          type="button"
          aria-label="Close local history"
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      </header>

      {notice && (
        <div style={{ padding: "2px 8px", color: "var(--text-secondary)", fontSize: "0.75rem" }}>
          {notice}
        </div>
      )}

      <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
        {/* timeline */}
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            width: 220,
            flexShrink: 0,
            overflow: "auto",
            borderRight: "1px solid var(--border-subtle)",
          }}
        >
          {entries.length === 0 ? (
            <li
              style={{
                padding: "var(--space-4, 8px)",
                color: "var(--text-secondary)",
                fontSize: "0.75rem",
              }}
            >
              No revisions yet — save the file to capture one.
            </li>
          ) : (
            entries.map((e) => (
              <li key={e.ts}>
                <button
                  type="button"
                  onClick={() => void select(e.ts)}
                  aria-current={selectedTs === e.ts}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    width: "100%",
                    textAlign: "left",
                    gap: 2,
                    padding: "var(--space-2, 4px) var(--space-3, 6px)",
                    background: selectedTs === e.ts ? "var(--bg-inset)" : "transparent",
                    border: "none",
                    borderBottom: "1px solid var(--border-subtle)",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    fontSize: "0.75rem",
                  }}
                >
                  <span>{new Date(e.ts).toLocaleString()}</span>
                  <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                    {e.label ? `${e.label} · ` : ""}
                    <span style={{ color: "var(--ok)" }}>+{e.added}</span>{" "}
                    <span style={{ color: "var(--danger)" }}>-{e.removed}</span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>

        {/* side-by-side: the revision vs the current on-disk content */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {selectedTs === null ? (
            <div style={{ padding: "var(--space-6, 12px)", color: "var(--text-secondary)" }}>
              Select a revision to compare it with the current file.
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  padding: "var(--space-2, 4px) var(--space-3, 6px)",
                  color: "var(--text-secondary)",
                  fontSize: "0.72rem",
                }}
              >
                <span style={{ flex: 1 }}>revision</span>
                <span style={{ flex: 1 }}>current</span>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flex: 1,
                  minHeight: 0,
                  padding: "0 var(--space-3, 6px) var(--space-3, 6px)",
                }}
              >
                <pre style={paneStyle}>{revision}</pre>
                <pre style={paneStyle}>{current}</pre>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "var(--space-3, 6px)",
                  borderTop: "1px solid var(--border-subtle)",
                }}
              >
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={`type "${REVERT_PHRASE}" to confirm`}
                  aria-label="type REVERT to confirm"
                  style={{
                    background: "var(--bg-inset)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-strong)",
                    borderRadius: "var(--radius-sm, 4px)",
                    padding: "var(--space-2, 4px)",
                  }}
                />
                <button
                  type="button"
                  onClick={() => void revert()}
                  disabled={typed.trim() !== REVERT_PHRASE}
                  style={{
                    background: "var(--bg-surface-2)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-strong)",
                    borderRadius: "var(--radius-sm, 4px)",
                    padding: "var(--space-2, 4px) var(--space-4, 8px)",
                    cursor: typed.trim() === REVERT_PHRASE ? "pointer" : "not-allowed",
                  }}
                >
                  Revert / Recover to this revision
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default HistoryPanel;
