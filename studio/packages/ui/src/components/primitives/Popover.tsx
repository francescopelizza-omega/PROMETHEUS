/**
 * Popover.tsx + Tooltip.tsx — non-modal floating layers (file 08 §3.1).
 *
 * Popover: a click-toggled surface anchored to a trigger; dismissed on Esc or
 * outside-click (useDismiss). Tooltip: a hover/focus label with a describedby tie.
 * @radix-ui/react-popover / -tooltip are DECLARED in package.json and swap in for
 * collision-aware positioning; these render anchored + accessible today. e2
 * elevation (08 §2.4).
 */

import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  cloneElement,
  useId,
  useRef,
  useState,
} from "react";
import { Z } from "../../tokens/layers.js";
import { useDismiss } from "./overlay.js";
import { fs, rad, sp, v } from "./styles.js";

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

function anchorStyle(side: Side, align: Align): CSSProperties {
  const base: CSSProperties = { position: "absolute" };
  if (side === "bottom") Object.assign(base, { top: "calc(100% + 6px)" });
  if (side === "top") Object.assign(base, { bottom: "calc(100% + 6px)" });
  if (side === "right") Object.assign(base, { left: "calc(100% + 6px)", top: 0 });
  if (side === "left") Object.assign(base, { right: "calc(100% + 6px)", top: 0 });
  if (side === "top" || side === "bottom") {
    if (align === "start") base.left = 0;
    else if (align === "end") base.right = 0;
    else Object.assign(base, { left: "50%", transform: "translateX(-50%)" });
  }
  return base;
}

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger element (a single focusable child). */
  trigger: ReactElement;
  side?: Side;
  align?: Align;
  className?: string;
  children?: ReactNode;
}

export function Popover({
  open,
  onOpenChange,
  trigger,
  side = "bottom",
  align = "start",
  className,
  children,
}: PopoverProps): ReactNode {
  const triggerRef = useRef<HTMLElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useDismiss(layerRef, triggerRef, open, () => onOpenChange(false));

  const triggerEl = cloneElement(
    trigger as ReactElement<Record<string, unknown>>,
    {
      ref: triggerRef,
      "aria-expanded": open,
      "aria-haspopup": "dialog",
      "aria-controls": open ? panelId : undefined,
      onClick: (e: unknown) => {
        (trigger.props as { onClick?: (e: unknown) => void }).onClick?.(e);
        onOpenChange(!open);
      },
    } as Record<string, unknown>,
  );

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      {triggerEl}
      {open && (
        <div
          ref={layerRef}
          id={panelId}
          role="dialog"
          className={className}
          style={{
            ...anchorStyle(side, align),
            zIndex: Z.dropdown,
            minWidth: "200px",
            background: v("bg-surface-2"),
            border: `1px solid ${v("border-strong")}`,
            borderRadius: rad("lg"),
            boxShadow: "0 8px 24px rgba(0,0,0,.35)",
            color: v("text-primary"),
            fontFamily: v("font-ui"),
            fontSize: fs("body"),
            padding: sp(4),
          }}
        >
          {children}
        </div>
      )}
    </span>
  );
}

/* ── Tooltip ─────────────────────────────────────────────────────────────────── */

export interface TooltipProps {
  /** The visible label content. */
  label: ReactNode;
  side?: Side;
  /** The trigger (a single focusable child). */
  children: ReactElement;
}

export function Tooltip({ label, side = "top", children }: TooltipProps): ReactNode {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const child = cloneElement(
    children as ReactElement<Record<string, unknown>>,
    {
      "aria-describedby": open ? tipId : undefined,
      onMouseEnter: (e: unknown) => {
        (children.props as { onMouseEnter?: (e: unknown) => void }).onMouseEnter?.(e);
        setOpen(true);
      },
      onMouseLeave: (e: unknown) => {
        (children.props as { onMouseLeave?: (e: unknown) => void }).onMouseLeave?.(e);
        setOpen(false);
      },
      onFocus: (e: unknown) => {
        (children.props as { onFocus?: (e: unknown) => void }).onFocus?.(e);
        setOpen(true);
      },
      onBlur: (e: unknown) => {
        (children.props as { onBlur?: (e: unknown) => void }).onBlur?.(e);
        setOpen(false);
      },
    } as Record<string, unknown>,
  );
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      {child}
      {open && (
        <span
          id={tipId}
          role="tooltip"
          style={{
            ...anchorStyle(side, "center"),
            // layers.ts: "dropdown 500 — popovers, menus, TOOLTIPS". A tooltip is not a
            // decision surface and must not outrank a dialog. It renders inline inside a
            // position:relative span, so within a Dialog it still stacks in that dialog's
            // own context and stays visible.
            zIndex: Z.dropdown,
            whiteSpace: "nowrap",
            background: v("bg-surface-2"),
            border: `1px solid ${v("border-strong")}`,
            borderRadius: rad("md"),
            boxShadow: "0 8px 24px rgba(0,0,0,.35)",
            color: v("text-primary"),
            fontFamily: v("font-ui"),
            fontSize: fs("small"),
            padding: `${sp(2)} ${sp(3)}`,
            pointerEvents: "none",
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

export default Popover;
