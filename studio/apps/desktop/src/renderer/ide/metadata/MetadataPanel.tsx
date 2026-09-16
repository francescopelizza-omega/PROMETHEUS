/**
 * MetadataPanel.tsx — the file-metadata control surface (file 0C — privacy protection).
 *
 * Pick a file → read its metadata → see it grouped + privacy-flagged → erase ALL of it behind a
 * two-step confirm. Drives the MAIN process over window.prometheus.metadata.* +
 * window.prometheus.fileOpen (C5: the renderer never touches the fs or spawns the sidecar).
 * Pure view-model (metadata-panel-view.ts) + @prometheus/ui atoms. Token colors only.
 *
 * For the user's OWN files + privacy only — the destructive erase ALWAYS confirms.
 *
 * WHAT THIS PANEL DOES NOT DO. This header used to advertise "erase all metadata
 * (typed-confirm), edit a field, or normalize timestamps", and none of the three was accurate:
 * the bridge interface below declares only `inspect` and `scrub`, there is no field-edit control
 * and no timestamp control anywhere in the file, and the erase dialog confirms with a BUTTON,
 * not a typed phrase. A header describing capabilities the component does not have is worse than
 * no header — it is what a reader checks instead of the code. Per-field edit and timestamp
 * normalisation would need new sidecar verbs and new IPC; they are not hidden here, they are
 * absent.
 */
import { Button, EmptyState, Panel, StatusPill } from "@prometheus/ui";
import { type CSSProperties, type ReactElement, useCallback, useRef, useState } from "react";

import { Z, useFocusTrap } from "@prometheus/ui";
import type { MetadataInspectResult } from "../../../shared/ipc-contract.js";
import { type MetadataRow, buildMetadataRows, summarize } from "./metadata-panel-view.js";

/** The window.prometheus.metadata + fileOpen surface this panel needs (typed locally). */
interface MetadataBridge {
  fileOpen(opts?: { title?: string }): Promise<{
    ok: boolean;
    path: string | null;
    canceled: boolean;
  }>;
  metadata: {
    inspect(uri: string): Promise<MetadataInspectResult>;
    scrub(
      uri: string,
      confirm?: boolean,
    ): Promise<{ ok: boolean; error?: string; removed?: number; xattrsRemoved?: number }>;
  };
}

function bridge(): MetadataBridge | null {
  const w = window as unknown as { prometheus?: MetadataBridge };
  return w.prometheus ?? null;
}

const cell: CSSProperties = {
  padding: "var(--space-1, 2px) var(--space-3, 6px)",
  fontSize: "var(--text-small-size, 0.8125rem)",
  borderBottom: "1px solid var(--border-subtle)",
  verticalAlign: "top",
};

/** The §0C Metadata panel. */
export function MetadataPanel(): ReactElement {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [inspect, setInspect] = useState<MetadataInspectResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // §9.2 overlay contract: a destructive confirm traps focus, closes on Escape, and has a
  // VISIBLE close affordance. It previously had none of the three — its Escape handler sat
  // on a `role="presentation"` backdrop that is never focused, so it could never fire.
  const confirmRef = useRef<HTMLElement | null>(null);
  const closeConfirm = useCallback(() => setConfirming(false), []);
  useFocusTrap(confirmRef, confirming, closeConfirm);

  const load = useCallback(async (uri: string) => {
    const api = bridge();
    if (!api) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await api.metadata.inspect(uri);
      setInspect(res);
      if (!res.ok) setStatus(res.error ?? "could not read metadata");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "metadata read failed");
    } finally {
      setBusy(false);
    }
  }, []);

  const pick = useCallback(async () => {
    const api = bridge();
    if (!api) return;
    try {
      const r = await api.fileOpen({ title: "Select a file to inspect its metadata" });
      if (r.ok && r.path) {
        setFilePath(r.path);
        setConfirming(false);
        await load(r.path);
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "could not open the file picker");
    }
  }, [load]);

  const erase = useCallback(async () => {
    const api = bridge();
    if (!api || !filePath) return;
    setBusy(true);
    setConfirming(false);
    try {
      const r = await api.metadata.scrub(filePath, true); // confirmed erase
      if (r.ok) {
        setStatus(
          `erased ${r.removed ?? 0} tag(s) + ${r.xattrsRemoved ?? 0} extended attribute(s)`,
        );
        await load(filePath);
      } else {
        setStatus(r.error ?? "erase failed — original left intact");
      }
    } catch (e) {
      // a rejected scrub IPC must NOT leave the user unsure whether the destructive op
      // ran — surface it (the original is left intact on a failed scrub).
      setStatus(
        `erase failed — ${e instanceof Error ? e.message : "error"} (original left intact)`,
      );
    } finally {
      setBusy(false);
    }
  }, [filePath, load]);

  const rows: MetadataRow[] = inspect?.ok ? buildMetadataRows(inspect) : [];
  const summary = inspect?.ok ? summarize(inspect) : null;
  const exiftool = inspect?.tools?.exiftool ?? false;

  return (
    <Panel title="Metadata — privacy control" elevation="e1">
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3, 6px)",
          height: "100%",
          boxSizing: "border-box",
          fontFamily: "var(--font-ui)",
          color: "var(--text-primary)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3, 6px)",
            flexWrap: "wrap",
          }}
        >
          <Button variant="primary" onClick={pick} disabled={busy}>
            📂 Select file…
          </Button>
          {filePath && (
            <>
              <Button
                variant="secondary"
                onClick={() => filePath && load(filePath)}
                disabled={busy}
              >
                ⟲ Re-scan
              </Button>
              <Button variant="danger" onClick={() => setConfirming(true)} disabled={busy}>
                🧼 Erase all metadata
              </Button>
            </>
          )}
          {summary && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: "var(--text-small-size, 0.8125rem)",
                color: summary.sensitive > 0 ? "var(--warn)" : "var(--text-secondary)",
              }}
            >
              {summary.label}
            </span>
          )}
        </div>

        {filePath && (
          <code
            title={filePath}
            style={{
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-small-size, 0.8125rem)",
              // header context, so ellipsis. The SAME path inside the erase confirm below
              // keeps `break-all` — there it is the thing being confirmed and must be
              // readable in full before the user destroys anything.
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0, // flex/grid floor — without it the ellipsis is unreachable
              whiteSpace: "nowrap",
            }}
          >
            {filePath}
            {inspect?.mime ? ` · ${inspect.mime}` : ""}
            {exiftool ? "" : " · (exiftool not found — content-tag editing disabled)"}
          </code>
        )}

        {status && (
          <div
            style={{
              fontSize: "var(--text-small-size, 0.8125rem)",
              color: inspect?.ok === false ? "var(--danger)" : "var(--ok)",
            }}
          >
            {status}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {!filePath ? (
            <EmptyState
              icon="🗂"
              title="No file selected"
              hint="Pick any file you own to inspect, edit, or erase its metadata for your privacy."
              actionLabel="Select file…"
              onAction={pick}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="✓"
              title={busy ? "Reading…" : "No metadata found"}
              hint={busy ? "Inspecting the file." : "This file carries no readable metadata."}
            />
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: "var(--text-secondary)", textAlign: "left" }}>
                  <th style={cell}>Group</th>
                  <th style={cell}>Field</th>
                  <th style={cell}>Value</th>
                  <th style={cell}>Privacy</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.group}:${r.key}`}>
                    <td style={{ ...cell, color: "var(--text-secondary)" }}>{r.group}</td>
                    <td style={{ ...cell, fontFamily: "var(--font-mono)" }}>{r.key}</td>
                    {/* `break-word`, not `break-all`: these are arbitrary metadata values,
                        mostly prose (author, comments, camera model). break-all chops normal
                        words mid-letter; break-word only breaks a token that cannot fit. */}
                    <td style={{ ...cell, overflowWrap: "break-word" }}>{r.value}</td>
                    <td style={cell}>
                      {r.sensitive ? (
                        <StatusPill status="degraded" label="sensitive" />
                      ) : (
                        <span style={{ color: "var(--text-disabled)" }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {confirming && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is Escape, owned
              by useFocusTrap on the document in capture. The onKeyDown this rule asks for is
              what USED to be here — on a never-focused presentation div, where it satisfied
              the lint and did nothing. */}
          <div
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeConfirm();
            }}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              // Z.modal, not Z.palette: this is a destructive confirm the user must answer
              // before continuing, which is exactly the rung layers.ts assigns to `modal`.
              // On `palette` (1100) it sat BELOW every other confirm in the app.
              zIndex: Z.modal,
            }}
          >
            <section
              ref={confirmRef}
              role="alertdialog"
              aria-modal="true"
              aria-label="Confirm erase metadata"
              style={{
                width: 440,
                maxWidth: "90vw",
                maxHeight: "90vh",
                overflow: "auto",
                background: "var(--bg-surface-2)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius-xl, 14px)",
                boxShadow: "0 16px 48px rgba(0,0,0,.5)",
                padding: "var(--space-8, 16px)",
                color: "var(--text-primary)",
                fontFamily: "var(--font-ui)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4, 8px)" }}>
                <h2
                  style={{
                    margin: 0,
                    flex: 1,
                    fontSize: "var(--text-h2-size, 1rem)",
                    color: "var(--danger)",
                  }}
                >
                  🧼 Erase all metadata?
                </h2>
                <Button size="sm" variant="ghost" aria-label="close" onClick={closeConfirm}>
                  ✕
                </Button>
              </div>
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "var(--text-small-size, 0.8125rem)",
                }}
              >
                This strips content tags + extended attributes from a COPY, verifies, then
                atomically replaces the file. The file's content is preserved and the original is
                never lost on failure. Applies to:
              </p>
              <code
                style={{
                  display: "block",
                  color: "var(--text-secondary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-small-size, 0.8125rem)",
                  wordBreak: "break-all",
                  marginBottom: "var(--space-4, 8px)",
                }}
              >
                {filePath}
              </code>
              <div
                style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3, 6px)" }}
              >
                <Button variant="secondary" onClick={closeConfirm}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={erase} disabled={busy}>
                  Erase metadata
                </Button>
              </div>
            </section>
          </div>
        </>
      )}
    </Panel>
  );
}

export default MetadataPanel;
