/**
 * ForceOverrideDialog.tsx — the deep-red ☠ Force-override flow (file 03 §5.3).
 *
 * The ONLY way past a nemesis BLOCK/error. Full-bleed red. It restates the
 * blocking findings, then demands the user TYPE the engine's exact token
 * (`install-dangerous`). The confirm CTA stays DISABLED until
 * `matchesForceToken(input)` is true — an exact match, no trim, no case-fold
 * (the engine re-checks identically on its side; the GUI never weakens the gate,
 * C5). Shows how many times the user has already forced this session, so a
 * "force everything" habit is visible.
 *
 * Decides nothing about "safe" — it renders the engine's block + collects a typed
 * confirmation, then hands control to `onConfirm` (the renderer runs the forced
 * install via window.prometheus.*). All engine strings are inert text.
 */

import { type ReactElement, useId, useRef, useState } from "react";
import { Button } from "../components/Button.js";
import { useFocusTrap } from "../components/primitives/overlay.js";
import { Z } from "../tokens/layers.js";
import { FindingRow } from "./FindingRow.js";
import type { SecFinding } from "./types.js";
import { FORCE_TOKEN, inertText, matchesForceToken } from "./util.js";

export interface ForceOverrideDialogProps {
  /** What is being forced (target label / path), shown inert. */
  target: string;
  /** The engine's blocking_reasons restated in the dialog. */
  blockingReasons: string[];
  /** The blocking findings, shown so the user sees exactly what they override. */
  findings?: SecFinding[];
  /** How many dangerous overrides the user has ALREADY confirmed this session. */
  forcedThisSession: number;
  /** Fired only when the typed token matches — the renderer runs the forced op. */
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
}

export function ForceOverrideDialog({
  target,
  blockingReasons,
  findings = [],
  forcedThisSession,
  onConfirm,
  onCancel,
  className,
}: ForceOverrideDialogProps): ReactElement {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const enabled = matchesForceToken(typed);
  // §9 overlay contract: focus trap + focus restore + Escape. This is a MODAL asking for
  // an irreversible decision — Tab must not walk out of it into the page behind, and
  // Escape must always be a way out that means "no".
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(panelRef, true, onCancel);

  return (
    <div
      className={className}
      role="alertdialog"
      aria-modal="true"
      aria-label="Force install over a deep-red block"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--danger) 22%, rgba(0,0,0,0.6))",
        padding: "var(--space-12, 24px)",
        zIndex: Z.modal,
      }}
    >
      <section
        ref={panelRef}
        tabIndex={-1}
        style={{
          width: "min(560px, 100%)",
          maxHeight: "100%",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-8, 16px)",
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
          <span aria-hidden="true" style={{ color: "var(--danger)", fontSize: "1.6rem" }}>
            ☠
          </span>
          <strong style={{ color: "var(--danger)", fontSize: "var(--text-h1-size, 1.375rem)" }}>
            Force install over a DEEP-RED BLOCK
          </strong>
        </header>

        <p style={{ margin: 0, color: "var(--text-secondary)" }}>
          nemesis blocked{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>{inertText(target)}</code>. Forcing this
          installs software the engine flagged as dangerous. This cannot be undone by this dialog.
        </p>

        {blockingReasons.length > 0 && (
          <ul
            style={{
              margin: 0,
              paddingLeft: "var(--space-12, 24px)",
              color: "var(--danger)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            {blockingReasons.map((reason, i) => (
              <li key={`${i}-${reason}`}>{inertText(reason)}</li>
            ))}
          </ul>
        )}

        {findings.length > 0 && (
          <div
            style={{
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md, 6px)",
              overflow: "hidden",
            }}
          >
            {findings.map((f, i) => (
              <FindingRow key={`${f.rule_id}-${f.path}-${i}`} finding={f} />
            ))}
          </div>
        )}

        {forcedThisSession > 0 && (
          <div
            role="note"
            style={{
              padding: "var(--space-3, 6px) var(--space-4, 8px)",
              border: "1px solid var(--warn)",
              borderRadius: "var(--radius-md, 6px)",
              color: "var(--warn)",
              fontSize: "var(--text-small-size, 0.8125rem)",
            }}
          >
            You have already forced {forcedThisSession} dangerous override
            {forcedThisSession === 1 ? "" : "s"} this session.
          </div>
        )}

        <label
          htmlFor={inputId}
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-2, 4px)" }}
        >
          <span style={{ fontSize: "var(--text-small-size, 0.8125rem)" }}>
            Type{" "}
            <code style={{ fontFamily: "var(--font-mono)", color: "var(--danger)" }}>
              {FORCE_TOKEN}
            </code>{" "}
            to enable the override:
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
              fontSize: "var(--text-code-size, 0.78125rem)",
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
              if (matchesForceToken(typed)) onConfirm();
            }}
          >
            ☠ Force install at my own risk
          </Button>
        </footer>
      </section>
    </div>
  );
}

export default ForceOverrideDialog;
