/**
 * Badge.tsx + Tag.tsx — small status/label atoms (file 08 §3.1).
 *
 * Badge: a tinted pill keyed to a semantic ROLE token (ok/warn/danger/info/brand/
 * neutral) — the generic sibling of the verdict/severity chips, color never alone
 * (callers pair a glyph/label). Tag: a removable chip (quant chips, klass tags). All
 * color via tokens; CVA expresses the role classes, inline styles render today.
 */

import { type ReactNode, forwardRef } from "react";
import { type VariantProps, cva } from "../util/cva.js";
import { fs, rad, sp, v } from "./styles.js";

export type BadgeRole = "neutral" | "brand" | "accent" | "ok" | "warn" | "danger" | "info";

export const badgeVariants = cva(
  "prom-badge inline-flex items-center rounded-full font-medium leading-none whitespace-nowrap",
  {
    variants: {
      role: {
        neutral: "text-text-secondary border-border-strong",
        brand: "text-brand border-brand",
        accent: "text-accent border-accent",
        ok: "text-ok border-ok",
        warn: "text-warn border-warn",
        danger: "text-danger border-danger",
        info: "text-info border-info",
      },
      mono: { true: "font-mono", false: "font-ui" },
    },
    defaultVariants: { role: "neutral", mono: false },
  },
);

/** Resolve a role to its CSS-var color (neutral → text-secondary/border-strong). */
/**
 * The three colours a badge needs: the role tint, its border, and — for `solid` — the LABEL
 * colour that sits ON the fill.
 *
 * `on` cannot be one fixed token. A solid badge fills with the ROLE colour, and the roles are
 * saturated light tones on the dark scheme (`--ok` #8be04a, `--warn` #f5c944), so the white
 * `--brand-fg` this used measured 1.63:1 and 1.58:1. Each role therefore carries its own
 * computed `--on-<role>` (tokens/contrast.ts `onFill`). `neutral` fills with
 * `--text-secondary`, which is a text tone rather than a role, so it takes the ground.
 */
function roleColor(role: BadgeRole): { color: string; border: string; on: string } {
  if (role === "neutral")
    return { color: v("text-secondary"), border: v("border-strong"), on: v("bg-app") };
  return { color: v(role), border: v(role), on: v(`on-${role}`) };
}

export interface BadgeProps extends Omit<VariantProps<typeof badgeVariants>, "role"> {
  role?: BadgeRole;
  /** Solid fill (brand-style CTA badge) vs. the default tinted outline. */
  solid?: boolean;
  className?: string;
  children?: ReactNode;
  title?: string;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { role = "neutral", mono = false, solid = false, className, children, title },
  ref,
) {
  const { color, border, on } = roleColor(role);
  return (
    <span
      ref={ref}
      title={title}
      data-role={role}
      className={badgeVariants({ role, mono, className })}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: sp(2),
        paddingInline: sp(3),
        paddingBlock: sp(1),
        borderRadius: rad("full"),
        border: `1px solid ${border}`,
        color: solid ? on : color,
        background: solid ? color : `color-mix(in srgb, ${color} 14%, transparent)`,
        fontFamily: mono ? v("font-mono") : v("font-ui"),
        fontSize: fs("small"),
        fontWeight: 600,
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
});

/* ── Tag — a removable chip ──────────────────────────────────────────────────── */

export interface TagProps {
  children: ReactNode;
  /** When present, renders a ✕ remove affordance with this handler. */
  onRemove?: () => void;
  mono?: boolean;
  className?: string;
}

export function Tag({ children, onRemove, mono = false, className }: TagProps): ReactNode {
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: sp(2),
        paddingInline: sp(3),
        paddingBlock: sp(1),
        borderRadius: rad("sm"),
        background: v("bg-surface-2"),
        border: `1px solid ${v("border-subtle")}`,
        color: v("text-secondary"),
        fontFamily: mono ? v("font-mono") : v("font-ui"),
        fontSize: fs("small"),
        lineHeight: 1,
      }}
    >
      <span>{children}</span>
      {onRemove != null && (
        <button
          type="button"
          aria-label="Remove"
          onClick={onRemove}
          style={{
            background: "transparent",
            border: "none",
            color: v("text-secondary"),
            cursor: "pointer",
            padding: 0,
            lineHeight: 1,
            fontSize: "0.9em",
          }}
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </span>
  );
}

export default Badge;
