// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Francesco Pelizza
/**
 * IconButton.tsx — a square icon-only button (file 08 §3.1).
 *
 * The toolbar/inline affordance (close ✕, expand ▸, the AI ⌘I trigger). Always
 * carries an `aria-label` (icon-only → no visible text, 08 §7). Variants reuse the
 * Button role tokens; sizes follow the density row-height family. Real Radix is not
 * needed for a button; CVA expresses the variant classes, inline styles render today.
 */

import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from "react";
import { type VariantProps, cva } from "../util/cva.js";
import { HOVER_TRANSITION, focusRingHandlers, rad, sp, v } from "./styles.js";

export const iconButtonVariants = cva(
  "prom-icon-button inline-flex items-center justify-center rounded-md transition",
  {
    variants: {
      variant: {
        ghost: "bg-transparent text-text-primary",
        surface: "bg-bg-surface-2 text-text-primary border border-border-strong",
        brand: "bg-brand text-brand-fg",
        danger: "text-danger",
      },
      size: { sm: "h-7 w-7", md: "h-9 w-9" },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export type IconButtonVariant = NonNullable<VariantProps<typeof iconButtonVariants>["variant"]>;
export type IconButtonSize = NonNullable<VariantProps<typeof iconButtonVariants>["size"]>;

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only buttons MUST name their action for screen readers (§7). */
  "aria-label": string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  icon: ReactNode;
}

function variantStyle(variant: IconButtonVariant): {
  background: string;
  color: string;
  border: string;
} {
  switch (variant) {
    case "surface":
      return {
        background: v("bg-surface-2"),
        color: v("text-primary"),
        border: `1px solid ${v("border-strong")}`,
      };
    case "brand":
      // The label sits ON the `--brand` fill, so it needs the computed `--on-brand`.
      // `--brand-fg` is #ffffff on the dark scheme and measures 3.96:1 over `--brand` —
      // under the 4.5:1 a label carries. It stays in use where it is a FILL, not a label
      // (the Toggle knob), which is why this is a call-site change and not a token change.
      return { background: v("brand"), color: v("on-brand"), border: "1px solid transparent" };
    case "danger":
      return {
        background: "color-mix(in srgb, var(--danger) 14%, transparent)",
        color: v("danger"),
        border: `1px solid ${v("danger")}`,
      };
    default:
      return {
        background: "transparent",
        color: v("text-primary"),
        border: "1px solid transparent",
      };
  }
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = "ghost", size = "md", icon, className, style, disabled, onFocus, onBlur, ...rest },
  ref,
) {
  const dim = size === "sm" ? "28px" : "var(--row-h, 36px)";
  const vs = variantStyle(variant);
  const ring = focusRingHandlers();
  return (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      disabled={disabled}
      data-variant={variant}
      data-size={size}
      className={iconButtonVariants({ variant, size, className })}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size === "sm" ? "28px" : dim,
        height: dim,
        borderRadius: rad("md"),
        padding: sp(2),
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: HOVER_TRANSITION,
        outline: "none",
        ...vs,
        ...style,
      }}
      // `{...rest}` FIRST. Spread last, a caller's own onFocus/onBlur silently replaced
      // the composed prop and the tokenized focus ring stopped being drawn on that
      // control. Spreading first lets the handlers below win; they chain the caller's,
      // destructured out of `rest` so the spread cannot reintroduce it.
      {...rest}
      onFocus={(e) => {
        ring.onFocus(e);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        ring.onBlur(e);
        onBlur?.(e);
      }}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", lineHeight: 1 }}>
        {icon}
      </span>
    </button>
  );
});

export default IconButton;
