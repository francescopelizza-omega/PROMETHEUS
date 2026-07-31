/**
 * Button.tsx — the primary control primitive (08 §3.1).
 *
 * Variants map to semantic role tokens (never raw hex, 08 §6):
 *   primary    --brand / --brand-fg   (CTAs, "Install", "Serve")
 *   secondary  --bg-surface-2 border  (neutral)
 *   ghost      transparent            (toolbar, inline)
 *   danger     --danger               (destructive — pairs with AlertDialog)
 * Reads density vars (--row-h / --pad-y, 08 §2.4) so it tightens in the editor
 * and relaxes in discovery screens. Focus ring is the tokenized accent (08 §7).
 */

import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Optional leading glyph/icon node (e.g. a verdict glyph or lucide icon). */
  icon?: ReactNode;
}

interface VariantStyle {
  background: string;
  color: string;
  border: string;
}

function variantStyle(variant: ButtonVariant): VariantStyle {
  switch (variant) {
    case "primary":
      return {
        background: "var(--brand)",
        color: "var(--brand-fg)",
        border: "1px solid transparent",
      };
    case "danger":
      return {
        background: "color-mix(in srgb, var(--danger) 16%, transparent)",
        color: "var(--danger)",
        border: "1px solid var(--danger)",
      };
    case "ghost":
      return {
        background: "transparent",
        color: "var(--text-primary)",
        border: "1px solid transparent",
      };
    default:
      return {
        background: "var(--bg-surface-2)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-strong)",
      };
  }
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, children, style, disabled, ...rest },
  ref,
) {
  const v = variantStyle(variant);
  return (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      disabled={disabled}
      data-variant={variant}
      data-size={size}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-2, 4px)",
        height: size === "sm" ? "28px" : "var(--row-h, 36px)",
        paddingInline: size === "sm" ? "var(--space-4, 8px)" : "var(--space-6, 12px)",
        borderRadius: "var(--radius-md, 6px)",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--text-body-size, 0.9375rem)",
        fontWeight: 600,
        lineHeight: 1,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition:
          "background var(--motion-hover, 120ms) ease-out, border-color var(--motion-hover, 120ms) ease-out",
        outline: "none",
        ...v,
        ...style,
      }}
      onFocus={(e) => {
        e.currentTarget.style.boxShadow = "0 0 0 2px var(--bg-app), 0 0 0 4px var(--focus-ring)";
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        e.currentTarget.style.boxShadow = "none";
        rest.onBlur?.(e);
      }}
      {...rest}
    >
      {icon != null && (
        <span aria-hidden="true" style={{ display: "inline-flex" }}>
          {icon}
        </span>
      )}
      {children}
    </button>
  );
});

export default Button;
