/**
 * PurgeDialog.tsx — the irreversible-deletion confirm (file 03 §9.3).
 *
 * Purge is the ONLY irreversible destruction in the app. This deep-red dialog
 * makes the user type the artifact's FILENAME (basename) before the destroy CTA
 * lights up: it stays DISABLED until `purgeNameMatches(typed, filename)` is true
 * (exact basename match — no trim, no case-fold). The engine still performs (or
 * refuses) the delete; this only gates the button (C5).
 *
 * Presentational + local input state. The filename it shows + asks for is inert
 * text. onConfirm fires only on an exact match and RECEIVES the exact string the
 * user typed (the basename) so the caller can forward it as the main-process
 * confirmation — the gate verifies the human's input, not a renderer echo (§9.3).
 * onCancel always backs out.
 */

import { type ReactElement, type ReactNode, useId, useState } from "react";
import { Button } from "../components/Button.js";
import { inertText, purgeBasename, purgeNameMatches } from "./util.js";

export interface PurgeDialogProps {
  /** The logical path of the artifact to purge (path or "pkg.zip!member"). */
  filename: string;
  /** Fires only on an exact basename match; receives the string the user typed. */
  onConfirm: (typedName: string) => void;
  onCancel: () => void;
  className?: string;
  /** Heading + destroy-CTA label (default "Purge permanently"). The typed-confirm
   *  mechanics never change — only the copy, so other destructive flows (uninstall,
   *  APP-006) reuse this dialog instead of hand-rolling a second modal. */
  title?: string;
  /** The consequence sentence (default the purge copy). */
  description?: ReactNode;
}

export function PurgeDialog({
  filename,
  onConfirm,
  onCancel,
  className,
  title = "Purge permanently",
  description,
}: PurgeDialogProps): ReactElement {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const expected = purgeBasename(filename);
  const enabled = purgeNameMatches(typed, filename);

  return (
    <div
      className={className}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--danger) 22%, rgba(0,0,0,0.6))",
        padding: "var(--space-12, 24px)",
        zIndex: 1000,
      }}
    >
      <section
        style={{
          width: "min(480px, 100%)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6, 12px)",
          background: "var(--bg-surface-2)",
          border: "2px solid var(--danger)",
          borderRadius: "var(--radius-xl, 14px)",
          padding: "var(--space-12, 24px)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-ui)",
          boxShadow: "0 16px 48px rgba(0,0,0,.5)",
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: "var(--space-4, 8px)" }}>
          <span aria-hidden="true" style={{ color: "var(--danger)", fontSize: "1.4rem" }}>
            ⚠
          </span>
          <strong style={{ color: "var(--danger)", fontSize: "var(--text-h2-size, 1.125rem)" }}>
            {title}
          </strong>
        </header>

        <p style={{ margin: 0, color: "var(--text-secondary)" }}>
          {description ?? (
            <>
              This deletes{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>{inertText(filename)}</code> for
              good. It cannot be restored.
            </>
          )}
        </p>

        <label
          htmlFor={inputId}
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 4px)" }}
        >
          <span style={{ fontSize: "var(--text-small-size, 0.8125rem)" }}>
            Type the name{" "}
            <code style={{ fontFamily: "var(--font-mono)", color: "var(--danger)" }}>
              {inertText(expected)}
            </code>{" "}
            to confirm:
          </span>
          <input
            id={inputId}
            type="text"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.currentTarget.value)}
            style={{
              padding: "var(--space-3, 6px) var(--space-4, 8px)",
              background: "var(--bg-inset)",
              border: `1px solid ${enabled ? "var(--danger)" : "var(--border-strong)"}`,
              borderRadius: "var(--radius-md, 6px)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-code-size, 0.875rem)",
            }}
          />
        </label>

        <footer style={{ display: "flex", gap: "var(--space-4, 8px)", justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!enabled}
            onClick={() => {
              if (purgeNameMatches(typed, filename)) onConfirm(typed);
            }}
          >
            {title}
          </Button>
        </footer>
      </section>
    </div>
  );
}

export default PurgeDialog;
