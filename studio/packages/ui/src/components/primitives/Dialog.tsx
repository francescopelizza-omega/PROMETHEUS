/**
 * Dialog.tsx — the modal primitive (file 08 §3.1, §5.2/§5.3 use it). Plus AlertDialog
 * (destructive confirm; the §5.2 Force-override path) and Sheet (a side drawer).
 *
 * Accessible: role=dialog + aria-modal, a scrim, a focus trap, Esc-to-close, focus
 * restore on close (08 §7). @radix-ui/react-dialog / -alert-dialog are DECLARED in
 * package.json and swap in 1:1; these render and trap focus today. e3 elevation +
 * scrim per 08 §2.4. Controlled via `open` / `onOpenChange`.
 */

import { type ReactNode, useId, useRef } from "react";
import { Z } from "../../tokens/layers.js";
import { Button } from "../Button.js";
import { useFocusTrap } from "./overlay.js";
import { fs, FOCUS_RING, rad, sp, v } from "./styles.js";

function Scrim({ onClick }: { onClick?: () => void }): ReactNode {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the scrim is an aria-hidden decorative overlay; scrim-click is a convenience only — keyboard dismissal is Esc (focus-trapped) + the explicit Close button.
    <div
      aria-hidden="true"
      onClick={onClick}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.5)",
        animation: "var(--motion-panel, 180ms) ease-out",
      }}
    />
  );
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  /** Trailing footer controls (defaults to nothing; callers pass their CTAs). */
  footer?: ReactNode;
  /** Hide the built-in ✕ close affordance (e.g. a forced confirm). */
  hideClose?: boolean;
  /** Clicking the scrim closes (default true; false for must-decide modals). */
  dismissOnScrim?: boolean;
  className?: string;
  children?: ReactNode;
  /** Max content width (px); default 560 (08 modal sizing). */
  width?: number;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  hideClose = false,
  dismissOnScrim = true,
  className,
  children,
  width = 560,
}: DialogProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(panelRef, open, () => onOpenChange(false));
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z.modal,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: sp(8),
      }}
    >
      <Scrim onClick={dismissOnScrim ? () => onOpenChange(false) : undefined} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        aria-describedby={description != null ? descId : undefined}
        tabIndex={-1}
        className={className}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: `${width}px`,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          background: v("bg-surface-2"),
          border: `1px solid ${v("border-strong")}`,
          borderRadius: rad("xl"),
          boxShadow: "0 16px 48px rgba(0,0,0,.5)",
          color: v("text-primary"),
          fontFamily: v("font-ui"),
          overflow: "hidden",
        }}
      >
        {(title != null || !hideClose) && (
          <header
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: sp(4),
              padding: sp(6),
              borderBottom: `1px solid ${v("border-subtle")}`,
            }}
          >
            <div style={{ minWidth: 0 }}>
              {title != null && (
                <h2 id={titleId} style={{ margin: 0, fontSize: fs("h2"), fontWeight: 600 }}>
                  {title}
                </h2>
              )}
              {description != null && (
                <p
                  id={descId}
                  style={{
                    margin: `${sp(2)} 0 0`,
                    color: v("text-secondary"),
                    fontSize: fs("small"),
                  }}
                >
                  {description}
                </p>
              )}
            </div>
            {!hideClose && (
              <button
                type="button"
                aria-label="Close dialog"
                onClick={() => onOpenChange(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: v("text-secondary"),
                  cursor: "pointer",
                  fontSize: fs("h2"),
                  lineHeight: 1,
                  padding: sp(1),
                  borderRadius: rad("sm"),
                  outline: "none",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.boxShadow = FOCUS_RING;
                }}
                onBlur={(e) => {
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                <span aria-hidden="true">✕</span>
              </button>
            )}
          </header>
        )}
        <div style={{ padding: sp(6), overflowY: "auto", flex: 1, minHeight: 0 }}>{children}</div>
        {footer != null && (
          <footer
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: sp(3),
              padding: sp(6),
              borderTop: `1px solid ${v("border-subtle")}`,
            }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/* ── AlertDialog — destructive confirm (the §5.2 Force path) ─────────────────── */

export interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` paints the confirm button --danger (destructive). */
  destructive?: boolean;
  /** Disable confirm (e.g. until a typed phrase matches — §5.2 Force). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  confirmDisabled = false,
  onConfirm,
  children,
}: AlertDialogProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useFocusTrap(panelRef, open, () => onOpenChange(false));
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z.palette,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: sp(8),
      }}
    >
      <Scrim />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description != null ? descId : undefined}
        tabIndex={-1}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "440px",
          background: v("bg-surface-2"),
          border: `1px solid ${destructive ? v("danger") : v("border-strong")}`,
          borderRadius: rad("xl"),
          boxShadow: "0 16px 48px rgba(0,0,0,.5)",
          color: v("text-primary"),
          fontFamily: v("font-ui"),
          padding: sp(6),
        }}
      >
        <h2 id={titleId} style={{ margin: 0, fontSize: fs("h2"), fontWeight: 600 }}>
          {title}
        </h2>
        {description != null && (
          <p
            id={descId}
            style={{ margin: `${sp(3)} 0 0`, color: v("text-secondary"), fontSize: fs("small") }}
          >
            {description}
          </p>
        )}
        {children != null && <div style={{ marginTop: sp(4) }}>{children}</div>}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: sp(3),
            marginTop: sp(6),
          }}
        >
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Sheet — a side drawer (file 08 §3.1) ────────────────────────────────────── */

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  title?: ReactNode;
  width?: number;
  className?: string;
  children?: ReactNode;
}

export function Sheet({
  open,
  onOpenChange,
  side = "right",
  title,
  width = 420,
  className,
  children,
}: SheetProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(panelRef, open, () => onOpenChange(false));
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: Z.modal }}>
      <Scrim onClick={() => onOpenChange(false)} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        tabIndex={-1}
        className={className}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          [side]: 0,
          width: `${width}px`,
          maxWidth: "90vw",
          display: "flex",
          flexDirection: "column",
          background: v("bg-surface-2"),
          [side === "right" ? "borderLeft" : "borderRight"]: `1px solid ${v("border-strong")}`,
          color: v("text-primary"),
          fontFamily: v("font-ui"),
          boxShadow: "0 16px 48px rgba(0,0,0,.5)",
        }}
      >
        {title != null && (
          <header
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: sp(4),
              padding: sp(6),
              borderBottom: `1px solid ${v("border-subtle")}`,
              fontSize: fs("h2"),
              fontWeight: 600,
            }}
          >
            <span id={titleId}>{title}</span>
            <button
              type="button"
              aria-label="Close panel"
              onClick={() => onOpenChange(false)}
              style={{
                background: "transparent",
                border: "none",
                color: v("text-secondary"),
                cursor: "pointer",
                fontSize: fs("h2"),
                lineHeight: 1,
              }}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </header>
        )}
        <div style={{ padding: sp(6), overflowY: "auto", flex: 1, minHeight: 0 }}>{children}</div>
      </div>
    </div>
  );
}

export default Dialog;
